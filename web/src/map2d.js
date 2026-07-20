//! 2D biome map (Part 12.2) — the default seed-map view.
//!
//! A top-down biome image: for the visible area it makes one `gen_biomes` call at a scale
//! chosen from the zoom level, colours each cell with Cubiomes' palette, and blits it. No
//! heights (that path is scale-4 only), no Three.js — just a 2D canvas. Faster than the 3D
//! mesh and the right default.
//!
//! It relies on the engine's global generator already being seeded (the orchestrator calls
//! `engine.setWorld` before `setWorld` here). Panning is Part 12.3; for now you navigate by
//! zooming toward the cursor.

// Zoom stops, coarsest → finest. `scale` is the Cubiomes generation scale (cell = `scale`
// blocks); `cellPx` is screen pixels per cell. blocks-per-pixel = scale / cellPx. Scale 1
// (Voronoi, 16x the cells) is gated to the two finest stops so it never covers a large area
// — the landmine 12.2 calls out.
const STOPS = [
  { scale: 256, cellPx: 2 }, // continents
  { scale: 64, cellPx: 2 },
  { scale: 64, cellPx: 4 },
  { scale: 16, cellPx: 3 },
  { scale: 16, cellPx: 6 },
  { scale: 4, cellPx: 3 },
  { scale: 4, cellPx: 6 }, // default — regional
  { scale: 1, cellPx: 4 }, // block-accurate
  { scale: 1, cellPx: 8 },
];
const DEFAULT_STOP = 6;

export function create2D({ canvas, engine, palette, mcVersion, ui }) {
  const ctx = canvas.getContext('2d');
  const off = document.createElement('canvas'); // cell-resolution scratch, scaled up crisp
  const offCtx = off.getContext('2d');

  let stop = DEFAULT_STOP;
  let cx = 0, cz = 0; // world-block coordinate at the canvas centre
  let shown = false, dirty = true;
  let grid = null; // last drawn grid, for hover lookups

  const bpp = () => STOPS[stop].scale / STOPS[stop].cellPx;

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

    const { scale, cellPx } = STOPS[stop];
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

  canvas.addEventListener('pointermove', (e) => {
    if (!shown || !grid) return;
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
    hide() { shown = false; },
  };
}
