#!/usr/bin/env node
// utilities.mc — smoke test over the BUILT artifacts (Part 9).
//
// Why this exists: a deploy once shipped a completely dead map while every check was green.
// The build succeeded, the files served with correct MIME types, and the app could not load a
// world at all — CI was pinned to an Emscripten version predating WASM_BIGINT's default, so
// `set_world`'s i64 seed was legalized into two i32 arguments and every call from JS had the
// wrong arity. "It built" and "the files serve" are not "it runs", and only the second pair
// was ever being checked.
//
// So this loads the SAME files that get deployed — via `instantiateWasm`, which bypasses the
// ENVIRONMENT=web fetch path without needing a separate Node build — and calls them.
//
// Two kinds of assertion, kept deliberately separate:
//
//   GROUND TRUTH   — values confirmed against something outside this codebase (Chunkbase for
//                    biomes and structures, a real in-game anvil for costs). A failure here
//                    means the tool became wrong.
//   REGRESSION     — values captured from a build that was believed good. A failure means
//                    behaviour CHANGED; it does not by itself mean the new value is wrong.
//
// Conflating those two is how a baseline gets mistaken for a proof.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStructures, STRUCTURE_TYPES } from '../web/src/structures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'web/public');
const MC = '1.21.3';

for (const f of ['wasm/cubiomes.js', 'wasm/cubiomes.wasm', 'app/app.js', 'app/app_bg.wasm']) {
  if (!fs.existsSync(path.join(PUB, f))) {
    console.error(`missing web/public/${f} — run scripts/build-all.sh`);
    process.exit(2);
  }
}

const { default: createCubiomes } = await import(path.join(PUB, 'wasm/cubiomes.js'));
const M = await createCubiomes({
  instantiateWasm(imports, cb) {
    const bytes = fs.readFileSync(path.join(PUB, 'wasm/cubiomes.wasm'));
    WebAssembly.instantiate(bytes, imports).then((r) => cb(r.instance));
  },
});
const app = await import(path.join(PUB, 'app/app.js'));
await app.default({ module_or_path: fs.readFileSync(path.join(PUB, 'app/app_bg.wasm')) });

let failures = 0;
const check = (kind, label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return console.log(`  ok    [${kind}] ${label}`);
  failures++;
  console.log(`  FAIL  [${kind}] ${label}\n          got  ${g}\n          want ${w}`);
};

