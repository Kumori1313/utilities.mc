// Tile cache key checks for the 2D map.
//
// This exists because the smoke test cannot reach it: map2d needs a DOM, so the one line most
// able to produce a convincingly-wrong map has no coverage there. The failure it guards is
// specific — a cached tile generated at one depth (or scale) being served for another. Nothing
// throws, nothing looks broken; the map just shows the wrong ground.

import { tileCacheKey, depthMatters, SEA_LEVEL, MIN_DEPTH, MAX_DEPTH } from '../src/map2d.js';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return console.log(`  ok    ${label}`);
  failures++;
  console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`);
};

console.log('tile cache key');
check('identical inputs give the same key',
  tileCacheKey(4, 3, -7, 63), tileCacheKey(4, 3, -7, 63));

// Each of these differs in exactly one field, so a key that dropped that field would collide.
const base = tileCacheKey(4, 3, -7, 63);
for (const [label, key] of [
  ['scale', tileCacheKey(16, 3, -7, 63)],
  ['tile x', tileCacheKey(4, 4, -7, 63)],
  ['tile z', tileCacheKey(4, 3, -6, 63)],
  ['depth', tileCacheKey(4, 3, -7, -16)],
]) {
  check(`a different ${label} gives a different key`, key === base, false);
}

// The specific collision that motivated this: same tile, surface vs cave layer.
check('surface and cave layers of one tile do not collide',
  tileCacheKey(4, 0, 0, SEA_LEVEL) === tileCacheKey(4, 0, 0, -16), false);

// Field separation. Concatenating without a delimiter would make (scale 4, tx 11) collide with
// (scale 41, tx 1); this asserts the parts stay distinguishable.
check('adjacent fields cannot be confused',
  tileCacheKey(4, 11, 0, 63) === tileCacheKey(41, 1, 0, 63), false);
check('negative tile indices stay distinct from positive',
  tileCacheKey(4, -3, 0, 63) === tileCacheKey(4, 3, 0, 63), false);

console.log('\ndepth applicability');
// A stub engine: depthMatters only asks for the 1.18 boundary, and using a stub keeps this
// test free of the WASM build. The ids mirror the real enum's ordering property, which is all
// the comparison relies on.
const engine = { str2mc: (s) => ({ '1.18': 22 })[s] ?? 0 };
check('1.18+ Overworld has depth', depthMatters(engine, 22, 0), true);
check('newer than 1.18 has depth', depthMatters(engine, 28, 0), true);
check('pre-1.18 Overworld does not', depthMatters(engine, 21, 0), false);
check('the Nether does not, even on 1.18+', depthMatters(engine, 28, -1), false);
check('the End does not, even on 1.18+', depthMatters(engine, 28, 1), false);

console.log('\nrange constants');
check('the default sits inside the range', SEA_LEVEL >= MIN_DEPTH && SEA_LEVEL <= MAX_DEPTH, true);
check('the range is the 1.18+ build range', [MIN_DEPTH, MAX_DEPTH], [-64, 320]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall 2D map checks passed');
process.exit(failures ? 1 : 0);
