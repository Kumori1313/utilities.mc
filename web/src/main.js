//! Entry point (Part 7, restructured in Part 12): load the WASM modules, wire the tab bar
//! and the calculator panels, and orchestrate the two seed-map renderers (2D default, 3D
//! toggle) over a shared engine and shared seed/coordinate inputs.

import { boot, parseSeed } from './engine.js';
import { create2D } from './map2d.js';
import { create3D } from './map3d.js';
import { setupEnchant } from './enchant-ui.js';
import { setupPortal } from './portal-ui.js';
import { createStructures, STRUCTURE_TYPES } from './structures.js';

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
const structures = createStructures(engine);
const map2d = create2D({ canvas: $('view2d'), engine, palette, mcVersion, ui, structures });
const map3d = create3D({ canvas: $('view3d'), engine, View, palette, mcVersion, ui });

// Both renderers share the engine's single generator, so seed it once here, then hand the
// same world to each. Each renders if visible and defers if hidden.
function loadWorld(seedText, x, z) {
  const seed = parseSeed(seedText);
  if (engine.setWorld(seed, mcVersion, 0) !== 0) { setStatus('engine set_world failed', 'err'); return; }
  map2d.setWorld(seedText, x, z);
  map3d.setWorld(seedText, x, z);
}

// Structure overlay (2D only for now — the 3D view has no marker path yet). All four types
// are confirmed against Chunkbase on seed 1 / 1.21.3; they start off so a first load pays no
// scan cost.
$('struct-list').innerHTML = STRUCTURE_TYPES.map((t) =>
  `<label class="chk"><input type="checkbox" data-struct="${t.id}">` +
  `<span class="swatch" style="background:${t.color}"></span>${t.label}</label>`).join('');
function syncStructures() {
  const on = [...document.querySelectorAll('#struct-list input:checked')].map((i) => i.dataset.struct);
  map2d.setStructureTypes(on);
  $('struct-hint').textContent = on.length
    ? `shown when the view is under ${structures.maxBlocksAcross.toLocaleString()} blocks wide`
    : '';
}
$('struct-list').addEventListener('change', syncStructures);

// Nearest-structure locator. Run on demand rather than continuously: the search is anchored
// to the centre at the moment it runs, so recomputing while panning would re-target the lines
// under the user's hand.
$('loc-type').innerHTML = STRUCTURE_TYPES.map((t) =>
  `<option value="${t.id}">${t.label}</option>`).join('');
$('loc-go').addEventListener('click', () => {
  const type = $('loc-type').value;
  const n = +$('loc-n').value;
  const origin = map2d.centre();
  const started = performance.now();
  const { targets, searched, truncated } =
    structures.nearest(Math.round(origin.x), Math.round(origin.z), type, n);
  const ms = Math.round(performance.now() - started);
  map2d.setNearest({ origin, type, targets });
  if (targets.length === 0) {
    $('loc-out').textContent = `none found within ${searched.toLocaleString()} blocks`;
  } else {
    const far = Math.round(targets[targets.length - 1].dist).toLocaleString();
    // "best found" rather than "nearest" when the search was cut short — the distinction is
    // the whole point of the stopping rule, so the UI must not overstate it.
    $('loc-out').textContent =
      `${targets.length} ${truncated ? 'found' : 'nearest'}, out to ${far} blocks (${ms} ms)` +
      (truncated ? ' — search truncated, may not be the nearest' : '');
  }
});
$('loc-clear').addEventListener('click', () => {
  map2d.setNearest(null);
  $('loc-out').textContent = '';
});

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
  $('structs').classList.toggle('hidden', mode !== '2d');
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
const submit = () => loadWorld($('seed').value, +$('cx').value | 0, +$('cz').value | 0);
$('go').addEventListener('click', submit);
// Enter from any of the three fields loads, so the common path never needs the mouse. These
// are bare inputs rather than a <form>, which would give this for free — hence doing it here.
for (const id of ['seed', 'cx', 'cz']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

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
