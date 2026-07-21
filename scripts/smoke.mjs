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
// surface, at get_biome_at(1, 0,64,0), and at scale 4. Chunkbase distinguishes Ocean from Deep
// Ocean, so the note was most likely a loose paraphrase rather than a mismatch. Promoting a
// half-remembered label to a ground-truth assertion would manufacture certainty that does not
// exist, so this pins observed behaviour until someone re-checks the exact Chunkbase label.
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

// No End city assertion: every one checked against Chunkbase was absent, so the layer is
// withheld from the UI. Pinning its output would enshrine a result known to be wrong.
// Instead, assert it stays withheld, so re-enabling it is a deliberate act that trips a test.
check('ground', 'End structure types are withheld pending verification',
  STRUCTURE_TYPES.filter((t) => t.dim === 'end').map((t) => t.id), []);

// Leave the generator back in the Overworld for anything that follows.
eng.setWorld(BigInt.asUintN(64, 1n), mc, 0);

console.log('\ncalculators');
check('regression', 'enchant table version', app.enchant_version(), MC);
// Fortune III + Unbreaking III onto a blank pickaxe, cross-checked on a real 1.21.3 anvil.
check('ground', 'anvil: fortune 3 + unbreaking 3 costs 10', app.anvil_optimize('fortune=3,unbreaking=3', 0).total, 10);
// Applying the same books to an item already worked twice costs more.
check('regression', 'anvil: fortune 3 at prior work 2', app.anvil_optimize('fortune=3', 2).total, 9);
check('regression', 'grid rows for a diamond pickaxe', app.enchant_applicable('diamond_pickaxe').length, 6);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'smoke test passed'}`);
process.exit(failures ? 1 : 0);
