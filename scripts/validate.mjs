#!/usr/bin/env node
// utilities.mc — full-pipeline validation (Part 8).
//
// Runs the REAL path end to end — engine module -> Rust tile cache -> lookups — rather
// than the isolated spikes of Parts 2/3. Two different things happen here:
//
//   1. INTERNAL CONSISTENCY, checked automatically. Every route to a biome id must agree:
//      gen_biomes, gen_heights' id output, get_biome_at, and the cached value read back
//      through Rust. These catch desyncs, indexing slips, and buffer-copy errors.
//
//   2. GROUND TRUTH, which this script CANNOT check. Nothing here proves Cubiomes is
//      being driven correctly overall — a wrong dimension or version would be perfectly
//      self-consistent. The script prints a table for manual comparison against Chunkbase
//      at the pinned version. That comparison is the actual Part 8 requirement; the
//      automated checks below are necessary, not sufficient.
//
// Usage:  node scripts/validate.mjs [--pan]
//         --pan also runs the memory/eviction soak described in Part 8.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'web/public');
const MC_VERSION = '1.21.3';
const SCALE = 4;

function need(p, hint) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${path.relative(ROOT, p)}\n  ${hint}`);
    process.exit(2);
  }
}
need(path.join(PUB, 'wasm/cubiomes.wasm'), 'run scripts/build-all.sh');
need(path.join(PUB, 'app/app_bg.wasm'), 'run scripts/build-all.sh');

// ---- load both modules -------------------------------------------------------------
const { default: createCubiomes } = await import(path.join(PUB, 'wasm/cubiomes.js'));
const M = await createCubiomes({
  instantiateWasm(imports, cb) {
    const bytes = fs.readFileSync(path.join(PUB, 'wasm/cubiomes.wasm'));
    WebAssembly.instantiate(bytes, imports).then((r) => cb(r.instance));
  },
});
const app = await import(path.join(PUB, 'app/app.js'));
await app.default({ module_or_path: fs.readFileSync(path.join(PUB, 'app/app_bg.wasm')) });

const eng = {
  setWorld: M.cwrap('set_world', 'number', ['number', 'number', 'number']),
  at: M.cwrap('get_biome_at', 'number', ['number', 'number', 'number', 'number']),
  gen: M.cwrap('gen_biomes', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']),
  genH: M.cwrap('gen_heights', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
  bufSize: M.cwrap('biome_buffer_size', 'number', ['number', 'number', 'number', 'number']),
  str2mc: M.cwrap('str2mc', 'number', ['string']),
  b2s: M.cwrap('biome2str', 'string', ['number', 'number']),
};

const mc = eng.str2mc(MC_VERSION);
if (mc < 0) { console.error(`engine does not know ${MC_VERSION}`); process.exit(2); }

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

// ---- 1. internal consistency across seeds -------------------------------------------
const SEEDS = [0n, 1n, 42n, -1n, 1234567890n, -4172144997902289642n, 9223372036854775807n];

console.log(`\n=== internal consistency (${MC_VERSION}, scale ${SCALE}) ===`);
for (const seed of SEEDS) {
  const s = BigInt.asUintN(64, seed);
  if (eng.setWorld(s, mc, 0) !== 0) { fail(`set_world failed for ${seed}`); continue; }

  const view = new app.View(64);
  view.set_world(s, mc, 0);
  const n = view.tile_cells, cells = n * n;

  // Generate a tile and require every route to the same surface biome to agree.
  const [ox, oz] = view.tile_origin_block(0, 0, SCALE);
  const bPtr = M._malloc(eng.bufSize(SCALE, n, 1, n) * 4);
  const yPtr = M._malloc(cells * 4);
  const iPtr = M._malloc(cells * 4);

  if (eng.gen(SCALE, ox / SCALE, 16, oz / SCALE, n, 1, n, bPtr) !== 0) fail(`gen_biomes ${seed}`);
  if (eng.genH(ox / SCALE, oz / SCALE, n, n, yPtr, iPtr) !== 0) fail(`gen_heights ${seed}`);

  const fromHeights = M.HEAP32.subarray(iPtr >> 2, (iPtr >> 2) + cells);
  const heights = M.HEAPF32.subarray(yPtr >> 2, (yPtr >> 2) + cells);

  // gen_heights' ids are SURFACE biomes, so they must be compared against a query at each
  // cell's own height — not against a fixed-y slice. Comparing them to gen_biomes at
  // y=16 would be apples to oranges: 3D biomes mean the two legitimately differ.
  let mismatch = 0, badHeight = 0;
  for (let k = 0; k < cells; k++) {
    const i = k % n, j = (k / n) | 0;
    if (!Number.isFinite(heights[k])) { badHeight++; continue; }
    const surfaceY = Math.floor(heights[k] / 4);
    if (fromHeights[k] !== eng.at(SCALE, ox / SCALE + i, surfaceY, oz / SCALE + j)) mismatch++;
  }
  view.store_tile(0, 0, SCALE, fromHeights, heights);
  M._free(bPtr); M._free(yPtr); M._free(iPtr);

  // Cached reads through Rust vs direct point queries. The cache holds SURFACE biomes,
  // so the direct query has to use each cell's own height too.
  let cacheBad = 0;
  for (let j = 0; j < n; j += 5) {
    for (let i = 0; i < n; i += 5) {
      const bx = ox + i * SCALE, bz = oz + j * SCALE;
      const surfaceY = Math.floor(view.height_at(bx, bz, SCALE) / 4);
      if (view.biome_at(bx, bz, SCALE) !== eng.at(SCALE, ox / SCALE + i, surfaceY, oz / SCALE + j)) cacheBad++;
    }
  }

  const label = `seed ${String(seed).padStart(20)}`;
  if (mismatch || badHeight || cacheBad) {
    fail(`${label}: ${mismatch} surface-biome disagreements, ${badHeight} non-finite heights, ${cacheBad} cache mismatches`);
  } else {
    ok(`${label}: surface ids == get_biome_at at surface; cache == direct`);
  }
}

// ---- 2. guards ----------------------------------------------------------------------
console.log('\n=== guards ===');
{
  const s = BigInt.asUintN(64, 1n);
  eng.setWorld(s, mc, -1); // Nether
  const p = M._malloc(64);
  eng.genH(0, 0, 2, 2, p, 0) === -1
    ? ok('gen_heights refuses the Nether instead of returning flat 127')
    : fail('gen_heights did not refuse the Nether');
  M._free(p);

  eng.setWorld(s, mc, 0);
  eng.at(2, 0, 64, 0) === -1 ? ok('get_biome_at rejects scale 2') : fail('scale 2 accepted');

  // Stale-world guard: a cache pointed at a new seed must not serve old tiles.
  const view = new app.View(8);
  view.set_world(s, mc, 0);
  const n = view.tile_cells;
  const yP = M._malloc(n * n * 4), iP = M._malloc(n * n * 4);
  eng.genH(0, 0, n, n, yP, iP);
  view.store_tile(0, 0, SCALE, M.HEAP32.subarray(iP >> 2, (iP >> 2) + n * n),
                  M.HEAPF32.subarray(yP >> 2, (yP >> 2) + n * n));
  M._free(yP); M._free(iP);
  const before = view.biome_at(0, 0, SCALE);
  view.set_world(BigInt.asUintN(64, 999n), mc, 0);
  const after = view.biome_at(0, 0, SCALE);
  after === -1 && before !== -1
    ? ok('changing seed invalidates cached tiles')
    : fail(`stale tile survived a seed change (before=${before}, after=${after})`);
}

// ---- 3. payload weight (Part 8: load performance) -----------------------------------
console.log('\n=== payload weight ===');
{
  const zlib = await import('node:zlib');
  const files = [
    ['engine wasm', 'wasm/cubiomes.wasm'],
    ['engine glue', 'wasm/cubiomes.js'],
    ['app wasm', 'app/app_bg.wasm'],
    ['app glue', 'app/app.js'],
  ];
  const dist = path.join(ROOT, 'web/dist/assets');
  if (fs.existsSync(dist)) {
    for (const f of fs.readdirSync(dist)) files.push([`bundle ${path.extname(f).slice(1)}`, `../dist/assets/${f}`]);
  }
  let raw = 0, gz = 0;
  for (const [label, rel] of files) {
    const p = path.join(PUB, rel);
    if (!fs.existsSync(p)) continue;
    const b = fs.readFileSync(p);
    const g = zlib.gzipSync(b).length;
    raw += b.length; gz += g;
    console.log(`  ${label.padEnd(14)} ${(b.length / 1024).toFixed(0).padStart(6)} KB   ${(g / 1024).toFixed(0).padStart(5)} KB gzip`);
  }
  console.log(`  ${'TOTAL'.padEnd(14)} ${(raw / 1024).toFixed(0).padStart(6)} KB   ${(gz / 1024).toFixed(0).padStart(5)} KB gzip`);
  // Rough transfer time on a throttled link; Part 8 asks for this rather than localhost.
  for (const [name, kbps] of [['slow 3G', 400], ['fast 3G', 1600], ['4G', 9000]]) {
    console.log(`    ~${(gz * 8 / 1024 / kbps).toFixed(1)}s to transfer on ${name} (${kbps} kbps)`);
  }
}

// ---- 4. pan soak (optional) ----------------------------------------------------------
if (process.argv.includes('--pan')) {
  console.log('\n=== pan soak (memory / eviction) ===');
  const s = BigInt.asUintN(64, 1n);
  eng.setWorld(s, mc, 0);
  const CAP = 64;
  const view = new app.View(CAP);
  view.set_world(s, mc, 0);
  const n = view.tile_cells;
  const yP = M._malloc(n * n * 4), iP = M._malloc(n * n * 4);

  const heapAt = () => M.HEAPU8.length;
  const heap0 = heapAt();
  let peakCached = 0;

  for (let step = 0; step < 400; step++) {
    const tx = (step % 20) - 10, tz = ((step / 20) | 0) - 10;
    const [ox, oz] = view.tile_origin_block(tx, tz, SCALE);
    eng.genH(ox / SCALE, oz / SCALE, n, n, yP, iP);
    view.store_tile(tx, tz, SCALE, M.HEAP32.subarray(iP >> 2, (iP >> 2) + n * n),
                    M.HEAPF32.subarray(yP >> 2, (yP >> 2) + n * n));
    peakCached = Math.max(peakCached, view.cached_tiles);
  }
  M._free(yP); M._free(iP);

  const heap1 = heapAt();
  console.log(`  tiles stored        400`);
  console.log(`  cache capacity      ${CAP}`);
  console.log(`  peak cached tiles   ${peakCached}`);
  console.log(`  evictions           ${view.evictions}`);
  console.log(`  emscripten heap     ${(heap0 / 1048576).toFixed(1)} MB -> ${(heap1 / 1048576).toFixed(1)} MB`);
  peakCached <= CAP ? ok('cache respected its capacity under sustained panning')
                    : fail(`cache grew past capacity (${peakCached} > ${CAP})`);
  heap1 <= heap0 * 2 ? ok('engine heap did not grow unbounded')
                     : fail(`engine heap more than doubled (${heap0} -> ${heap1})`);
}

// ---- 5. ground-truth table (manual) --------------------------------------------------
console.log(`\n=== ground truth: CHECK THESE AGAINST CHUNKBASE (Java ${MC_VERSION}) ===`);
console.log('  This script cannot verify these — self-consistency is not correctness.');
console.log('  A wrong dimension or version would agree with itself perfectly.\n');
console.log('    seed                  x      z    y   biome');
const CHECKS = [
  [1n, 100, 100], [1n, 0, 0], [1n, -500, 700], [1n, 2000, -2000],
  [42n, 0, 0], [42n, 300, -300],
  [-4172144997902289642n, 0, 0], [-4172144997902289642n, 1000, 1000],
];
for (const [seed, x, z] of CHECKS) {
  eng.setWorld(BigInt.asUintN(64, seed), mc, 0);
  const id = eng.at(1, x, 64, z); // scale 1 = block coords, what Chunkbase shows
  console.log(`  ${String(seed).padStart(20)} ${String(x).padStart(6)} ${String(z).padStart(6)}   64   ${eng.b2s(mc, id)}`);
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all automated checks passed'}`);
process.exit(failures ? 1 : 0);
