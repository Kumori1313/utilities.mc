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
import { buildVersions } from '../web/src/versions.js';

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
  getBiomeAt: M.cwrap('get_biome_at', 'number', ['number', 'number', 'number', 'number']),
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
// This one was a regression for a long time, and the story is worth keeping. It was checked
// against Chunkbase early on and recorded as "ocean", while the engine said `deep_ocean`
// consistently — at the surface, at get_biome_at(1, 0,64,0), and at scale 4. Neither could be
// dismissed, so it was pinned as observed behaviour rather than promoted on a hunch.
//
// The Part 13 version sweep resolved it. This seed's origin biome IS `ocean` in every version
// up to 1.17 and `deep_ocean` from 1.18, and all 18 versions have now been confirmed against
// Chunkbase — 1.21.3 included. So the original note was read off a pre-1.18 view and later
// attributed to 1.21.3. Both observations were correct; only the version attached to one of
// them was wrong. Now ground truth.
const yPtr = M._malloc(4), idPtr = M._malloc(4);
eng.genH(0, 0, 1, 1, yPtr, idPtr);
check('ground', 'seed 1 surface biome at (0,0)', eng.b2s(mc, M.HEAP32[idPtr >> 2]), 'deep_ocean');
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

const { versions: registry, gaps } = buildVersions(eng);
check('ground', 'offered versions plus gaps account for the whole range',
  registry.length + gaps.length, newest - floor + 1);
check('regression', 'offered version count', registry.length, 23);

// One entry in the vendored engine cannot be named in either direction: `mc2str(30)` returns
// "?" and `str2mc("1.21.6")` returns 0, so the registry cannot offer it — an option must be
// able to say which version it loads. That is a bug in the vendored fork, not here.
//
// Omitting it is harmless, but that is a MEASURED claim, not an assumption: id 30 generates
// identically to the entries on either side of it, so a player on 1.21.6 gets the same world
// whichever neighbour they pick. 1.21.6 ("Chase the Skies") had no worldgen changes. If a
// future bump gives that id its own generation, these checks fail and the gap stops being
// harmless — which is exactly when we would need to do something about it.
check('regression', 'enum ids the engine cannot name', gaps, [30]);
const cells = (ver, y) => {
  eng.setWorld(BigInt.asUintN(64, 1n), ver, 0);
  const n = M.cwrap('biome_buffer_size', 'number', Array(4).fill('number'))(4, 48, 1, 48);
  const p = M._malloc(n * 4);
  M.cwrap('gen_biomes', 'number', Array(8).fill('number'))(4, -96, y, -96, 48, 1, 48, p);
  const out = Array.from(new Int32Array(M.HEAP32.buffer, p, 48 * 48));
  M._free(p);
  return out;
};
for (const y of [15, -4]) {
  const gap = cells(30, y), lo = cells(29, y), hi = cells(31, y);
  check('ground', `unnameable id 30 matches its neighbours (y=${y})`,
    [gap.filter((x, i) => x !== lo[i]).length, gap.filter((x, i) => x !== hi[i]).length], [0, 0]);
}
// Every offered entry must carry a string that parses back to it, or an option could resolve to
// a different world than the one it names. That guard lives on `key` — the engine's own
// spelling — because one displayed label is deliberately not the engine's.
check('ground', 'every entry round-trips through str2mc on its key',
  registry.filter((v) => eng.str2mc(v.key) !== v.id), []);
// No label should currently diverge from the engine's own spelling. The Winter Drop override
// that used to live here went inert when the vendored engine started returning "1.21.4"
// directly. Anything reappearing must be a deliberate, documented placeholder.
check('ground', 'no label diverges from the engine spelling',
  registry.filter((v) => v.label !== v.key).map((v) => [v.key, v.label]), []);
