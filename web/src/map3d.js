//! 3D seed map (Parts 6–7, extracted from main.js in Part 12).
//!
//! The rendering logic is unchanged from Part 7 — this only wraps it so the 2D map can be
//! the default and the 3D view initialises lazily. It runs its own render loop, gated on
//! being visible so a hidden 3D view costs nothing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SCALE, fetchTile, parseSeed } from './engine.js';
import { buildTileMesh, disposeMesh } from './terrain.js';
import { flyDelta } from './fly.js';

/// Tiles within this Chebyshev radius of the camera focus get meshed. Adjustable now
/// (Part 12.1); the LRU cache capacity below must stay above (2r+1)^2 at the max radius.
const DEFAULT_RADIUS = 3;
const MAX_RADIUS = 8; // (2*8+1)^2 = 289 tiles < cache capacity 512

/// Per-frame tile-building budgets, in ms. A load can afford a longer stall than flight can:
/// on load the user is waiting for terrain anyway, whereas mid-flight the same pause reads as
/// a dropped frame.
const REFRESH_BUDGET_MS = 24;
const FLY_BUDGET_MS = 8;

/// Keys that drive flight. Held in a Set so diagonal movement and key repeat behave.
const FLY_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'ShiftLeft', 'ShiftRight',
]);

export function create3D({ canvas, engine, View, palette, mcVersion, ui }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11131a);
  // No fog: it faded out the far edge of the rendered plane before the render-distance
  // boundary, so you couldn't see how far the terrain actually extends.

  const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49; // stop the camera going under the terrain

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(-0.6, 1, 0.4);
  scene.add(sun);

  const meshes = new Map(); // "tx,tz" -> THREE.Mesh
  let view = null;
  let radius = DEFAULT_RADIUS;
  let shown = false;
  let lastTile = null; // tile the focus was in at the last re-tile
  let queue = []; // tiles still to mesh, nearest first
  let pending = null; // { seed, x, z } loaded while hidden, applied on first show

  function resize(force = false) {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (w === 0 || h === 0) return; // hidden: 0x0 would give a NaN-aspect camera
    if (force || canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function clearMeshes() {
    for (const m of meshes.values()) { scene.remove(m); disposeMesh(m); }
    meshes.clear();
  }

  // Decide which tiles the focus wants: drop anything now out of range, and queue what is
  // missing nearest-first. Building is deferred to pump() so a single call cannot stall the
  // frame — see the note there.
  function refresh(centreX, centreZ) {
    const tileSpan = view.tile_cells * SCALE;
    const ctx = Math.floor(centreX / tileSpan);
    const ctz = Math.floor(centreZ / tileSpan);

    const wanted = new Set();
    queue = [];
    for (let tz = ctz - radius; tz <= ctz + radius; tz++) {
      for (let tx = ctx - radius; tx <= ctx + radius; tx++) {
        const key = `${tx},${tz}`;
        wanted.add(key);
        if (!meshes.has(key)) {
          queue.push({ tx, tz, key, d: Math.abs(tx - ctx) + Math.abs(tz - ctz) });
        }
      }
    }
    for (const [key, mesh] of meshes) {
      if (!wanted.has(key)) { scene.remove(mesh); disposeMesh(mesh); meshes.delete(key); }
    }
    queue.sort((a, b) => a.d - b.d); // fill outward from the camera
    pump(REFRESH_BUDGET_MS);
  }

  // Build queued tiles within a time budget, continuing on later frames.
  //
  // Each tile is a gen_heights call over a 65x65 grid plus a mesh build — around 10 ms — and
  // crossing one tile boundary at radius 3 queues a whole strip of seven. Building that
  // synchronously drops frames exactly as 12.5 warns, and does so precisely while the camera
  // is moving, which is when it is most visible. Budgeting keeps flight smooth without the
  // Web Worker that section says not to front-load.
  function pump(budgetMs) {
    if (!queue.length || !view) return;
    const t0 = performance.now();
    let built = 0, failed = 0;
    while (queue.length && performance.now() - t0 < budgetMs) {
      const { tx, tz, key } = queue.shift();
      if (meshes.has(key)) continue;
      if (!fetchTile(engine, view, tx, tz)) { failed++; continue; }

      const biomes = view.tile_biomes(tx, tz, SCALE);
      const heights = view.tile_heights(tx, tz, SCALE);
      if (!biomes.length || !heights.length) { failed++; continue; }

      const [ox, oz] = view.tile_origin_block(tx, tz, SCALE);
      const mesh = buildTileMesh(biomes, heights, view.tile_stride, SCALE, ox, oz, palette);
      scene.add(mesh);
      meshes.set(key, mesh);
      built++;
    }
    if (built || failed) {
      ui.setStatus(failed
        ? `${built} tiles built, ${failed} failed`
        : `${built} tiles built${queue.length ? `, ${queue.length} pending` : ''}`,
        failed ? 'err' : 'ok');
      showStats();
    }
  }

  function showStats() {
    const centre = controls.target;
    ui.statsEl.innerHTML = `
      <dt>meshes</dt><dd>${meshes.size}</dd>
      <dt>cached tiles</dt><dd>${view.cached_tiles}</dd>
      <dt>cache hits</dt><dd>${view.hits}</dd>
      <dt>evictions</dt><dd>${view.evictions}</dd>
      <dt>centre</dt><dd>${Math.round(centre.x)}, ${Math.round(centre.z)}</dd>`;
  }

  // Apply a loaded world: reset the Rust cache (and thus the meshes) and re-mesh + frame
  // the camera. Called only when visible; loads received while hidden wait in `pending`.
  function apply(seed, centreX, centreZ) {
    if (!view) view = new View(512);
    if (view.set_world(seed, mcVersion, 0)) clearMeshes();
    refresh(centreX, centreZ);
    const tileSpan = view.tile_cells * SCALE;
    const framed = tileSpan * (2 * radius + 1);
    camera.position.set(centreX + framed * 0.35, 260, centreZ + framed * 0.45);
    controls.target.set(centreX, 40, centreZ);
    controls.update();
    lastTile = { tx: Math.floor(centreX / tileSpan), tz: Math.floor(centreZ / tileSpan) };
  }

  // --- hover readout ---
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  canvas.addEventListener('pointermove', (e) => {
    if (!shown || !view) return;
    const r = canvas.getBoundingClientRect();
    ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects([...meshes.values()], false)[0];
    if (!hit) { ui.hoverEl.textContent = '—'; return; }
    const x = Math.round(hit.point.x), z = Math.round(hit.point.z);
    const id = view.biome_at(x, z, SCALE);
    const h = view.height_at(x, z, SCALE);
    ui.hoverEl.textContent =
      `${x}, ${z} — ${id >= 0 ? engine.biome2str(mcVersion, id) : 'unknown'}` +
      `${Number.isFinite(h) ? ` (y≈${Math.round(h)})` : ''}`;
  });

  // Re-tile only when the focus crosses into a different tile, never per frame. refresh()
  // walks the whole radius and every missing tile costs a gen_heights call, so running it
  // continuously during flight would stall the very thing it is meant to keep fed.
  function maybeRetile() {
    if (!view) return;
    const span = view.tile_cells * SCALE;
    const tx = Math.floor(controls.target.x / span);
    const tz = Math.floor(controls.target.z / span);
    if (lastTile && tx === lastTile.tx && tz === lastTile.tz) return;
    lastTile = { tx, tz };
    refresh(controls.target.x, controls.target.z);
  }

  controls.addEventListener('end', () => { if (shown) maybeRetile(); });

  // --- WASD / arrow-key flight (12.5) ---
  //
  // Rather than replacing OrbitControls, this translates the camera and its orbit target
  // together. Orbiting still works for looking around, the flight is just a pan along the
  // view direction, and re-tiling keeps keying off `controls.target` as it already did.
  const keys = new Set();

  addEventListener('keydown', (e) => {
    if (!shown || !FLY_KEYS.has(e.code)) return;
    // Never take keys from a form field: typing "w" or a "-" in the seed or coordinate boxes
    // must not fly the camera, and Space must still type a space.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'
              || t.isContentEditable)) return;
    keys.add(e.code);
    e.preventDefault(); // Space and the arrows would otherwise scroll the page
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  // A key held while the window loses focus never sends keyup, which would leave the camera
  // flying off forever with nothing pressed.
  addEventListener('blur', () => keys.clear());

  const move = new THREE.Vector3();

  function fly(dt) {
    if (!keys.size) return false;
    if (!flyDelta(keys, camera, dt, move)) return false;
    // Translate the camera and its orbit target together: the view slides rather than
    // rotating, so orbiting still works around wherever you flew to.
    camera.position.add(move);
    controls.target.add(move);
    return true;
  }

  let lastFrame = performance.now();

  function frame() {
    const now = performance.now();
    // Clamped: returning to a backgrounded tab yields a huge dt that would teleport the camera.
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    if (shown) {
      resize();
      if (fly(dt)) maybeRetile();
      controls.update();
      pump(FLY_BUDGET_MS);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  frame();

  return {
    // Store the load; render now if visible, else defer until shown.
    setWorld(seedText, x, z) {
      const seed = parseSeed(seedText);
      pending = { seed, x, z };
      if (shown) { apply(seed, x, z); pending = null; }
    },
    show() {
      shown = true;
      resize(true);
      if (pending) { apply(pending.seed, pending.x, pending.z); pending = null; }
    },
    hide() { shown = false; },
    setRadius(r) {
      radius = Math.max(1, Math.min(MAX_RADIUS, r | 0));
      if (shown && view) { clearMeshes(); refresh(controls.target.x, controls.target.z); }
    },
    maxRadius: MAX_RADIUS,
  };
}
