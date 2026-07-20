# utilities.mc — Build Guide

**`utilities.mc`** is a browser-based suite of Minecraft utilities, written in Rust and
compiled to WebAssembly. Three tools share one codebase and one deployment:

| Tool | Guide | Depends on |
|---|---|---|
| **Seed map renderer** — 3D biome/terrain view for any seed | Parts 0–9 | Cubiomes (C, via Emscripten) |
| **Enchantment calculator** — predicts enchanting table results | Part 10 | Pure Rust |
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
      let mut out = [0; 3];
      for slot in 0..3 {
          let mut r = JavaRandom::new((xp_seed as i64) + slot as i64);
          let base = r.next_int_bound(8) + 1 + (b >> 1) + r.next_int_bound(b + 1);
          let lvl = match slot {
              0 => base / 3,
              1 => (base * 2) / 3 + 1,
              _ => base.max(b * 2),
          };
          out[slot] = if lvl < slot + 1 { 0 } else { lvl };   // slot n requires level >= n+1
      }
      out
  }
  ```
- [ ] Note the seeding: **each slot re-seeds from `xp_seed + slot`**, it does not continue one
  stream across all three. Getting this wrong gives you a correct-looking slot 0 and wrong 1–2.
- [ ] The `xp_seed` is a **per-player value** that persists until the player actually enchants
  something (any enchant re-rolls it). Your calculator takes it as an input — treat "how does
  the user obtain their xp seed" as a UI/UX question for 10.5, not a math question.
- [ ] Verify the trivial cases by hand before anything else: `b = 0` must never offer a slot-3
  level near 30; `b = 15` must offer 30 in the bottom slot.

## 10.4 — Phase 4: Actual Enchantment Rolls

This is the part with the most steps and therefore the most places to desync. Order is load-bearing.

- [ ] Re-seed with `xp_seed + slot` **again** (the display in 10.3 and the roll here both start
  from the same seed — they are two reads of the same stream, not sequential ones).
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
- [ ] Collect every `(enchantment, level)` candidate whose `[min_cost, max_cost]` window contains
  the modified level, then do a **weighted random pick** over them by rarity weight. Match Java's
  weighted-selection loop exactly (`nextInt(total_weight)`, then walk the list subtracting).
- [ ] Then the multi-enchantment loop, which is where extras come from:
  ```
  loop {
      level = level / 2;                     // integer halving each iteration
      if r.next_int_bound(50) > level { break; }
      remove candidates incompatible with what's already picked;
      if none remain { break; }
      pick another (weighted);
  }
  ```
  Order matters: the halve/roll/filter/pick sequence must match the game's, and incompatibility
  filtering happens **before** the next pick, not after.
- [ ] Books are a special case — they accept enchantments that no other item does, and (version
  depending) treasure enchantments are gated differently. Encode "is this enchantment applicable
  to this item" as a predicate in the data table, not as `if item == Book` branches in logic.

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
  then searches the destination dimension for an **existing portal within a horizontal radius
  (128 blocks in the destination's own scale)** of that target, linking to the nearest one if
  found and creating a new portal if not.
- [ ] The practical consequence, and the thing to surface in the UI: **a 128-block search radius
  in the Nether covers 1024 Overworld blocks.** This is why two Overworld portals built too
  close together both link to the same Nether portal — a very common player-facing problem, and
  a genuinely useful thing for this tool to warn about.
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
- [ ] Each enchanting slot **re-seeds** from `xp_seed + slot`; it is not one continuous
      stream across the three slots (10.3)
- [ ] The ±15% bonus uses **two separate `nextFloat()` draws** summed — one draw doubled gives
      a wrong distribution that still looks plausible (10.4)
- [ ] Incompatibility filtering happens **before** each subsequent pick in the multi-enchant
      loop; reordering it changes results (10.4)
- [ ] Rust's `/` truncates toward zero — **use `div_euclid`** for Overworld→Nether or every
      negative coordinate is off by one (11.1)
- [ ] **Y is never scaled** by the 1:8 ratio; Y clamping is a portal-placement rule only (11.1, 11.2)
- [ ] A 128-block Nether search radius spans **1024 Overworld blocks** — the cause of most
      unintended portal linking, and worth warning about explicitly (11.2)
- [ ] Neither part depends on Cubiomes or Emscripten — **keep them out of `engine/`** so they
      stay on the easy side of the Part 0 libc boundary (10.0)
