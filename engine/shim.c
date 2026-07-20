// utilities.mc — Cubiomes shim (Parts 3b / 5).
//
// Keep the exported surface SMALL and FLAT: plain integers, floats, and raw pointers
// to buffers. Emscripten can marshal more, but simple C ABI functions are far easier
// to call correctly from ccall/cwrap. Anything returning more than a scalar should
// write into a pre-allocated buffer instead of returning a struct by value.
//
// TARGET MINECRAFT VERSION: 1.21.3  (MC_1_21_3 == 27 in the vendored biomes.h)
// Per Part 8 this is a hard constraint: world generation changed substantially across
// versions (most drastically at 1.18), so this tool is only correct for the version
// pinned here and the Cubiomes commit vendored in ./cubiomes (e61f905).
//
// 1.21.3 is the newest *stable* version this Cubiomes commit knows. MC_NEWEST (28)
// points at MC_1_21_WD, the unreleased Winter Drop — don't target it.
//
// Callers pass the version as an int. Prefer resolving it via the exported str2mc()
// ("1.21.3" -> 27) over hardcoding the number: the enum is positional, so vendoring a
// newer Cubiomes can renumber it underneath you.

#include <emscripten.h>
#include "cubiomes/generator.h"

// Signatures verified against the vendored cubiomes/generator.h at e61f905.
// Re-verify if you bump the submodule — Cubiomes' API shifts between releases.
//
// `scale` selects the coordinate space of x/y/z, and Cubiomes accepts only 1 or 4:
//   1 — block coordinates. What a user types into a "go to coordinate" box.
//   4 — biome coordinates, i.e. block/4. One sample per 4x4x4 cell, so a map tile
//       costs 16x fewer calls. Use this for rendering, not for point lookups.
// Passing block coordinates with scale=4 silently queries a point 4x further out in
// every axis rather than erroring, so callers must be explicit — hence the parameter.
// Anything other than 1 or 4 is rejected here instead of being handed to Cubiomes.
EMSCRIPTEN_KEEPALIVE
int get_biome_at(unsigned long long seed, int mc_version, int scale, int x, int y, int z) {
    if (scale != 1 && scale != 4) return -1;

    Generator g;
    setupGenerator(&g, mc_version, 0);
    applySeed(&g, DIM_OVERWORLD, seed);
    return getBiomeAt(&g, scale, x, y, z);
}
