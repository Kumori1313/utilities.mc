//! Structure locating and caching (Part 12.4).
//!
//! Wraps the engine's `gen_structures` / `gen_strongholds` with the two things a map needs
//! and the raw calls do not provide: a cache, so panning does not rescan ground already
//! scanned, and a zoom cutoff, so a zoomed-out view does not ask for a scan it cannot afford.
//!
//! # Why the cutoff exists
//!
//! A scan is not proportional to the number of structures found — it is proportional to the
//! regions covered, each of which pays a biome viability check. Measured on this engine at
//! seed 1, scanning for monuments costs ~2 ms across a 1,920-block box, 158 ms across 30,720
//! blocks, and 2,328 ms across 122,880. Villages overflow an 8k-pair buffer at that size.
//! Rendering markers at full zoom-out is therefore not a thing to optimise later; it is a
//! thing not to do.
//!
//! # Correctness
//!
//! Everything here trusts the shim's two-step (candidate then viability check). The one
//! subtlety at this layer is that scanning by box, and filtering returned positions to that
//! box, is exactly complete: a structure at position P in region R is found when scanning the
//! box containing P, because P lies in both R and that box, so R necessarily overlaps it.
//! No structure is missed at a boundary and none is reported twice.

/// Types offered, in draw order. `stronghold` is deliberately separate in the engine (rings,
/// not regions) and is handled by its own path below.
/// Dimensions, matching Cubiomes' DIM_* values — which set_world takes directly.
export const DIMENSIONS = [
  { id: 0, name: 'overworld', label: 'Overworld' },
  { id: -1, name: 'nether', label: 'Nether' },
  { id: 1, name: 'end', label: 'End' },
];

/// Colours are chosen to stay distinguishable *on top of biome colours*, which is why they
/// are light and saturated rather than a conventional categorical palette — every marker also
/// carries a dark outline for the same reason.
///
/// `dim` is load-bearing, not documentation: `gen_structures` refuses a type whose dimension
/// does not match the loaded generator, so offering one from the wrong dimension would give
/// the user a checkbox that silently finds nothing.
export const STRUCTURE_TYPES = [
  { id: 'village', label: 'Villages', color: '#ffd28a', dim: 'overworld' },
  { id: 'outpost', label: 'Pillager outposts', color: '#ff8f6e', dim: 'overworld' },
  { id: 'desert_pyramid', label: 'Desert pyramids', color: '#ffe066', dim: 'overworld' },
  { id: 'jungle_temple', label: 'Jungle temples', color: '#7bd88f', dim: 'overworld' },
  { id: 'swamp_hut', label: 'Swamp huts', color: '#66c2a5', dim: 'overworld' },
  { id: 'igloo', label: 'Igloos', color: '#d6f0ff', dim: 'overworld' },
  { id: 'monument', label: 'Ocean monuments', color: '#6ea8fe', dim: 'overworld' },
  { id: 'ocean_ruin', label: 'Ocean ruins', color: '#80deea', dim: 'overworld' },
  { id: 'shipwreck', label: 'Shipwrecks', color: '#b0bec5', dim: 'overworld' },
  { id: 'mansion', label: 'Woodland mansions', color: '#d08bff', dim: 'overworld' },
  { id: 'ancient_city', label: 'Ancient cities', color: '#4fd1c5', dim: 'overworld' },
  { id: 'trail_ruins', label: 'Trail ruins', color: '#c9a66b', dim: 'overworld' },
  { id: 'trial_chambers', label: 'Trial chambers', color: '#ff6ec7', dim: 'overworld' },
  { id: 'ruined_portal', label: 'Ruined portals', color: '#e57373', dim: 'overworld' },
  { id: 'treasure', label: 'Buried treasure', color: '#a3e635', dim: 'overworld' },
  { id: 'stronghold', label: 'Strongholds', color: '#a6e9c4', dim: 'overworld' },
  { id: 'fortress', label: 'Nether fortresses', color: '#ff8a80', dim: 'nether' },
  { id: 'bastion', label: 'Bastion remnants', color: '#cfa2ff', dim: 'nether' },
  { id: 'ruined_portal_n', label: 'Ruined portals', color: '#ffcc80', dim: 'nether' },
  // End cities were withheld for a while: the biome check alone put ~82% of them on terrain
  // too low to generate, and every one checked was absent. The shim now applies Cubiomes' own
  // End height model as a second gate (END_CITY_MIN_Y), which reproduces all 18 Chunkbase
  // observations exactly, so they are back.
  { id: 'end_city', label: 'End cities', color: '#e6d9ff', dim: 'end' },
  // Gateways were confirmed against Chunkbase in the original Part 14 list and are unaffected
  // by the city height gate, which applies to End_City only.
  { id: 'end_gateway', label: 'End gateways', color: '#b39ddb', dim: 'end' },
];

