//! Entry point (Part 7, restructured in Part 12): load the WASM modules, wire the tab bar
//! and the calculator panels, and orchestrate the two seed-map renderers (2D default, 3D
//! toggle) over a shared engine and shared seed/coordinate inputs.

import { boot, parseSeed } from './engine.js';
import { create2D } from './map2d.js';
import { create3D } from './map3d.js';
import { setupEnchant } from './enchant-ui.js';
import { setupPortal } from './portal-ui.js';
import { createStructures, STRUCTURE_TYPES, DIMENSIONS } from './structures.js';
import { buildVersions } from './versions.js';

const $ = (id) => document.getElementById(id);
const setStatus = (msg, cls = '') => { const s = $('status'); s.textContent = msg; s.className = cls; };

let engine, View, palette, app, mcVersion;
try {
  ({ engine, View, palette, app } = await boot());
} catch (e) {
  setStatus(`failed to load WASM modules:\n${e}\n\nRun scripts/build-all.sh, then npm run dev.`, 'err');
  throw e;
}

// --- version registry (Part 13) ---
//
// Built in versions.js, entirely from the engine — see there for why the labels need fixing up.
// The floor is 13.0's agreed scope (1.8.9, exactly the MC_1_8_9 entry); the ceiling is whatever
// this build knows.
//
// Per-tool, not global (13.1): the map offers all of these, while the enchant calculator is
// pinned to the single version its data tables encode. Presenting one selector for both would
// claim a parity that does not exist.
const MAP_DEFAULT_VERSION = '1.21.3';
let VERSIONS;
try {
  ({ versions: VERSIONS } = buildVersions(engine));
} catch (e) {
  setStatus(`${e.message} — cannot build a version list`, 'err');
  throw e;
}
mcVersion = engine.str2mc(MAP_DEFAULT_VERSION);
if (mcVersion < 0) { setStatus(`engine does not know version ${MAP_DEFAULT_VERSION}`, 'err'); throw new Error(); }

// Calculator panels — pure form UIs over the shared `app` module.
setupEnchant($('view-enchant'), app);
setupPortal($('view-portal'), app);

// --- seed maps --------------------------------------------------------------
const ui = { setStatus, statsEl: $('stats'), hoverEl: $('hover') };
const structures = createStructures(engine);
const map2d = create2D({ canvas: $('view2d'), engine, palette, mcVersion, ui, structures });
const map3d = create3D({ canvas: $('view3d'), engine, View, palette, mcVersion, ui });

// Dimension (Part 14). The 2D map generates all three; the 3D view cannot, because Cubiomes'
// mapApproxHeight has no height model outside the Overworld and gen_heights returns -1 there.
$('dim').innerHTML = DIMENSIONS.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
// Labels are the precise top of each entry; the range it covers goes in the hint, because one
// entry serves a span of releases and "1.16.5" alone does not tell a 1.16.3 player it is theirs.
$('ver').innerHTML = VERSIONS.map((v) =>
  `<option value="${v.id}"${v.id === mcVersion ? ' selected' : ''} title="covers ${v.covers}">${v.label}</option>`).join('');
const showCovers = () => {
  const v = VERSIONS.find((x) => x.id === mcVersion);
  $('ver-covers').textContent = v && v.covers !== v.label ? ` Selected: covers ${v.covers}.` : '';
};
showCovers();
$('ver').addEventListener('change', () => {
  mcVersion = +$('ver').value | 0;
  showCovers();
  // Structure availability is version-dependent (1.8 knows 8 types, 1.21.3 knows 24), and the
  // engine is the authority on that — but it can only answer for a world already loaded, so
  // the list is rebuilt after the reload rather than before.
  submit();
  renderStructureList();
});
let dim = 0;
const dimName = () => DIMENSIONS.find((d) => d.id === dim).name;

// Both renderers share the engine's single generator, so seed it once here, then hand the
// same world to each. Each renders if visible and defers if hidden.
//
// Landmine (14.1): four separate caches key on the world — the C generator here, the Rust
// View inside map3d, and the 2D map's own tile and structure caches. Every one must be told,
// or tiles generated in the previous dimension stay on screen looking entirely correct.
// map2d.setWorld clears its two; map3d.setWorld resets the View.
function loadWorld(seedText, x, z) {
  const seed = parseSeed(seedText);
  if (engine.setWorld(seed, mcVersion, dim) !== 0) {
    setStatus(`engine set_world failed (dimension ${dim})`, 'err');
    return;
  }
  map2d.setWorld(seedText, x, z, dim, mcVersion);
  map3d.setWorld(seedText, x, z, dim, mcVersion);
  syncLayers(); // spawn is resolved per world, and the layers are Overworld-only
}

