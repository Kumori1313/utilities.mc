//! Thin wrapper over the two WASM modules (Part 7).
//!
//! Deliberately does NOT expose the engine functions on `window`, which the guide's Part 7
//! instructs. That instruction exists to satisfy the `js_namespace = window` binding in the
//! guide's Part 6 sketch, where Rust calls out to JS per sample. This project inverted that
//! — JS drives the loop and hands data to Rust — so there is nothing on the Rust side
//! reaching for `window`, and populating globals would be an unused global namespace.
//!
//! The consequence is that load order between the two modules no longer matters. The guide
//! calls it "load-bearing"; with this design it is not.

export const SCALE = 4; // gen_heights is fixed at 1:4; tiles match it.

// Both modules live in public/ and are produced by scripts/build-all.sh, so they are
// SERVED, not bundled. They must therefore be imported at runtime: a static import would
// make Rollup try to resolve them at build time and fail, since they may not exist yet
// when the frontend is built. `@vite-ignore` tells Vite to leave the specifier alone.
//
// Resolve against BASE_URL, not `location.origin`. Because `@vite-ignore` opts these out of
// Vite's rewriting, they are the one place the deploy base has to be applied by hand — and a
// root-absolute path silently works in dev (base "/") while 404-ing on GitHub Pages, which
// serves this project at /utilities.mc/. BASE_URL always carries a trailing slash, so `path`
// is relative here.
const load = (path) =>
  import(/* @vite-ignore */ new URL(`${import.meta.env.BASE_URL}${path}`, location.origin).href);

export async function boot() {
  const [{ default: createCubiomes }, app] = await Promise.all([
    load('wasm/cubiomes.js'),
    load('app/app.js'),
  ]);
  const initApp = app.default;
  const View = app.View;

  const Module = await createCubiomes();

  const engine = {
    setWorld: Module.cwrap('set_world', 'number', ['number', 'number', 'number']),
    genHeights: Module.cwrap('gen_heights', 'number',
                             ['number', 'number', 'number', 'number', 'number', 'number']),
    // gen_biomes takes CELL coords at any of scales 1/4/16/64/256 — the 2D map drives this
    // at a scale chosen from the zoom level. get_biome_at (3D hover) only allows 1/4.
    genBiomes: Module.cwrap('gen_biomes', 'number',
                            ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']),
    biomeColors: Module.cwrap('biome_colors', 'number', ['number']),
    biomeAt: Module.cwrap('get_biome_at', 'number', ['number', 'number', 'number', 'number']),
    biome2str: Module.cwrap('biome2str', 'string', ['number', 'number']),
    str2mc: Module.cwrap('str2mc', 'number', ['string']),
    // Structures (12.4). Resolve the type through structure_id rather than hardcoding the
    // enum value: StructureType is positional, so a Cubiomes bump can renumber it.
    structureId: Module.cwrap('structure_id', 'number', ['string']),
    genStructures: Module.cwrap('gen_structures', 'number',
                                ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
    genStrongholds: Module.cwrap('gen_strongholds', 'number', ['number', 'number']),
    M: Module,
  };

  await initApp();

  // Pull Cubiomes' own palette rather than inventing one, so colours match every other
  // Cubiomes-based map. 256 entries x RGB.
  const cptr = Module._malloc(768);
  if (engine.biomeColors(cptr) !== 0) throw new Error('biome_colors failed');
  const palette = new Uint8Array(Module.HEAPU8.subarray(cptr, cptr + 768)); // copy
  Module._free(cptr);

  // `app` also carries the enchant_*/anvil_*/portal_* exports — the same initialised
  // module — so the calculator panels share this one instance rather than re-loading.
  return { engine, View, palette, app };
}

/// Parse a seed the way Minecraft does: a numeric string is the seed itself, anything else
/// is hashed. Java's String.hashCode, so text seeds match the game.
export function parseSeed(text) {
  const t = text.trim();
  if (/^-?\d+$/.test(t)) return BigInt.asUintN(64, BigInt(t));
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (Math.imul(31, h) + t.charCodeAt(i)) | 0;
  return BigInt.asUintN(64, BigInt(h));
}

/// Generate one tile's heights + biomes with a single engine call and hand it to Rust.
///
/// Returns false if the engine refused (e.g. a non-Overworld dimension, where Cubiomes has
/// no height model) so the caller can report that rather than mesh an empty buffer.
export function fetchTile(engine, view, tx, tz) {
  // Request the STRIDE, not the owned cell count: the extra row/column is the skirt that
  // lets this tile's mesh reach its neighbour's edge instead of stopping one cell short.
  const n = view.tile_stride;
  const [ox, oz] = view.tile_origin_block(tx, tz, SCALE);
  const cells = n * n;

  const yPtr = engine.M._malloc(cells * 4);
  const idPtr = engine.M._malloc(cells * 4);
  try {
    // gen_heights takes CELL coordinates at its fixed 1:4 scale.
    if (engine.genHeights(ox / SCALE, oz / SCALE, n, n, yPtr, idPtr) !== 0) return false;
    const heights = engine.M.HEAPF32.subarray(yPtr >> 2, (yPtr >> 2) + cells);
    const biomes = engine.M.HEAP32.subarray(idPtr >> 2, (idPtr >> 2) + cells);
    return view.store_tile(tx, tz, SCALE, biomes, heights);
  } finally {
    // Freed even on an early return; the heap views above are invalidated by this, which
    // is fine because store_tile has already copied into Rust's memory.
    engine.M._free(yPtr);
    engine.M._free(idPtr);
  }
}
