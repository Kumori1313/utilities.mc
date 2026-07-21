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
#include <math.h>
#include "cubiomes/generator.h"
#include "cubiomes/finders.h"
#include "cubiomes/util.h"
#include <string.h>

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

// Surface noise for mapApproxHeight(). Kept alongside the generator and re-initialised by
// the same set_world() call, because a height field from one seed over biomes from another
// would render as plausible terrain in the wrong shape.
static SurfaceNoise g_sn;

// Signatures verified against the vendored cubiomes/generator.h at e61f905.
// Re-verify if you bump the submodule — Cubiomes' API shifts between releases.

// Configure the world. Call before any query, and again on any seed/version/dimension
// change. Returns 0 on success, -1 if the version or dimension is out of range.
EMSCRIPTEN_KEEPALIVE
int set_world(unsigned long long seed, int mc_version, int dim) {
    if (mc_version < MC_B1_7 || mc_version > MC_NEWEST) return -1;
    if (dim != DIM_NETHER && dim != DIM_OVERWORLD && dim != DIM_END) return -1;

    setupGenerator(&g, mc_version, 0);
    applySeed(&g, dim, seed);
    initSurfaceNoise(&g_sn, dim, seed);
    g_ready = 1;
    return 0;
}

// Fill `out` with Cubiomes' biome colour table: 256 entries of RGB, 768 bytes total.
//
// Uses the library's own palette (AMIDST-derived, extended for 1.18+) rather than a
// hand-written one, so colours stay consistent with every other Cubiomes-based map and do
// not drift as biomes are added.
EMSCRIPTEN_KEEPALIVE
int biome_colors(unsigned char *out) {
    if (!out) return -1;
    initBiomeColors((unsigned char(*)[3])out);
    return 0;
}

// Approximate Overworld surface height, with the biome at that surface.
//
// The height is an APPROXIMATION (np[NP_DEPTH]/76.0) — the exact surface needs the full
// density/aquifer simulation Cubiomes does not do cheaply. Good enough to shape terrain and
// pick the surface biome, but not an exact y.
//
// ACCURACY, corrected: an earlier note here claimed "within ~5 blocks, mixed sign" from a
// small sample. A later 6-point check against Chunkbase found five within 2 blocks but one off
// by **14** (approx 55 against a real 69). So the error is usually small and occasionally much
// larger — which is why this must not be used for anything with a threshold, such as deciding
// whether a structure site is above water (see the guide's 12.6). The resampled id below inherits that: if the approximate
// height crosses a vertical biome band it could pick a neighbour. Verified correct on the
// delicate cases (e.g. a snowy_taiga/snowy_beach coast matched Chunkbase), but it is a
// dependency, not a guarantee.
//
// Fixed 1:4 horizontal scale — x/z/w/h are BIOME coordinates, not blocks. Unlike
// gen_biomes there is no scale parameter, because Cubiomes' mapApproxHeight offers none.
//
// `y_out` receives w*h floats (height in blocks); `ids_out`, if non-NULL, receives w*h
// biome ids. Both are row-major, out[j*w + i], matching gen_biomes.
//
// IDs ARE RESAMPLED AT THE SURFACE, deliberately not taken from mapApproxHeight's own id
// output. That output comes from sampleBiomeNoise(..., y=0, ...) — i.e. the biome at
// y=0, not at the terrain surface. Since 1.18 biomes are three-dimensional, so for many
// seeds those ids are CAVE biomes: at seed 42 the origin reports lush_caves where the
// surface is dark_forest, and 3098 of 4096 cells in one tile disagree. Colouring terrain
// with them produces a map that looks entirely plausible and is wrong.
//
// The resampling loop lives here rather than in the caller so it costs no JS boundary
// crossings and cannot be forgotten by a second caller.
//
// Overworld only: Cubiomes returns a sentinel for the Nether (a flat 127) and for the End,
// rather than filling the buffer. Those are surfaced as -1 here so a caller cannot mistake
// an unwritten buffer for flat terrain.
EMSCRIPTEN_KEEPALIVE
int gen_heights(int x, int z, int w, int h, float *y_out, int *ids_out) {
    if (!g_ready || !y_out) return -1;
    if (w <= 0 || h <= 0) return -1;
    if (g.dim != DIM_OVERWORLD) return -1;

    if (mapApproxHeight(y_out, NULL, &g, &g_sn, x, z, w, h) != 0) return -1;

    if (ids_out) {
        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) {
                float hy = y_out[j*w + i];
                // getBiomeAt's y is in biome coordinates at scale 4, so height/4.
                int cy = (int)floorf(hy / 4.0f);
                ids_out[j*w + i] = getBiomeAt(&g, 4, x + i, cy, z + j);
            }
        }
    }
    return 0;
}

// Single-point lookup. Returns the biome id, or -1 on failure.
//
// `scale` selects the coordinate space of x/y/z, and Cubiomes accepts only 1 or 4:
//   1 — block coordinates. What a user types into a "go to coordinate" box.
//   4 — biome coordinates, i.e. block/4. One sample per 4x4x4 cell, so a map tile
//       costs 16x fewer calls. Use this for rendering, not for point lookups.
// Passing block coordinates with scale=4 silently queries a point 4x further out in
// every axis rather than erroring, so callers must be explicit — hence the parameter.
// Anything other than 1 or 4 is rejected here instead of being handed to Cubiomes.
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