// A version outside the enum must not silently resolve to something plausible.
//
// This originally used "26.2" as a stand-in for an obviously-fake version. It is now a real
// Minecraft release — the 1.21 line ended at 1.21.11 and versioning moved to a 26.x scheme —
// which is a good reminder that "no such version" and "a version we do not support" are
// different claims, and only the second one is ours to make. Use a string that cannot ever be
// a version, and assert the ceiling separately and honestly below.
check('ground', 'a malformed version string does not resolve', eng.str2mc('not-a-version'), 0);
// The ceiling is a property of the vendored engine, not of Minecraft. Pinned so that a
// submodule bump has to come here and state its new range deliberately.
check('regression', 'newest version this build supports',
  eng.mc2str(eng.mcNewest()), '26.2');
check('ground', 'versions past the vendored ceiling do not resolve',
  ['26.3', '27.1'].filter((s) => eng.str2mc(s) !== 0), []);

// Labels name the newest release each entry covers, so the list reads in release order without
// being sorted. Cubiomes' own labels do not: it calls the 1.16.2–1.16.5 entry "1.16", which
// looks misplaced after "1.16.1" even though the enum order is right and 1.16.1 really is older.
// Pinned in full because these are facts about Minecraft's release history — if a submodule bump
// changes them, that needs looking at rather than re-recording.
check('ground', 'labels are the precise top of each entry, in release order',
  registry.map((v) => v.label),
  ['1.8.9', '1.9.4', '1.10.2', '1.11.2', '1.12.2', '1.13.2', '1.14.4', '1.15.2', '1.16.1',
   '1.16.5', '1.17.1', '1.18.2', '1.19.2', '1.19.4', '1.20.6', '1.21.1', '1.21.3', '1.21.4',
   '1.21.5', '1.21.9', '1.21.11', '26.1', '26.2']);
// The property behind that list, checked independently of it: strictly increasing as version
// tuples. Every label is numeric now that the Winter Drop placeholder is resolved, but the
// check does not assume that — a future TBA entry is allowed, provided it sorts last.
const tuple = (s) => /^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null;
const ordered = registry.map((v) => tuple(v.label));
check('ground', 'no numeric label follows a non-numeric one',
  ordered.filter((t, i) => t && ordered.slice(0, i).some((p) => !p)), []);
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
// Filter the non-numeric entries rather than assuming they are last — the check above owns
// that, and this one should fail rather than throw if they ever aren't.
check('ground', 'numeric labels strictly increase',
  ordered.filter(Boolean).filter((t, i, a) => i > 0 && cmp(a[i - 1], t) >= 0), []);
// The span each entry serves must be contiguous with the one before it, so that every real
// release maps to exactly one option and none falls in a gap.
check('ground', 'covered ranges are contiguous and complete',
  registry.map((v) => v.covers),
  ['1.8 – 1.8.9', '1.9 – 1.9.4', '1.10 – 1.10.2', '1.11 – 1.11.2', '1.12 – 1.12.2',
   '1.13 – 1.13.2', '1.14 – 1.14.4', '1.15 – 1.15.2', '1.16 – 1.16.1', '1.16.2 – 1.16.5',
   '1.17 – 1.17.1', '1.18 – 1.18.2', '1.19 – 1.19.2', '1.19.3 – 1.19.4', '1.20 – 1.20.6',
   '1.21 – 1.21.1', '1.21.2 – 1.21.3', '1.21.4', '1.21.5',
   // No lower bound after the 1.21.6 gap — claiming one here would swallow the four 1.21.x
   // entries above it. This is the assertion that would have caught "1.21 – 1.21.9".
   '1.21.9', '1.21.10 – 1.21.11', '26.1', '26.2']);

