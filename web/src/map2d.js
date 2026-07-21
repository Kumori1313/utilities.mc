//! 2D biome map (Part 12.2) — the default seed-map view.
//!
//! A top-down biome image: for the visible area it makes one `gen_biomes` call at a scale
//! chosen from the zoom level, colours each cell with Cubiomes' palette, and blits it. No
//! heights (that path is scale-4 only), no Three.js — just a 2D canvas. Faster than the 3D
//! mesh and the right default.
//!
//! It relies on the engine's global generator already being seeded (the orchestrator calls
//! `engine.setWorld` before `setWorld` here). Navigation is drag-to-pan (12.3) plus
//! zoom-toward-the-cursor.

// Zoom stops, coarsest → finest. `scale` is the Cubiomes generation scale (cell = `scale`
// blocks); `cellPx` is screen pixels per cell. blocks-per-pixel = scale / cellPx.
//
// The zoom range is carried by `scale`, NOT by shrinking `cellPx` — cell count is
// canvasArea/cellPx², so a small cellPx when zoomed out is what tanks performance. Keeping
// cellPx >= 4 bounds the work at every level; scale 256 at cellPx 4 already shows ~90k
// blocks across a normal window, which is the practical zoom-out cap. Scale 1 (Voronoi,
// 16x the cells) stays at the two finest stops so it never covers a large area.
const STOPS = [
  { scale: 256, cellPx: 4 }, // continents — the zoom-out limit
  { scale: 256, cellPx: 8 },
  { scale: 64, cellPx: 4 },
  { scale: 64, cellPx: 8 },
  { scale: 16, cellPx: 4 },
  { scale: 16, cellPx: 8 },
  { scale: 4, cellPx: 4 }, // default — regional
  { scale: 4, cellPx: 8 },
  { scale: 1, cellPx: 6 }, // block-accurate
  { scale: 1, cellPx: 10 },
];
const DEFAULT_STOP = 6;

// Hard ceiling on cells generated per redraw, independent of zoom — defends against very
// large (4K/8K) canvases where even cellPx 4 would ask for millions of samples. If the
// visible grid exceeds this, the cells are drawn coarser (larger effective cellPx) rather
// than generating an unbounded amount.
const MAX_CELLS = 400_000;

