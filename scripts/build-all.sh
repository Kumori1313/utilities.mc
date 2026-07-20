#!/usr/bin/env bash
# utilities.mc — full build. Order matters: engine, then app, then web.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> engine (Cubiomes via Emscripten)"
"$ROOT/engine/build.sh"

echo "==> app (Rust via wasm-pack)"
cd "$ROOT/app" && wasm-pack build --target web

# Publish the app module where web/ can import it. app/pkg is gitignored build output,
# so this copy is what makes the two modules loadable from one page.
echo "==> publishing app/pkg -> web/public/app"
rm -rf "$ROOT/web/public/app"
mkdir -p "$ROOT/web/public/app"
cp "$ROOT/app/pkg/app.js" "$ROOT/app/pkg/app_bg.wasm" "$ROOT/web/public/app/"

echo "==> web (Vite)"
if [ -f "$ROOT/web/package.json" ]; then
    cd "$ROOT/web" && npm run build
else
    echo "  skipped: web/ not scaffolded yet (Part 7)"
fi

echo "==> done"
