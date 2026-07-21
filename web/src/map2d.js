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

export function create2D({ canvas, engine, palette, mcVersion, ui, structures }) {
  const ctx = canvas.getContext('2d');
  const markerColor = new Map(STRUCTURE_TYPES.map((t) => [t.id, t.color]));
  const markerLabel = new Map(STRUCTURE_TYPES.map((t) => [t.id, t.label.replace(/s$/, '')]));
  let showTypes = new Set(); // structure types the user has enabled
  let markers = []; // last drawn markers, with screen positions, for hover

  let bpp = DEFAULT_BPP; // blocks per screen pixel — the single source of truth for zoom
  let cx = 0, cz = 0; // world-block coordinate at the canvas centre
  let shown = false, dirty = true;
  let lastScale = SCALES[1]; // scale of the last draw, for hover lookups

  // Tile cache, keyed "scale:tx:tz". A Map iterates in insertion order, which is all an LRU
  // needs: re-inserting on hit moves an entry to the end, so the oldest key is always first.
  // Scale is in the key because the same tile index at another scale covers different ground
  // entirely — omitting it would serve 4x-offset data, the same trap the Rust cache calls out.
  const tiles = new Map();

  function tileKey(scale, tx, tz) {
    return `${scale}:${tx}:${tz}`;
  }

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
    // A near-sea-level layer, so the overview shows surface biomes (ocean, plains, forest)
    // and not the deep cave biomes that appear near y=0. Cubiomes' vertical scaling is 1:1
    // at scale 1 and 1:4 otherwise, so the y argument differs by scale.
    const yArg = scale === 1 ? 63 : 15;
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

    drawMarkers(w, h);

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
    ui.setStatus(
      `2D · scale ${scale} · ${Math.round(w * bpp)} blocks across · ` +
        `centre ${Math.round(cx)}, ${Math.round(cz)}` +
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
    setWorld(_seedText, x, z) {
      // Every cached tile was generated under the previous seed/version. Serving one after a
      // world change is a silent wrong-biome bug that looks exactly like correct output, so
      // the cache is dropped wholesale — the same rule the Rust tile cache enforces.
      tiles.clear();
      structures.setWorld(); // same rule: a structure list from the old world looks correct
      cx = x; cz = z;
      dirty = true;
      if (shown) draw();
    },
    /// Which structure types to overlay. Re-renders immediately.
    setStructureTypes(set) {
      showTypes = new Set(set);
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
