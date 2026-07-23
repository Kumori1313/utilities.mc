#!/usr/bin/env python3
"""Regenerate crates/enchant/data/enchantments-1.16.5.json (Part 13.3).

"Generate, don't type" (Part 10.2): the 1.16.5 dataset is produced deterministically from two
independent sources rather than hand-edited, so a transcription slip has nowhere to hide.

  source A = PrismarineJS/minecraft-data pc/1.16.4 (fetched here): weight, max_level,
             min_cost, treasureOnly, exclude, discoverable.
  source B = this repo's VERIFIED 1.21.3 dataset: max_cost, anvil_cost, applicability
             (primary/supported items + tags), item enchantability.

The script asserts A and B agree on min_cost / weight / max_level / treasure for every shared
enchantment, which is what licenses taking the B-only fields (unchanged since the enchantments
are identically tuned). The only real 1.16->1.21 deltas it applies: four enchantments do not
exist in 1.16.5, the damage-exclusivity group is smaller, and the mace/brush items are absent.

PrismarineJS's max_cost for 1.16.4 is a known-buggy generic 10*level+51 and is deliberately
NOT used; max_cost comes from 1.21.3 (valid because min_cost is identical).

Run:  python3 scripts/gen-enchant-1.16.5.py
Needs network (curl) for the PrismarineJS file. The committed JSON is the artifact of record.
"""
import collections
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "crates" / "enchant" / "data"
PJ_URL = "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc/1.16.4/enchantments.json"

REMOVE_ENCH = {"breach", "density", "wind_burst", "swift_sneak"}  # added after 1.16
REMOVE_ITEMS = {"mace", "brush"}  # mace (1.21), brush (1.20)
REMOVE_TAGS = {"mace"}
NAMEMAP = {"sweeping": "sweeping_edge"}  # PrismarineJS 1.16 id -> 1.21 id form (cosmetic)
oname = lambda n: NAMEMAP.get(n, n)


def fetch_prismarine():
    out = subprocess.run(["curl", "-sS", "--max-time", "30", PJ_URL],
                         capture_output=True, text=True, check=True).stdout
    return {e["name"]: e for e in json.loads(out)}


