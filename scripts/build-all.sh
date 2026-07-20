#!/usr/bin/env bash
# utilities.mc — full build. Order matters: engine, then app, then web.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> engine (Cubiomes via Emscripten)"
"$ROOT/engine/build.sh"

echo "==> app (Rust via wasm-pack)"
cd "$ROOT/app" && wasm-pack build --target web

echo "==> web (Vite)"
if [ -f "$ROOT/web/package.json" ]; then
    cd "$ROOT/web" && npm run build
else
    echo "  skipped: web/ not scaffolded yet (Part 7)"
fi

echo "==> done"
