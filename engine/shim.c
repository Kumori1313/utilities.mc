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
#include <limits.h>
#include "cubiomes/generator.h"

// One generator for the whole module, seeded via set_world().
//
// setupGenerator() + applySeed() is the expensive part of a query — applySeed builds the
// full noise stack. Doing it per lookup is invisible for a point query and ruinous for a
// map tile, which is thousands of samples against one unchanging world. So the world is
// configured once and every query below reuses it.
//
// The cost is hidden state: callers MUST call set_world() before anything else, and again
// whenever seed, version, or dimension changes. Forgetting returns -1 rather than
// producing biomes for whatever world happened to be loaded last — a stale-world bug
// would otherwise look exactly like correct output.
static Generator g;
static int g_ready = 0;

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
// Configure the world. Call before any query, and again on any seed/version/dimension
// change. Returns 0 on success, -1 if the version or dimension is out of range.
EMSCRIPTEN_KEEPALIVE
int set_world(unsigned long long seed, int mc_version, int dim) {
    if (mc_version < MC_B1_7 || mc_version > MC_NEWEST) return -1;
    if (dim != DIM_NETHER && dim != DIM_OVERWORLD && dim != DIM_END) return -1;

    setupGenerator(&g, mc_version, 0);
    applySeed(&g, dim, seed);
    g_ready = 1;
    return 0;
}

// Single-point lookup. Returns the biome id, or -1 on failure.
EMSCRIPTEN_KEEPALIVE
int get_biome_at(int scale, int x, int y, int z) {
    if (!g_ready) return -1;
    if (scale != 1 && scale != 4) return -1;
    return getBiomeAt(&g, scale, x, y, z);
}

// Number of ints the caller must allocate for a gen_biomes() call with these dimensions.
//
// This is NOT always sx*sy*sz: for MC <= 1.17 the layered generator needs extra scratch
// space at the head of the buffer, so getMinCacheSize() can exceed the output volume.
// Allocate what this returns, but only read the first sx*sy*sz entries. Returns -1 on
// failure.
EMSCRIPTEN_KEEPALIVE
int biome_buffer_size(int scale, int sx, int sy, int sz) {
    if (!g_ready) return -1;
    if (sx <= 0 || sz <= 0) return -1;
    if (sy <= 0) sy = 1;

    size_t len = getMinCacheSize(&g, scale, sx, sy, sz);
    if (len == 0 || len > INT_MAX) return -1;
    return (int)len;
}

// Bulk generation: fills `out` with the biome ids of a volume, one applySeed for the lot.
// This is the path a map tile should use — not a get_biome_at() loop.
//
// `out` must have room for biome_buffer_size(scale, sx, sy, sz) ints; allocate it from JS
// with _malloc and free it with _free. Results are indexed out[iy*sx*sz + iz*sx + ix].
//
// Vertical scaling follows Cubiomes: y is in blocks iff scale == 1, otherwise it is in
// biome coordinates (block/4) — the same trap get_biome_at's scale parameter documents.
// Returns 0 on success, non-zero on failure.
EMSCRIPTEN_KEEPALIVE
int gen_biomes(int scale, int x, int y, int z, int sx, int sy, int sz, int *out) {
    if (!g_ready || !out) return -1;
    if (scale != 1 && scale != 4 && scale != 16 && scale != 64 && scale != 256) return -1;
    if (sx <= 0 || sz <= 0) return -1;
    if (sy <= 0) sy = 1;

    Range r = { scale, x, z, sx, sz, y, sy };
    return genBiomes(&g, out, r);
}