/// Scan granularity. Each cell is scanned at most once per world and cached whole, so a pan
/// only pays for newly exposed cells. 2048 blocks is ~1-2 ms per cell per type, small enough
/// to fit several into a frame budget.
const GRID = 2048;

/// Widest view, in blocks, that still draws markers. Above this the scan cost climbs into
/// hundreds of milliseconds (see the module note) and the markers would be too dense to read
/// anyway.
const MAX_BLOCKS_ACROSS = 12_288;

/// Pair capacity for one grid-cell scan. A 2048-block cell holds at most a handful of any
/// type; this is slack, not a limit that should ever bind.
const SCAN_CAP = 256;

/// Strongholds in a modern world. The engine returns 128; this is headroom for a version
/// that returns fewer.
const STRONGHOLD_CAP = 200;

/// Widest ring the nearest-search will expand to, in grid cells — a ~86k-block half-extent.
/// A rare structure in an unlucky direction can genuinely be this far, but past here the
/// honest answer is "not found nearby" rather than an unbounded scan.
const MAX_RINGS = 42;

export function createStructures(engine) {
  const cache = new Map(); // "type:gx:gz" -> [[x, z], ...]
  let strongholds = null; // whole-world, fetched once per seed

  const ids = new Map();
  const typeId = (type) => {
    if (!ids.has(type)) ids.set(type, engine.structureId(type));
    return ids.get(type);
  };

  /// Scan one grid cell for one type and cache it. Returns the positions found.
  function scanCell(type, gx, gz) {
    const key = `${type}:${gx}:${gz}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const x0 = gx * GRID, z0 = gz * GRID;
    const ptr = engine.M._malloc(SCAN_CAP * 2 * 4);
    const n = engine.genStructures(typeId(type), x0, z0, x0 + GRID - 1, z0 + GRID - 1, ptr, SCAN_CAP);
    const found = [];
    if (n > 0) {
      const a = engine.M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + n * 2);
      for (let i = 0; i < n; i++) found.push([a[i * 2], a[i * 2 + 1]]);
    }
    engine.M._free(ptr);
    // n < 0 means the engine refused (type absent in this version, or wrong dimension) or the
    // buffer filled. Cache the empty result either way: retrying every frame would turn a
    // refusal into a per-frame cost, and the condition does not change between frames.
    cache.set(key, found);
    return found;
  }

  function allStrongholds() {
    if (strongholds) return strongholds;
    const ptr = engine.M._malloc(STRONGHOLD_CAP * 2 * 4);
    const n = engine.genStrongholds(ptr, STRONGHOLD_CAP);
    strongholds = [];
    if (n > 0) {
      const a = engine.M.HEAP32.subarray(ptr >> 2, (ptr >> 2) + n * 2);
      for (let i = 0; i < n; i++) strongholds.push([a[i * 2], a[i * 2 + 1]]);
    }
    engine.M._free(ptr);
    return strongholds;
  }

  return {
    /// Drop every cached scan. Must be called on any seed/version/dimension change — a
    /// structure list from the previous world would render as confidently as a correct one.
    setWorld() {
      cache.clear();
      strongholds = null;
    },

    /// True if the view is tight enough for markers to be drawn at all.
    enabledAt(blocksAcross) {
      return blocksAcross <= MAX_BLOCKS_ACROSS;
    },

    maxBlocksAcross: MAX_BLOCKS_ACROSS,

    /// Structures of the given types inside a block box.
    ///
    /// Scanning is bounded by `budgetMs`; cells left unscanned are reported as `pending` so
    /// the caller can redraw and continue, exactly as the tile renderer does. Returns
    /// `{ found: [{ type, x, z }], pending }`.
    inBox(x0, z0, x1, z1, types, budgetMs) {
      const found = [];
      let pending = 0;

      for (const type of types) {
        if (type === 'stronghold') {
          for (const [x, z] of allStrongholds()) {
            if (x >= x0 && x <= x1 && z >= z0 && z <= z1) found.push({ type, x, z });
          }
          continue;
        }
        for (let gz = Math.floor(z0 / GRID); gz <= Math.floor(z1 / GRID); gz++) {
          for (let gx = Math.floor(x0 / GRID); gx <= Math.floor(x1 / GRID); gx++) {
            const key = `${type}:${gx}:${gz}`;
            if (!cache.has(key)) {
              if (budgetMs <= 0) { pending++; continue; }
              const started = performance.now();
              scanCell(type, gx, gz);
              budgetMs -= performance.now() - started;
            }
            for (const [x, z] of cache.get(key)) {
              if (x >= x0 && x <= x1 && z >= z0 && z <= z1) found.push({ type, x, z });
            }
          }
        }
      }
      return { found, pending };
    },

    /// The `count` nearest structures of `type` to a block position, nearest first.
    ///
    /// Returns `{ targets: [{x, z, dist}], searched, truncated }`, where `searched` is the
    /// half-extent in blocks actually covered and `truncated` means the search hit its budget
    /// or ring cap before it could prove the answer — in which case the targets are the best
    /// found, not necessarily the nearest.
    ///
    /// # The stopping rule
    ///
    /// Expanding in square rings and halting on the `count`-th hit is WRONG: a structure
    /// found in the corner of a scanned ring can be farther away than one sitting just beyond
    /// that ring's near edge, which has not been looked at yet. Everything unscanned lies
    /// outside the square covered so far, so it is at least `edge` blocks away, where `edge`
    /// is the distance from the origin to the nearest side of that square. It is only safe to
    /// stop once `count` results are in hand AND the `count`-th is no farther than `edge`.
    nearest(ox, oz, type, count, timeCapMs = 150) {
      // Strongholds are all cached already, so this needs no search at all — but they come
      // back in ring order, which is only loosely distance order, so they must be sorted.
      if (type === 'stronghold') {
        const all = allStrongholds()
          .map(([x, z]) => ({ x, z, dist: Math.hypot(x - ox, z - oz) }))
          .sort((a, b) => a.dist - b.dist);
        return { targets: all.slice(0, count), searched: Infinity, truncated: false };
      }

      const gx0 = Math.floor(ox / GRID), gz0 = Math.floor(oz / GRID);
      const found = [];
      const started = performance.now();
      let truncated = false;
      let r = 0;
      for (; r <= MAX_RINGS; r++) {
        for (let gz = gz0 - r; gz <= gz0 + r; gz++) {
          // On the two edge rows walk every column; between them only the two side columns.
          const edgeRow = gz === gz0 - r || gz === gz0 + r;
          const step = edgeRow ? 1 : 2 * r;
          for (let gx = gx0 - r; gx <= gx0 + r; gx += step) {
            for (const [x, z] of scanCell(type, gx, gz)) {
              found.push({ x, z, dist: Math.hypot(x - ox, z - oz) });
            }
          }
        }
        found.sort((a, b) => a.dist - b.dist);

        const x0 = (gx0 - r) * GRID, x1 = (gx0 + r + 1) * GRID;
        const z0 = (gz0 - r) * GRID, z1 = (gz0 + r + 1) * GRID;
        const edge = Math.min(ox - x0, x1 - ox, oz - z0, z1 - oz);
        if (found.length >= count && found[count - 1].dist <= edge) break;

        if (performance.now() - started > timeCapMs) { truncated = true; break; }
      }
      return {
        targets: found.slice(0, count),
        searched: (r + 1) * GRID,
        truncated: truncated || r > MAX_RINGS,
      };
    },
  };
}
