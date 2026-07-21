#!/usr/bin/env bash
# utilities.mc — engine build (Parts 3b / 4 / 5).
# Compiles Cubiomes + shim.c to a standalone WASM module via Emscripten, output
# where Vite can serve it from web/.
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="../web/public/wasm"

# Arch ships emcc at /usr/lib/emscripten with no /usr/bin symlink; PATH comes from
# /etc/profile.d/emscripten.sh, which a non-login shell may not have sourced.
if ! command -v emcc >/dev/null 2>&1; then
    [ -f /etc/profile.d/emscripten.sh ] && . /etc/profile.d/emscripten.sh
fi
command -v emcc >/dev/null 2>&1 || { echo "error: emcc not found (see Part 1)" >&2; exit 1; }

if [ ! -f cubiomes/generator.c ]; then
    echo "error: engine/cubiomes not populated — run: git submodule update --init" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"

# EXPORTED_FUNCTIONS must list every shim function you add, each with a leading
# underscore. Forgetting one means it silently vanishes from the module.
# NB: cubiomes/tests.c defines its own main() — including it in the glob collides at
# link time. List sources explicitly rather than globbing, so a future upstream file
# is a deliberate addition instead of a surprise.
emcc \
    cubiomes/biomenoise.c \
    cubiomes/biomes.c \
    cubiomes/finders.c \
    cubiomes/generator.c \
    cubiomes/layers.c \
    cubiomes/noise.c \
    cubiomes/quadbase.c \
    cubiomes/util.c \
    shim.c -O3 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME="createCubiomesModule" \
    -s EXPORTED_FUNCTIONS="['_set_world','_get_biome_at','_gen_biomes','_gen_heights','_biome_colors','_biome_buffer_size','_gen_structures','_gen_strongholds','_structure_id','_str2mc','_mc2str','_biome2str','_malloc','_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','HEAP32','HEAPF32','HEAPU8']" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s WASM_BIGINT=1 \
    -s ENVIRONMENT=web \
    -o "$OUT_DIR/cubiomes.js"

# WASM_BIGINT is set EXPLICITLY above, never left to the toolchain default, because that
# default changed across Emscripten versions and the failure is silent and total.
#
# set_world's seed is `unsigned long long`. With WASM_BIGINT it is one i64 parameter and JS
# passes a BigInt. Without it, Emscripten "legalizes" the parameter into two i32 halves, so
# the export quietly becomes FOUR arguments — set_world(lo, hi, version, dim) — and every
# existing three-argument call is wrong in both arity and type. Nothing errors at build time.
#
# This shipped once: local emcc 6.0.3 (BigInt on by default) built a working map, while CI
# pinned to 3.1.64 (off by default) built a legalized one, and the deployed site could not
# load a world at all. Assert the ABI rather than trusting it.
if ! grep -q 'BigInt' "$OUT_DIR/cubiomes.js"; then
    echo "error: engine glue has no BigInt handling — WASM_BIGINT did not take effect." >&2
    echo "       set_world's i64 seed would be legalized into two i32 args and every" >&2
    echo "       call from JS would be silently wrong. Check the Emscripten version." >&2
    exit 1
fi

echo "engine: built $OUT_DIR/cubiomes.{js,wasm}"
