# utilities.mc — Build Guide

**`utilities.mc`** is a browser-based suite of Minecraft utilities, written in Rust and
compiled to WebAssembly. Three tools share one codebase and one deployment:

| Tool | Guide | Depends on |
|---|---|---|
| **Seed map renderer** — 2D/3D biome & terrain view for any seed | Parts 0–9, 12 | Cubiomes (C, via Emscripten) |
| **Enchantment calculator** — predicts enchanting-table results and anvil combine costs | Part 10 | Pure Rust |
| **Nether ↔ Overworld converter** — portal coordinate & linking math | Part 11 | Pure Rust |

The seed map is the hard one, and it sets the architecture for everything else; the other two
are pure Rust with no C dependency and can be built in parallel or first.

---

## Building the Seed Map Renderer — Start to Finish

A phased, checkable build plan: prerequisites → native validation → the critical WASM
spike → application → frontend → deployment. Every phase ends before the next begins —
don't skip ahead, especially past Part 3.

---

## Part 0 — Read This First: The Architecture Fork

Everything discussed so far (Cubiomes, `cubiomes-sys`, `cubiomes`) has been about calling
a **C library from Rust**. That's easy on a native target (your laptop, a server). It gets
genuinely harder the moment the target is **a browser**, because of one specific fact:

> `wasm32-unknown-unknown` — the target `wasm-pack` and `wasm-bindgen` use — has **no libc**.
> It only supports Rust's `core`/`alloc` and a partial `std`. Cubiomes' C code calls
> `malloc`, `memcpy`, `sin`, `pow`, `floor`, etc. from the standard library. Those symbols
> won't exist to link against on that target, and the build will fail with undefined-symbol
> linker errors.

This isn't a hypothetical — it's a well-documented, long-standing rough edge in the Rust/C/WASM
ecosystem, which is exactly why we validate it with a tiny spike in **Part 3** before writing
a single line of real application code.

There are two ways through it:

- **Path A (recommended): Split the build.** Compile Cubiomes to its *own* standalone WASM
  module using **Emscripten** (which ships its own browser-friendly libc), and keep your
  Rust code as a *separate* `wasm-bindgen` module for app logic (state, caching, math, UI
  glue). JavaScript sits in the middle and calls both. This is exactly the pattern used by
  existing open-source browser biome viewers built on Cubiomes — proven, not experimental.
- **Path B (harder, more "pure Rust"): Target `wasm32-wasip1`.** This target *does* support
  C interop (via the WASI SDK toolchain) and could let `cubiomes-sys` compile as one unit
  with your Rust code. The catch: browsers don't natively speak WASI, so you need a
  polyfill/shim to run the result on a webpage, and the existing `cubiomes-sys`/`cubiomes`
  crates weren't necessarily built or tested with this cross-compilation target in mind.

**This guide builds Path A** as the main line, since it's the lower-risk, precedented route
for a *website* specifically. Path B is documented in Appendix B if you want to attempt it —
treat it as an experiment, not a fallback you can rely on working first try.

```
┌─────────────────────┐        ┌──────────────────────┐
│   Cubiomes (C)       │ emcc   │  cubiomes.wasm +      │
│   generator.c etc.   ├───────▶│  cubiomes.js (glue)   │
└─────────────────────┘        └──────────┬────────────┘
                                            │  ccall / cwrap
┌─────────────────────┐        ┌──────────▼────────────┐
│  Your Rust app logic │ wasm-  │   app.wasm +           │
│  (state, cache, math)├───────▶│   app.js (wasm-bindgen)│
└─────────────────────┘  pack   └──────────┬────────────┘
                                            │
                                 ┌──────────▼────────────┐
                                 │  Frontend (Vite + JS)  │
                                 │  orchestrates both,    │
                                 │  renders with Three.js │
                                 └────────────────────────┘
```

---

## Part 1 — Prerequisites & Tooling

Install everything up front so later phases aren't interrupted.

### Arch Linux (the reference environment)

Everything this project needs is in the official repos — no emsdk clone, no `cargo install`:

```bash
sudo pacman -S --needed rust rust-wasm wasm-pack emscripten \
                        nodejs npm cmake git clang
```

- `rust` — compiler + cargo. **This project uses the distro toolchain, not rustup.** Arch's
  `rustup` package *conflicts with* `rust`/`cargo`/`rustfmt` and installing it removes them;
  there's no need for that here, since `rust-wasm` supplies the targets we'd otherwise add with
  `rustup target add`. If you later want per-project toolchain pinning (`rust-toolchain.toml`),
  that's the point to reconsider — it's the one thing this setup gives up.
- `rust-wasm` — the `wasm32-unknown-unknown` std (and `wasm32-wasip1`, which covers Appendix B's
  Rust side for free; Path B would still need a separate wasi-sdk for the C half)
- `emscripten` — provides `emcc`. There is no `emsdk_env.sh` to source per shell and no SDK
  checkout to maintain, but note the binary is at `/usr/lib/emscripten/emcc` with **no
  `/usr/bin` symlink**; the package adds that directory to PATH via
  `/etc/profile.d/emscripten.sh`. That file is read at shell startup, so **`emcc` will not be
  found in a shell that was already open when you installed it** — open a new terminal, or
  `source /etc/profile.d/emscripten.sh`. Use `/usr/lib/emscripten` if something later asks for
  an `EMSDK` path. It conflicts with `binaryen` (Emscripten vendors its own copy), so pacman
  will offer to replace that package if you have it.
- `clang` — for Part 2's native build only, unrelated to anything WASM

### Other platforms