export function create2D({ canvas, engine, palette, mcVersion, ui }) {
  const ctx = canvas.getContext('2d');
  const off = document.createElement('canvas'); // cell-resolution scratch, scaled up crisp
  const offCtx = off.getContext('2d');

  let stop = DEFAULT_STOP;
  let cx = 0, cz = 0; // world-block coordinate at the canvas centre
  let shown = false, dirty = true;
  let grid = null; // last drawn grid, for hover lookups

  // Effective pixels-per-cell at the current stop, after the MAX_CELLS cap. On an oversized
  // canvas this coarsens (bigger cellPx = fewer cells) so a redraw never asks the engine for
  // an unbounded number of samples. draw(), bpp(), zoom and hover all read this same value so
  // their coordinate math stays consistent when the cap is active.
  function effCellPx(w, h) {
    let cp = STOPS[stop].cellPx;
    while ((Math.ceil(w / cp) + 1) * (Math.ceil(h / cp) + 1) > MAX_CELLS) cp *= 2;
    return cp;
  }

  const bpp = () => STOPS[stop].scale / effCellPx(canvas.width, canvas.height);

  // Screen pixel -> continuous world-block coordinate.
  function screenToWorld(mx, my) {
    return { x: cx + (mx - canvas.width / 2) * bpp(), z: cz + (my - canvas.height / 2) * bpp() };
  }

  function draw() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return; // hidden
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;

    const { scale } = STOPS[stop];
    const cellPx = effCellPx(w, h);
    const sx = Math.ceil(w / cellPx) + 1;
    const sz = Math.ceil(h / cellPx) + 1;
    const originCellX = Math.floor(cx / scale) - (sx >> 1);
    const originCellZ = Math.floor(cz / scale) - (sz >> 1);
    // A near-sea-level layer, so the overview shows surface biomes (ocean, plains, forest)
    // and not the deep cave biomes that appear near y=0. Cubiomes' vertical scaling is 1:1
    // at scale 1 and 1:4 otherwise, so the y argument differs by scale.
    const yArg = scale === 1 ? 63 : 15;

    const n = sx * sz;
    const ptr = engine.M._malloc(n * 4);
    const rc = engine.genBiomes(scale, originCellX, yArg, originCellZ, sx, 1, sz, ptr);
    if (rc !== 0) {
      engine.M._free(ptr);
      ui.setStatus(`gen_biomes failed (scale ${scale})`, 'err');
      return;
    }
    // Copy out before any later allocation can detach the heap view.
    const ids = Int32Array.from(engine.M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + n));
    engine.M._free(ptr);

    const img = offCtx.createImageData(sx, sz);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const p = id >= 0 && id < 256 ? id * 3 : 0;
      const o = i * 4;
      d[o] = palette[p]; d[o + 1] = palette[p + 1]; d[o + 2] = palette[p + 2]; d[o + 3] = 255;
    }
    off.width = sx; off.height = sz;
    offCtx.putImageData(img, 0, 0);

    // Align so world (cx, cz) lands at the canvas centre.
    const screenX = w / 2 - (cx - originCellX * scale) / bpp();
    const screenZ = h / 2 - (cz - originCellZ * scale) / bpp();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0, sx, sz, screenX, screenZ, sx * cellPx, sz * cellPx);

    // Centre crosshair, so the coordinate readout has a visible anchor.
    ctx.strokeStyle = '#ffffff88';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 6, h / 2); ctx.lineTo(w / 2 + 6, h / 2);
    ctx.moveTo(w / 2, h / 2 - 6); ctx.lineTo(w / 2, h / 2 + 6);
    ctx.stroke();

    grid = { scale, cellPx, originCellX, originCellZ, sx, sz, ids, screenX, screenZ };
    ui.setStatus(`2D · scale ${scale} · centre ${Math.round(cx)}, ${Math.round(cz)}`, 'ok');
    dirty = false;
  }

  // --- drag to pan (12.3) ---------------------------------------------------------------
  // Pointer deltas are converted with `bpp()` read fresh on every move, never captured at
  // drag start: blocks-per-pixel depends on the active zoom stop, so a captured value would
  // feel right at one zoom only and would be wrong outright if the wheel fires mid-drag.
  //
  // Moves are coalesced to one redraw per animation frame. Unlike the 3D view this renderer
  // holds no tile cache — every draw regenerates the whole visible grid — so redrawing per
  // pointermove event would run several full `gen_biomes` calls per frame.
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
      const b = bpp();
      cx -= (e.clientX - lastX) * b;
      cz -= (e.clientY - lastY) * b;
      lastX = e.clientX;
      lastY = e.clientY;
      scheduleDraw();
      return; // skip hover: `grid` still describes the pre-move frame
    }
    if (!grid) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const ix = Math.floor((mx - grid.screenX) / grid.cellPx);
    const iz = Math.floor((my - grid.screenZ) / grid.cellPx);
    if (ix < 0 || iz < 0 || ix >= grid.sx || iz >= grid.sz) { ui.hoverEl.textContent = '—'; return; }
    const id = grid.ids[iz * grid.sx + ix];
    const bx = (grid.originCellX + ix) * grid.scale;
    const bz = (grid.originCellZ + iz) * grid.scale;
    ui.hoverEl.textContent =
      `${bx}, ${bz} — ${id >= 0 ? engine.biome2str(mcVersion, id) : 'unknown'}`;
  });

  // Scroll to zoom, anchored on the cursor — the world point under the pointer stays put.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!shown) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const before = screenToWorld(mx, my);
    const next = Math.max(0, Math.min(STOPS.length - 1, stop + (e.deltaY < 0 ? 1 : -1)));
    if (next === stop) return;
    stop = next;
    cx = before.x - (mx - canvas.width / 2) * bpp();
    cz = before.z - (my - canvas.height / 2) * bpp();
    draw();
  }, { passive: false });

  return {
    setWorld(_seedText, x, z) {
      cx = x; cz = z;
      dirty = true;
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
