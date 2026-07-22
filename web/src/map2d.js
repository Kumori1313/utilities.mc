//! 2D biome map (Part 12.2) — the default seed-map view.
//!
//! A top-down biome image: for the visible area it makes one `gen_biomes` call at a scale
//! chosen from the zoom level, colours each cell with Cubiomes' palette, and blits it. No
//! heights (that path is scale-4 only), no Three.js — just a 2D canvas. Faster than the 3D
//! mesh and the right default.
//!
//! It relies on the engine's global generator already being seeded (the orchestrator calls
//! `engine.setWorld` before `setWorld` here). Navigation is drag-to-pan (12.3) plus
//! zoom-toward-the-cursor. Structure markers (12.4) are drawn over the biome image.

import { STRUCTURE_TYPES } from './structures.js';

const DIM_LABEL = { 0: '2D', [-1]: 'Nether', 1: 'End' };

// Zoom is a continuous blocks-per-pixel value, not a ladder of fixed stops. The wheel scales
// it exponentially, so one notch is the same ratio at every level and a trackpad's many small
// deltas come through proportionally. The Cubiomes generation scale is *derived* from it
// rather than chosen alongside it — which is what removes the old jump-a-whole-octave-per-
// notch feel, where a single click went 16 -> 64 -> 256.
//
// The zoom range is still carried by `scale`, NOT by shrinking cellPx: cell count is
// canvasArea/cellPx², so a small cellPx when zoomed out is what tanks performance. Picking
// the finest scale whose cells still cover MIN_CELL_PX screen pixels bounds the work at every
// zoom automatically — including scale 1 (Voronoi, 16x the cells), which therefore cannot
// cover a large area. Within a scale band, zooming in grows cellPx (blockier) until the band
// flips to the finer scale and it snaps back — the usual LOD trade, and the reason the bands
// are 4x apart rather than 2x.
const SCALES = [1, 4, 16, 64, 256];
const MIN_CELL_PX = 3;
const MIN_BPP = 1 / 16; // furthest in: 16 screen px per block
const MAX_BPP = 64; // furthest out: scale 256 at 4 px/cell, ~120k blocks across a 1080p window
const DEFAULT_BPP = 1; // regional — the same view the old default stop gave

// One mouse notch (deltaY ~100 in pixel mode) changes zoom by this ratio: four notches per
// doubling, versus the old one-notch-per-doubling.
const ZOOM_K = Math.log(2 ** (1 / 4)) / 100;

// Hard ceiling on cells generated per redraw, independent of zoom — defends against very
// large (4K/8K) canvases where even MIN_CELL_PX would ask for millions of samples. Exceeding
// it drops to a coarser generation scale rather than generating an unbounded amount.
const MAX_CELLS = 400_000;

// --- tiling -----------------------------------------------------------------------------
//
// The renderer used to regenerate the entire visible grid on every redraw. That is what made
// panning and zooming feel heavy: measured against this engine, a full-screen 481x271 grid
// costs ~277 ms at scale 4 (and ~500 ms at scale 256), so every drag frame was paying for a
// whole screen of biome generation.
//
// Generation is now split into fixed world-aligned tiles that are cached once and re-blitted
// thereafter, so a pan only generates the tiles it newly exposes. It is caching that wins
// here, not batching: measured cost is ~2.1 us/cell and flat across batch sizes from 256 to
// 65,536 cells, so one big call is no cheaper per cell than many small ones.
//
// 32 cells/tile is chosen for latency, not throughput — since per-cell cost is flat, the only
// thing tile size controls is the size of a single hitch. A 32x32 tile is ~2 ms; a 64x64 one
// would be ~8.6 ms, past a frame budget on its own.
const TILE_CELLS = 32;

// Tiles kept before least-recently-used eviction. 1024 tiles is ~4 MB of ids plus their small
// canvases, and comfortably exceeds a 4K screenful at any zoom so panning back and forth
// inside a region never thrashes.
const MAX_TILES = 1024;

// Per-frame generation budget. Missing tiles beyond this are left for the next frame, so a
// cold view fills in progressively instead of blocking on a few hundred milliseconds of work.
const FRAME_BUDGET_MS = 8;

