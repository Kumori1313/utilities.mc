//! Entry point (Part 7, restructured in Part 12): load the WASM modules, wire the tab bar
//! and the calculator panels, and orchestrate the two seed-map renderers (2D default, 3D
//! toggle) over a shared engine and shared seed/coordinate inputs.

import { boot, parseSeed } from './engine.js';
import { create2D } from './map2d.js';
import { create3D } from './map3d.js';
import { setupEnchant } from './enchant-ui.js';
import { setupPortal } from './portal-ui.js';

const $ = (id) => document.getElementById(id);
const setStatus = (msg, cls = '') => { const s = $('status'); s.textContent = msg; s.className = cls; };

let engine, View, palette, app, mcVersion;
try {
  ({ engine, View, palette, app } = await boot());
} catch (e) {
  setStatus(`failed to load WASM modules:\n${e}\n\nRun scripts/build-all.sh, then npm run dev.`, 'err');
  throw e;
}

mcVersion = engine.str2mc('1.21.3');
if (mcVersion < 0) { setStatus('engine does not know version 1.21.3', 'err'); throw new Error(); }

// Calculator panels — pure form UIs over the shared `app` module.
setupEnchant($('view-enchant'), app);
setupPortal($('view-portal'), app);

// --- seed maps --------------------------------------------------------------
const ui = { setStatus, statsEl: $('stats'), hoverEl: $('hover') };
const map2d = create2D({ canvas: $('view2d'), engine, palette, mcVersion, ui });
const map3d = create3D({ canvas: $('view3d'), engine, View, palette, mcVersion, ui });

// Both renderers share the engine's single generator, so seed it once here, then hand the
// same world to each. Each renders if visible and defers if hidden.
function loadWorld(seedText, x, z) {
  const seed = parseSeed(seedText);
  if (engine.setWorld(seed, mcVersion, 0) !== 0) { setStatus('engine set_world failed', 'err'); return; }
  map2d.setWorld(seedText, x, z);
  map3d.setWorld(seedText, x, z);
}

// Render distance (3D). JS holds the source of truth: a range input laid out while
// display:none can corrupt its own `value` property to its max, so we never read the
// slider to seed state — we write this value into it once it is visible.
let renderRadius = 3;
function syncRdist() {
  const rdist = $('rdist');
  rdist.max = String(map3d.maxRadius);
  rdist.value = String(renderRadius);
  $('rdist-val').textContent = renderRadius;
}

let mapMode = '2d';
function setMode(mode) {
  mapMode = mode;
  $('view2d').classList.toggle('hidden', mode !== '2d');
  $('view3d').classList.toggle('hidden', mode !== '3d');
  $('rdist-wrap').classList.toggle('hidden', mode !== '3d');
  $('map2d-hint').classList.toggle('hidden', mode !== '2d');
  $('map3d-hint').classList.toggle('hidden', mode !== '3d');
  document.querySelectorAll('#map-mode button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === '2d') { map3d.hide(); map2d.show(); }
  else {
    map2d.hide();
    map3d.show();
    syncRdist(); // write the known radius into the now-visible slider
  }
}

// --- controls ---------------------------------------------------------------
$('go').addEventListener('click', () => loadWorld($('seed').value, +$('cx').value | 0, +$('cz').value | 0));

document.querySelectorAll('#map-mode button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)));

// Dragging the slider is the one time the input is the source of truth (it is visible and
// user-driven); mirror it into renderRadius and apply it.
$('rdist').addEventListener('input', (e) => {
  renderRadius = +e.target.value;
  $('rdist-val').textContent = renderRadius;
  map3d.setRadius(renderRadius);
});

// The 2D canvas has no self-driven loop, so redraw it on window resize when it's active.
window.addEventListener('resize', () => { if (mapMode === '2d') map2d.redraw(); });

// Tab switching. Returning to the map re-shows the active renderer (resize / redraw).
const views = document.querySelectorAll('.view');
document.querySelectorAll('#tabs button').forEach((btn) => btn.addEventListener('click', () => {
  const tab = btn.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  views.forEach((v) => v.classList.toggle('active', v.id === `view-${tab}`));
  if (tab === 'map') (mapMode === '2d' ? map2d : map3d).show();
}));

// --- go ---------------------------------------------------------------------
// Seed the engine first, then show the default (2D) view so its first draw has a world.
loadWorld('1', 0, 0);
setMode('2d');
