//! Part 10.6 optimiser tests.
//!
//! The DP is cross-checked against an independent brute-force reference (exhaustive over all
//! combining orders) for small inputs, so "optimal" is verified, not asserted. Plus a few
//! hand-computed values that also match the in-game numbers cross-checked earlier.

use enchant::ENCHANTMENTS;
use enchant::anvil::book_cost_multiplier;
use enchant::data::index_of;
use enchant::optimize::optimal_plan;

fn ix(name: &str) -> usize {
    index_of(name).unwrap()
}
fn book_cost(idx: usize, level: i32) -> i32 {
    level * book_cost_multiplier(ENCHANTMENTS[idx].anvil_cost)
}
fn penalty(w: u32) -> i32 {
    (1i64 << w) as i32 - 1
}
fn sac_sum(mask: u32, en: &[(usize, i32)]) -> i32 {
    (0..en.len())
        .filter(|k| mask & (1 << k) != 0)
        .map(|k| book_cost(en[k].0, en[k].1))
        .sum()
}

/// Brute force: exhaustively try every order of combining the tool + one book per
/// enchantment, tool always the target. Component = (book-set mask, prior work, is_tool).
fn brute(comps: &[(u32, u32, bool)], en: &[(usize, i32)]) -> i32 {
    if comps.len() == 1 {
        return 0;
    }
    let mut best = i32::MAX;
    for i in 0..comps.len() {
        for j in (i + 1)..comps.len() {
            let (mi, wi, ti) = comps[i];
            let (mj, wj, tj) = comps[j];
            // Which component is sacrificed. The tool can only be the target.
            let dirs: Vec<i32> = if ti {
                vec![sac_sum(mj, en)]
            } else if tj {
                vec![sac_sum(mi, en)]
            } else {
                vec![sac_sum(mi, en), sac_sum(mj, en)]
            };
            for sac in dirs {
                let op = penalty(wi) + penalty(wj) + sac;
                let merged = (mi | mj, wi.max(wj) + 1, ti || tj);
                let mut rest: Vec<_> = comps
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| *k != i && *k != j)
                    .map(|(_, c)| *c)
                    .collect();
                rest.push(merged);
                best = best.min(op + brute(&rest, en));
            }
        }
    }
    best
}

fn brute_optimal(en: &[(usize, i32)], tool_pw: u32) -> i32 {
    let mut comps = vec![(0u32, tool_pw, true)]; // the tool
    for k in 0..en.len() {
        comps.push((1u32 << k, 0, false));
    }
    brute(&comps, en)
}

#[test]
fn empty_and_single() {
    assert_eq!(optimal_plan(&[], 0).unwrap().total, 0);
    // Fortune III book onto a blank tool: 3 * bookMult(anvil_cost 4)=2 => 6.
    let one = optimal_plan(&[(ix("fortune"), 3)], 0).unwrap();
    assert_eq!(one.total, 6);
    assert_eq!(one.steps.len(), 1);
    assert!(one.steps[0].onto_tool);
}

/// The pair we cross-checked against a real anvil: fortune III + unbreaking III onto a blank
/// pickaxe applied directly is 6 + (3 + prior-work 1) = 10, and that is optimal.
#[test]
fn fortune_unbreaking_pair_is_ten() {
    let en = [(ix("fortune"), 3), (ix("unbreaking"), 3)];
    let plan = optimal_plan(&en, 0).unwrap();
    assert_eq!(plan.total, 10);
    assert_eq!(plan.total, brute_optimal(&en, 0));
}

/// An item that already carries prior work costs more to add to, and the DP must still match
/// the brute force with that starting penalty.
#[test]
fn tool_prior_work_is_charged() {
    // Fortune III onto a tool worked twice: penalty(2) + fortune 6 = 3 + 6 = 9.
    assert_eq!(optimal_plan(&[(ix("fortune"), 3)], 2).unwrap().total, 9);
    let en = [
        (ix("sharpness"), 5),
        (ix("unbreaking"), 3),
        (ix("mending"), 1),
    ];
    for pw in 0..4 {
        assert_eq!(
            optimal_plan(&en, pw).unwrap().total,
            brute_optimal(&en, pw),
            "pw={pw}"
        );
    }
}

/// The DP must equal the brute-force optimum on every small case — this is what makes
/// "optimal" a verified claim rather than a hopeful one.
#[test]
fn dp_matches_brute_force() {
    let pool = [
        ("sharpness", 5),
        ("unbreaking", 3),
        ("mending", 1),
        ("fire_aspect", 2),
        ("looting", 3),
        ("sweeping_edge", 3),
        ("knockback", 2),
    ];
    // All non-empty subsets up to 6 enchantments.
    for combo in 1u32..(1 << pool.len()) {
        if combo.count_ones() > 6 {
            continue;
        }
        let en: Vec<(usize, i32)> = (0..pool.len())
            .filter(|k| combo & (1 << k) != 0)
            .map(|k| (ix(pool[k].0), pool[k].1))
            .collect();
        let plan = optimal_plan(&en, 0).unwrap();
        assert_eq!(
            plan.total,
            brute_optimal(&en, 0),
            "DP != brute for {:?}",
            en.iter()
                .map(|&(i, l)| (ENCHANTMENTS[i].name, l))
                .collect::<Vec<_>>()
        );
    }
}

/// The reconstructed steps must actually sum to the reported total, and max_step must be the
/// largest — otherwise the displayed plan wouldn't match its own cost.
#[test]
fn steps_are_consistent_with_total() {
    let en = [
        (ix("sharpness"), 5),
        (ix("unbreaking"), 3),
        (ix("mending"), 1),
        (ix("looting"), 3),
    ];
    let plan = optimal_plan(&en, 0).unwrap();
    assert_eq!(plan.total, plan.steps.iter().map(|s| s.cost).sum::<i32>());
    assert_eq!(
        plan.max_step,
        plan.steps.iter().map(|s| s.cost).max().unwrap()
    );
    // n enchantments always take exactly n merge operations (each book joins once).
    assert_eq!(plan.steps.len(), en.len());
    // Exactly one step ends on the bare tool (the first thing added to it), and the last
    // step's target must be the tool side.
    assert!(plan.steps.last().unwrap().onto_tool);
}

#[test]
fn respects_the_enchant_cap() {
    let many: Vec<(usize, i32)> = (0..13).map(|_| (ix("unbreaking"), 3)).collect();
    assert!(optimal_plan(&many, 0).is_none());
}