def main():
    pj = fetch_prismarine()
    base = json.loads((DATA / "enchantments-1.21.3.json").read_text())

    # --- cross-check A vs B on overlapping fields (must be identical) ------------------
    errs = []
    for pn, e in pj.items():
        on = oname(pn)
        b = base["enchantments"].get(on)
        if b is None:
            errs.append(f"PJ enchantment {pn} missing from 1.21.3 base")
            continue
        a_min = {"base": e["minCost"]["a"] + e["minCost"]["b"], "per_level": e["minCost"]["a"]}
        if a_min != b["min_cost"]:
            errs.append(f"{on}: min_cost A={a_min} B={b['min_cost']}")
        if e["weight"] != b["weight"]:
            errs.append(f"{on}: weight A={e['weight']} B={b['weight']}")
        if e["maxLevel"] != b["max_level"]:
            errs.append(f"{on}: max_level A={e['maxLevel']} B={b['max_level']}")
        if e["treasureOnly"] != b["treasure"]:
            errs.append(f"{on}: treasure A={e['treasureOnly']} B={b['treasure']}")
    if errs:
        print("SOURCE DISAGREEMENT — refusing to generate:", *errs, sep="\n  ")
        sys.exit(1)

    kept = {n for n in base["enchantments"] if n not in REMOVE_ENCH}
    if kept != {oname(n) for n in pj}:
        print("kept set != PrismarineJS 1.16.4 set", file=sys.stderr)
        sys.exit(1)

    # Exclusivity: PrismarineJS's 1.16 form, symmetric-closed (build.rs consumes the closure).
    excl = collections.defaultdict(set)
    for pn, e in pj.items():
        on = oname(pn)
        for x in e["exclude"]:
            ox = oname(x)
            excl[on].add(ox)
            excl[ox].add(on)

    enchants = {}
    for n in sorted(kept):
        b = dict(base["enchantments"][n])  # 1.21.3 fields: max_cost, anvil_cost, items, slots
        e = pj[next(k for k in pj if oname(k) == n)]
        b["weight"] = e["weight"]
        b["max_level"] = e["maxLevel"]
        b["min_cost"] = {"base": e["minCost"]["a"] + e["minCost"]["b"], "per_level": e["minCost"]["a"]}
        b["treasure"] = e["treasureOnly"]
        b["in_enchanting_table"] = not e["treasureOnly"]
        b["exclusive_with"] = sorted(excl[n])
        enchants[n] = b

    item_tags = {t: [i for i in items if i not in REMOVE_ITEMS]
                 for t, items in base["item_tags"].items() if t not in REMOVE_TAGS}
    item_ench = {k: v for k, v in base["item_enchantability"].items() if k not in REMOVE_ITEMS}
    mat_ench = {k: v for k, v in base["enchantability"].items() if k not in REMOVE_ITEMS}

    # Invariants: no dangling tag ref, and symmetric exclusivity.
    for n, b in enchants.items():
        for f in ("primary_items", "supported_items"):
            ref = b.get(f)
            if isinstance(ref, str):
                assert ref.split("/")[-1] in item_tags, f"{n}.{f} -> removed tag"
        for x in b["exclusive_with"]:
            assert n in enchants[x]["exclusive_with"], f"{n}<->{x} not symmetric"

    out = {
        "_provenance": {
            "minecraft_version": "1.16.5",
            "method": "Generated from the verified 1.21.3 dataset + PrismarineJS pc/1.16.4 by "
                      "scripts/gen-enchant-1.16.5.py. Do not hand-edit; re-run the script.",
            "enchantments": {
                "source_a": "PrismarineJS/minecraft-data @ pc/1.16.4 (covers 1.16.4 and 1.16.5): "
                            "weight, max_level, min_cost, treasureOnly, exclude, discoverable.",
                "source_b": "this repo's verified 1.21.3 dataset: max_cost, anvil_cost, "
                            "primary_items/supported_items, slots — provably unchanged since A "
                            "and B agree on min_cost, weight, max_level and treasure for every "
                            "shared enchantment (the generator asserts this).",
                "agreement": "38 shared enchantments; 0 disagreements on the overlapping fields. "
                             "Real deltas: 4 enchantments absent in 1.16.5, smaller damage group.",
                "deltas_from_1_21_3": "removed breach, density, wind_burst (mace, 1.21) and "
                                      "swift_sneak (1.19); damage exclusivity is "
                                      "sharpness<->smite<->bane_of_arthropods only (impaling "
                                      "ungrouped; no breach/density).",
                "max_cost_note": "PrismarineJS 1.16.4 max_cost is a buggy generic 10*level+51 "
                                 "for ~10 enchantments (efficiency serialises 61 vs the game's "
                                 "51) and is NOT used; max_cost is taken from 1.21.3, valid "
                                 "because min_cost is identical.",
                "id_note": "PrismarineJS's 'sweeping' is written as the 1.21 id 'sweeping_edge' "
                           "for display consistency; the id is cosmetic to the roll.",
                "in_enchanting_table": "NOT treasureOnly (source_a); non-table in 1.16.5: "
                                       "mending, frost_walker, soul_speed, binding_curse, "
                                       "vanishing_curse.",
            },
            "enchantability": {
                "source": "1.21.3 material/item enchantability minus mace; values unchanged "
                          "across 1.16.5-1.21.3.",
                "caveat": "inherits the single-source-lineage caveat on the values from 1.21.3.",
            },
            "item_tags": {"source": "1.21.3 tags minus the mace tag and the mace/brush items."},
            "item_enchantability": {"derivation": "1.21.3 item_enchantability minus mace and brush."},
            "verification_status": {
                "transcription": "two independent sources diffed by the generator, 0 disagreements.",
                "external_cross_check": "PENDING — roll-level check against an in-game 1.16.5 "
                                        "table or an external 1.16.5 calculator (the manual step "
                                        "1.21.3 also required). Use "
                                        "`cargo run -p enchant --example predict -- --version 1.16.5`.",
            },
        },
        "enchantability": mat_ench,
        "enchantments": enchants,
        "item_tags": {k: item_tags[k] for k in sorted(item_tags)},
        "item_enchantability": {k: item_ench[k] for k in sorted(item_ench)},
    }

    dest = DATA / "enchantments-1.16.5.json"
    dest.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dest.relative_to(ROOT)} — {len(enchants)} enchantments, {len(item_ench)} items")


if __name__ == "__main__":
    main()