$('dim').addEventListener('change', () => {
  dim = +$('dim').value | 0;
  // Structure types are per-dimension, so the list has to be rebuilt before reloading.
  renderStructureList();
  syncLayers();
  if (dim !== 0 && mapMode === '3d') setMode('2d'); // 3D has no terrain outside the Overworld
  syncModeAvailability();
  submit();
});

// Structure overlay (2D only — the 3D view has no marker path). Village, monument, mansion and
// stronghold are confirmed against Chunkbase on seed 1 / 1.21.3; the rest are pending. All
// start off, so a first load pays no scan cost.
//
// Only the current dimension's types are offered: gen_structures refuses a mismatch, so
// listing the others would give the user a checkbox that finds nothing and says nothing.
function typesHere() {
  // The engine decides: it knows which version introduced each type and which dimension it
  // belongs to. Asking it beats keeping a table here that would need updating twice — once per
  // new type and once per Cubiomes bump.
  return STRUCTURE_TYPES.filter((t) => engine.structureSupported(t.id) === 1);
}
function renderStructureList() {
  const types = typesHere();
  // The End currently offers none — its structures are withheld pending verification (see
  // structures.js). Say so rather than showing an empty box that reads as a bug.
  $('struct-list').innerHTML = types.length
    ? types.map((t) =>
        `<label class="chk"><input type="checkbox" data-struct="${t.id}">` +
        `<span class="swatch" style="background:${t.color}"></span>${t.label}</label>`).join('')
    : '<span class="hint">none available for this dimension yet</span>';
  $('loc-type').innerHTML = types.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
  $('structs').querySelector('.locate').classList.toggle('hidden', types.length === 0);
  // Selections and any drawn search belong to the old dimension's types.
  map2d.setStructureTypes([]);
  map2d.setNearest(null);
  $('loc-out').textContent = '';
  syncStructures();
}
function syncStructures() {
  const on = [...document.querySelectorAll('#struct-list input:checked')].map((i) => i.dataset.struct);
  map2d.setStructureTypes(on);
  $('struct-hint').textContent = on.length
    ? `shown under ${structures.maxBlocksAcross.toLocaleString()} blocks wide · positions pass ` +
      `the biome rule, so a small fraction may not generate`
    : '';
}
$('struct-list').addEventListener('change', syncStructures);

// Non-structure overlays. Both are Overworld-only: slimes spawn there, and world spawn is an
// Overworld concept the engine refuses to answer elsewhere.
function syncLayers() {
  const slimeChunks = $('lay-slime').checked && dim === 0;
  const worldSpawn = $('lay-spawn').checked && dim === 0;
  map2d.setLayers({ slimeChunks, worldSpawn });
  const notes = [];
  if (dim !== 0 && ($('lay-slime').checked || $('lay-spawn').checked)) {
    notes.push('Overworld only');
  } else {
    // Stated unconditionally rather than only while hidden: nothing notifies this code when
    // the zoom changes, so a "zoom in to see them" that appears and disappears would go stale
    // the moment the user scrolled.
    if (slimeChunks) notes.push('slime chunks show when zoomed in');
    const sp = map2d.spawnPos();
    if (worldSpawn && sp) notes.push(`spawn at ${sp.x}, ${sp.z}`);
  }
  $('layer-hint').textContent = notes.join(' · ');
}
$('layer-list').addEventListener('change', syncLayers);

// Nearest-structure locator. Run on demand rather than continuously: the search is anchored
// to the centre at the moment it runs, so recomputing while panning would re-target the lines
// under the user's hand. Its type list is populated by renderStructureList(), per dimension.
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

// The 3D view is Overworld-only and always will be: gen_heights returns -1 for the Nether and
// the End because Cubiomes has no height model there. Disable the toggle and say why, rather
// than switching to a view that would render nothing (14.4).
function syncModeAvailability() {
  const btn = document.querySelector('#map-mode button[data-mode="3d"]');
  const ok = dim === 0;
  btn.disabled = !ok;
  btn.title = ok ? '' : 'The 3D view is Overworld-only — no terrain height model exists for this dimension';
}

document.querySelectorAll('#map-mode button').forEach((b) =>
  b.addEventListener('click', () => { if (!b.disabled) setMode(b.dataset.mode); }));

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
renderStructureList();
syncModeAvailability();
loadWorld('1', 0, 0);
setMode('2d');