const eng = {
  setWorld: M.cwrap('set_world', 'number', ['number', 'number', 'number']),
  genH: M.cwrap('gen_heights', 'number', ['number', 'number', 'number', 'number', 'number', 'number']),
  b2s: M.cwrap('biome2str', 'string', ['number', 'number']),
  str2mc: M.cwrap('str2mc', 'number', ['string']),
  structureId: M.cwrap('structure_id', 'number', ['string']),
  genStructures: M.cwrap('gen_structures', 'number',
    ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
  genStrongholds: M.cwrap('gen_strongholds', 'number', ['number', 'number']),
  genSlimeChunks: M.cwrap('gen_slime_chunks', 'number',
    ['number', 'number', 'number', 'number', 'number']),
  worldSpawn: M.cwrap('world_spawn', 'number', ['number']),
  mc2str: M.cwrap('mc2str', 'string', ['number']),
  mcNewest: M.cwrap('mc_newest', 'number', []),
  structureSupported: M.cwrap('structure_supported', 'number', ['string']),
  M,
};

const mc = eng.str2mc(MC);
if (mc < 0) { console.error(`engine does not know ${MC}`); process.exit(2); }

// The i64 seed crosses as a BigInt. This single call is what the dead deploy failed on: with
// a legalized ABI the export takes four arguments and this returns nonsense or throws.
console.log('\nengine');
const rc = eng.setWorld(BigInt.asUintN(64, 1n), mc, 0);
check('ground', 'set_world accepts a BigInt seed (i64 ABI intact)', rc, 0);

// Surface biome at the origin for seed 1.
//
// Marked REGRESSION, not ground truth, deliberately. This point was checked against Chunkbase
// early on and recorded as "ocean", but the engine says `deep_ocean` consistently — at the
// surface, at get_biome_at(1, 0,64,0), and at scale 4.
//
// The Part 13 version work explains the discrepancy: this seed's origin biome IS `ocean` in
// every version up to 1.17 and `deep_ocean` from 1.18 (both now confirmed against Chunkbase —
// see the version section below). The early note was almost certainly read off a pre-1.18 view.
// That resolves the contradiction, but it does not verify THIS assertion, which is 1.21.3: a
// neighbouring version agreeing is an explanation, not an observation. Stays a regression until
// someone reads the label off Chunkbase on 1.21.3 itself.
const yPtr = M._malloc(4), idPtr = M._malloc(4);
eng.genH(0, 0, 1, 1, yPtr, idPtr);
check('regression', 'seed 1 surface biome at (0,0)', eng.b2s(mc, M.HEAP32[idPtr >> 2]), 'deep_ocean');
M._free(yPtr); M._free(idPtr);

// Structures, all confirmed against Chunkbase on seed 1 / 1.21.3.
console.log('\nstructures');
const S = createStructures(eng);
const near = (type, n = 1) =>
  S.nearest(0, 0, type, n).targets.map((t) => [t.x, t.z]);

check('ground', 'nearest village', near('village'), [[-240, -912]]);
check('ground', 'nearest ocean monument', near('monument'), [[816, -272]]);
check('ground', 'nearest woodland mansion', near('mansion'), [[1888, 240]]);
check('ground', 'nearest desert pyramid', near('desert_pyramid'), [[272, 9552]]);
// Ring order is not distance order — this is the sort, and the count is the off-by-one that
// once produced a phantom 129th stronghold.
check('ground', 'nearest stronghold', near('stronghold'), [[-1132, 852]]);
check('ground', 'stronghold count', S.nearest(0, 0, 'stronghold', 999).targets.length, 128);
// Regression until checked: buried treasure is new. Its positions do satisfy the structural
// invariant — treasure generates at chunk-relative (9, 9), so every x and z must be 9 mod 16.
check('regression', 'nearest buried treasure', near('treasure'), [[-439, -343]]);
check('ground', 'buried treasure sits at chunk-relative (9,9)',
  near('treasure', 8).filter(([x, z]) => ((x % 16) + 16) % 16 !== 9 || ((z % 16) + 16) % 16 !== 9), []);

// --- dimensions (Part 14) ---
//
// Regression, not ground truth: none of these positions has been checked against Chunkbase
// yet. What IS asserted as ground truth is the dimension guard, because that is a property of
// this code rather than of Minecraft.
console.log('\ndimensions');
for (const [name, d, biome] of [['nether', -1, 'nether_wastes'], ['end', 1, 'the_end']]) {
  check('ground', `set_world accepts the ${name}`, eng.setWorld(BigInt.asUintN(64, 1n), mc, d), 0);
  const p = M._malloc(4);
  M.cwrap('gen_biomes', 'number', Array(8).fill('number'))(4, 0, 15, 0, 1, 1, 1, p);
  check('regression', `${name} biome at origin`, eng.b2s(mc, M.HEAP32[p >> 2]), biome);
  M._free(p);
  // A type from another dimension must be refused, not silently return nothing.
  const buf = M._malloc(64);
  check('ground', `${name} refuses an Overworld structure type`,
    eng.genStructures(eng.structureId('village'), -500, -500, 500, 500, buf, 8), -1);
  M._free(buf);
  const shb = M._malloc(16);
  check('ground', `${name} refuses strongholds`, eng.genStrongholds(shb, 2), -1);
  M._free(shb);
}

eng.setWorld(BigInt.asUintN(64, 1n), mc, -1);
const NS = createStructures(eng);
check('regression', 'nearest nether fortress',
  NS.nearest(0, 0, 'fortress', 1).targets.map((t) => [t.x, t.z]), [[-96, 144]]);
check('regression', 'nearest bastion',
  NS.nearest(0, 0, 'bastion', 1).targets.map((t) => [t.x, t.z]), [[192, 0]]);

// Every End city position checked against Chunkbase on seed 1 / 1.21.3, encoded as a set. The
// biome check alone accepts all 18; the shim's height gate (END_CITY_MIN_Y) is what separates
// them, so this is the test that pins that constant. Shifting it one block either way — the
// height distribution has 358 candidates at 59 and 282 at 60 — breaks these immediately.
eng.setWorld(BigInt.asUintN(64, 1n), mc, 1);
const END_PRESENT = [[32, -12736], [-3120, -12704], [5840, -12768], [-1872, -12032]];
const END_ABSENT = [
  [368, -12736], [2960, -12736], [-11136, -12784], [-1552, -12704], [352, 992],
  [992, -560], [96, -1168], [-7952, -12736], [-6000, -12736], [-4736, -12784],
  [-10512, -12704], [1024, -12752], [-12688, -12768], [-6688, -12720],
];
const cityAt = (x, z) => {
  const ptr = M._malloc(16 * 2 * 4);
  const n = eng.genStructures(eng.structureId('end_city'), x - 8, z - 8, x + 8, z + 8, ptr, 16);
  let hit = false;
  if (n > 0) {
    const a = M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + n * 2);
    for (let i = 0; i < n; i++) if (a[i * 2] === x && a[i * 2 + 1] === z) hit = true;
  }
  M._free(ptr);
  return hit;
};
check('ground', 'End cities Chunkbase shows are reported',
  END_PRESENT.filter(([x, z]) => !cityAt(x, z)), []);
