//! 3D seed map (Parts 6–7, extracted from main.js in Part 12).
//!
//! The rendering logic is unchanged from Part 7 — this only wraps it so the 2D map can be
//! the default and the 3D view initialises lazily. It runs its own render loop, gated on
//! being visible so a hidden 3D view costs nothing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SCALE, fetchTile, parseSeed } from './engine.js';
import { buildTileMesh, disposeMesh } from './terrain.js';

/// Tiles within this Chebyshev radius of the camera focus get meshed. Adjustable now
/// (Part 12.1); the LRU cache capacity below must stay above (2r+1)^2 at the max radius.
const DEFAULT_RADIUS = 3;
const MAX_RADIUS = 8; // (2*8+1)^2 = 289 tiles < cache capacity 512

export function create3D({ canvas, engine, View, palette, mcVersion, ui }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11131a);
  scene.fog = new THREE.Fog(0x11131a, 900, 2400);

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
  let lastCentre = null;
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

  // Fetch + mesh every tile within `radius` of a centre, dropping meshes outside it.
  function refresh(centreX, centreZ) {
    const tileSpan = view.tile_cells * SCALE;
    const ctx = Math.floor(centreX / tileSpan);
    const ctz = Math.floor(centreZ / tileSpan);

    const t0 = performance.now();
    let built = 0, failed = 0;
    const wanted = new Set();

    for (let tz = ctz - radius; tz <= ctz + radius; tz++) {
      for (let tx = ctx - radius; tx <= ctx + radius; tx++) {
        const key = `${tx},${tz}`;
        wanted.add(key);
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
    }

    for (const [key, mesh] of meshes) {
      if (!wanted.has(key)) { scene.remove(mesh); disposeMesh(mesh); meshes.delete(key); }
    }

    const ms = performance.now() - t0;
    ui.setStatus(failed
      ? `${built} tiles built, ${failed} failed`
      : `${built} tiles built in ${ms.toFixed(0)} ms`, failed ? 'err' : 'ok');
    showStats();
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
    const span = view.tile_cells * SCALE * (2 * radius + 1);
    camera.position.set(centreX + span * 0.35, 260, centreZ + span * 0.45);
    controls.target.set(centreX, 40, centreZ);
    controls.update();
    lastCentre = { x: centreX, z: centreZ };
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

  // Re-tile when the orbit target has moved far enough to want new terrain.
  controls.addEventListener('end', () => {
    if (!shown || !view) return;
    const t = controls.target;
    if (!lastCentre || Math.hypot(t.x - lastCentre.x, t.z - lastCentre.z) > view.tile_cells * SCALE * 0.5) {
      lastCentre = { x: t.x, z: t.z };
      refresh(t.x, t.z);
    }
  });

  function frame() {
    if (shown) {
      resize();
      controls.update();
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
