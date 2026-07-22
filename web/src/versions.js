//! Version registry for the seed map (Part 13).
//
// Derived from the engine, never tabulated here: the version enum is positional, so a list
// written out in JS would rot silently the next time the Cubiomes submodule moves — the same
// trap 13.2 records for MC_NEWEST.
//
// The one thing that needs work is the LABEL. Cubiomes names each entry after the *family* it
// starts, not the version it tops out at: the entry covering 1.16.2–1.16.5 is `MC_1_16_5`, but
// `mc2str` returns "1.16" for it (the header aliases `MC_1_16 = MC_1_16_5`). Take those labels
// at face value and the selector reads:
//
//     … 1.15, 1.16.1, 1.16, 1.17, 1.18, 1.19.2, 1.19, 1.20, 1.21.1, 1.21.3, 1.21 WD
//
// which looks like 1.16.1 is sorted before 1.16 by mistake. It isn't — the enum is in release
// order and 1.16.1 genuinely predates 1.16.5. Re-sorting to "fix" the appearance would put
// 1.16.1 *after* 1.16.5 and get the chronology backwards. The fix is to stop understating the
// labels, after which the list reads monotonically with no sorting at all.

// The precise version an entry tops out at. `mc2str` gives the family label, so probe `str2mc`
// for the highest patch that maps back to this same entry — cubiomes accepts both spellings
// ("1.16" and "1.16.5" both resolve to MC_1_16_5), which is what makes this derivable rather
// than a hand-kept table. Falls through to the base label for entries that are already precise
// ("1.16.1") or that aren't numeric at all ("1.21 WD").
function preciseLabel(engine, v, base) {
  for (let p = 9; p >= 0; p--) {
    const cand = `${base}.${p}`;
    if (engine.str2mc(cand) === v) return cand;
  }
  return base;
}

const NUMERIC = /^(\d+\.\d+)\.(\d+)$/;

// The lower end of the range an entry covers, given the entry before it: "1.16.2" after
// "1.16.1", but plain "1.16" after "1.15.2". Null when the label isn't a numeric release.
function rangeFrom(label, prev) {
  const m = NUMERIC.exec(label);
  if (!m) return null;
  const p = prev && NUMERIC.exec(prev);
  return p && p[1] === m[1] ? `${m[1]}.${+p[2] + 1}` : m[1];
}

/**
 * Build the offered version list: `{ id, label, covers }`, oldest first.
 *
 * `label` is the precise top of the entry ("1.16.5"); `covers` spells out the whole span
 * ("1.16.2 – 1.16.5") so someone running 1.16.3 can tell which entry is theirs — that is the
 * question the family labels leave unanswerable.
 */
export function buildVersions(engine, floorLabel = '1.8.9') {
  const floor = engine.str2mc(floorLabel);
  const newest = engine.mcNewest();
  if (floor <= 0) throw new Error(`engine does not know ${floorLabel}`);

  const out = [];
  // Start one below the floor so the floor's own range has a predecessor to measure against —
  // 1.8's entry covers 1.8–1.8.9 whether or not 1.7 is offered.
  let prev = null;
  for (let v = floor - 1; v <= newest; v++) {
    const base = engine.mc2str(v);
    // Round-trip guard: only offer a version whose own label parses back to it, so a selector
    // entry can never resolve to a different world than the one it names. `preciseLabel` only
    // ever returns a string that round-trips, so the guard covers the displayed label too.
    if (!base || engine.str2mc(base) !== v) { prev = null; continue; }
    const label = preciseLabel(engine, v, base);
    if (v >= floor) {
      const from = rangeFrom(label, prev);
      out.push({ id: v, label, covers: from && from !== label ? `${from} – ${label}` : label });
    }
    prev = label;
  }
  return out;
}