check('ground', 'End cities Chunkbase does not show are filtered out',
  END_ABSENT.filter(([x, z]) => cityAt(x, z)), []);
// Gateways were confirmed in the original Part 14 list and are unaffected by the city gate.
const EG = createStructures(eng);
check('ground', 'nearest end gateways',
  EG.nearest(0, 0, 'end_gateway', 3).targets.map((t) => [t.x, t.z]),
  [[1434, 66], [1002, 1315], [1038, 1290]]);

// Leave the generator back in the Overworld for anything that follows.
eng.setWorld(BigInt.asUintN(64, 1n), mc, 0);

// --- non-structure layers ---
console.log('\nlayers');
eng.setWorld(BigInt.asUintN(64, 1n), mc, 0);
const spPtr = M._malloc(8);
check('ground', 'world_spawn succeeds in the Overworld', eng.worldSpawn(spPtr), 0);
check('regression', 'seed 1 world spawn',
  [M.HEAP32[spPtr >> 2], M.HEAP32[(spPtr >> 2) + 1]], [160, 160]);
eng.setWorld(BigInt.asUintN(64, 1n), mc, -1);
check('ground', 'world_spawn refuses the Nether', eng.worldSpawn(spPtr), -1);
M._free(spPtr);

eng.setWorld(BigInt.asUintN(64, 1n), mc, 0);
const N = 400;
const slPtr = M._malloc(N * N);
check('ground', 'gen_slime_chunks succeeds', eng.genSlimeChunks(-N / 2, -N / 2, N, N, slPtr), 0);
let slime = 0;
for (let i = 0; i < N * N; i++) slime += M.HEAPU8[slPtr + i];
const rate = slime / (N * N);
// Minecraft makes ~1 chunk in 10 a slime chunk. This is a distribution check, not a captured
// number: it would catch a wrong seed, a broken RNG, or an all-zero buffer, none of which the
// return code reveals.
check('ground', 'slime chunk rate is near 10%', rate > 0.08 && rate < 0.12, true);
M._free(slPtr);