// ---- structures (Part 12.4) -------------------------------------------------------------

// Resolve a structure name to Cubiomes' StructureType. Prefer this over hardcoding the int
// in JS, for the same reason str2mc() exists: the enum is positional, so vendoring a newer
// Cubiomes can renumber it underneath you.
//
// Structure placement has changed across versions (salts, region sizes, viability rules), so
// each type is a separate correctness claim and none is implied by the shared code path.
//
// VERIFIED against Chunkbase (seed 1 / 1.21.3): village, monument, mansion, stronghold, and
// the nearest three of each remaining type — 31 of 33 positions matched.
//
// KNOWN LIMIT, and the reason those two did not: isViableStructurePos is documented as
// performing "a biome check ... to determine whether a structure COULD spawn there". It is a
// necessary condition, not a sufficient one, so this can report a position the game declines
// to generate. False positives are possible; false negatives are not. Ruled out for the two
// known cases: biome is valid at every sampled y, the position is its region's genuine
// candidate with no near alternative, and it is identical across 1.20.6 through 1.21_WD. See
// the guide's 12.6 for the full write-up — and do not paper over it with a terrain heuristic.
// Every dimension's types live here; gen_structures refuses any whose dimension does not
// match the loaded generator, so the caller must offer only the ones matching set_world's dim.
//
// Left out on density grounds, not cost: the per-chunk Overworld types (Treasure, Mineshaft,
// Desert_Well, Geode) — geodes alone are ~620 per default-zoom viewport, noise rather than
// information. End_Island is left out for the opposite reason: measured at seed 1 it is viable
// for 0 of 1,162 candidates near the origin and 0 of 1,212 out at (12000, 12000), so exposing
// it would only ever draw an empty layer.
EMSCRIPTEN_KEEPALIVE
int structure_id(const char *name) {
    if (!name) return -1;
    if (!strcmp(name, "village"))         return Village;
    if (!strcmp(name, "outpost"))         return Outpost;
    if (!strcmp(name, "desert_pyramid"))  return Desert_Pyramid;
    if (!strcmp(name, "jungle_temple"))   return Jungle_Temple;
    if (!strcmp(name, "swamp_hut"))       return Swamp_Hut;
    if (!strcmp(name, "igloo"))           return Igloo;
    if (!strcmp(name, "monument"))        return Monument;
    if (!strcmp(name, "ocean_ruin"))      return Ocean_Ruin;
    if (!strcmp(name, "shipwreck"))       return Shipwreck;
    if (!strcmp(name, "mansion"))         return Mansion;
    if (!strcmp(name, "ancient_city"))    return Ancient_City;
    if (!strcmp(name, "trail_ruins"))     return Trail_Ruins;
    if (!strcmp(name, "trial_chambers"))  return Trial_Chambers;
    if (!strcmp(name, "ruined_portal"))   return Ruined_Portal;
    if (!strcmp(name, "treasure"))        return Treasure;
    if (!strcmp(name, "stronghold"))      return -2; // separate algorithm; see gen_strongholds
    // Nether
    if (!strcmp(name, "fortress"))        return Fortress;
    if (!strcmp(name, "bastion"))         return Bastion;
    if (!strcmp(name, "ruined_portal_n")) return Ruined_Portal_N;
    // End
    if (!strcmp(name, "end_city"))        return End_City;
    if (!strcmp(name, "end_gateway"))     return End_Gateway;
    return -1;
}

// Minimum End surface height for an End city, in blocks.
//
// isViableStructurePos checks only the biome, and for End cities that is badly insufficient:
// of 2,837 biome-viable candidates within 20k blocks of seed 1's origin, only ~18% actually
// generate. The rest sit on terrain too low — including 375 over open void, where the biome is
// still end_midlands or end_highlands because in 1.18+ biome assignment and terrain are
// independent noise systems.
//
// 61 is measured, not guessed: 18 candidates were checked against Chunkbase on seed 1 /
// 1.21.3, and they separate perfectly on this value. Every one at height >= 61 exists (61, 63,
// 63, 63); every one at <= 60 does not (60, 60, 59, 59, 58, 57, 57, 57, 56, 56, and three over
// void). The boundary was narrowed deliberately: candidates at exactly 59 and 60 were checked
// once the coarse split was known, because the height distribution piles up there — 358 at 59
// and 282 at 60 — so guessing within (58, 61] would have mis-drawn more than half the layer.
//
// getEndSurfaceHeight is Cubiomes' own End terrain model, not a heuristic invented here. That
// is the difference from the low-lying desert-pyramid false positives in the guide's 12.6,
// where no height model existed and a threshold would have been reverse-engineered from two
// cases.
#define END_CITY_MIN_Y 61

