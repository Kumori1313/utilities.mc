//! Entry point (Part 7): load both WASM modules, mesh visible tiles, render.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SCALE, boot, fetchTile, parseSeed } from './engine.js';
import { Y_SCALE, buildTileMesh, disposeMesh } from './terrain.js';
import { setupEnchant } from './enchant-ui.js';
import { setupPortal } from './portal-ui.js';

const $ = (id) => document.getElementById(id);
const status = $('status');
const setStatus = (msg, cls = '') => { status.textContent = msg; status.className = cls; };

/// Tiles within this Chebyshev radius of the camera focus get meshed. This is the LOD the
/// guide calls non-optional: without a bound, panning meshes an unbounded region and the
/// tab dies. 3 -> 7x7 tiles -> a 1792-block square at scale 4.
const TILE_RADIUS = 3;

let engine, View, palette, app, view, mcVersion;
const meshes = new Map(); // "tx,tz" -> THREE.Mesh

try {
  ({ engine, View, palette, app } = await boot());
} catch (e) {
  setStatus(`failed to load WASM modules:\n${e}\n\n` +
            `Run scripts/build-all.sh first, then npm run dev.`, 'err');
  throw e;
}

mcVersion = engine.str2mc('1.21.3');
if (mcVersion < 0) { setStatus('engine does not know version 1.21.3', 'err'); throw new Error(); }

// The two calculator panels are pure form UIs over the shared `app` module. Build them
// once now — they hold no per-frame state, unlike the seed map.
setupEnchant($('view-enchant'), app);
setupPortal($('view-portal'), app);

// Tab switching. The seed map's render loop keeps running while hidden (cheap — nothing
// re-meshes), but a resize is forced when it becomes visible so the canvas isn't stale.
const views = document.querySelectorAll('.view');
const tabs = document.querySelectorAll('#tabs button');
tabs.forEach((btn) => btn.addEventListener('click', () => {
  const tab = btn.dataset.tab;
  tabs.forEach((b) => b.classList.toggle('active', b === btn));
  views.forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  if (tab === 'map') resize(true);
}));

// --- three.js scene ---------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11131a);
scene.fog = new THREE.Fog(0x11131a, 900, 2400);

const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49; // stop the camera going under the terrain

// A directional key light plus fill; without directional light the vertex colours read
// flat and slopes are invisible.
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2f3a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(-0.6, 1, 0.4);
scene.add(sun);

function resize(force = false) {
  const { clientWidth: w, clientHeight: h } = canvas;
  // While the map tab is hidden the canvas measures 0x0; skip so we don't set a 0-sized
  // (and NaN-aspect) camera. The frame loop re-resizes once it's visible again.
  if (w === 0 || h === 0) return;
  if (force || canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// --- world loading ----------------------------------------------------------
function loadWorld(seedText, centreX, centreZ) {
  const seed = parseSeed(seedText);

  if (engine.setWorld(seed, mcVersion, 0) !== 0) {
    setStatus('engine set_world failed', 'err');
    return;
  }
  if (!view) view = new View(512);
  // Rust clears its cache when the world changes. Meshes are built from that cache, so
  // they have to go too — otherwise the old seed stays on screen over the new data.
  if (view.set_world(seed, mcVersion, 0)) clearMeshes();

  refresh(centreX, centreZ);

  const span = view.tile_cells * SCALE * (2 * TILE_RADIUS + 1);
  camera.position.set(centreX + span * 0.35, 260, centreZ + span * 0.45);
  controls.target.set(centreX, 40, centreZ);
  controls.update();
}

function clearMeshes() {
  for (const m of meshes.values()) { scene.remove(m); disposeMesh(m); }
  meshes.clear();
}

/// Fetch + mesh every tile within TILE_RADIUS of a centre, and drop meshes outside it.
function refresh(centreX, centreZ) {
  const tileSpan = view.tile_cells * SCALE;
  const ctx = Math.floor(centreX / tileSpan);
  const ctz = Math.floor(centreZ / tileSpan);

  const t0 = performance.now();
  let built = 0, failed = 0;
  const wanted = new Set();

  for (let tz = ctz - TILE_RADIUS; tz <= ctz + TILE_RADIUS; tz++) {
    for (let tx = ctx - TILE_RADIUS; tx <= ctx + TILE_RADIUS; tx++) {
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

  // Evict meshes outside the radius so panning does not grow the scene without bound.
  for (const [key, mesh] of meshes) {
    if (!wanted.has(key)) { scene.remove(mesh); disposeMesh(mesh); meshes.delete(key); }
  }

  const ms = performance.now() - t0;
  setStatus(failed
    ? `${built} tiles built, ${failed} failed`
    : `${built} tiles built in ${ms.toFixed(0)} ms`, failed ? 'err' : 'ok');
  showStats();
}

function showStats() {
  const centre = controls.target;
  $('stats').innerHTML = `
    <dt>meshes</dt><dd>${meshes.size}</dd>
    <dt>cached tiles</dt><dd>${view.cached_tiles}</dd>
    <dt>cache hits</dt><dd>${view.hits}</dd>
    <dt>evictions</dt><dd>${view.evictions}</dd>
    <dt>centre</dt><dd>${Math.round(centre.x)}, ${Math.round(centre.z)}</dd>`;
}

// --- hover readout ----------------------------------------------------------
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects([...meshes.values()], false)[0];
  if (!hit) { $('hover').textContent = '—'; return; }
  const x = Math.round(hit.point.x), z = Math.round(hit.point.z);
  const id = view.biome_at(x, z, SCALE);
  const h = view.height_at(x, z, SCALE);
  $('hover').textContent =
    `${x}, ${z} — ${id >= 0 ? engine.biome2str(mcVersion, id) : 'unknown'}` +
    `${Number.isFinite(h) ? ` (y≈${Math.round(h)})` : ''}`;
});

// --- controls ---------------------------------------------------------------
$('go').addEventListener('click', () => {
  loadWorld($('seed').value, +$('cx').value | 0, +$('cz').value | 0);
});

// Re-tile when the camera has moved far enough to want new terrain.
let lastCentre = null;
controls.addEventListener('end', () => {
  const t = controls.target;
  if (!lastCentre || Math.hypot(t.x - lastCentre.x, t.z - lastCentre.z) > view.tile_cells * SCALE * 0.5) {
    lastCentre = { x: t.x, z: t.z };
    refresh(t.x, t.z);
  }
});

function frame() {
  resize();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

loadWorld('1', 0, 0);
lastCentre = { x: 0, z: 0 };
frame();