// --- versions (Part 13) ---
console.log('\nversions');
const floor = eng.str2mc('1.8.9');
const newest = eng.mcNewest();
check('ground', '1.8.9 resolves (the agreed scope floor)', floor > 0, true);
// Every offered version's own label must parse back to it, or a selector entry could load a
// different world than the one it names.
const versions = [];
for (let v = floor; v <= newest; v++) {
  const label = eng.mc2str(v);
  if (label && eng.str2mc(label) === v) versions.push([v, label]);
}
check('ground', 'all versions in range round-trip through their labels',
  versions.length, newest - floor + 1);
check('regression', 'offered version count', versions.length, 18);
// A version outside the enum must not silently resolve to something plausible.
check('ground', 'an unknown version string does not resolve', eng.str2mc('26.2'), 0);

// Structure availability is version-dependent, and this is what the UI filters on.
const supAt = (ver, name) => {
  eng.setWorld(BigInt.asUintN(64, 1n), ver, 0);
  return eng.structureSupported(name) === 1;
};
check('ground', 'trial chambers absent in 1.8', supAt(eng.str2mc('1.8'), 'trial_chambers'), false);
check('ground', 'trial chambers present in 1.21.3', supAt(eng.str2mc('1.21.3'), 'trial_chambers'), true);
check('ground', 'pillager outposts absent in 1.13', supAt(eng.str2mc('1.13'), 'outpost'), false);
check('ground', 'pillager outposts present in 1.14', supAt(eng.str2mc('1.14'), 'outpost'), true);
check('ground', 'villages present in every offered version',
  versions.filter(([v]) => !supAt(v, 'village')), []);

// Selecting a version must actually change generation, not just a label. Seed 1's origin biome
// moved with the 1.18 overhaul, which is the cheapest observable proof of that.
//
// Ground truth: the biome maps for 1.8 (the scope floor) and 1.18 (the first version after the
// overhaul) were both compared against Chunkbase on seed 1 and matched. The origin cell is the
// pinned witness for each, since it is the centre of any view compared. Those two versions
// bracket the only change in this range big enough to invalidate an entire era, so they are the
// pair worth pinning — but the other 16 remain unverified, and a passing check here says
// nothing about, say, 1.16.
const biomeAt = (ver) => {
  eng.setWorld(BigInt.asUintN(64, 1n), ver, 0);
  const n = M.cwrap('biome_buffer_size', 'number', Array(4).fill('number'))(4, 4, 1, 4);
  const p = M._malloc(n * 4);
  M.cwrap('gen_biomes', 'number', Array(8).fill('number'))(4, 0, 15, 0, 4, 1, 4, p);
  const b = eng.b2s(ver, M.HEAP32[p >> 2]);
  M._free(p);
  return b;
};
check('ground', 'seed 1 origin biome in 1.8', biomeAt(eng.str2mc('1.8')), 'ocean');
check('ground', 'seed 1 origin biome in 1.18', biomeAt(eng.str2mc('1.18')), 'deep_ocean');
// 1.17 is unchecked externally, but it must agree with 1.8: the overhaul lands in 1.18, so the
// whole pre-1.18 era shares one answer. This is what would catch the boundary drifting.
check('regression', 'seed 1 origin biome in 1.17', biomeAt(eng.str2mc('1.17')), 'ocean');

eng.setWorld(BigInt.asUintN(64, 1n), mc, 0); // restore for what follows

console.log('\ncalculators');
check('regression', 'enchant table version', app.enchant_version(), MC);
// Fortune III + Unbreaking III onto a blank pickaxe, cross-checked on a real 1.21.3 anvil.
check('ground', 'anvil: fortune 3 + unbreaking 3 costs 10', app.anvil_optimize('fortune=3,unbreaking=3', 0).total, 10);
// Applying the same books to an item already worked twice costs more.
check('regression', 'anvil: fortune 3 at prior work 2', app.anvil_optimize('fortune=3', 2).total, 9);
check('regression', 'grid rows for a diamond pickaxe', app.enchant_applicable('diamond_pickaxe').length, 6);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'smoke test passed'}`);
process.exit(failures ? 1 : 0);