// Separate, smaller budget for structure scanning, which is a different cost curve entirely
// (a biome viability check per region, not per cell) and must not starve tile generation.
const STRUCT_BUDGET_MS = 4;

/// Widest zoom that still draws slime chunks, as blocks-per-pixel. The limit is legibility,
/// not cost — filling 518,400 chunks measures at under 1 ms, so the whole overlay is
/// effectively free. But a chunk is 16 blocks, so at bpp 4 it is already down to 4 screen
/// pixels, and any further out the 10%-of-chunks pattern washes into flat noise that says
/// nothing.
const SLIME_MAX_BPP = 4;

/// Chunk edge in blocks. Slime chunks are a chunk-grid property, not a biome one.
const CHUNK = 16;

/// Default draw height, in block y. Keeps the map a surface map unless asked otherwise.
export const SEA_LEVEL = 63;

/// Legal build range for 1.18+. Older versions have a 0..255 world, but their biomes are 2D
/// and ignore y entirely, so the control is hidden there rather than clamped to a narrower
/// range that would imply it does something.
export const MIN_DEPTH = -64;
export const MAX_DEPTH = 320;

/// Whether a depth control does anything at all for this world. Overworld biomes only became
/// three-dimensional in 1.18; before that, and in both other dimensions at the scales this map
/// generates, y is ignored and a slider would be a control that silently changes nothing.
/// Measured, not assumed: at seed 1 in a land area, moving y from 63 to -16 changes 458 of 4096
/// cells on 1.18+ Overworld and exactly 0 cells on 1.17, in the Nether, and in the End.
export function depthMatters(engine, version, dim) {
  return dim === 0 && version >= engine.str2mc('1.18');
}

/// Tile cache key. Exported only so it can be tested without a DOM: it is the single line where
/// this map can grow the cache bug it has hit before, where a cached tile from one world (or
/// scale, or depth) is served for another and looks entirely correct on screen.
///
/// Everything that changes what a tile CONTAINS must appear here. Seed, version and dimension
/// are absent deliberately — those clear the whole cache in `setWorld` instead, because they
/// invalidate every entry rather than partitioning it.
export function tileCacheKey(scale, tx, tz, depthY) {
  return `${scale}:${tx}:${tz}:${depthY}`;
}

