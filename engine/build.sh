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
    -s EXPORTED_FUNCTIONS="['_set_world','_get_biome_at','_gen_biomes','_gen_heights','_biome_colors','_biome_buffer_size','_str2mc','_mc2str','_biome2str','_malloc','_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','HEAP32','HEAPF32','HEAPU8']" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web \
    -o "$OUT_DIR/cubiomes.js"

echo "engine: built $OUT_DIR/cubiomes.{js,wasm}"