const versions = registry.map((v) => [v.id, v.label]);

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
// The verification status of these entries is NOT uniform, so they are split accordingly.
//
// GROUND TRUTH — 1.8 through 1.21.4. Each was compared against Chunkbase on seed 1 and matched,
// the newest against Chunkbase's 1.21.4 specifically. That checking was done against the
// PREVIOUS engine (Cubitect e61f905), and it carries over only because the two engines were
// compared directly across every shared version: surface biomes, terrain heights, Nether, End
// and all 18 structure types over a 4096-block square were byte-identical. Without that
// comparison this whole block would have had to drop to regression on the dependency swap.
//
// REGRESSION — 1.21.5 and newer. These arrived with the engine swap and have never been checked
// against anything external. They are pinned so a change is visible, and that is all.
//
// Structures remain checked on 1.21.3 alone in every case. Region salts and viability rules are
// version-parameterised too, and biomes agreeing says nothing about them.
const biomeAt = (ver) => {
  eng.setWorld(BigInt.asUintN(64, 1n), ver, 0);
  const n = M.cwrap('biome_buffer_size', 'number', Array(4).fill('number'))(4, 4, 1, 4);
  const p = M._malloc(n * 4);
  M.cwrap('gen_biomes', 'number', Array(8).fill('number'))(4, 0, 15, 0, 4, 1, 4, p);
  const b = eng.b2s(ver, M.HEAP32[p >> 2]);
  M._free(p);
  return b;
};
const cut = eng.str2mc('1.18');
const VERIFIED_THROUGH = eng.str2mc('1.21.4');
const expected = (v) => [v.label, v.id < cut ? 'ocean' : 'deep_ocean'];
const verified = registry.filter((v) => v.id <= VERIFIED_THROUGH);
const unverified = registry.filter((v) => v.id > VERIFIED_THROUGH);
check('ground', 'seed 1 origin biome, versions checked against Chunkbase',
  verified.map((v) => [v.label, biomeAt(v.id)]), verified.map(expected));
check('regression', 'seed 1 origin biome, versions added by the engine swap',
  unverified.map((v) => [v.label, biomeAt(v.id)]), unverified.map(expected));
// The split must not quietly become empty on one side — that would turn either assertion into a
// no-op while still reading as if it covered the whole list.
check('ground', 'both verification tiers are non-empty',
  [verified.length > 0, unverified.length > 0], [true, true]);
// Per-version witnesses are only worth having if they can disagree. If set_world ignored its
// version argument every entry above would still pass as one uniform block, so assert the split
// itself: the two eras must differ, and the boundary must sit exactly at 1.18.
check('ground', 'the 1.18 overhaul is visible at the boundary',
  [biomeAt(eng.str2mc('1.17')), biomeAt(cut)], ['ocean', 'deep_ocean']);

// --- draw depth / cave biomes ---
//
// The 2D map draws one horizontal slice, at block y 60 by default, and the depth control moves
// that slice. Coordinates below are from a search over seed 1 and are exact, so they double as
// spots to check against Chunkbase.
console.log('\ndepth');
const SLICE_CELLS = 64;
// map2d converts block y to generator y with `>> 2` at every scale but 1. Mirror that here
// rather than passing generator units, so this exercises the same arithmetic the map does.
const slice = (ver, dim, blockY, x0 = 512, scale = 4) => {
  if (eng.setWorld(BigInt.asUintN(64, 1n), ver, dim) !== 0) return null;
  const y = scale === 1 ? blockY : blockY >> 2;
  const c = SLICE_CELLS;
  const n = M.cwrap('biome_buffer_size', 'number', Array(4).fill('number'))(scale, c, 1, c);
  const p = M._malloc(n * 4);
  const rc = M.cwrap('gen_biomes', 'number', Array(8).fill('number'))(scale, x0, y, x0, c, 1, c, p);
  const out = rc === 0 ? Array.from(new Int32Array(M.HEAP32.buffer, p, c * c)) : null;
  M._free(p);
  return out;
};
const diff = (a, b) => a.filter((x, i) => x !== b[i]).length;
// Point lookup in BLOCK coordinates, converted the way the map does.
const at = (ver, bx, by, bz) => {
  eng.setWorld(BigInt.asUintN(64, 1n), ver, 0);
  return eng.b2s(ver, eng.getBiomeAt(4, bx >> 2, by >> 2, bz >> 2));
};

