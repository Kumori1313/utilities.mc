# utilities.mc

Browser-based Minecraft utilities: a Cubiomes-backed seed map renderer, an enchantment
calculator, and a Nether/Overworld portal converter. Rust and C compiled to WebAssembly.

## Target Minecraft version: **Java 1.21.3**

This is a hard constraint, not a default. World generation changed substantially across
versions — most drastically at 1.18's noise-based biome overhaul — and enchantment cost
tables are rebalanced between releases. **Output is only correct for 1.21.3.** Pointing
this tool at a world from another version produces confident, plausible, wrong answers.

The pin appears in four places, and all four must move together:

| Where | What it pins |
|---|---|
| `engine/shim.c` | `MC_1_21_3`, and the vendored Cubiomes commit (`e61f905`) |
| `crates/enchant/data/enchantments-1.21.3.json` | enchantment tables + provenance |
| `crates/portal/src/lib.rs` | portal search rules |
| `web/index.html` | the version shown to the user |

## Layout

```
engine/     C: Cubiomes submodule + shim.c, built with Emscripten
app/        Rust: tile math + LRU cache, wasm-bindgen (no C dependency)
crates/     Rust: enchant (calculator), portal (coordinate converter)
web/        Vite + Three.js frontend
scripts/    build-all.sh, validate.mjs, gen-java-vectors.sh
```

`engine/` is the only place C lives. `app/` and `crates/` build on plain
`wasm32-unknown-unknown`; keeping them free of a C dependency is what makes them so.

## Build

```bash
git submodule update --init      # engine/cubiomes
./scripts/build-all.sh           # engine -> app -> web
cd web && npm run dev
```

Needs Rust + `wasm-pack`, Emscripten (`emcc`), and Node. On Arch, everything is in the
official repos — see the build guide's Part 1.

## Validate

```bash
node scripts/validate.mjs --pan
```

Runs the full pipeline (engine → Rust cache → lookups) across several seeds, checks the
guards, reports payload weight, and soaks the cache to confirm it evicts rather than grows.

It then prints a table of seed/coordinate/biome predictions **for you to check against
Chunkbase**. That step is manual on purpose: everything the script checks automatically is
internal consistency, and a wrong dimension or version would be perfectly self-consistent
while being wrong. Self-agreement is not correctness.

## Status

| Component | State |
|---|---|
| Seed map (Parts 0–8) | Pipeline verified end to end; renderer not yet visually reviewed |
| Portal converter | Complete |
| Enchantment calculator | Table roll cross-referenced against an external calculator; anvil calculator (10.6) built, its rules pinned to the wiki but **not yet cross-checked against a real anvil** |

The enchantment calculator's offered-level seeding, its material enchantability values,
and its roll sequence are each individually plausible and none has been confirmed against
in-game output. It will produce confident predictions regardless. Treat it as unverified
until golden vectors exist.