// Region indices use Cubiomes' own floordiv (rng.h): region -1 must map to the region left
// of the origin, not to region 0. Truncating toward zero would duplicate region 0 and drop
// a region on each negative axis — the same trap the tile math documents.
//
// Confirmed structure positions inside a block-coordinate box, as (x,z) pairs.
//
// Two steps, and the second is the one that matters. getStructurePos returns where a
// structure would be ATTEMPTED in a region; isViableStructurePos checks whether the biome
// and terrain there actually permit it. Returning candidates unchecked paints structures
// that are not in the world — output that looks entirely plausible and is wrong, the same
// failure mode as the y=0 cave-biome bug.
//
// Region size comes from getStructureConfig for the loaded version, never hardcoded: it
// varies by structure type AND by version.
//
// `out` receives up to max_pairs (x,z) pairs. Returns the count written, -1 on error, or
// -2 if the buffer filled before the box was covered.
EMSCRIPTEN_KEEPALIVE
int gen_structures(int stype, int x0, int z0, int x1, int z1, int *out, int max_pairs) {
    if (!g_ready || !out || max_pairs <= 0) return -1;
    if (x1 < x0 || z1 < z0) return -1;

    StructureConfig sc;
    if (!getStructureConfig(stype, g.mc, &sc)) return -1; // type absent in this version
    if (sc.dim != g.dim) return -1;                       // wrong dimension loaded

    int span = sc.regionSize * 16; // regionSize is in chunks
    if (span <= 0) return -1;

    int n = 0;
    for (int rz = floordiv(z0, span); rz <= floordiv(z1, span); rz++) {
        for (int rx = floordiv(x0, span); rx <= floordiv(x1, span); rx++) {
            Pos p;
            if (!getStructurePos(stype, g.mc, g.seed, rx, rz, &p)) continue;
            if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
            if (!isViableStructurePos(stype, &g, p.x, p.z, 0)) continue;
            // Second gate, End cities only: the biome check passes over void and low terrain
            // where no city generates. See END_CITY_MIN_Y.
            if (stype == End_City
                && getEndSurfaceHeight(g.mc, g.seed, p.x, p.z) < END_CITY_MIN_Y) continue;
            if (n >= max_pairs) return -2;
            out[n * 2] = p.x;
            out[n * 2 + 1] = p.z;
            n++;
        }
    }
    return n;
}

// Slime chunks over a rectangle of CHUNK coordinates; `out` receives w*h bytes, 1 or 0.
//
// Bulk like gen_biomes rather than a per-chunk export, because the caller wants a whole
// screenful at once — a zoomed-in view is tens of thousands of chunks, and that many
// individual calls is the pattern this shim exists to avoid.
//
// Slime chunks depend only on the world seed's low 48 bits: not on the version, not on the
// dimension, and not on biomes. They are still Overworld-only in practice (slimes spawn
// there), which is the caller's business, not this function's.
EMSCRIPTEN_KEEPALIVE
int gen_slime_chunks(int cx, int cz, int w, int h, unsigned char *out) {
    if (!g_ready || !out) return -1;
    if (w <= 0 || h <= 0) return -1;

    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            out[j * w + i] = (unsigned char)(isSlimeChunk(g.seed, cx + i, cz + j) != 0);
        }
    }
    return 0;
}

// World spawn, as a block (x,z) pair written to `out`. Returns 0, or -1 if unavailable.
//
// getSpawn runs a real search rather than a lookup, so callers should ask once per world and
// keep the answer — see the note on its cost where it is called.
EMSCRIPTEN_KEEPALIVE
int world_spawn(int *out) {
    if (!g_ready || !out) return -1;
    if (g.dim != DIM_OVERWORLD) return -1; // spawn is an Overworld concept
    Pos p = getSpawn(&g);
    out[0] = p.x;
    out[1] = p.z;
    return 0;
}

// Stronghold positions as (x,z) pairs, nearest-first from the origin.
//
// Strongholds are NOT placed one-per-region: they sit in rings (3 in the first, then 6, 10,
// ...) and are found by iteration, so they cannot be folded into the region loop above.
// There are ~128 in a modern world and they do not depend on the view, so the caller can
// fetch the lot once and filter locally.
//
// TEST THE RETURN BEFORE USING THE POSITION. finders.h documents nextStronghold as returning
// "the number of further strongholds after this one", but the implementation increments
// sh->index before returning `128 - (index-1)` — i.e. the count INCLUDING the one just
// resolved. Recording first and testing after, as that comment invites, therefore resolves a
// phantom 129th stronghold: a plausible position, at a plausible ring distance, that is not
// in the game. Checked: this loop yields 128, the real count for MC >= 1.9.
EMSCRIPTEN_KEEPALIVE
int gen_strongholds(int *out, int max_pairs) {
    if (!g_ready || !out || max_pairs <= 0) return -1;
    if (g.dim != DIM_OVERWORLD) return -1;

    StrongholdIter sh;
    initFirstStronghold(&sh, g.mc, g.seed);
    int n = 0;
    while (n < max_pairs) {
        if (nextStronghold(&sh, &g) <= 0) break;
        out[n * 2] = sh.pos.x;
        out[n * 2 + 1] = sh.pos.z;
        n++;
    }
    return n;
}