Same components, different sourcing. Use [rustup](https://rustup.rs) plus
`rustup target add wasm32-unknown-unknown` and `cargo install wasm-pack`, and install Emscripten
via the [emsdk](https://github.com/emscripten-core/emsdk) checkout
(`./emsdk install latest && ./emsdk activate latest`, then `source ./emsdk_env.sh` **in every new
shell session** — the main ergonomic difference from the packaged build above). Node.js LTS,
CMake, Git, and a C compiler come from your platform's usual channels.

### Regardless of platform

- [ ] **A code editor with `rust-analyzer`** (VS Code + rust-analyzer extension is the
      path of least resistance)
- [ ] *(Path B only, skip for now)* **wasi-sdk** — see Appendix B

**Checkpoint:** `rustc --version`, `wasm-pack --version`, `node -v`, `emcc --version`,
`cmake --version` all return something without error. Confirm the WASM target is present too —
`rustc --print target-list | grep wasm32-unknown-unknown`, and that a trivial
`cargo build --target wasm32-unknown-unknown` on a `cargo new --lib` scratch crate succeeds.

---

## Part 2 — De-risk on Native First (Don't Touch WASM Yet)

Goal: prove your understanding of Cubiomes' API and confirm correct output **before**
adding WASM cross-compilation as a second variable. If something's wrong later, you want
to already know the generation logic itself is sound.

- [ ] Create a throwaway project: `cargo new seedmap-native-check && cd seedmap-native-check`
- [ ] Add the crate: `cargo add cubiomes` (this pulls in `cubiomes-sys` and statically
      links Cubiomes for your native platform via the `cc` crate — no WASM involved yet)
- [ ] Check **docs.rs for the `cubiomes` crate** before writing code — its own
      documentation notes it's still incomplete, so confirm the specific function you need
      (biome-at-point, at minimum) is actually exposed in the safe wrapper. If it isn't,
      you'll be reaching into `cubiomes-sys`'s raw bindings directly instead.
- [ ] Write a minimal `main.rs` that: initializes a generator for a specific Minecraft
      version, applies a known seed, and queries the biome at a specific coordinate
- [ ] `cargo run` and check the output
- [ ] **Validate against ground truth**: take that same seed and coordinate, look it up on
      an established site (e.g. Chunkbase) for the *same game version*, and confirm the
      biome matches. Don't skip this — it's the cheapest point in the whole project to
      catch an off-by-one in coordinates, a wrong dimension, or a version mismatch.

**Checkpoint:** native binary reproduces a known seed's biome correctly. If this doesn't
match, stop and fix it here — everything downstream depends on this being right, and it's
far easier to debug without WASM in the mix.

---

## Part 3 — The Critical Spike: Prove the WASM Path Before Building Anything Else

This is the phase that determines your architecture. Budget real time for it before
committing to app code.

### 3a. Confirm the failure mode (so you're not debugging blind later)

- [ ] In the same throwaway project, try the naive thing:
  ```bash
  cargo add wasm-bindgen
  wasm-pack build --target web
  ```
- [ ] **Expect this to fail** if `cubiomes`/`cubiomes-sys` is still a dependency, with
      linker errors referencing undefined symbols like `malloc`, `memcpy`, `sinf`, or
      similar. This is the libc problem from Part 0 — seeing it once yourself means you'll
      recognize it instantly if it resurfaces elsewhere.
- [ ] Remove the C dependency from this particular crate once you've seen the failure —
      confirm a *pure-Rust* `wasm-pack build --target web` succeeds on its own. This
      isolates the problem cleanly: pure Rust → fine; Rust + this particular C dependency →
      breaks specifically at the libc boundary.

### 3b. Build the Path A spike: Cubiomes via Emscripten, standalone

- [ ] In a **separate** folder (this is not a Rust project — it's a small C project), write
      a tiny shim file that wraps just the one function you need, e.g.:
  ```c
  // shim.c
  #include <emscripten.h>
  #include "generator.h"   // from the Cubiomes repo

  EMSCRIPTEN_KEEPALIVE
  int get_biome_at(unsigned long long seed, int mc_version, int x, int y, int z) {
      Generator g;
      setupGenerator(&g, mc_version, 0);
      applySeed(&g, DIM_OVERWORLD, seed);
      return getBiomeAt(&g, 4, x, y, z);
  }
  ```
  Treat the exact function/struct names as approximate — check them against the current
  `generator.h` in the Cubiomes repo you clone, since library internals shift between
  releases.
- [ ] Clone Cubiomes alongside it, then compile with Emscripten:
  ```bash
  emcc cubiomes/*.c shim.c -O3 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME="createCubiomesModule" \
    -s EXPORTED_FUNCTIONS="['_get_biome_at']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=web \
    -o cubiomes.js
  ```
- [ ] Write a **5-line HTML file** that imports `cubiomes.js` as an ES module, calls
      `createCubiomesModule()`, uses `cwrap` to call `get_biome_at`, and
      `console.log`s the result
- [ ] Open it (via a local static server — `npx serve .` works) and confirm you get a
      sane integer back, matching what Part 2 produced for the same seed/coordinate

**Checkpoint — go/no-go:** you have a working `.wasm` + `.js` pair, loadable from plain
HTML, returning correct biome data. This is the hardest technical risk in the whole
project, and it's now retired *before* you've written any real app code.

---

## Part 4 — Project Layout

With the spike proven, set up the real repo:

```
seedmap/
├── engine/              # C: Cubiomes checkout + your shim.c, builds via emcc
│   ├── cubiomes/         # (submodule or vendored copy)
│   ├── shim.c
│   └── build.sh          # wraps the emcc command from Part 3
├── app/                  # Rust: state, caching, coordinate math — wasm-bindgen target
│   ├── Cargo.toml
│   └── src/lib.rs
├── web/                   # Vite project: HTML/JS/Three.js frontend
│   ├── index.html
│   ├── package.json
│   └── src/
└── scripts/
    └── build-all.sh       # runs engine build, then app build, then web build
```

- [ ] Scaffold the four directories
- [ ] Get `engine/build.sh` running the Part 3 emcc command against the real vendored
      Cubiomes source, outputting into a location `web/` can import from (e.g. `web/public/wasm/`)

---

## Part 5 — Build the Generation Layer (`engine/`)

- [ ] Vendor Cubiomes into `engine/cubiomes` (as a git submodule is cleanest, so you can
      pin a specific commit/version)
- [ ] Expand `shim.c` beyond the single spike function. Practical guidance:
  - Keep the exported surface **small and flat** — plain integers, floats, and raw
    pointers to buffers. Emscripten *can* marshal more complex data, but simple C ABI
    functions are far easier to call from `ccall`/`cwrap` correctly.
  - For anything returning more than a scalar (e.g., a whole chunk's worth of biome IDs),
    have the C side write into a pre-allocated buffer and expose separate `alloc`/`free`
    helpers, rather than trying to return structs by value.
  - Common functions worth exposing early: biome-at-point, biome-at-region (batched, for
    a whole chunk at once — far fewer JS↔WASM calls than one-at-a-time), and structure
    location queries (villages, strongholds, etc., if you want those markers).
- [ ] Add `-s ALLOW_MEMORY_GROWTH=1` (already in the spike command) — generating larger
      regions can need more memory than Emscripten's conservative default
- [ ] Re-run the build, confirm each newly exported function independently from a plain
      JS test page before wiring it into the real frontend

**Checkpoint:** `engine/build.sh` reliably produces a working `cubiomes.wasm` +
`cubiomes.js` pair with every function you plan to use, each spot-tested from bare JS.

---

## Part 6 — Build the Rust Application Layer (`app/`)

This crate holds **no C dependency at all** — that's the whole point of the split. It's
pure Rust, targeting `wasm32-unknown-unknown` normally, with none of Part 3's problems.

- [ ] `cd app && cargo init --lib`
- [ ] `cargo add wasm-bindgen`
- [ ] In `Cargo.toml`, set:
  ```toml
  [lib]
  crate-type = ["cdylib", "rlib"]
  ```
- [ ] Import the Cubiomes-via-JS functions as **external JS bindings** so Rust can call
      out to them (JS orchestrates loading `cubiomes.js`; Rust just calls a JS function
      that's already been set up on `window` or passed in):
  ```rust
  use wasm_bindgen::prelude::*;

  #[wasm_bindgen]
  extern "C" {
      #[wasm_bindgen(js_namespace = window)]
      fn get_biome_at(seed: u64, version: i32, x: i32, y: i32, z: i32) -> i32;
  }

  #[wasm_bindgen]
  pub fn biome_for_view(seed: u64, version: i32, cx: i32, cz: i32) -> i32 {
      // your app logic — caching, coordinate transforms, chunk-batching — lives here
      get_biome_at(seed, version, cx, 64, cz)
  }
  ```
- [ ] This is where the things that are genuinely Rust's strengths belong: view-state
      management, an LRU-style cache so re-visited chunks don't re-query Cubiomes,
      coordinate/chunk math, and any post-processing on the raw biome/height data before
      it reaches the renderer
- [ ] **NB — this snippet is a smoke test, not the shape to ship.** Passing `seed, version` on
      every call implies re-seeding the generator per sample, and in Cubiomes that re-runs
      `applySeed` — measured at roughly **13× the cost of generating a whole tile**. Split the C
      side into a `set_world(seed, version, dim)` called once when the world changes and a query
      that takes only coordinates. Measured separately: batching many samples into one
      `gen_biomes` call rather than one `get_biome_at` per sample is **not** a meaningful win
      (biome generation dominates the JS↔WASM boundary cost by orders of magnitude); the reason
      to work in tiles is the *cache*, not the batching.
- [ ] Build it: `wasm-pack build --target web`
- [ ] Confirm it produces `app/pkg/` with the `.wasm` and JS glue, and that a plain test
      page can import both `app`'s output and `cubiomes.js` side by side

**Checkpoint:** two independent WASM modules, both loadable from plain JS, with your Rust
functions successfully calling out to the Cubiomes JS glue and returning correct data.

---

## Part 7 — Build the Frontend (`web/`)

- [ ] `npm create vite@latest web -- --template vanilla` (or `vanilla-ts` if you want
      TypeScript — recommended here, since you're juggling two WASM modules' function
      signatures and types genuinely help)
- [ ] Add Three.js: `npm install three`
- [ ] Copy or symlink `engine`'s build output and `app/pkg` into `web/public/` or
      `web/src/wasm/` so Vite can serve/bundle them
- [ ] Wire up module loading in your entry point — load `cubiomes.js`'s module factory
      first, expose its `ccall`/`cwrap`-wrapped functions on `window` (matching the
      `js_namespace = window` binding from Part 6), *then* import and initialize the
      `app` wasm-bindgen module, since Rust's calls depend on Cubiomes already being ready
- [ ] **NB — the `window` globals and the "load order is load-bearing" ordering only apply if
      Rust calls *out* to Cubiomes** (the Part 6 sketch's design). If you instead let JS drive the
      loop — JS calls `gen_biomes`/`gen_heights`, copies the buffer out of the Emscripten heap, and
      hands it to Rust via a `store_tile`-style function — then nothing on the Rust side reaches for
      `window`, the two modules load independently, and their order stops mattering. The
      JS-drives-Rust direction is also what lets `app` stay a plain `wasm32-unknown-unknown` module
      with no `window` coupling. Note too that the wasm-bindgen `app.js`/`app_bg.wasm` live in
      `public/` and are *served*, not bundled, so import them at runtime (a dynamic `import()`),
      not with a static import Vite/Rollup will try to resolve at build time.
- [ ] **Heightmap → mesh**: for each visible chunk, pull height/biome data from your Rust
      layer, build a `THREE.PlaneGeometry` (or a manual `BufferGeometry` for more control),
      and displace vertex heights based on the returned elevation values
- [ ] **Biome texturing**: color or texture each face/vertex based on biome ID, layered
      with basic directional lighting so slopes and cliffs read clearly
- [ ] **Chunked/LOD loading**: only generate detailed mesh geometry for chunks near the
      camera; drop or simplify geometry further out. This isn't optional polish — without
      it, the browser will choke trying to mesh large regions at once
- [ ] **Vegetation layer (optional, later)**: simple instanced meshes for trees, added as
      a separate lightweight pass, not part of the terrain mesh itself

**Checkpoint:** a page that loads both WASM modules, renders a navigable 3D chunk of
terrain for a given seed, colored by biome.

---

## Part 8 — Validate & Test

- [ ] Spot-check several seeds/coordinates against Chunkbase (or your own in-game
      exploration) again, now through the *full* pipeline, not just the Part 2/3 spikes
- [ ] **Pin your target Minecraft version explicitly**, and treat it as a hard constraint
      documented somewhere visible (e.g. a comment in `shim.c` and a line in your README).
      Mojang has substantially changed world generation across versions (most drastically
      at 1.18's noise-based biome overhaul) — a seed map is only accurate for the version
      it was generated against, and your whole tool is implicitly tied to whichever
      Cubiomes version/commit you vendored
- [ ] Test initial load performance — two WASM modules plus Three.js is real payload
      weight; check load time on a throttled connection, not just localhost
- [ ] Test memory behavior while panning around a large area for a while (confirm
      `ALLOW_MEMORY_GROWTH` is doing its job and nothing leaks unbounded)

---

## Part 9 — Deploy

Everything here is static output — no server-side compute needed, since generation
happens client-side in the browser.

- [ ] Pick a static host: GitHub Pages, Cloudflare Pages, Netlify, and Vercel all work
      fine for this
- [ ] Confirm your host serves `.wasm` files with the `application/wasm` MIME type —
      most modern static hosts do this correctly by default, but verify with your
      browser's network tab rather than assuming
- [ ] You do **not** need COOP/COEP headers (`SharedArrayBuffer`/threading isolation) for
      this project as designed — that's only relevant if you later add multi-threaded
      generation. Don't add the complexity preemptively
- [ ] Basic CI sketch (e.g., GitHub Actions): run `engine/build.sh` (needs emsdk in the
      CI environment), then `wasm-pack build` in `app/`, then `npm run build` in `web/`,
      then deploy `web/dist`
- [ ] Confirm the deployed site works from a fresh incognito window (catches any
      "worked because it was cached locally" issues)

---

## Appendix A — Full Snag Log (Condensed)

Every risk called out above, in one place, for a final pre-launch pass:

- [ ] `wasm32-unknown-unknown` has no libc — any C code with libc calls will fail to link
      there directly (Part 0, confirmed in Part 3a)
- [ ] The `cubiomes` safe Rust crate is explicitly incomplete per its own docs — verify
      coverage before relying on it, especially if you ever pursue Path B (Part 2)
- [ ] Cubiomes' exact function/struct signatures shift between versions/commits — treat
      any code sketch (including the ones in this guide) as approximate, verify against
      the header you actually vendored (Part 3b, Part 5)
- [ ] Emscripten's default memory limits can be too small for larger generated regions —
      `ALLOW_MEMORY_GROWTH=1` (Part 3b, Part 5)
- [ ] Complex data (buffers, structs) across the JS↔WASM boundary is fragile if you try
      to return them by value — use flat scalars or pre-allocated buffers instead (Part 5)
- [ ] Minecraft's world generation algorithm changes across versions (1.18 especially) —
      pin and document a specific target version everywhere (Part 8)
- [ ] Rendering a full world's mesh at once will choke the browser — chunked/LOD loading
      is required, not optional polish (Part 7)
- [ ] Static hosts must serve `.wasm` as `application/wasm` — verify, don't assume (Part 9)

---

## Appendix B — Alternative: Pure Rust via `wasm32-wasip1` (Path B)

Only pursue this if you specifically want `cubiomes-sys`/`cubiomes` compiling as one unit
with your own Rust code, and you're comfortable with more troubleshooting.

- [ ] Install the [WASI SDK](https://github.com/WebAssembly/wasi-sdk) (provides the
      `clang` + `wasi-libc` toolchain this target needs for C interop)
- [ ] `rustup target add wasm32-wasip1`
- [ ] Point the `cc` crate's build step at the WASI SDK's `clang` (typically via the
      `CC_wasm32_wasip1` environment variable, or `cc`'s own target-detection if
      configured correctly) so `cubiomes-sys`'s `build.rs` compiles Cubiomes' C source
      against `wasi-libc` instead of your host's libc
- [ ] `cargo build --target wasm32-wasip1`, expect to spend real time here — this
      cross-compilation path is less traveled than native builds, and the existing
      Cubiomes Rust crates weren't necessarily authored with this target in mind
- [ ] To actually run the output in a browser, add a **WASI shim/polyfill** (browsers have
      no native WASI implementation) — options include community browser-WASI shims or
      transpiling through the WASI component-model tooling. Budget time here too; this is
      an extra moving part Path A doesn't need at all
- [ ] If you get stuck indefinitely on either the cross-compilation or the browser shim,
      that's your signal to fall back to Path A rather than sinking further time in

---

## Appendix C — Reference Links

- Cubiomes (the C library): search GitHub for `Cubitect/cubiomes`
- `cubiomes-sys` / `cubiomes` Rust crates: docs.rs and crates.io
- Emscripten SDK: `emscripten-core/emsdk` on GitHub
- `wasm-pack`: `rustwasm/wasm-pack` on GitHub
- Vite: vitejs.dev
- Three.js: threejs.org
- WASI SDK (Path B only): `WebAssembly/wasi-sdk` on GitHub
- Rust WASM target docs (Path B only): `doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html`

---
---

# Part 10 — The Enchantment Calculator

> **Where this fits:** Parts 0–9 are one workstream (the seed map). This part and Part 11 are a
> *second, independent* workstream. They can be built in parallel, or first — they do not depend
> on Cubiomes, Emscripten, or the Part 3 spike in any way.

## 10.0 — Why This Is the Easy Half

Read this before scheduling anything: **the enchantment calculator has none of the Part 0 problem.**

Enchanting is not world generation. It's Java's `java.util.Random` (a 48-bit LCG), a weighted
pick from a static table, and integer arithmetic. There is **no C to link**, so this crate is
pure Rust and compiles to `wasm32-unknown-unknown` with plain `wasm-pack` — the naive path that
*fails* in Part 3a works fine here.

Concretely: this lives in `app/` (or a sibling crate beside it), not `engine/`. Do not put an
enchantment dependency in `engine/` — that would drag a pure-Rust feature across the libc
boundary for no reason and re-introduce a problem you'd already solved.

The real risk here is a different one, and it's worth naming up front: **bit-exact fidelity to
Java's RNG.** Being 99% right is worthless — a single wrong bit desynchronizes the stream and
every prediction after it is garbage. That's what Phase 10.1 is for.

```
crates/enchant/           # pure Rust, no C, no wasm-specific code in the core
├── src/
│   ├── java_random.rs     # bit-exact java.util.Random
│   ├── data.rs            # enchantment + material tables (generated, not hand-typed)
│   ├── table.rs           # bookshelf → offered levels
│   ├── enchant.rs         # level → actual enchantment list
│   └── lib.rs
└── tests/
    └── vectors.rs         # golden vectors captured from real Minecraft
```

## 10.1 — Phase 1: Bit-Exact `java.util.Random` (Do This First, Alone)

Same philosophy as Part 2: prove the foundation in isolation before stacking anything on it.

- [ ] `cargo new --lib crates/enchant`
- [ ] Implement `JavaRandom` — this is a fully specified algorithm, so there is one correct answer:
  ```rust
  const MULTIPLIER: u64 = 0x5DEECE66D;
  const ADDEND: u64 = 0xB;
  const MASK: u64 = (1 << 48) - 1;

  pub struct JavaRandom { seed: u64 }

  impl JavaRandom {
      pub fn new(seed: i64) -> Self {
          Self { seed: (seed as u64 ^ MULTIPLIER) & MASK }   // the initial scramble
      }

      pub fn set_seed(&mut self, seed: i64) {
          self.seed = (seed as u64 ^ MULTIPLIER) & MASK;
      }

      fn next(&mut self, bits: u32) -> i32 {
          self.seed = self.seed.wrapping_mul(MULTIPLIER).wrapping_add(ADDEND) & MASK;
          (self.seed >> (48 - bits)) as i32          // NB: Java's >>> on the 48-bit state
      }

      pub fn next_int_bound(&mut self, bound: i32) -> i32 {
          assert!(bound > 0);
          if (bound & -bound) == bound {             // power of two: special-cased in Java
              return ((bound as i64).wrapping_mul(self.next(31) as i64) >> 31) as i32;
          }
          loop {                                     // rejection loop — DO NOT simplify to %
              let bits = self.next(31);
              let val = bits % bound;
              if bits - val + (bound - 1) >= 0 { return val; }   // wrapping i32 overflow check
          }
      }

      pub fn next_float(&mut self) -> f32 {
          self.next(24) as f32 / (1u32 << 24) as f32
      }
  }
  ```
- [ ] **Three landmines, all of which produce *nearly* correct output:**
  - The **power-of-two branch** in `next_int_bound` is not an optimization — it consumes the
    stream differently than the general path. Skipping it silently desyncs on `nextInt(2)`,
    `nextInt(4)`, `nextInt(16)`, which enchanting hits constantly.
  - The **rejection loop** must stay. `bits % bound` alone is right the overwhelming majority
    of the time, which is exactly what makes it a miserable bug to find later.
  - The overflow check `bits - val + (bound - 1) >= 0` relies on **Java's wrapping i32
    arithmetic**. In Rust, debug builds panic on overflow — use `wrapping_sub`/`wrapping_add`
    explicitly so debug and release agree.
- [ ] Unit-test against known values. The cheapest ground truth: `jshell` (ships with any JDK) —
  ```
  jshell> var r = new java.util.Random(12345L); r.nextInt(100); r.nextInt(100); r.nextFloat();
  ```
  Capture a few dozen outputs across several seeds and bounds (include powers of two **and**
  non-powers) as a hardcoded table in `tests/`.

**Checkpoint — hard gate:** your `JavaRandom` reproduces a JDK's output exactly for every seed
and bound you tested, including `nextFloat`. Nothing below this line is debuggable until this
is true, so do not proceed on "close enough."

## 10.2 — Phase 2: The Data Tables (Generate, Don't Type)

- [ ] Two tables are needed:
  - **Material enchantability** — an integer per material (gold is famously high, diamond
    comparatively low). This is what makes gold gear roll high-tier enchantments cheaply.
  - **Per-enchantment cost curves** — for each enchantment *level*, a `min_cost` and `max_cost`,
    both usually linear in the level, plus a `weight` (rarity) and its incompatibility set
    (e.g. Sharpness / Smite / Bane of Arthropods are mutually exclusive).
- [ ] **Source these as data; do not hand-transcribe them into Rust.** They are large, they are
  version-specific, and a typo in one `max_cost` yields a calculator that's subtly wrong for
  exactly one enchantment — the hardest possible failure to notice. Put them in a `.json`/`.ron`
  file and either `include_str!` + parse at startup, or codegen a static table in `build.rs`.
- [ ] **Pin the Minecraft version and record it in the data file itself**, the same discipline
  Part 8 demands of the seed map and for the same reason: Mojang rebalances enchantment costs
  and adds enchantments between versions. A calculator is only correct for the version it
  encodes. Surface that version string in the UI.
- [ ] Best extraction route, in order of preference: the game's own data via a datapack/registry
  dump for your pinned version → a machine-readable community dataset → the wiki tables last,
  and if it's the wiki, diff two independent transcriptions against each other.

## 10.3 — Phase 3: Offered Levels (The Table UI Numbers)

The three numbers shown on the enchanting table's slots, from bookshelf count `b` (clamped 0–15):

- [ ] Implement:
  ```rust
  pub fn offered_levels(xp_seed: i32, bookshelves: i32) -> [i32; 3] {
      let b = bookshelves.clamp(0, 15);
      // Seeded ONCE, outside the loop. All three slots draw from this one stream, in
      // order; it is NOT reset between them.
      let mut r = JavaRandom::new(xp_seed as i64);
      let mut out = [0; 3];
      for slot in 0..3 {
          let base = r.next_int_bound(8) + 1 + (b >> 1) + r.next_int_bound(b + 1);
          let lvl = match slot {
              0 => (base / 3).max(1),          // NB: max(.,1) — the game floors slot 0 at 1
              1 => (base * 2) / 3 + 1,
              _ => base.max(b * 2),
          };
          out[slot] = if lvl < slot + 1 { 0 } else { lvl };   // slot n requires level >= n+1
      }
      out
  }
  ```
- [ ] Note the seeding: the offered levels come from **one stream seeded once with `xp_seed`**,
  the three slots drawing sequentially — the generator is *not* reset between them. (Verified
  against the Minecraft Wiki's "Enchanting table mechanics" and Earthcomputer/EnchantmentCracker,
  whose caller carries the comment "Important they're done in a row like this because RNG is not
  reset in between".) The `xp_seed + slot` re-seeding is the *roll* in 10.4, a different phase;
  do not apply it here. Getting this wrong gives a correct-looking slot 0 and wrong slots 1–2 —
  the same distribution, different values, so range-based tests pass and only an exact vector
  catches it.
- [ ] The slot-0 floor is `max(base / 3, 1)`, not `base / 3`. Without it, low `base` renders 0
  in the top slot where the game shows 1.
- [ ] The `xp_seed` is a **per-player value** that persists until the player actually enchants
  something (any enchant re-rolls it). Your calculator takes it as an input — treat "how does
  the user obtain their xp seed" as a UI/UX question for 10.5, not a math question.
- [ ] Verify the trivial cases by hand before anything else: `b = 0` must never offer a slot-3
  level near 30; `b = 15` must offer 30 in the bottom slot.

## 10.4 — Phase 4: Actual Enchantment Rolls

This is the part with the most steps and therefore the most places to desync. Order is load-bearing.

- [ ] Re-seed with **`xp_seed + slot`** here. This is genuinely different from 10.3: the offered
  levels use one stream seeded once with `xp_seed` (no `+ slot`), while each slot's *roll* starts
  a fresh stream from `xp_seed + slot`. They are not "two reads of the same stream" — they are two
  different seedings, and conflating them is the single easiest desync to introduce.
- [ ] Apply the **enchantability modifier**, then the random ±15% bonus:
  ```rust
  let e = material_enchantability;
  let mut level = level + 1
      + r.next_int_bound(e / 4 + 1)
      + r.next_int_bound(e / 4 + 1);
  let bonus = 1.0 + (r.next_float() + r.next_float() - 1.0) * 0.15;
  let mut level = ((level as f32 * bonus).round() as i32).max(1);
  ```
  The two `next_float()` calls summed is what makes the bonus triangular rather than uniform —
  and it is **two separate draws**, not one doubled.
- [ ] Build the candidate list, then do a **weighted random pick** by rarity weight (Java's
  loop: `nextInt(total_weight)`, then walk the list subtracting until negative). Two things about
  the list are easy to get wrong and both produce plausible-but-wrong output:
  - **One candidate per enchantment, not per level.** For each applicable enchantment take the
    *highest* level whose `[min_cost, max_cost]` window contains the modified level, and stop.
    Collecting "every `(enchantment, level)`" — as an earlier draft of this guide said — counts a
    multi-level enchantment's weight several times and skews the draw.
  - **Gate on table-obtainability, not just item applicability.** 7 of 1.21.3's 42 enchantments
    (mending, frost_walker, soul_speed, swift_sneak, wind_burst, and both curses) can never come
    from a table, yet they still declare item tags — so a filter that checks only "does this apply
    to the item" rolls them anyway. Use the `in_enchanting_table` tag. This is separate from the
    treasure gate.
- [ ] Then the multi-enchantment loop, which is where extras come from. **The order below is the
  game's; an earlier draft of this guide halved the level first, which makes the first extra
  enchantment far too rare:**
  ```
  loop {
      if r.next_int_bound(50) > level { break; }   // roll against the CURRENT level, first
      remove candidates incompatible with what's already picked;   // filter BEFORE the pick
      if none remain { break; }
      pick another (weighted);
      level = level / 2;                            // halve at the END, not the start
  }
  ```
- [ ] Books are a special case in two ways. They accept **any** table enchantment regardless of
  item tags (vanilla's check is `isPrimaryItem(stack) || stack.is(Items.BOOK)`) — without the
  bypass a book matches nothing and rolls empty. And after rolling, **a book holding more than one
  enchantment has one removed at random** (`list.remove(rand.nextInt(list.size()))`); that draw
  consumes RNG, so omitting it desyncs everything after it. Encode applicability as a data-table
  predicate, not `if item == Book` branches in logic.

## 10.5 — Phase 5: Golden Vectors & Wiring Up

- [ ] **Capture real golden vectors.** Get into a creative world on your pinned version, note the
  xp seed (a debug mod or reading the player NBT `XpSeed` field both work), and record maybe
  20–30 real outcomes across varied materials, bookshelf counts, and slots. Commit them as
  `tests/vectors.rs`. This is the enchantment equivalent of Part 2's Chunkbase check, and it is
  the single highest-value artifact in this whole part — it's what lets you refactor later
  without fear, and what catches a version bump breaking your data tables.
- [ ] Only once vectors pass: add the `wasm-bindgen` surface. Keep it in a **thin wrapper module**
  so the core crate stays `#![no_std]`-friendly and natively testable —
  `cargo test` on the core must not require a browser.
- [ ] Frontend: bookshelf count, material, and item type as inputs; the three offered levels plus
  the predicted enchantments per slot as output. Display the pinned MC version prominently.
- [ ] Consider a "search" mode — iterate xp seeds to find one producing a desired enchantment.
  This is embarrassingly parallel and pure integer work, i.e. exactly what Rust-in-WASM is good
  at, and it's the feature that justifies this not being a JS script. Run it off the main thread
  (a Web Worker) so the UI doesn't lock during the sweep.

**Checkpoint:** every golden vector passes, and the browser UI reproduces a real in-game
enchantment you did not use while developing.

## 10.6 — Phase 6: The Anvil Cost Calculator

A second, independent enchantment tool that shares 10.2's data tables but **none** of its RNG.
Anvil combining is fully deterministic integer arithmetic — no `JavaRandom`, no xp seed — so it
is far simpler to get bit-exact than the table roll, and golden vectors are trivial to capture
(any anvil in a creative world). It answers the question the table calculator can't: *"I have
these enchanted books and this tool — what does merging them cost, and in what order?"*

- [ ] **Reuse the 10.2 crate.** You need each enchantment's `max_level`, its incompatibility set,
  its item-applicability predicate, and its **`anvil_cost`** (the per-level cost multiplier — this
  field is already in the enchantment data if you sourced it from the game's registry, as 10.2
  advises). You do **not** need the weights or cost curves the table roll used.
- [ ] **Model the combine of a target item + a sacrifice (item or book).** The result cost is the
  sum of three parts:
  1. **Prior work penalty (PWP)** — the dominant term, and the one players find surprising. Every
     item carries a stored "repair cost" that starts at 0; **both** inputs add their current repair
     cost to the combine total. After combining, the *result's* repair cost becomes
     `2 × max(costA, costB) + 1`, so a never-touched item is 0, then 1, 3, 7, 15… — the penalty is
     `2^work − 1`, exponential and *independent of the enchantments*. This is what actually drives
     real costs and the "Too Expensive!" wall, not the enchantment multipliers.
  2. **Per-enchantment cost.** For each enchantment on the sacrifice, resolve the result level
     against the target — absent → sacrifice's level; equal level below max → level + 1; unequal →
     the higher — then add `result_level × multiplier`, where the multiplier is that enchantment's
     `anvil_cost`, **halved when the sacrifice is a book** (round per your pinned version's rule —
     verify the direction, since getting item-vs-book backwards makes book costs ~4× off).
  3. **Rename**, if any: a flat `+1`.
- [ ] **Landmines, all of which produce plausible-but-wrong totals:**
  - The PWP is `2^work − 1` and applies to **both** items — forgetting the sacrifice's PWP
    undercounts every non-fresh combine.
  - **Order changes the total.** Because PWP compounds, merging N books into a tool in a balanced
    binary tree costs less than a linear chain. The genuinely useful feature here — and where Rust
    earns its place over a naive JS calculator — is a solver that finds the **minimum-total-cost
    combining order** (a min-cost binary-tree / DP problem over the inputs).
  - Incompatible enchantments (e.g. Sharpness onto a tool that has Smite) don't apply and, in Java,
    still add a small cost per conflict — model conflicts, don't silently drop them.
  - The **40-level "Too Expensive!" cap is survival-only**; creative ignores it. Don't hard-block
    in a calculator that also serves creative planning.
- [ ] **These constants are version-specific — verify them against your pinned version's data**,
  same discipline as 10.2 and Part 8. The `anvil_cost` values, the item/book halving, and the
  conflict-cost rule have all shifted across releases.
- [ ] Capture a handful of golden vectors from a real anvil (the level cost shown in the UI) and
  commit them next to 10.5's. Being deterministic, these never flake — a mismatch is always a real
  regression.

**Checkpoint:** for a fixed set of inputs and prior-work values, the calculator reproduces the
exact level cost an in-game anvil shows, and its suggested combine order is no more expensive than
the order you'd work out by hand.

---

# Part 11 — Nether ↔ Overworld Coordinate Converter

The smallest deliverable in the project, and worth building early precisely because of that —
it's a complete, shippable feature that exercises your Rust→WASM→UI pipeline end to end with
nearly zero domain risk. Good first thing to put on screen.

## 11.1 — The Core Math

The ratio is **1 Nether block = 8 Overworld blocks**, horizontally only. **Y is never scaled.**

- [ ] Implement both directions:
  ```rust
  pub fn overworld_to_nether(x: i32, z: i32) -> (i32, i32) {
      (x.div_euclid(8), z.div_euclid(8))
  }

  pub fn nether_to_overworld(x: i32, z: i32) -> (i32, i32) {
      (x * 8, z * 8)
  }
  ```
- [ ] **The one real bug in this feature: negative coordinates.** Rust's `/` truncates toward
  zero, so `-9 / 8 == -1`, but the correct block-space answer is `-2`. Use `div_euclid`, which
  floors. A converter that's right in the +X/+Z quadrant and wrong in the other three is the
  classic version of this tool shipping broken — **the north-west quadrant is the test case
  that matters.**
- [ ] Y passes through unchanged in both directions. Do not scale it, and do not silently clamp
  it during conversion — see 11.2 for why clamping is a *portal-linking* concern, not a
  *coordinate-conversion* one.
- [ ] Test explicitly: `(0,0)`, `(8,8)`, `(-8,-8)`, `(-1,-1)` → `(-1,-1)` in the Nether,
  `(-9,-9)` → `(-2,-2)`, and a large-magnitude pair in each of the four quadrants.

## 11.2 — Portal Linking (What Makes This Actually Useful)

Naive conversion answers "what coordinate corresponds to this one." The question players
actually have is "will my two portals link?" — a different and more valuable question.

- [ ] Model the search behavior: when a player enters a portal, the game scales the coordinate,
  then searches the destination dimension for an **existing portal within a horizontal radius**
  of that target, linking to the nearest one if found and creating a new portal if not. The
  radius is **asymmetric**, and an earlier draft of this guide got it wrong. Per the Minecraft
  Wiki's "Nether Portal" article (verified against a 1.21.3-era revision): the search area is
  **17×17 chunks, ±128 blocks, when searching the Overworld, but only 33×33 blocks, ±16 blocks,
  when searching the Nether.** The two are equivalent once scaled — 16 Nether blocks *is* 128
  Overworld blocks — which is where the confusion comes from.
- [ ] The practical consequence, and the thing to surface in the UI: **a Nether search of ±16
  blocks covers 128 Overworld blocks** — not 1024, which came from wrongly applying the Overworld
  radius in the Nether. This is why two Overworld portals built within ~128 blocks of each other
  both link to the same Nether portal — a very common player-facing problem, and a genuinely
  useful thing for this tool to warn about.
- [ ] Useful UI outputs beyond the raw number:
  - Given two portals, do they link, and if not, how far off is the pairing?
  - Given a desired destination, where should the counterpart portal be built?
  - A warning when two Overworld portals fall inside each other's shared linking zone.
- [ ] **Verify the exact radius, Y bounds, and search-volume shape against your pinned version**
  rather than trusting the numbers above — portal search specifics (the vertical range
  considered, and how nether-roof Y values are handled) have shifted across versions, and the
  build-height changes make the Y handling version-dependent in particular. Same discipline as
  Part 8: pin it, document it, show it in the UI.
- [ ] Note this is the **only** place in Parts 10–11 where Y needs care, and it's a clamping
  rule for portal *placement*, not a scaling rule. Keep it out of 11.1's pure functions.

## 11.3 — Integration

- [ ] Lives in the same pure-Rust crate family as Part 10 — no C, no Cubiomes, no Emscripten.
- [ ] Where it earns its place in the *seed map*: once Part 7's renderer exists, overlay Nether
  coordinates on the Overworld view (and vice versa), so portal planning happens directly against
  real terrain instead of in a separate calculator. That's the version of this feature nobody
  else's standalone converter can offer, and it's the reason to build it inside this project
  rather than as its own page.

---

## Appendix D — Snag Log for Parts 10–11

- [ ] `next_int_bound`'s **power-of-two branch** consumes the RNG stream differently — omitting
      it desyncs on the most common bounds in enchanting (10.1)
- [ ] The **rejection loop** is not optional; plain `%` is right *almost* always, which is what
      makes its absence so hard to diagnose (10.1)
- [ ] Java's i32 arithmetic **wraps**; Rust debug builds **panic**. Use explicit
      `wrapping_*` so debug and release behave identically (10.1)
- [ ] Enchantment cost tables are **version-specific and large** — generate them from data,
      never hand-transcribe, and pin the version in the file (10.2)
- [ ] **Offered levels** (10.3) draw from one stream seeded **once** with `xp_seed`; the per-slot
      `xp_seed + slot` re-seed belongs to the **roll** (10.4). Swapping them gives a right slot 0
      and wrong 1–2 — same distribution, so only an exact vector catches it (10.3)
- [ ] Slot 0's offered level is `max(base / 3, 1)`, not `base / 3` (10.3)
- [ ] The ±15% bonus uses **two separate `nextFloat()` draws** summed — one draw doubled gives
      a wrong distribution that still looks plausible (10.4)
- [ ] The multi-enchant loop rolls against the **current** level then halves at the **end**, not
      the other way round; incompatibility filtering happens **before** each pick (10.4)
- [ ] Take **one candidate per enchantment** (highest fitting level), and gate on
      `in_enchanting_table` — 7 of 42 enchantments are never table-obtainable but still declare
      item tags (10.4)
- [ ] A book with more than one rolled enchantment has **one removed at random**, which consumes
      RNG; omit it and everything after desyncs (10.4)
- [ ] Rust's `/` truncates toward zero — **use `div_euclid`** for Overworld→Nether or every
      negative coordinate is off by one (11.1)
- [ ] **Y is never scaled** by the 1:8 ratio; Y clamping is a portal-placement rule only (11.1, 11.2)
- [ ] The portal search radius is **asymmetric**: ±128 blocks searching the Overworld, ±16
      searching the Nether. A Nether search therefore spans **128 Overworld blocks** (not 1024) —
      the cause of most unintended portal linking, and worth warning about explicitly (11.2)
- [ ] Neither part depends on Cubiomes or Emscripten — **keep them out of `engine/`** so they
      stay on the easy side of the Part 0 libc boundary (10.0)

---

# Part 12 — Seed Map Enhancements

Extensions to the shipped seed map (Parts 0–9), in recommended build order. Each builds on
the architecture already in place: the `engine/` shim, the Rust `View` tile cache (keyed by
`{tx, tz, scale}`), and the Three.js frontend. Two facts from that architecture make most of
this cheaper than it looks, and are worth stating up front because the sections lean on them:

- **`gen_biomes` already generates at five scales** — 1, 4, 16, 64, 256 — and **the tile
  cache already keys on scale.** Coarse scales sample a large area with few cells; fine
  scales are block-accurate. That is exactly what a zoomable 2D map needs, so 12.2 mostly
  wires up existing capability rather than adding it.
- **`gen_heights` is scale-4 only** (Cubiomes' `mapApproxHeight` takes no scale). The 3D
  terrain therefore stays at scale 4; the 2D map, which needs no heights, is free to use any
  scale.

Order below is deliberate: a trivial warm-up, then the 2D map (which becomes the default and
is the largest single change), then structures (highest value, highest verification risk),
then flight controls (polish for what is now the secondary view).

## 12.1 — Adjustable render distance (3D)

The smallest change, worth doing first to re-familiarise with the tiling loop.

- [ ] `TILE_RADIUS` is currently a hardcoded const in the frontend (tiles within a Chebyshev
      radius of the camera focus get meshed). Expose it as a slider, and re-run the tiling
      refresh when it changes.
- [ ] **Cap it.** A radius `R` meshes `(2R+1)²` tiles, each a 64×64 grid (~8k triangles). At
      `R=8` that is 289 tiles / ~2.3M triangles — fine on desktop, punishing on a phone. Clamp
      to ~8 and treat anything above as opt-in.
- [ ] **Raise the cache capacity alongside the radius.** The LRU tile cache has a fixed
      capacity; if the visible tile count exceeds it, tiles are evicted and immediately
      re-fetched every frame — cache thrashing that looks like a stutter, not an error. The
      capacity must comfortably exceed `(2R+1)²` at the maximum radius.
- [ ] Changing the radius re-meshes; a shrink should also **dispose** the now-out-of-range
      meshes (geometry + material) rather than just hiding them, or memory climbs as the user
      fiddles the slider.

## 12.2 — 2D map mode, made the default, with scroll-to-zoom

The anchor of this part. A top-down biome map is *simpler and faster* to render than the 3D
mesh — it is a coloured image, not geometry — and it is what most seed tools show, so it is
the right default. The 3D view moves behind a toggle.

- [ ] **New renderer, shared data.** Draw a 2D canvas where each biome cell is a coloured
      pixel/rect, using the same `biome_colors` palette the 3D mesh uses. Reuse the tile cache
      and `gen_biomes` — this is a second consumer of the existing tiles, not a second data
      path. Do **not** call `gen_heights` here; 2D needs biomes only.
- [ ] **Zoom selects the Cubiomes scale**, and this is the whole point of a 2D map over the
      fixed-scale 3D one. Map the zoom level to a generation scale — far out → 256 or 64
      (continent overview, few samples), mid → 16 or 4, fully zoomed → 1 (block-accurate). The
      cache already distinguishes tiles by scale, so zooming in and back out reuses both scales'
      tiles instead of regenerating.
- [ ] **Landmine — never generate scale 1 for a large area.** Scale 1 uses Voronoi sampling and
      is 16× the cells of scale 4 for the same ground. If the zoom→scale mapping lets scale 1
      cover a whole screen at low zoom, generation time explodes. Gate scale 1 to high zoom only,
      where the visible area in blocks is small.
- [ ] **Landmine — the frontend's tile math currently assumes scale 4.** The block↔cell↔tile
      conversions in the frontend were written with a fixed `SCALE = 4`. Generalising to a
      variable scale touches every place that constant appears; audit them, and prefer routing
      the math through the Rust `View` (which already parameterises on scale) over duplicating it
      in JS.
- [ ] **Render fast.** Per-cell `fillRect` is slow at map sizes; build an `ImageData` (or a
      small offscreen canvas) per tile and `putImageData`/`drawImage` it. One image per cached
      tile composites cheaply as the view pans.
- [ ] Make 2D the **default** view on load; the 3D mesh becomes the toggled-in mode. Keep the
      hover-to-read-biome readout working in both.
- [ ] **Verification is easier here, not harder** — a 2D map shows a whole region at once, so
      the Part 8 Chunkbase spot-checks become "does this shape match", not one coordinate at a
      time. Still pin the version and check.

## 12.3 — Click-and-drag panning (2D)

Depends on 12.2; trivial once the 2D renderer exists.

- [ ] Track pointer movement while dragging, convert the screen-pixel delta to a **world-block**
      delta using the current zoom's blocks-per-pixel, and offset the view origin. Redraw from
      cached tiles; fetch newly-exposed tiles at the edges (throttled, as 12.5 does for flight).
- [ ] **Landmine — the pixel→block conversion is zoom-dependent.** A fixed pixels-per-block will
      make panning feel wrong at every zoom except the one it was tuned for. Derive it from the
      active scale each frame.
- [ ] Momentum/inertia is optional polish; correctness is just "the cell under the cursor stays
      under the cursor while dragging."

## 12.4 — Structure display

Highest value, highest risk — deliberately after both renderers exist so markers land on
either. Cubiomes has the API (`getStructurePos`, `isViableStructurePos`, `getStructureConfig`,
and `nextStronghold` for strongholds); none of it is exposed by the shim yet, and this is the
one enhancement that can be *subtly and confidently wrong*, so it gets the full Part 8
treatment.

- [ ] **Expose a region-scan shim function.** Most structures are placed one candidate per
      region (region size and salt vary by type — read them from `getStructureConfig`, never
      hardcode). For each region overlapping the view: `getStructurePos(type, mc, seed, rx, rz,
      &pos)` for the candidate, then confirm with `isViableStructurePos`. Return the confirmed
      positions as a flat `[x, z, x, z, …]` buffer, the same pattern as the tile functions.
- [ ] **Landmine — `getStructurePos` returns a *candidate*, not a placement.** It gives where a
      structure *would* go; `isViableStructurePos` checks whether the biome/terrain there
      actually permits it. Skipping the viability check paints phantom structures that aren't in
      the world — the structure equivalent of the y=0 cave-biome bug: plausible, wrong.
- [ ] **Strongholds are a separate algorithm — do not fit them into the region loop.** They are
      placed in rings (3 in the first ring, then 6, 10, …) via `initFirstStronghold` /
      `nextStronghold`, not per region. Handle them with their own call path.
- [ ] **Pin and verify per structure type.** Structure placement has changed across versions
      (salts, region sizes, viability rules). Check each type you expose against Chunkbase for the
      pinned version — villages/temples/monuments first (moderate), strongholds last (fiddliest).
      Treat a type as unverified until it matches, exactly as with biomes.
- [ ] **Render markers in both modes.** 2D: icons/dots on the canvas at the projected position.
      3D: sprites or billboards at the structure's world position and surface height. Label on
      hover; show the coordinate.
- [x] Start with a small, high-value set (village, stronghold, ocean monument, mansion) rather
      than all eleven types at once — each additional type is more verification surface.
      **All four confirmed against Chunkbase on seed 1 / 1.21.3.** Widening the set is 12.6.
- [x] **Landmine found in the doing — `nextStronghold`'s own doc comment is wrong.** finders.h
      describes the return as "the number of further strongholds after this one", but the
      implementation increments `index` before returning `128 - (index-1)`, which is the count
      *including* the one just resolved. Recording the position and then testing the return, as
      that wording invites, yields a phantom 129th stronghold — plausible position, plausible
      ring distance, no duplicate, nothing to mark it as junk. Test the return **before** using
      the position. Vendored doc comments are not ground truth; the count is (128 for MC >= 1.9).

## 12.5 — WASD / arrow-key flight (3D)

Polish for the now-secondary 3D view. The re-tiling machinery already exists (the mesh loop
recenters on a point); flight just drives it from the camera continuously instead of on an
orbit-end event.

- [ ] Swap `OrbitControls` for fly-style controls (Three.js `FlyControls`/`FirstPersonControls`,
      or a custom WASD + pointer-lock handler). Keep vertical movement (space / shift) since the
      terrain has real elevation.
- [ ] **Throttle the re-tiling.** Drive the existing recenter-and-mesh off the camera position,
      but only when the camera **crosses a tile boundary** (or every N ms), not every frame —
      otherwise you re-run the tiling loop continuously and stall.
- [ ] **Landmine — synchronous meshing stutters during fast flight.** Each newly-entered tile
      runs `gen_heights` + `buildTileMesh` on the main thread; crossing a row of tiles at speed
      meshes a dozen at once and drops frames. Ship the throttled-synchronous version first (it is
      fine at moderate speed), and only if it feels janky move tile generation to a **Web Worker**
      so meshing happens off the main thread. The worker is real work — do not front-load it.
- [ ] Optional: frustum-bias the tiling so you mesh tiles **ahead** of the camera preferentially,
      spending the tile budget on what the player is flying toward rather than a symmetric radius.

# Part 13 — Version Targeting

Let the user choose which Minecraft version the seed map and the enchantment calculator model,
including the items, enchantments, and rules that version actually had.

Start by reading where the two halves already stand, because they could hardly be further
apart and the work splits accordingly:

- **The seed map is already version-parameterised, end to end.** `set_world(seed, mc_version,
  dim)` takes a version int and validates it against Cubiomes' full `MC_B1_7..MC_NEWEST` range
  (wider than the 13.0 scope, which the registry narrows to `MC_1_8_9..MC_NEWEST`); `str2mc`
  converts a string to that enum; and the Rust tile cache already carries `version` in its
  `World` key, so changing it invalidates every cached tile. The *only* thing pinning the app
  to one version is a single hardcoded line in the frontend. This part is mostly UI.
- **The enchantment calculator is welded to one version at compile time.** `build.rs` reads
  exactly one file, `data/enchantments-1.21.3.json`, and emits a `MC_VERSION` const plus a
  fixed-size `[EnchantmentData; 42]`. There is no runtime notion of a version at all. This is
  the real work of Part 13, and most of it is data, not code.

Order below reflects that: the cheap half first to establish the UI shape, then the data
layer, then the logic that the data cannot express, then verification.

## 13.0 — Scope: 1.8.9 and above

**Only versions 1.8.9 and later are in scope.** Everything below assumes that floor, and it is
a well-chosen one for two independent reasons.

- [ ] **The floor is exactly a Cubiomes enum entry — `MC_1_8_9` — so no approximation is
      needed.** Cubiomes names each entry after the newest patch of its major release
      (`MC_1_8_9`, `MC_1_7_10`, …, with `MC_1_8 = MC_1_8_9` as an alias), and its own header
      notes that development targets only that newest patch, with minor releases and versions
      ≤ 1.0 flagged experimental. The floor therefore also sits above the experimental band. It
      excludes 9 entries (`MC_B1_7`, `MC_B1_8`, and 1.0 through 1.7.10) and leaves 18 usable
      ones, `MC_1_8_9` through `MC_1_21_WD`.
- [ ] **The floor makes the enchanting model uniform across the whole supported range.** The
      3-slot, lapis-based enchanting system with the per-player xp seed — the model this
      codebase implements throughout (`offered_levels` from an xp seed and a bookshelf count,
      the per-slot re-seed) — arrives in 1.8. A range starting below it would need a second,
      structurally different enchanting algorithm, not merely different numbers. **Confirm this
      boundary before relying on it**; if the overhaul actually lands mid-1.8.x the floor is
      still safe, but the reasoning should be checked rather than inherited from this guide.
      With it confirmed, 13.4's audit is about parameters and content, not about a second
      algorithm.
- [ ] **The ceiling is `MC_NEWEST`, currently `MC_1_21_WD` (Winter Drop).** The vendored
      Cubiomes tops out there, so the seed map cannot target 26.x at all today regardless of the
      floor — worth stating plainly, since that is the version actually being played. Closing
      that gap is the vendor bump described in 13.2, and it depends on upstream Cubiomes
      supporting the version at all.
- [ ] **Enforce the floor in exactly one place — the registry — and derive every list from it.**
      A floor re-implemented as scattered `>=` comparisons will disagree with itself, and the
      version strings involved do not compare naturally (see 13.1).
- [ ] **Landmine — the two halves change at different granularities, so the version list is not
      one list.** Cubiomes carries one entry per major release (with a few exceptions:
      `MC_1_16_1` vs `MC_1_16_5`, `MC_1_19_2` vs `MC_1_19_4`, and three separate 1.21 entries),
      because that is where *biome generation* changes. Enchantment content changes on entirely
      different boundaries. Map a canonical version key to both a Cubiomes enum value and an
      enchantment dataset id, and expect the mapping to be many-to-one in both directions —
      several biome-distinct versions can share one enchantment dataset, and vice versa.

## 13.1 — Decide the version model before writing any of it

The tempting design — one global version selector at the top of the app — is wrong, and it is
much cheaper to reject it now than to unpick it later.

- [ ] **Landmine — the two halves support different sets of versions, and always will.** The
      seed map can offer whatever the vendored Cubiomes knows (beta 1.7 through `MC_NEWEST`).
      The calculator can offer only versions you have transcribed a dataset for — realistically
      a handful. A single global selector claims parity that does not exist, and will either
      hide seed-map versions that work or offer calculator versions that silently fall back.
- [x] **Per-tool version selectors, one shared registry.** Keep a single source of truth listing
      known versions and, per version, which features support it. Each tool renders its own
      selector from that registry, filtered to what it can actually serve.
- [x] **Landmine — version strings are no longer `1.x.y`.** Handled by treating the version as
      an opaque engine int and never parsing it: the registry is built by walking the enum from
      `str2mc("1.8.9")` to `mc_newest()` and asking `mc2str` for each label, with a round-trip
      guard (`str2mc(mc2str(v)) === v`) so a selector entry can never load a world other than
      the one it names. `str2mc("26.2")` returns 0, confirming the ceiling. Minecraft's newer releases use a
      date-style scheme (26.1, 26.2, …). Any comparison, sorting, or "is this at least X" check
      written as a `1.MAJOR.MINOR` parse will mis-order these or reject them outright. Treat the
      version as an opaque key into the registry, and store an explicit sort order.
- [ ] Decide and write down what happens to in-flight UI state when the version changes — see
      13.5. Doing this last is how you end up with a calculator showing an item the selected
      version never had.

## 13.2 — Seed map version selector

Nearly free; do it first to prove the registry and the selector UI.

- [x] Replace the hardcoded `str2mc('1.21.3')` in the frontend with a dropdown bound to the
      registry. On change, call the engine's `set_world` **and** the Rust `View::set_world`, then
      force a full re-render.
- [x] **Landmine — two `set_world`s, and only one of them clears the cache.** Found a related
      bug while wiring this: both renderers captured `mcVersion` as a constructor argument, so a
      version change would have left the 3D view seeding its Rust cache with the *previous*
      version — serving one version's terrain from a cache that believed it was current. Version
      is now per-load state, passed through `setWorld` like the dimension. The engine shim
      holds the C `Generator`; the Rust `View` holds the tile cache. Calling only the engine's
      leaves every cached tile generated under the *previous* version, and stale biome tiles look
      exactly like correct output. The cache already keys on `version` — the bug is failing to
      tell it.
- [x] **Validate before use.** `set_world` returns -1 outside `MC_B1_7..MC_NEWEST`, and `str2mc`
      on an unrecognised string does not return a usable version. Check both; do not feed the
      result straight into a generate call. Note that the shim's check is **wider than the 13.0
      scope** — it accepts 1.7.10 and the betas — so it will not catch a below-floor version on
      its own. The registry is what enforces the floor.
- [x] **Landmine — you cannot offer a version newer than the vendored Cubiomes knows.**
      `MC_NEWEST` is a compile-time ceiling from the vendored C source. Supporting a newer
      Minecraft means updating the Cubiomes vendor, which is a dependency bump with its own
      re-verification pass (Part 8 against Chunkbase, pinned to the new version) — not a registry
      entry. Cap the offered list at what the build actually contains.
      **This happened.** Upstream Cubiomes went dormant after 2024-11-10, capping us at 1.21.4
      while Minecraft reached 1.21.11 and then a 26.x scheme. The engine moved to the
      `xpple/cubiomes` fork (93 commits ahead, same MIT licence, all 13 functions the shim calls
      unchanged in signature) — see 13.6 for how that swap was verified.
- [x] **Landmine — Cubiomes' version labels understate what each entry covers, and the list
      looks mis-sorted as a result.** `mc2str` names each entry after the family it *starts*, not
      the release it tops out at: the entry spanning 1.16.2–1.16.5 is `MC_1_16_5`, but its label
      is "1.16" (the header aliases `MC_1_16 = MC_1_16_5`). Rendered literally, the selector shows
      `… 1.16.1, 1.16, … 1.19.2, 1.19, … 1.21.1, 1.21.3, 1.21 WD`, which reads as though the
      point releases were sorted before their majors by mistake.
      They weren't — the enum is in release order and 1.16.1 genuinely predates 1.16.5.
      **Do not re-sort to fix the appearance**; that puts 1.16.1 after 1.16.5 and inverts the
      chronology. Relabel instead: probe `str2mc` for the highest patch string that maps back to
      the same entry (cubiomes accepts both spellings, so this is derivable rather than a table
      that rots on the next submodule bump), and the list reads monotonically with no sort at
      all. Show the covered span too — "1.16.5" alone does not tell someone running 1.16.3 that
      it is their entry, which is the actual user-facing cost of the understated labels.
      Keep the round-trip guard on a string the engine actually resolves, and keep that string
      separate from the displayed one (`key` vs `label`) — see the next item for why they must
      be allowed to diverge.
- [x] **Landmine — one entry has a placeholder name, not a version.** `MC_1_21_WD` was added
      from snapshot **24w40a**, before the Winter Drop's number was announced; `biomes.h` still
      reads "version TBA" and `mc2str` still returns `"1.21 WD"`, even though upstream's own
      biome comment in `util.c` already calls it 1.21.4. It shipped as **1.21.4** ("The Garden
      Awakens"), adding `pale_garden` and swapping in the `btree21wd` biome tree.
      Two consequences. First, the label is useless to a player deciding whether it is their
      version, so display the real one — but note this is the **only** label not derived from
      the engine, and `str2mc("1.21.4")` does not resolve, which is exactly why the round-trip
      guard has to run on `key` instead. Keep the override keyed on the exact placeholder string
      so a submodule bump that renames the enum makes it go quiet rather than mislabel some
      other entry, and assert in the smoke test that precisely one label diverges.
      Second, and more important: a snapshot-derived tree is **not** self-evidently the released
      version's tree. That gap is only closed by checking it against the real thing — here, a
      Chunkbase comparison on 1.21.4 specifically. Until such a check exists, an entry like this
      deserves less trust than its neighbours, not equal trust because it happens to be newest.
- [x] Re-run a handful of Part 8 Chunkbase spot-checks **per offered version**, not once. Biome
      generation changed substantially across versions (1.18 in particular); a check that passes
      on 1.21.3 says nothing about 1.16.
      **Done: all 18 offered versions checked against Chunkbase on seed 1, all matching.** The
      smoke test pins the origin biome per version as the witness for each, and asserts the
      1.17/1.18 split separately — because 18 per-version witnesses prove nothing if they cannot
      disagree. Were `set_world` to ignore its version argument, every one of them would still
      pass as a single uniform block; the boundary assertion is what makes the set meaningful.
      The newest entry was compared against Chunkbase's **1.21.4** in particular, which is what
      confirms both the identity of the "1.21 WD" placeholder and that its snapshot-derived
      biome tree matches the released version.
      **Biomes only.** Structures are still verified on 1.21.3 alone, and region salts and
      viability rules are version-parameterised too, so biome agreement says nothing about them.

### Status: the map ships, the calculator does not

13.2 is done — 18 versions, 1.8.9 through 1.21 WD, selectable on the seed map. Structure
availability follows automatically, because the engine is asked rather than a table being kept
here: `structure_supported` answers for the loaded version *and* dimension, so pillager outposts
appear from 1.14, ancient cities from 1.19, trail ruins from 1.20 and trial chambers from 1.21,
with no per-type version list in the UI. Selecting a version demonstrably changes generation:
seed 1's origin biome is `ocean` up to 1.17 and `deep_ocean` from 1.18, the overhaul Part 7 was
bitten by. **All 18 versions have been confirmed against Chunkbase on seed 1**, so the biome
side of the map is verified across its whole offered range rather than at one pinned version.
Structures remain checked on 1.21.3 only.

That sweep also **settles the oldest open question in this file**. Seed 1's origin biome was
recorded back in Part 8 as "ocean" from a Chunkbase check, while the engine insisted on
`deep_ocean`; the smoke test pinned it as a regression rather than ground truth because the
discrepancy had no explanation. It has one now: `ocean` is exactly what pre-1.18 generation
produces there, and 1.21.3 has since been checked directly. The original note was read off a
pre-1.18 view and later attributed to 1.21.3 — both observations were right, and only the
version attached to one of them was wrong.

The lesson generalises past this one cell. A biome label is meaningless without the version it
was read at, and an external source that silently defaults to a different version will produce
disagreements that look like bugs. Leaving it as a regression for months was the right call: it
preserved the contradiction intact until there was enough information to resolve it, instead of
burying it under a plausible guess.

**13.3 is deliberately NOT implemented.** It is not blocked on code — the shape below is clear
enough — but on *data*: each version needs its enchantment tables transcribed, under 10.2's
two-independent-transcriptions rule. Generating those tables from anything other than a real
source would produce a calculator that is confidently wrong, which is worse than one that is
honestly limited. The calculator therefore stays pinned to 1.21.3 and says so in its own panel,
explicitly noting that it does not follow the map's selector. That is 13.1's per-tool rule doing
its job rather than a gap.

## 13.3 — Multi-version enchantment data

The bulk of the work, and it is transcription plus codegen rather than algorithms.

- [ ] **One dataset file per version**, each carrying its own `_provenance` block exactly as the
      current file does. `build.rs` globs the data directory instead of naming one file, and emits
      one table module per version plus a lookup from version string to table.
- [ ] **Landmine — `ENCHANTMENTS` is a fixed-size `[EnchantmentData; 42]`.** That count is
      1.21.3's. It must become a slice (`&'static [EnchantmentData]`) before a second version can
      exist, and every consumer that assumed a fixed length or a compile-time-known index follows.
- [ ] **Landmine — enchantment indices are version-scoped, and nothing in the type system says
      so.** `exclusive_with` is `&[usize]` into *its own* table; `index_of` returns a position in
      *a* table; `optimal_plan` takes `(usize, i32)` pairs. Mix an index resolved under one
      version with a table from another and you get a real enchantment with the wrong identity —
      no error, just a wrong answer. Resolve names to indices once per request, against the
      selected version's table, and never cache an index across a version change. The UI already
      keys its selection map by **name**, which is the right shape; keep it that way.
- [ ] Make the version an explicit parameter of the public surface (`offered_levels`,
      `enchantments_in_slot`, `enchant_applicable`, `anvil_optimize`, …) rather than a mutable
      global. A global "current version" invites exactly the cross-version index bug above, and
      makes the crate's tests order-dependent.
- [ ] **Landmine — a second dataset is a second chance to make transcription errors, with no
      cross-check.** Part 10.2's rule (two independent transcriptions, diffed) was what caught the
      original errors; it applies per version. Do not hand-edit a copy of the 1.21.3 file into a
      new version — that produces a file that looks plausible and shares every one of the original's
      mistakes while adding new ones.
- [ ] Generate golden vectors per version from a JDK matching **that** version, per 10.5. Vectors
      from one version do not validate another.

## 13.4 — Version-dependent logic, not just data

The tables express what exists; they do not express how it behaves. Assume nothing here is
version-independent merely because it currently passes for 1.21.3.

- [ ] **Audit each rule for version sensitivity, and record the finding either way.** The roll
      path (offered levels, the enchantability modifier, the ±15% triangular bonus, the
      book-loses-one-enchantment draw) and the anvil path (the `2^n - 1` prior-work penalty, the
      item-vs-book multiplier, the survival "too expensive" limit) each need a verdict: verified
      identical across the versions you offer, or version-gated. An unexamined rule is not the
      same as an unchanged one.
- [ ] **Landmine — content changes silently shift the roll.** The weighted pick walks the
      applicable enchantment list, so adding or removing an enchantment from a version changes
      which one a given seed lands on — even for enchantments that themselves did not change. The
      1.21 mace enchantments (density, breach, wind burst) are in the current dataset and are
      exactly this kind of change. This is why per-version golden vectors are non-negotiable.
- [ ] **Landmine — the anvil cross-checks were version-spanning by luck, not by design.** The
      hand-verified anvil results matched on both 1.21.3 and 26.2, which is evidence those
      mechanics are stable across that gap — not evidence that they are stable everywhere. The
      untested span is the whole of 1.8.9 → 1.21.3, and that is where the risk sits. In
      particular, confirm when the survival "too expensive" cap took its current form rather
      than assuming the 39 in `TOO_EXPENSIVE_LIMIT` holds at the bottom of the range.
- [ ] Where a rule genuinely differs, gate it on the version explicitly at the call site rather
      than branching deep inside a helper, so the difference is visible when reading the
      algorithm.

## 13.5 — UI wiring, state migration, and verification

- [ ] **Surface the active version in each tool**, replacing the single global `MC_VERSION`
      readout. A user cross-checking against a wiki needs to know which version's rules produced
      the number in front of them.
- [ ] **Landmine — selected state may not exist in the newly chosen version.** Switching versions
      can strand a selected item or enchantment that the target version never had (or that was
      removed from it). The item and enchantment dropdowns are already generated from the data, so
      they will re-render correctly on their own — the failure is the *retained selection* behind
      them. Drop what no longer applies and say so, rather than silently computing against a
      substitute. The anvil grid already drops selections that do not apply to the chosen item;
      extend that same pass to a version change.
- [ ] Default to the newest version both halves support, so the common case needs no interaction.
- [ ] **Verify per version, not once.** Every claim in Parts 8 and 10 is a claim about one
      version. Re-run the Chunkbase spot-checks, the external enchantment-calculator comparison,
      and the real-anvil check against each version you offer, and treat any version you have not
      checked as unverified — including in the UI, if you ship it anyway.

## 13.6 — Swapping the engine vendor (done: Cubitect → xpple)

Upstream Cubiomes stopped at 2024-11-10. Minecraft did not: the 1.21 line ran to 1.21.11 and
then versioning moved to a 26.x scheme, with 26.2 adding sulfur cave biomes. `MC_NEWEST` capped
the tool at 1.21.4 — a limit in the *vendored data*, not in any code here, and therefore not
fixable here. This is the general shape of the problem: worldgen support is upstream's to
provide, because the parameter tables come from reverse-engineering the game.

Resolved by moving the submodule to `xpple/cubiomes` (93 commits ahead of upstream, 0 behind,
MIT like upstream, actively maintained). Checks made **before** switching, in this order:

- [x] **Do the functions we call still exist, unchanged?** All 13 the shim uses had identical
      signatures. A swap that compiles but silently changes a signature's meaning is the bad case.
- [x] **Is the licence compatible?** MIT to MIT.
- [x] **Is it maintained, or a drive-by?** Recent commits, issue numbers referenced in messages,
      the specific features claimed (sulfur caves, Nether terrain) present in the enum and tables.

- [x] **The one that actually matters — does it change output for versions already verified?**
      Every ground-truth assertion in this project is a claim about output from *a particular
      engine*. A 93-commit swap can silently alter old versions, which would invalidate all of
      Part 8 at once. Do not reason about this from commit messages. **Measure it**: load the
      previously deployed `cubiomes.wasm` alongside the newly built one and compare them
      directly, matching versions by label rather than enum id (ids shift when entries are
      inserted). Result here: all 18 shared versions byte-identical across surface biomes,
      terrain heights, Nether, End, and all 18 structure types over a 4096-block square — so the
      existing verification carried over. Had anything differed, the honest move was to demote
      Part 8's ground truth to regression, not to hope.
- [x] **Split the assertions by verification tier afterwards.** The new versions inherit nothing.
      The smoke test now checks 1.8–1.21.4 as ground truth and 1.21.5+ as regression, plus an
      assertion that *both tiers are non-empty* — otherwise a future edit could empty one side
      and leave a check that reads as though it still covers everything.

Two defects the swap exposed, both worth keeping in mind for the next one:

- [x] **A forked engine can be internally inconsistent.** `MC_1_21_6` exists in the enum but is
      missing from **both** `mc2str` and `str2mc`, so it cannot be named in either direction and
      cannot be offered. The registry's round-trip guard already refused it — correctly — but
      silently. Gaps are now returned explicitly and asserted. Omitting it is harmless *because
      it was measured to generate identically to both neighbours* (1.21.6 changed no worldgen),
      not because that seemed likely.
- [x] **A gap is not the same as "no predecessor".** The range logic reset its previous-entry
      state on a skip, so the entry after the gap advertised `1.21 – 1.21.9` and swallowed the
      four 1.21.x entries that really owned that range. An unknown lower bound must print **no**
      range rather than a plausible one. The contiguity assertion is what catches this.

Outstanding after the swap was that **1.21.5 and newer had been compared only against our own
engine**. 13.7 added the depth control, and the new versions were then confirmed against
Chunkbase — so all 23 offered versions are now ground truth for biomes. Structures remain checked
on 1.21.3 alone.

## 13.7 — Drawing a depth slice, so cave biomes are visible

26.x differs from 1.21.11 in exactly one thing: the `sulfur_caves` biome. It is underground, so
the question was whether the map could show it at all. Answer: yes, and the change is small,
because the 2D map was *already* drawing a fixed horizontal slice (block y 60) rather than the
terrain surface. Making that y adjustable is the whole feature.

- [x] Take the control's value in **block y**, the number on the F3 screen, and convert per draw.
      Cubiomes' vertical scaling is 1:1 only at scale 1 and 1:4 otherwise, so the conversion
      depends on the scale the zoom picked and cannot be done once at the input.
- [x] **Use `>> 2`, not `/ 4`.** Truncating division rounds toward zero, so y=-17 would land in
      the cell above the one containing it. That error appears only below y=0 — precisely the
      range this feature exists to show.
- [x] **Landmine — depth must be in the tile cache key.** Same rule as scale: the same tile index
      at another depth is different ground. Without it a cave layer shows surface tiles, or a mix,
      depending on what happened to be cached — the convincingly-wrong failure this project has
      hit before. It is also the one line the smoke test cannot reach, since map2d needs a DOM, so
      the key is exported and unit-tested separately.
- [x] **Hide the control where it does nothing.** Overworld biomes became 3D in 1.18; before
      that, and in the Nether and End at these scales, y is ignored entirely. Measured rather than
      assumed: moving y from 63 to -16 at seed 1 changes 458 of 4096 cells on 1.18+ Overworld and
      exactly 0 on 1.17, in the Nether, and in the End. Reset it when hiding, or a depth carried
      into a version that ignores it reappears later with no explanation.

**A correction worth recording.** The 13.6 note said 26.x could not be distinguished on a surface
map. That was wrong in a way worth understanding. The *terrain surface* biome is indeed identical
— at (1356, 2980) the surface is y≈79 and reads `plains` in both versions. But this map does not
draw the terrain surface; it draws a fixed y slice, and its default of 60 is already **underground
wherever terrain rises above it**, which is most land. So at that column the map shows
`sulfur_caves` on 26.2 and `plains` on 1.21.11 *at the default depth*, and 26.x was checkable all
along. The depth control makes it systematic instead of dependent on where terrain happens to sit
relative to y=60.

The general lesson: "the map shows surface biomes" was an approximation nobody had restated since
it was written, and a conclusion got built on it. When a claim about the tool's own behaviour is
load-bearing, re-derive it from the code rather than from memory of the code.

- [x] Verify 1.21.5+ against Chunkbase. Done at **(1356, 2980), depth 60**: 26.2 shows sulfur
      caves there and 1.21.11 shows plains, matching Chunkbase. The other cave biomes were
      confirmed at the same time — dripstone at (-3072, -3072), lush caves at (-3068, 184), deep
      dark at (-2516, -3032), all at y 60 on seed 1.
      This is what closed the last verification gap from the engine swap, and it is worth noting
      how small the evidence needed to be: one coordinate at one depth, chosen because it was the
      only place the two versions could disagree. Finding *where* a claim is falsifiable is most
      of the work; checking it there is cheap.
- [ ] **Still open: structures are verified on 1.21.3 only.** Region sizes, salts and viability
      rules are all version-parameterised, so 22 of the 23 offered versions have structure output
      that nothing has checked. Biome agreement says nothing about it. This is now the largest
      unverified surface in the project. 13.8 starts on it.

## 13.8 — Structures across versions, starting at the 1.14 outpost boundary

Same method as the sulfur column: find where versions can disagree, then check there. Sweeping
every type at every version wastes effort on regions where nothing changes.

**Finding the boundaries.** For each type, take the nearest few from the origin at every offered
version and record only the versions where the answer changes. On seed 1 the result is that
almost every Overworld type has its output rewritten at **1.18** — unsurprising once stated,
since `isViableStructurePos` is a biome check and 1.18 replaced biome generation wholesale.
Outposts specifically have four regimes: absent through 1.13, then distinct sets appearing at
1.14, 1.15, 1.16, and 1.18. The nearest three happen to be stable across 1.14–1.17; the regime
changes in between are further out.

- [x] **Landmine, hit while writing the probe — the structure cache is per world, not per call.**
      `createStructures` caches results, and `S.setWorld()` is what clears it. A sweep that
      changes version with `engine.setWorld` but never clears that cache reports the *first*
      version's answer for every subsequent one, and the output looks perfectly plausible: a
      clean table showing that structures never change across versions. That is exactly the
      conclusion the first run produced, and it is wrong.
      The application does not have this bug — a version change runs `submit()` → `loadWorld` →
      `map2d.setWorld` → `structures.setWorld()` — but it is worth knowing that the *analysis*
      tooling shares the trap, and that a wrong answer here is a quiet one. The smoke test now
      fails in three places if the clear is removed.

**What is asserted, and at which tier.** Positions are REGRESSION — none has been checked
externally yet. What is ground truth is the shape:

- Outpost availability is a clean step at 1.14 across all 23 versions, not just at the one
  boundary pair. A salt or config change that made them resolve early would slip past a
  two-sided check.
- The 1.14 and 1.18 eras must genuinely differ, since 1.18 rebuilt the biomes their viability
  check reads. Agreement would mean the version never reached the viability test.
- The eras must nonetheless **share** at least one position. Full disjointness cannot distinguish
  "same generator, different rules" from "two unrelated random streams"; a survivor can.
  (1888, -3504) is an outpost in every version from 1.14 on.

- [x] Checked against Chunkbase — **all three match**. The sharp ones are coordinates that *flip*,
      because a version-blind tool would have to get both wrong:
      | coordinate | 1.14–1.17 | 1.18+ |
      |---|---|---|
      | (80, 320) | outpost (plains) | none (ocean) |
      | (-1904, -1328) | none (forest) | outpost (snowy plains) |
      | (1888, -3504) | outpost | outpost |
      The third is the control: full disagreement between eras would be equally consistent with
      the tool emitting unrelated noise per version, and a survivor rules that out.
      Outpost positions at 1.14 and 1.18 are now ground truth. Note how narrow that still is —
      one type, one seed, one boundary — and that it is worth stating in those terms rather than
      as "structures are verified".
- [x] Then repeat for one pre-1.18 type that is not gated on 1.14 — desert pyramids, which have
      existed since 1.3, so their behaviour at 1.18 tests version-dependent viability alone.

### Desert pyramids across the 1.18 boundary

Three positions have clean era masks — present across exactly one era, absent across the other,
switching at 1.18 and nowhere else — plus one control present in all 23 versions:

| coordinate | 1.8.9 – 1.17.1 | 1.18.2 – 26.2 |
|---|---|---|
| (2624, 2816) | pyramid | none |
| (-1760, 3936) | pyramid | none |
| (-2848, -10000) | none | pyramid |
| (768, 10880) | pyramid | pyramid |

- [x] **Screen candidates through the footprint rule before offering them.** Cubiomes checks only
      the biome, so it reports pyramids the game declines to place when the 21x21 footprint dips
      below sea level. Offering an unscreened coordinate would mean re-discovering that known
      limitation and reading it as a version bug. Re-deriving the screen on the nine positions
      already checked reproduces a clean gap: absent cases have footprint minima 50-64, present
      cases 74-76. Every coordinate above clears it comfortably.
- [x] **Caveat — the screen is calibrated on 1.18+ heights only.** `mapApproxHeight` has a
      genuinely different branch below 1.18 (a biome depth/scale kernel rather than the noise
      depth parameter), so the threshold does not transfer with known accuracy. The two pre-1.18
      coordinates sit at footprint minima of 77 and 72, far enough above the boundary that a few
      blocks of error in an uncalibrated estimate should not matter — but that is a judgement,
      not a measurement.
- [x] **A check that passed under the bug it was written for.** The first version of the
      version-sensitivity assertion compared two positions' era masks and required them to
      differ. A version-blind tool passes that easily: it still returns a *constant* mask per
      position, and two positions can be constantly different. The property that actually
      separates the two worlds is that some position's mask is **not constant**. Same failure as
      the flight test asserting finiteness instead of direction — the assertion was about the
      wrong property, and only mutation testing exposed it.

- [x] Check the four coordinates above against Chunkbase on one pre-1.18 version and one 1.18+
      version. **All four match.**

**Be precise about what that buys.** Chunkbase confirmed the *era-level* claim: a pyramid on one
pre-1.18 version and none on one 1.18+ version, and the reverse. The 23-entry mask asserted in
the smoke test is that plus **within-era constancy**, which is a property of this code and was
never externally checked. Both halves are asserted, and neither alone would justify the mask —
so the constancy half is now its own named assertion rather than being folded invisibly into a
long array comparison. It reports which version disagrees with its era, so a failure names the
offender instead of printing two 23-element arrays to diff by eye.

With this, the two claims that were entangled are separated: outposts cover the introduction
gate at 1.14, pyramids cover version-dependent viability at 1.18 for a type present throughout.

- [ ] **Remaining structure gaps**: the other 21 Overworld types are still checked on 1.21.3
      alone, and the pre-1.18 Overworld boundaries (1.9, 1.16) have no verified coordinate — every
      flip candidate there failed the footprint screen, which is itself uncalibrated below 1.18,
      so that needs a different method rather than more searching. 13.9 covers the other two
      dimensions.

## 13.9 — Nether and End structures across versions

The Nether had **no external verification at any version**: fortress and bastion positions were
regression-only from the day they were added. The End was checked on 1.21.3 alone. This closes
the per-version question for both, and finds that the two dimensions need opposite treatment.

**The End is nearly free.** Nether biomes change exactly once, at 1.16, and are byte-identical
from 1.16.1 onward; End biomes never change at all across the offered range. So:

- **End cities have ONE regime.** Their positions are identical in every version that has them
  (1.9 onward). That matters because the 18-observation Chunkbase check from Part 14 was done on
  1.21.3 only — with invariance asserted, that single verification now covers all 22 versions.
  This is the cheapest result in the whole verification effort, and it came from measuring
  something that was assumed to need 22 checks.
- **End gateways are the opposite**: four config regimes (`s_end_gateway_115` / `_116` / `_117` /
  default), so the boundaries land at 1.13, 1.16, 1.17 and 1.18. The existing check covers only
  the newest. Three regimes remain unverified.

**The Nether has a structural invariant worth more than any coordinate.** `s_fortress` and
`s_bastion` share a salt (30084232) *and* a region grid (27 chunks), so a region holds one or the
other, never both. From 1.18 they partition it exactly — fortresses generate precisely where
bastions do not — while in 1.16–1.17 each rolled independently and some regions get neither.

- [x] **Assert the partition, not just the absence of overlap.** "No region holds both" is nearly
      vacuous: a wrongly small region size satisfies it trivially, since two structures never
      share a block. Counting how many interior regions hold exactly one is what bites — the
      halved and doubled region sizes each fail it. Count only regions **fully inside** the scan
      box, or edge clipping reads as an empty region.
- [x] The 1.16–1.17 "some regions hold neither" assertion earns its place separately: a
      version-blind engine answering from 1.21.3 for everything passes the partition check and
      fails this one.

- [x] **Checked externally; all assertions here are now ground truth.** The Nether pair was the
      sharp test — 1.18 swapped which structure each region gets, so a single coordinate changes
      *type*, which a version-blind tool cannot produce and a merely-shifted one would break the
      controls on:
      | coordinate | 1.16 – 1.17 | 1.18+ |
      |---|---|---|
      | (192, 0) | fortress | bastion |
      | (112, 528) | bastion | fortress |
      | (336, -128) | fortress | fortress |
      | (-256, -432) | bastion | bastion |
      All four confirmed on both sides, plus a 1.21.3 baseline on the nearest fortress and
      bastion — the first external check the Nether has ever had.
- [x] **The End gateway coordinates needed a second source.** (-1501, 311) on 1.13,
      (-1085, -403) on 1.16, (-1200, -132) on 1.17, all confirmed — but against
      **mcseedmap.net**, not Chunkbase, which does not offer End gateways on 1.13. Recorded in
      the assertion's comment because provenance naming the wrong site is worse than none:
      anyone re-checking on Chunkbase would find the oldest unverifiable and conclude it was
      fabricated. Worth remembering as a general point — when a boundary check reaches back far
      enough, the reference tool may not reach with it, and the fix is a named second source
      rather than dropping the old regime.

**Where this leaves per-version structure coverage.** Verified across versions: outposts (1.14
and 1.18 boundaries), desert pyramids (1.18 boundary), fortresses and bastions (1.18 swap), End
cities (all versions, via invariance), End gateways (all four regimes). Still 1.21.3-only: the
remaining Overworld types. The pre-1.18 Overworld boundaries are handled next, in 13.10.

## 13.10 — The pre-1.18 Overworld boundaries (1.9 and 1.16)

The earlier attempt on these searched **desert pyramids** for a coordinate that flips across the
boundary, and every candidate died on the same screen: a pyramid does not generate partly
submerged, so the finder applies a footprint/sea-level check — and that check is uncalibrated
below 1.18, where terrain is a different noise system. So a failed candidate could not be told
apart from a mis-screened one. The lesson was not "search harder" but **change the instrument**:
pick discriminators with no sea-level constraint at all.

**1.9 — two independent mechanisms.**

- **Strongholds.** They are underground, so there is no terrain gate whatsoever. The count jumps
  `3 → 128` at exactly 1.9 (`finders.c`: `mc >= MC_1_9 ? 128 : 3`), and the ring algorithm
  changes, so the first stronghold moves `(-92, -732) → (-220, -1916)`. The count step is ground
  truth from the source; the positions are pending Chunkbase.
- **MC-98995.** This is the sharp one, and it came out of reading `biomes.c`, not searching.
  `getMutated` emulates a real Minecraft bug present only in 1.9–1.10: `birch_forest` mutates to
  `tall_birch_HILLS` instead of `tall_birch_forest`, reverting at 1.11 (`mc >= MC_1_9 && mc <=
  MC_1_10`). So a single coordinate — `(-352, 992)` — reads `tall_birch_forest / tall_birch_hills
  / tall_birch_hills / tall_birch_forest` across 1.8.9 / 1.9 / 1.10 / 1.11. A **two-version
  window** no version-blind tool can produce, and it is a pure biome read, which the map already
  verifies against Chunkbase. The smoke test also asserts the window is exactly 1.9–1.10 across
  the whole offered list, which is the property the source encodes.

  Worth keeping as method: the biome map changes at *every* boundary (an 11-cell grid delta at
  1.9, one cell at 1.16, 387 at 1.13, 2264 at 1.18), and biomes need no viability screen. When a
  structure boundary resists verification, the biome delta underneath it may be directly
  checkable instead.

**1.16 — introduction gate plus a resize signature.**

- **Ruined portals** arrive at 1.16.1 (config gate), so the absent side needs no screen at all.
  `(304, 288)` is absent through 1.15.2 and present from 1.16.1.
- **Shipwrecks** grew their region grid `16×8 → 24×20` at 1.16, which moves coordinates both
  *out* of and *into* the generated set across one boundary — the sharpest 1.16 test, because it
  flips in both directions. `(48, 16)` is present 1.13.2–1.15.2 and gone at 1.16.1; `(-288, 176)`
  is the reverse.
- **The control had to be a different type.** The resize reshuffles the shipwreck field so
  completely that *no* shipwreck survives the boundary, so a same-type control is impossible. A
  **monument** — whose config does not change at 1.16 — that stays put at `(-960, -288)` fills
  that role, ruling out a tool that shifts positions by the wrong rule (which the two shipwreck
  flips alone would not catch).

Mutation test: a version-blind engine answering everything from 1.21.3 trips every one of these —
count reads 128 at 1.8.9, the birch cell reads `old_growth_birch_forest` (never hills), ruined
portals report as available at 1.8.9, and both shipwreck flips collapse to a constant.

- [x] **Structural / code-derived claims are ground truth**: the stronghold count step, the
      ruined-portal availability step, and the exact 1.9–1.10 span of the birch window.
- [ ] **Coordinate-level claims pending Chunkbase** (regression until then):
      | boundary | coordinate | claim |
      |---|---|---|
      | 1.9 | first stronghold | `(-92, -732)` on 1.8.9, `(-220, -1916)` on 1.9.4 |
      | 1.9 | `(-352, 992)` | `tall_birch_forest` → `tall_birch_hills` (1.9–1.10) → back at 1.11 |
      | 1.16 | `(304, 288)` | ruined portal absent ≤1.15.2, present ≥1.16.1 |
      | 1.16 | `(48, 16)` | shipwreck present 1.13.2–1.15.2, gone at 1.16.1 (resize out) |
      | 1.16 | `(-288, 176)` | shipwreck absent ≤1.15.2, present ≥1.16.1 (resize in) |
      | 1.16 | `(-960, -288)` | monument unchanged across the boundary (cross-type control) |

**Where this leaves per-version structure coverage.** Verified or code-pinned across versions:
outposts, desert pyramids, fortresses/bastions, End cities and gateways, plus the 1.9 and 1.16
Overworld boundaries above. Still 1.21.3-only: the remaining Overworld types, at versions away
from a boundary — a broad-but-shallow gap rather than a sharp one, since every version-sensitive
config change now has at least one boundary witness.

## 12.6 — Structure coverage beyond the verified four

12.4 ships four types (village, ocean monument, woodland mansion, stronghold), all confirmed
against Chunkbase on seed 1 / 1.21.3. Cubiomes exposes **23 usable types** in 1.21.3 — the
enum's `Feature` is pre-1.13 only — so this is about widening that set deliberately.

The instinct is that per-chunk structures must be ruinously expensive to scan, since their
region is 1 chunk against a village's 34. **Measured, that is false**, and it is worth
knowing before designing around it:

| type | region | scan of one 2048-block cell | found |
|---|---|---|---|
| Village | 34 chunks | 1.4 ms | 2 |
| Treasure | 1 chunk | 1.3 ms | 9 |
| Mineshaft | 1 chunk | 0.3 ms | 83 |
| Geode | 1 chunk | 0.7 ms | 673 |
| Ruined_Portal | 40 chunks | 0.0 ms | 13 |

Village costs more than geode despite scanning 1/1000th as many candidates, because its cost
is the **biome viability check**, not candidate enumeration. Scan cost tracks how expensive a
type's viability rule is, not how many regions it covers.

- [ ] **The real limits are density and dimension, not cost.** Geodes come in at ~620 per
      default-zoom viewport; drawn as markers that is noise, not information. Per-chunk types
      need their own much tighter zoom cutoff, or clustering, or to be left out.
- [ ] **Landmine — three types are Nether and three are End.** `Ruined_Portal_N`, `Fortress`
      and `Bastion` are `DIM_NETHER`; `End_City`, `End_Gateway` and `End_Island` are `DIM_END`.
      `gen_structures` rejects a type whose `sc.dim` does not match the loaded generator, and
      the map loads the Overworld unconditionally. These six are therefore blocked on a
      dimension switch — which also means Nether/End biome rendering — not on structure work.
      Six of the 23 are a *different feature*; do not scope them into this one. That feature is
      **Part 14**, and 14.3 picks these up.
- [ ] **Each type is a separate verification claim, and that is the actual per-type cost.**
      `structure_id` is deliberately narrow: adding a name to it asserts that type was checked
      against Chunkbase for the pinned version. Widen it one type at a time, verifying each,
      rather than pasting the enum in and assuming the shared code path makes them all correct.
      Placement rules differ per type, so a shared path proves nothing about any single one.
- [x] Prefer the types a player actually navigates to — outpost, desert pyramid, jungle temple,
      swamp hut, igloo, ancient city, trail ruins, trial chambers, shipwreck, ruined portal,
      buried treasure — over the ambient ones (geode, desert well, mineshaft) that mainly add
      clutter.

### What is left, and why it was left

Cubiomes exposes 23 structure types in 1.21.3; 21 are now live. The remainder were excluded on
measurement, not oversight — counts are per default-zoom viewport at seed 1:

| type | per viewport | why not |
|---|---|---|
| Geode | 621 | Players do hunt amethyst, but this needs its own far tighter zoom cutoff before it is information rather than noise. |
| Mineshaft | 71 | Dense and underground; useful for routing, cluttered as markers. |
| Desert well | ~0 | Cosmetic, and vanishingly rare. |
| End island | 0 viable anywhere measured | The layer can only ever be empty (0 of 1,162 candidates near the origin, 0 of 1,212 at 12k out). |

- [ ] **Two non-structure layers are better value than any of those**, and Cubiomes already
      supports both: slime chunks (`isSlimeChunk`) and world spawn (`getSpawn` /
      `estimateSpawn`). Slime chunks in particular are a staple of every other seed map and
      matter for farm planning. They need a different rendering path — a shaded chunk overlay
      rather than point markers — so they are their own piece of work, not another entry in
      `STRUCTURE_TYPES`.

### Known discrepancy — `isViableStructurePos` is a biome check, nothing more

Spot-checking the eleven new types against Chunkbase (seed 1 / 1.21.3, nearest three of each)
matched on 31 of 33 positions. Two did not: a desert pyramid at (-416, 10416) and a trail ruin
at (-336, -1552), both of which this tool reports and Chunkbase does not.

Ruled out, each by direct test rather than argument:

- **Not the biome check.** Both positions carry a valid biome for their type at y=319 (what
  Cubiomes actually samples), at the approximate surface, and at y=63.
- **Not a position offset.** Enumerating every candidate within 1,200 blocks shows each
  disputed position is the genuine candidate for its own region, with no near alternative it
  could have been confused with.
- **Not version drift.** Both are byte-identical and viable across 1.20.6, 1.21.1, 1.21.3 and
  1.21_WD.
- **Not the region or box-scan math**, which is separately tested against brute force.
- **Terrain — initially dismissed, on reasoning that was wrong.** The first pass rejected it by
  observing that ~7% of *villages* sit on equally rough ground and ~30% equally low, "and
  villages verify correctly". That comparison is invalid: only **three** villages were ever
  checked, none of them low-lying, so it says nothing about the 166 low ones. Treating a
  property of an unexamined population as verified is precisely the error this guide keeps
  warning about, and it was made here.

  Tested properly, terrain is the discriminator. Six predicted cases were checked against
  Chunkbase and **all six matched the prediction**, giving nine data points that separate
  perfectly on terrain height with a clean gap:

  | Chunkbase | terrain y at the position |
  |---|---|
  | absent | 69, 65, 62, 59, 59 |
  | present | 86, 80, 78, 77 |

  Biome is definitively *not* the cause: all nine read `desert` at every sampled y, including
  at y=319 where Cubiomes checks, at the real surface, and at y=64.

  The mechanism is submersion, but of the **footprint**, not the centre — a first pass guessed
  "centre below sea level" and that is wrong, since two absent cases sit at 69 and 65, above
  the sea level of 63. Sampling the 21x21 pyramid footprint, every absent case dips below sea
  level somewhere (minima 55, 52, ~62, 52, 61) while every present case stays clear (81, 72,
  74, 78). A pyramid does not generate partly submerged; Cubiomes checks only the biome, and in
  1.18+ biome and terrain height are independent noise systems, so a column reads `desert`
  regardless of whether its terrain is above water.

- [ ] **Even with the mechanism understood, do not implement it as a height filter yet** — the
      height model is not accurate enough to drive one. See the accuracy correction below.

What remains is the documented scope of the check itself: finders.h describes
`isViableStructurePos` as performing *"a biome check ... to determine whether a structure
**could** spawn there"*. It is a necessary condition, not a sufficient one. Real generation can
still decline for reasons Cubiomes does not model, which yields **false positives — structures
shown that do not exist — but not false negatives**.

- [ ] **Do not "fix" this with a terrain heuristic.** It would trade a small, measured
      false-positive rate for an unmeasured false-negative rate, and a missing structure is far
      worse than a spurious one: the user cannot tell a phantom from a real structure they
      failed to find, but they *can* verify a marker by travelling to it. Only act on a rule
      taken from Minecraft's actual generation code, not one reverse-engineered from two cases.
- [ ] Say so in the UI instead. Markers are candidate positions satisfying the biome rule; a
      small fraction may not generate. That is honest and costs nothing.
- [ ] If the rate turns out higher than ~5%, revisit — that would suggest a modelling gap
      rather than the known limit of a biome-only check.

## 12.7 — Nearest-structure locator

Find the N nearest structures of a chosen type and draw a line to each from the view centre.
Depends on 12.4's cache; the search is the interesting part.

- [x] **Landmine — stopping as soon as N are found gives wrong answers.** Scanning outward in
      square rings of grid cells and halting on the Nth hit is the obvious implementation and
      it is incorrect: a structure in the next unscanned ring can be nearer than one found in
      the *corner* of a ring already scanned. Keep expanding until the nearest possible point
      of the next ring is farther than the current Nth-best distance, then stop. This is the
      one part of the feature that can be confidently wrong.
      **Implemented as: everything unscanned lies outside the square covered so far, so it is
      at least `edge` away (origin to nearest side); stop only once N results are in hand and
      the Nth is no farther than `edge`.** Verified against brute force — 672 checks on a
      synthetic world and 30 on the real engine across three types and five origins, 0
      mismatches. Substituting the naive rule breaks 45 of the 672, including at N=1, so the
      failure is routine rather than a corner case.
- [x] **Landmine — strongholds are not returned in distance order.** `gen_strongholds` yields
      ring order, which is only loosely distance order: on seed 1 the first three sit at 1809,
      1871 and 1416 blocks. Sort by actual distance rather than taking the first N. The upside
      is that all 128 are already cached, so nearest-N for strongholds needs no search at all.
      **Confirmed live: the nearest to the origin is the third Cubiomes returns.**
- [x] Cap the search radius and report honestly when it is hit ("none within N blocks") rather
      than silently returning fewer than asked. An empty result and a truncated search look the
      same to the user otherwise. **The readout says "found" rather than "nearest" and warns
      explicitly when the search was cut short.**
- [x] Reuse the 12.4 grid cache for the search. **Deviation: it uses a one-off time cap
      (150 ms) rather than the per-frame budget, because the search is user-triggered rather
      than per-frame — there is no frame to starve. Measured 2 ms for the 4 nearest mansions
      from the origin, the sparsest of the four types, so the cap is far from binding.**
- [x] **Draw lines in screen space, and handle targets off-screen.** The nearest match is
      usually outside the viewport at useful zooms. Clamp the line to the canvas edge with a
      distance label rather than drawing to coordinates far outside it. Show the block distance
      and the target coordinate; that is the number the user actually wants.
- [x] Let the user pick N (e.g. 1, 4, 8). Keep the selection stable while panning so the lines
      do not re-target on every frame — recompute on demand or when the centre moves past a
      threshold, not continuously. **Lines anchor to the origin the search used, not the
      current centre: the targets were nearest to that point, and re-anchoring would depict a
      relationship never computed.**

## 12.8 — Map interaction polish

Small fixes to the 2D map, done alongside 12.4.

- [x] **Enter loads.** The seed and x/z fields respond to Enter, not just the load button.
      They are bare inputs rather than a `<form>`, which would have given this for free.
- [x] **Adaptive crosshair.** The centre crosshair took its colour from a fixed white, which
      disappears against snow, ice and desert. It now picks ink from the Rec. 601 luma of the
      biome beneath it and carries a halo in the opposite tone, so it survives mid-tones too.
      The luma is read from the cached tile, not a `getImageData` readback, which would stall
      the pipeline every frame to sample a single pixel.

# Part 14 — Nether and End Support

Let the seed map render the other two dimensions, and unlock the structures that live in them.
Cross-cutting like Part 13: it touches the engine surface, both renderers, the structure
layer, and the portal calculator.

## 14.0 — What already works, and the one thing that cannot

Measure before planning here, because the split is not where it looks.

- [x] **`set_world` already takes a dimension** and validates `DIM_NETHER`/`DIM_OVERWORLD`/
      `DIM_END`. The Rust tile cache already carries `dimension` in its `World` key, so a
      dimension change already invalidates cached tiles. Nothing in the storage layer needs
      changing.
- [x] **`gen_biomes` works in all three dimensions at all five scales.** Verified at seed 1 /
      1.21.3: the Nether returns nether_wastes, soul_sand_valley, crimson_forest and
      basalt_deltas; the End returns the_end, small_end_islands, end_highlands and
      end_midlands. **The 2D map is therefore already capable** — it simply never asks for a
      non-Overworld dimension.
- [x] **Landmine — `gen_heights` returns -1 for the Nether and the End, and that is not a
      limit the shim can lift.** Cubiomes' `mapApproxHeight` has no model for those dimensions
      and returns a sentinel rather than filling the buffer. **The 3D view is therefore
      Overworld-only**, permanently, unless a different height source is introduced. Plan the
      feature as "2D gains two dimensions", not "the map gains two dimensions", or 14.4 will
      come as an unpleasant surprise late.
- [x] **Nether and End biomes do not vary with y**, unlike the post-1.18 Overworld. Measured
      across 289 columns over a 1,600-block box at seed 42: 0 varied in either dimension,
      while the same probe found 57 of 289 varying in the Overworld
      (flower_forest/dripstone_caves — the cave-biome effect Part 7 was bitten by). The control
      matters: without it, "0 varied" is equally consistent with a broken probe. This means the
      2D map's `yArg` — 63 at scale 1, else 15, chosen for Overworld sea level — is simply
      irrelevant in the other two dimensions, and needs no per-dimension tuning.

## 14.1 — Dimension selector and world plumbing

- [x] Add a dimension control alongside the seed/coordinate inputs, and route it into
      `loadWorld`, which currently passes a hardcoded `0`.
- [ ] **Landmine — the same two-`set_world` trap as 13.2.** The engine shim holds the C
      generator; the Rust `View` holds the tile cache; the 2D renderer holds its own JS tile
      cache and its structure cache. Every one of them must be told. Missing any leaves tiles
      generated in the previous dimension on screen, which looks like correct output.
- [ ] Reset the view centre on a dimension change, or at least reconsider it: Overworld
      coordinates carried into the Nether land 8x further out in effective terms (14.2), and
      keeping them silently is disorienting rather than helpful.

## 14.2 — Rendering the other dimensions

- [x] **Landmine — the Nether's 1:8 coordinate ratio makes the same zoom mean different
      things.** The readout now shows the Overworld-equivalent centre alongside the Nether one. A Nether view 1,920 blocks wide covers ground equivalent to 15,360 Overworld
      blocks. Decide deliberately whether the zoom range, the default zoom, and the
      blocks-across readout are per-dimension, and consider showing the Overworld-equivalent
      coordinate — which is exactly what Part 11's converter already computes. A Nether map
      that cannot tell you the Overworld coordinate of what you are looking at is missing the
      point of a Nether map.
- [ ] **The End reads as empty near the origin, and that is correct.** Within ~1,000 blocks it
      is uniformly `the_end`; the interesting biomes start further out. A user who loads the
      End at 0,0 sees one flat colour and reasonably concludes the feature is broken. Say so in
      the UI rather than letting them guess.
- [ ] Check palette contrast per dimension before shipping. Cubiomes' own palette covers Nether
      and End biomes, so nothing needs inventing, but the Nether set is largely reds and browns
      and may read as one mass at a glance. Verify it is legible; if not, that is a per-dimension
      palette tweak, not a generation problem.

## 14.3 — Structures in the other dimensions

- [x] Five of the six types now ship: `Fortress`, `Bastion`, `Ruined_Portal_N` (Nether) and
      `End_City`, `End_Gateway` (End). **`End_Island` is excluded**: measured at seed 1 it is
      viable for 0 of 1,162 candidates near the origin and 0 of 1,212 out at (12000, 12000), so
      the layer would always be empty. Exposing a control that can only ever draw nothing is
      worse than omitting it.
- [x] **Nether ruined portals sit at the same coordinates as Overworld ones, and that is not a
      bug.** Since 1.18 Cubiomes gives both the same salt (34222645), region size and chunk
      range, differing only in `dim`; pre-1.18 they had their own spacing. Nether candidates
      are also viable unconditionally — the Nether branch returns 1 for the type without a
      biome check — so every candidate shows. The coincidence looks like a copy-paste bug on
      screen, which is exactly why it is worth writing down before someone "fixes" it.
- [x] **`gen_structures` already refuses a type whose `sc.dim` does not match the loaded
      generator** — a deliberate guard, not a bug to work around. The UI must filter the offered
      type list by the active dimension, or the user checks a box and correctly gets nothing,
      with no explanation. Each type now carries its dimension, and the checkbox list and the
      locator dropdown are both rebuilt per dimension.
- [x] **Strongholds are Overworld-only** and `gen_strongholds` guards on it. Do not let the
      stronghold toggle survive a switch to another dimension.
- [ ] Each new type needs the same Chunkbase verification as the first four (12.4), against the
      right dimension's map. Nether fortresses in particular changed placement in 1.16; a check
      on the pinned version proves nothing about older ones once Part 13 lands.

### End cities need a height gate as well as a biome check — resolved

`isViableStructurePos` checks only the biome, and for End cities that is badly insufficient:
of 2,837 biome-viable candidates within 20k blocks of seed 1's origin, roughly 82% do not
generate. The first three checked against Chunkbase were all absent, which is what exposed it.

The cause is the same independence Part 14 records elsewhere — since 1.18 biome assignment and
terrain height come from separate noise systems, so a column reads `end_midlands` or
`end_highlands` whether or not there is an island under it. 375 of those candidates sit over
open void; many more sit on terrain simply too low.

**The fix uses Cubiomes' own End terrain model** (`getEndSurfaceHeight`), gating End cities at
a surface height of **61**. This is not the reverse-engineered heuristic 12.6 refuses: there,
no height model existed and a threshold would have been fitted to two cases; here the library
ships the model and the constant was measured.

- [x] **Narrow the threshold before trusting it.** A coarse split (absent ≤58, present ≥61)
      leaves the value ambiguous across (58, 61], and the height distribution piles up exactly
      there — 358 candidates at 59 and 282 at 60. Choosing wrongly inside that window would
      have mis-drawn more than half the layer in one direction or the other, so candidates at
      exactly 59 and 60 were checked specifically. Both absent; the threshold is 61.
- [x] 18 Chunkbase observations now separate perfectly: present at 61, 63, 63, 63; absent at
      60, 60, 59, 59, 58, 57, 57, 57, 56, 56 and three over void. All 18 are encoded in the
      smoke test as ground truth, and moving the constant to 60 or 62 breaks it immediately.
- [x] **End gateways verified and enabled.** Confirmed against Chunkbase in the original Part
      14 list, and unaffected by the height gate, which applies to `End_City` only.
- [ ] The same gap may exist for other types in other dimensions. The lesson generalises: where
      Cubiomes exposes a terrain model for a dimension, a biome-only viability check is a
      necessary condition, not a sufficient one.

## 14.4 — The 3D view stays Overworld

- [x] Disable, or clearly mark, the 3D toggle when a non-Overworld dimension is selected.
      Silently rendering flat or empty terrain is worse than refusing. The toggle is disabled
      with a tooltip explaining why, and `map3d.setWorld` DROPS a non-Overworld load rather
      than deferring it — keeping it pending would replay a load it can never satisfy on the
      next switch back.
- [ ] Only revisit this if a real height source appears. Approximating Nether terrain from
      biome data alone would produce confident, wrong topography — the same class of error as
      the y=0 cave-biome bug, and harder to notice because nobody has an intuition for what a
      Nether height map should look like.

## 14.5 — Verification

- [ ] Chunkbase renders the Nether and the End; check each dimension's biomes exactly as Part 8
      checked the Overworld, on the pinned version, at positive and negative coordinates.
- [ ] **Treat each dimension as independently unverified.** They share `gen_biomes` but not the
      generation logic behind it, so an Overworld check says nothing about the Nether. The same
      applies per structure type per dimension.