export function create2D({ canvas, engine, palette, mcVersion: initialVersion, ui, structures }) {
  const ctx = canvas.getContext('2d');
  const markerColor = new Map(STRUCTURE_TYPES.map((t) => [t.id, t.color]));
  const markerLabel = new Map(STRUCTURE_TYPES.map((t) => [t.id, t.label.replace(/s$/, '')]));
  let showTypes = new Set(); // structure types the user has enabled
  let markers = []; // last drawn markers, with screen positions, for hover
  let nearest = null; // { origin: {x, z}, type, targets: [{x, z, dist}] }
  let dim = 0; // Cubiomes DIM_* — only affects presentation here; generation is set globally
  // Version must be state, not a captured constructor argument: it is selectable (Part 13),
  // and a stale value here would label biomes using a different version's table.
  let mcVersion = initialVersion;
  let showSlime = false, showSpawn = false;
  let spawn = null; // world spawn, resolved once per world (getSpawn runs a real search)
  const slime = document.createElement('canvas'); // chunk-resolution scratch, scaled up crisp
  const slimeCtx = slime.getContext('2d');

  let bpp = DEFAULT_BPP; // blocks per screen pixel — the single source of truth for zoom
  let cx = 0, cz = 0; // world-block coordinate at the canvas centre
  let shown = false, dirty = true;
  let lastScale = SCALES[1]; // scale of the last draw, for hover lookups

  // Tile cache, keyed "scale:tx:tz". A Map iterates in insertion order, which is all an LRU
  // needs: re-inserting on hit moves an entry to the end, so the oldest key is always first.
  // Scale is in the key because the same tile index at another scale covers different ground
  // entirely — omitting it would serve 4x-offset data, the same trap the Rust cache calls out.
  const tiles = new Map();

  // Depth is in BLOCK y, the number a player reads off their F3 screen. The generator wants it
  // in its own vertical units, which are 1:1 only at scale 1 and 1:4 everywhere else — so the
  // conversion has to happen per draw, not once at the input. `>> 2` rather than `/ 4` because
  // it floors toward negative infinity, which is what the cell containing y=-17 requires.
  let depthY = SEA_LEVEL;
  const genY = (scale) => (scale === 1 ? depthY : depthY >> 2);

  const tileKey = (scale, tx, tz) => tileCacheKey(scale, tx, tz, depthY);

  function getTile(scale, tx, tz) {
    const key = tileKey(scale, tx, tz);
    const hit = tiles.get(key);
    if (hit === undefined) return null;
    tiles.delete(key); // re-insert to mark most-recently-used
    tiles.set(key, hit);
    return hit;
  }

  /// Generate one tile: its biome ids plus a cell-resolution canvas to blit. Returns null if
  /// the engine call fails, so a failure degrades to a blank tile rather than poisoning the
  /// cache with garbage.
  function makeTile(scale, tx, tz) {
    const n = TILE_CELLS * TILE_CELLS;
    const yArg = genY(scale);
    const ptr = engine.M._malloc(n * 4);
    const rc = engine.genBiomes(
      scale, tx * TILE_CELLS, yArg, tz * TILE_CELLS, TILE_CELLS, 1, TILE_CELLS, ptr,
    );
    if (rc !== 0) {
      engine.M._free(ptr);
      ui.setStatus(`gen_biomes failed (scale ${scale})`, 'err');
      return null;
    }
    // Copy out before any later allocation can detach the heap view.
    const ids = Int32Array.from(engine.M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + n));
    engine.M._free(ptr);

    const c = document.createElement('canvas');
    c.width = TILE_CELLS;
    c.height = TILE_CELLS;
    const cctx = c.getContext('2d');
    const img = cctx.createImageData(TILE_CELLS, TILE_CELLS);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const p = id >= 0 && id < 256 ? id * 3 : 0;
      const o = i * 4;
      d[o] = palette[p]; d[o + 1] = palette[p + 1]; d[o + 2] = palette[p + 2]; d[o + 3] = 255;
    }
    cctx.putImageData(img, 0, 0);

    const tile = { ids, canvas: c };
    tiles.set(tileKey(scale, tx, tz), tile);
    if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
    return tile;
  }

  // Finest generation scale whose cells still cover MIN_CELL_PX screen pixels and whose grid
  // fits the cell budget. Note this coarsens the *scale* rather than adjusting `bpp`, so the
  // budget guard never fights the user's zoom: the view stays exactly where they put it and
  // only the data behind it gets coarser.
  function scaleFor(w, h) {
    for (const s of SCALES) {
      const cellPx = s / bpp;
      if (cellPx < MIN_CELL_PX) continue;
      if ((Math.ceil(w / cellPx) + 1) * (Math.ceil(h / cellPx) + 1) <= MAX_CELLS) return s;
    }
    return SCALES[SCALES.length - 1];
  }

  // Screen pixel -> continuous world-block coordinate.
  function screenToWorld(mx, my) {
    return { x: cx + (mx - canvas.width / 2) * bpp, z: cz + (my - canvas.height / 2) * bpp };
  }

  /// Blit one tile, snapped to whole pixels so neighbours abut exactly.
  ///
  /// Both edges are derived from the *tile index* through one shared expression, rather than
  /// rounding an origin and adding a fractional width. Tile n's right edge and tile n+1's left
  /// edge are then the identical computation on the identical input, so they cannot disagree.
  /// Rounding `px + width` instead is equal in exact arithmetic but not bit-identical to the
  /// neighbour's `round(px_next)`, and an edge landing on .5 then splits into a 1px seam.
  function drawTile(tile, tx, tz, scale, w, h) {
    const tileBlocks = TILE_CELLS * scale;
    const edgeX = (i) => Math.round(w / 2 + (i * tileBlocks - cx) / bpp);
    const edgeZ = (i) => Math.round(h / 2 + (i * tileBlocks - cz) / bpp);
    const x0 = edgeX(tx), x1 = edgeX(tx + 1);
    const y0 = edgeZ(tz), y1 = edgeZ(tz + 1);
    ctx.drawImage(tile.canvas, 0, 0, TILE_CELLS, TILE_CELLS, x0, y0, x1 - x0, y1 - y0);
  }

  /// Relative luminance (0..1) of the biome colour at the view centre, or 0 (treat as dark)
  /// if that tile is not generated yet. Rec. 601 weights, which approximate how the eye
  /// weights the channels — a plain RGB average would call saturated green too dark.
  function centreLuma(scale) {
    const cellX = Math.floor(cx / scale), cellZ = Math.floor(cz / scale);
    const tx = Math.floor(cellX / TILE_CELLS), tz = Math.floor(cellZ / TILE_CELLS);
    const tile = tiles.get(tileKey(scale, tx, tz));
    if (!tile) return 0;
    const id = tile.ids[(cellZ - tz * TILE_CELLS) * TILE_CELLS + (cellX - tx * TILE_CELLS)];
    const p = id >= 0 && id < 256 ? id * 3 : 0;
    return (0.299 * palette[p] + 0.587 * palette[p + 1] + 0.114 * palette[p + 2]) / 255;
  }

  /// Tint slime chunks. Built as a chunk-resolution image and scaled up, the same trick the
  /// biome tiles use — one drawImage instead of a fillRect per chunk, which at a zoomed-in
  /// screenful would be tens of thousands of calls.
  function drawSlime(w, h) {
    if (!showSlime || bpp > SLIME_MAX_BPP) return;
    const c0x = Math.floor((cx - (w / 2) * bpp) / CHUNK);
    const c1x = Math.floor((cx + (w / 2) * bpp) / CHUNK);
    const c0z = Math.floor((cz - (h / 2) * bpp) / CHUNK);
    const c1z = Math.floor((cz + (h / 2) * bpp) / CHUNK);
    const sw = c1x - c0x + 1, sh = c1z - c0z + 1;
    if (sw <= 0 || sh <= 0) return;

    const ptr = engine.M._malloc(sw * sh);
    if (engine.genSlimeChunks(c0x, c0z, sw, sh, ptr) !== 0) { engine.M._free(ptr); return; }
    const img = slimeCtx.createImageData(sw, sh);
    const d = img.data;
    const flags = engine.M.HEAPU8.subarray(ptr, ptr + sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      if (!flags[i]) continue;
      const o = i * 4;
      d[o] = 0x7c; d[o + 1] = 0xd9; d[o + 2] = 0x4a; d[o + 3] = 90; // translucent slime green
    }
    engine.M._free(ptr);
    slime.width = sw; slime.height = sh;
    slimeCtx.putImageData(img, 0, 0);

    // Aligned to the chunk grid, not the view centre, or the tint would drift off the chunks.
    const px = w / 2 + (c0x * CHUNK - cx) / bpp;
    const py = h / 2 + (c0z * CHUNK - cz) / bpp;
    ctx.drawImage(slime, 0, 0, sw, sh, px, py, (sw * CHUNK) / bpp, (sh * CHUNK) / bpp);
  }

  /// World spawn marker: a ringed dot, distinct from the structure markers.
  function drawSpawn(w, h) {
    if (!showSpawn || !spawn) return;
    const px = w / 2 + (spawn.x - cx) / bpp;
    const py = h / 2 + (spawn.z - cz) / bpp;
    ctx.lineWidth = 3; ctx.strokeStyle = '#000000aa';
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  /// Overlay structure markers for the enabled types. Scanning shares the frame budget with
  /// tile generation, and unscanned ground schedules another frame rather than stalling this
  /// one — the same progressive fill the tiles use.
  function drawMarkers(w, h) {
    markers = [];
    if (showTypes.size === 0 || !structures.enabledAt(w * bpp)) return;

    const x0 = Math.floor(cx - (w / 2) * bpp), x1 = Math.ceil(cx + (w / 2) * bpp);
    const z0 = Math.floor(cz - (h / 2) * bpp), z1 = Math.ceil(cz + (h / 2) * bpp);
    const { found, pending } = structures.inBox(x0, z0, x1, z1, [...showTypes], STRUCT_BUDGET_MS);

    for (const s of found) {
      const px = w / 2 + (s.x - cx) / bpp;
      const py = h / 2 + (s.z - cz) / bpp;
      markers.push({ ...s, px, py });
      // Dark outline so the marker reads against any biome colour underneath.
      ctx.beginPath();
      ctx.arc(px, py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = markerColor.get(s.type) ?? '#fff';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#000000cc';
      ctx.stroke();
    }
    if (pending > 0) scheduleDraw();
  }

  /// Point where the segment origin->target leaves the canvas (inset by `m`), or the target
  /// itself when already inside. An off-screen target can then still report its distance at
  /// the edge, instead of being labelled far outside the canvas where nothing is drawn.
  function clampToView(x0, y0, x1, y1, w, h, m) {
    if (x1 >= m && x1 <= w - m && y1 >= m && y1 <= h - m) return [x1, y1];
    const dx = x1 - x0, dy = y1 - y0;
    let t = 1;
    const lim = (num, den) => {
      if (den === 0) return;
      const s = num / den;
      if (s >= 0) t = Math.min(t, s);
    };
    if (x1 < m) lim(m - x0, dx);
    if (x1 > w - m) lim(w - m - x0, dx);
    if (y1 < m) lim(m - y0, dy);
    if (y1 > h - m) lim(h - m - y0, dy);
    return [x0 + dx * t, y0 + dy * t];
  }

  /// Lines from the search origin to each nearest-N target.
  ///
  /// Anchored to the origin the search actually used, NOT the current view centre. The
  /// targets are "nearest to that point"; re-drawing them from a centre the user has since
  /// panned would depict a relationship that was never computed.
  function drawNearest(w, h) {
    if (!nearest || nearest.targets.length === 0) return;
    const ox = w / 2 + (nearest.origin.x - cx) / bpp;
    const oy = h / 2 + (nearest.origin.z - cz) / bpp;
    const color = markerColor.get(nearest.type) ?? '#ffffff';

    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of nearest.targets) {
      const tx = w / 2 + (t.x - cx) / bpp;
      const ty = h / 2 + (t.z - cz) / bpp;

      // Dark under-stroke first so the line survives a light biome underneath.
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000000aa';
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.setLineDash([]);

      // Ring the target so it reads even when that type's marker layer is switched off.
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#000000aa';
      ctx.beginPath(); ctx.arc(tx, ty, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.arc(tx, ty, 7, 0, Math.PI * 2); ctx.stroke();

      const [lx, ly] = clampToView(ox, oy, tx, ty, w, h, 24);
      const label = `${Math.round(t.dist).toLocaleString()}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000000cc';
      ctx.strokeText(label, lx, ly - 12);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, lx, ly - 12);
    }
    ctx.restore();
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return; // hidden
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;

    const scale = scaleFor(w, h);
    lastScale = scale;
    const cellPx = scale / bpp; // fractional; drawImage scales the tile image to suit
    const tileBlocks = TILE_CELLS * scale;

    // Tile range covering the viewport. Screen x of a tile's left edge is
    // w/2 + (tileBlockX - cx) / bpp, so invert that at the two screen edges.
    const t0x = Math.floor((cx - (w / 2) * bpp) / tileBlocks);
    const t1x = Math.floor((cx + (w / 2) * bpp) / tileBlocks);
    const t0z = Math.floor((cz - (h / 2) * bpp) / tileBlocks);
    const t1z = Math.floor((cz + (h / 2) * bpp) / tileBlocks);

    ctx.clearRect(0, 0, w, h);
    const missing = [];
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const tile = getTile(scale, tx, tz);
        if (tile) drawTile(tile, tx, tz, scale, w, h);
        // Queue by distance from the view centre so the middle of the screen fills first.
        else missing.push({ tx, tz, d: Math.abs(tx - (t0x + t1x) / 2) + Math.abs(tz - (t0z + t1z) / 2) });
      }
    }

    // Fill what the frame budget allows; anything left over comes in on later frames.
    let generated = 0;
    if (missing.length) {
      missing.sort((a, b) => a.d - b.d);
      const started = performance.now();
      for (const m of missing) {
        if (performance.now() - started > FRAME_BUDGET_MS) break;
        const tile = makeTile(scale, m.tx, m.tz);
        generated++;
        if (tile) drawTile(tile, m.tx, m.tz, scale, w, h);
      }
      if (generated < missing.length) scheduleDraw(); // keep filling next frame
    }

    drawSlime(w, h); // under the markers: it is a background property of the chunk grid
    drawMarkers(w, h);
    drawNearest(w, h);
    drawSpawn(w, h);

    // Centre crosshair, so the coordinate readout has a visible anchor. Its colour adapts to
    // the biome underneath — a white cross disappears on snow and ice, a dark one on deep
    // ocean — and it carries a halo in the opposite tone so it survives the mid-tones too.
    // The luma comes from the cached tile rather than a getImageData readback, which would
    // stall the pipeline every frame for a single pixel.
    const light = centreLuma(scale) > 0.55;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 6, h / 2); ctx.lineTo(w / 2 + 6, h / 2);
    ctx.moveTo(w / 2, h / 2 - 6); ctx.lineTo(w / 2, h / 2 + 6);
    ctx.lineWidth = 3;
    ctx.strokeStyle = light ? '#ffffffcc' : '#000000aa';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = light ? '#000000' : '#ffffff';
    ctx.stroke();

    const pending = missing.length - generated;
    // In the Nether one block is eight Overworld blocks, so the same view covers eight times
    // the ground and a raw coordinate is not the one a player needs. Show the Overworld
    // equivalent alongside it — the ratio Part 11's converter already encodes.
    const equiv = dim === -1 ? ` (overworld ${Math.round(cx * 8)}, ${Math.round(cz * 8)})` : '';
    // Show the depth only when it is off the surface, so the common case stays uncluttered but
    // a cave layer can never be mistaken for a surface map.
    const deep = depthMatters(engine, mcVersion, dim) && depthY !== SEA_LEVEL
      ? ` · y ${depthY}` : '';
    ui.setStatus(
      `${DIM_LABEL[dim] ?? '2D'} · scale ${scale} · ${Math.round(w * bpp)} blocks across · ` +
        `centre ${Math.round(cx)}, ${Math.round(cz)}${equiv}${deep}` +
        (pending > 0 ? ` · loading ${pending}` : ''),
      'ok',
    );
    dirty = false;
  }

  // --- drag to pan (12.3) ---------------------------------------------------------------
  // Pointer deltas are converted with `bpp` read fresh on every move, never captured at drag
  // start: a captured value would feel right at one zoom only, and would be wrong outright if
  // the wheel fires mid-drag.
  //
  // Moves are coalesced to one redraw per animation frame: pointermove can fire several times
  // per frame, and each redraw re-blits every visible tile (and may generate newly exposed
  // ones), so drawing per event would repeat that work with nothing to show for it.
  let dragging = false, lastX = 0, lastY = 0, raf = 0;

  function scheduleDraw() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!shown || e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId); // keep panning if the cursor leaves the canvas
    canvas.classList.add('grabbing');
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove('grabbing');
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('pointermove', (e) => {
    if (!shown) return;
    if (dragging) {
      // Drag the map right => look further west, so the centre moves against the pointer.
      cx -= (e.clientX - lastX) * bpp;
      cz -= (e.clientY - lastY) * bpp;
      lastX = e.clientX;
      lastY = e.clientY;
      scheduleDraw();
      return; // skip hover: the readout would lag a frame behind the pan anyway
    }
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    // A marker under the cursor wins over the biome readout — it is the more specific answer,
    // and it is the only way to read a structure's exact coordinate.
    let near = null, nearD = 10; // px
    for (const m of markers) {
      const d = Math.hypot(m.px - mx, m.py - my);
      if (d < nearD) { nearD = d; near = m; }
    }
    if (near) {
      ui.hoverEl.textContent = `${markerLabel.get(near.type) ?? near.type} — ${near.x}, ${near.z}`;
      return;
    }

    const { x: wx, z: wz } = screenToWorld(mx, my);
    const scale = lastScale;
    const cellX = Math.floor(wx / scale), cellZ = Math.floor(wz / scale);
    const tx = Math.floor(cellX / TILE_CELLS), tz = Math.floor(cellZ / TILE_CELLS);
    // Peek rather than getTile: hovering should not reorder the LRU.
    const tile = tiles.get(tileKey(scale, tx, tz));
    if (!tile) { ui.hoverEl.textContent = '—'; return; } // not generated yet
    const id = tile.ids[(cellZ - tz * TILE_CELLS) * TILE_CELLS + (cellX - tx * TILE_CELLS)];
    ui.hoverEl.textContent =
      `${cellX * scale}, ${cellZ * scale} — ${id >= 0 ? engine.biome2str(mcVersion, id) : 'unknown'}`;
  });

  // Scroll to zoom, anchored on the cursor — the world point under the pointer stays put.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!shown) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    // Normalise the delta: Firefox reports lines (deltaMode 1), not pixels, so a raw deltaY
    // would zoom ~16x too slowly there. Pages (deltaMode 2) are rarer but just as wrong.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const next = Math.min(MAX_BPP, Math.max(MIN_BPP, bpp * Math.exp(dy * ZOOM_K)));
    if (next === bpp) return; // already clamped at a limit
    const before = screenToWorld(mx, my);
    bpp = next;
    cx = before.x - (mx - canvas.width / 2) * bpp;
    cz = before.z - (my - canvas.height / 2) * bpp;
    scheduleDraw(); // a trackpad fires many events per frame; coalesce as the drag does
  }, { passive: false });

  return {
    setWorld(_seedText, x, z, newDim = 0, newVersion = mcVersion) {
      // Every cached tile was generated under the previous seed/version. Serving one after a
      // world change is a silent wrong-biome bug that looks exactly like correct output, so
      // the cache is dropped wholesale — the same rule the Rust tile cache enforces.
      tiles.clear();
      structures.setWorld(); // same rule: a structure list from the old world looks correct
      nearest = null; // targets from the previous world would draw just as convincingly
      dim = newDim;
      mcVersion = newVersion;
      // Resolve spawn once per world: getSpawn runs a search (2-7 ms), not a lookup, so it
      // must not be called per frame. Overworld only — the engine refuses otherwise.
      spawn = null;
      if (dim === 0) {
        const p = engine.M._malloc(8);
        if (engine.worldSpawn(p) === 0) {
          spawn = { x: engine.M.HEAP32[p >> 2], z: engine.M.HEAP32[(p >> 2) + 1] };
        }
        engine.M._free(p);
      }
      cx = x; cz = z;
      dirty = true;
      if (shown) draw();
    },
    /// Draw height, in block y. Clamped to the legal build range. Returns the value actually
    /// used, so the caller can reflect a clamp back into its input rather than letting the two
    /// disagree.
    setDepth(y) {
      const next = Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, Math.round(y) || 0));
      if (next === depthY) return next;
      depthY = next;
      // Not strictly required — depth is in the tile key, so old tiles could simply age out of
      // the LRU. Cleared anyway because leaving them means every depth the user scrubs through
      // stays resident, and a 1024-entry cache full of one seed's depth layers evicts the tiles
      // actually on screen.
      tiles.clear();
      dirty = true;
      if (shown) draw();
      return next;
    },
    depth() {
      return depthY;
    },
    /// Toggle the non-structure overlays. Returns nothing; re-renders if visible.
    setLayers({ slimeChunks, worldSpawn }) {
      showSlime = !!slimeChunks;
      showSpawn = !!worldSpawn;
      if (shown) draw();
    },
    /// Whether slime chunks are legible at the current zoom, for the UI to explain itself.
    slimeVisible() {
      return bpp <= SLIME_MAX_BPP;
    },
    spawnPos() {
      return spawn;
    },
    /// Which structure types to overlay. Re-renders immediately.
    setStructureTypes(set) {
      showTypes = new Set(set);
      if (shown) draw();
    },
    /// World-block coordinate at the view centre — the origin a nearest-search runs from.
    centre() {
      return { x: cx, z: cz };
    },
    /// Show (or clear, with null) the result of a nearest-structure search.
    setNearest(result) {
      nearest = result;
      if (shown) draw();
    },
    show() {
      shown = true;
      if (dirty) draw();
    },
    /// Force a redraw. `show()` deliberately only draws when dirty, so it cannot serve a
    /// resize: the canvas backing store is sized from the client box inside `draw()`, and
    /// without this the map stays at its old pixel size until some other interaction.
    redraw() {
      if (shown) draw();
      else dirty = true; // hidden: clientWidth is 0, so defer to the next show()
    },
    hide() { shown = false; },
  };
}