// `>> 2` must floor toward negative infinity. Plain division truncates toward zero, which would
// put y=-17 in the cell above the one containing it — a one-cell error only below y=0, i.e.
// exactly in the range this feature exists to show.
check('ground', 'block-to-generator y flooring is correct below zero',
  [-16 >> 2, -17 >> 2, -1 >> 2, 63 >> 2], [-4, -5, -1, 15]);

// Depth must do something where the UI offers it, and nothing where it hides it. This is the
// measurement `depthMatters` encodes; if it ever inverts, the control lies in one direction or
// the other.
const v1213 = eng.str2mc('1.21.3'), v117 = eng.str2mc('1.17'), v262 = eng.str2mc('26.2');
check('ground', 'depth changes the map on 1.18+ Overworld',
  diff(slice(v1213, 0, 63), slice(v1213, 0, -16)) > 0, true);
check('ground', 'depth is inert pre-1.18 and outside the Overworld',
  [diff(slice(v117, 0, 63), slice(v117, 0, -16)),
   diff(slice(v1213, -1, 63), slice(v1213, -1, -16)),
   diff(slice(v1213, 1, 63), slice(v1213, 1, -16))], [0, 0, 0]);

// Every cave biome must be reachable, not just the new one. A depth view that only ever
// produced sulfur would be broken in a way a sulfur-only check could not see. These are the
// first occurrence of each on seed 1, found by search.
check('ground', 'cave biomes are reachable', [
  at(v262, -3072, 60, -3072),
  at(v262, -3068, 60, 184),
  at(v262, -2516, 60, -3032),
  at(v262, 1356, 60, 2980),
], ['dripstone_caves', 'lush_caves', 'deep_dark', 'sulfur_caves']);

// The 26.x check that matters. At (1356, 2980) the two versions disagree from y 60 down to
// about -32, and agree above it.
//
// Note what is and is not true here. The TERRAIN SURFACE at this column is y~79 and reads
// plains in both versions — so a map showing the true surface biome could not tell them apart.
// This map draws a fixed y slice, and its default of 60 is already underground wherever terrain
// rises above it, which is most land. So the difference is visible at the default depth; the
// control exists to make that systematic rather than dependent on where terrain happens to sit.
const SULFUR_COL = [1356, 2980];
check('ground', '26.2 and 1.21.11 differ underground at a known column',
  [at(v262, ...[SULFUR_COL[0], 60, SULFUR_COL[1]]), at(eng.str2mc('1.21.11'), SULFUR_COL[0], 60, SULFUR_COL[1])],
  ['sulfur_caves', 'plains']);
check('ground', 'the same column agrees above the sulfur layer',
  [at(v262, 1356, 80, 2980), at(eng.str2mc('1.21.11'), 1356, 80, 2980)], ['plains', 'plains']);
// The true terrain surface is identical, which is why this needed a depth slice rather than a
// surface map, and why the sulfur band is genuinely underground rather than a surface biome.
eng.setWorld(BigInt.asUintN(64, 1n), v262, 0);
const hP = M._malloc(4), iP = M._malloc(4);
eng.genH(1356 >> 2, 2980 >> 2, 1, 1, hP, iP);
check('ground', 'terrain surface at that column is above the sulfur band',
  [Math.round(new Float32Array(M.HEAPF32.buffer, hP, 1)[0]) > 60, eng.b2s(v262, M.HEAP32[iP >> 2])],
  [true, 'plains']);
M._free(hP); M._free(iP);

console.log('\ncalculators');
check('regression', 'enchant table version', app.enchant_version(), MC);
// Fortune III + Unbreaking III onto a blank pickaxe, cross-checked on a real 1.21.3 anvil.
check('ground', 'anvil: fortune 3 + unbreaking 3 costs 10', app.anvil_optimize('fortune=3,unbreaking=3', 0).total, 10);
// Applying the same books to an item already worked twice costs more.
check('regression', 'anvil: fortune 3 at prior work 2', app.anvil_optimize('fortune=3', 2).total, 9);
check('regression', 'grid rows for a diamond pickaxe', app.enchant_applicable('diamond_pickaxe').length, 6);

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'smoke test passed'}`);
process.exit(failures ? 1 : 0);
