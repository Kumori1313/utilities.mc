//! Optimal anvil combining order (Part 10.6 extension).
//!
//! Given a blank item and a set of enchantments to apply — each supplied as one book at its
//! target level — find the combining order that costs the fewest total XP levels. This is a
//! real optimisation, not a lookup: applying books directly to the tool charges each
//! enchantment once but grows the tool's prior-work penalty exponentially, while pre-merging
//! books into piles keeps the penalty down but charges the piled enchantments again when the
//! pile joins the tool. The optimum trades these off.
//!
//! # Model and its assumptions
//!
//! - The tool is always the target (you cannot sacrifice the tool and keep it), so every
//!   sacrifice is a book and transfers at the **book** multiplier. Enchantments are distinct
//!   across books (one book per selected enchantment), so a pile's transfer cost is just the
//!   sum of its books' `level x book_multiplier`, independent of how the pile was built.
//! - The base item starts unenchanted. Building a higher level from two lower books (e.g.
//!   Sharpness V from two IV) is out of scope — each enchantment is one book at its level.
//! - The input is assumed conflict-free (the UI enforces it); conflicts are not modelled
//!   here.
//!
//! Correctness is by exhaustive subset DP, cross-checked against a brute-force reference for
//! small inputs in the tests.

use crate::anvil::book_cost_multiplier;
use crate::data::ENCHANTMENTS;

/// Above this many enchantments the 3^n DP is too large; callers should cap selection. (A
/// real item has far fewer applicable enchantments than this.)
pub const MAX_ENCHANTS: usize = 12;

/// Prior-work penalty for an item worked `w` times: 2^w - 1.
fn penalty(w: u32) -> i32 {
    (1i64 << w.min(31)) as i32 - 1
}

/// One book's contribution when it is on the sacrifice side: level x book multiplier.
fn book_cost(idx: usize, level: i32) -> i32 {
    level * book_cost_multiplier(ENCHANTMENTS[idx].anvil_cost)
}

/// A node in a combining tree: the tool, a single book, or an anvil operation (target then
/// sacrifice). Kept so the optimal plan can be replayed as ordered steps.
#[derive(Clone, Debug)]
enum Tree {
    Tool,
    Book(usize),                 // index into the caller's enchantment list
    Merge(Box<Tree>, Box<Tree>), // (target, sacrifice)
}

#[derive(Clone)]
struct Node {
    cost: i32,
    work: u32,
    tree: Tree,
}

/// Pareto insert: keep only entries that are not beaten on both cost and work.
fn pareto_push(frontier: &mut Vec<Node>, node: Node) {
    for e in frontier.iter() {
        if e.cost <= node.cost && e.work <= node.work {
            return; // dominated by an existing entry
        }
    }
    frontier.retain(|e| !(node.cost <= e.cost && node.work <= e.work));
    frontier.push(node);
}

/// One step of the optimal plan, for display / reconstruction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    /// Enchantment indices (into the input list) already on the target of this operation.
    /// Empty means the bare tool.
    pub target: Vec<usize>,
    /// Enchantment indices being added by the sacrifice.
    pub sacrifice: Vec<usize>,
    /// Whether the target is the tool (vs. a book pile being pre-built).
    pub onto_tool: bool,
    /// Level cost of this single operation.
    pub cost: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub total: i32,
    /// Operations in execution order (sub-piles before the merges that consume them).
    pub steps: Vec<Step>,
    /// Cost of the most expensive single step — > 39 means a survival anvil refuses it.
    pub max_step: i32,
}

/// Minimum-cost order to apply `enchants` (each `(index, level)`) onto a blank item.
///
/// Returns `None` if there are more than [`MAX_ENCHANTS`] enchantments. Zero enchantments
/// yields an empty, zero-cost plan.
pub fn optimal_plan(enchants: &[(usize, i32)]) -> Option<Plan> {
    let n = enchants.len();
    if n > MAX_ENCHANTS {
        return None;
    }
    if n == 0 {
        return Some(Plan {
            total: 0,
            steps: vec![],
            max_step: 0,
        });
    }

    let full = (1u32 << n) - 1;
    // Total sacrifice cost of each subset of books (order-independent).
    let mut sum_ench = vec![0i32; 1 << n];
    for mask in 1..=full {
        let low = mask.trailing_zeros() as usize;
        sum_ench[mask as usize] =
            sum_ench[(mask & (mask - 1)) as usize] + book_cost(enchants[low].0, enchants[low].1);
    }

    // dp_pile[mask]: Pareto frontier of ways to combine exactly `mask`'s books into a book.
    let mut dp_pile: Vec<Vec<Node>> = vec![Vec::new(); 1 << n];
    for i in 0..n {
        dp_pile[1 << i] = vec![Node {
            cost: 0,
            work: 0,
            tree: Tree::Book(i),
        }];
    }
    for mask in 1u32..=full {
        if mask.count_ones() < 2 {
            continue;
        }
        // Canonical split: the lowest set bit always goes to A, so each unordered split is
        // visited once. `sub` ranges over ALL subsets of `rest` including the empty set
        // (A = just the low bit) — the loop must run once at sub == 0, hence the break-after.
        let low = 1u32 << mask.trailing_zeros();
        let rest = mask & !low;
        let mut sub = rest;
        loop {
            let a = low | sub; // A holds the lowest bit
            let b = mask & !a;
            if b != 0 {
                combine_piles(&mut dp_pile, &sum_ench, mask, a, b);
            }
            if sub == 0 {
                break;
            }
            sub = (sub - 1) & rest;
        }
    }

    // dp_tool[mask]: Pareto frontier of tool + exactly `mask`'s books, tool as the target spine.
    let mut dp_tool: Vec<Vec<Node>> = vec![Vec::new(); 1 << n];
    dp_tool[0] = vec![Node {
        cost: 0,
        work: 0,
        tree: Tree::Tool,
    }];
    for mask in 1u32..=full {
        // Choose the pile P merged onto the tool last; the rest is already on the tool.
        let mut p = mask;
        while p > 0 {
            let rest = mask & !p;
            for pile in dp_pile[p as usize].clone() {
                for base in dp_tool[rest as usize].clone() {
                    let cost = base.cost
                        + pile.cost
                        + penalty(base.work)
                        + penalty(pile.work)
                        + sum_ench[p as usize];
                    let work = base.work.max(pile.work) + 1;
                    let tree =
                        Tree::Merge(Box::new(base.tree.clone()), Box::new(pile.tree.clone()));
                    pareto_push(&mut dp_tool[mask as usize], Node { cost, work, tree });
                }
            }
            p = (p - 1) & mask;
        }
    }

    let best = dp_tool[full as usize].iter().min_by_key(|nd| nd.cost)?;
    let mut steps = Vec::new();
    reconstruct(&best.tree, enchants, &mut steps);
    let max_step = steps.iter().map(|s| s.cost).max().unwrap_or(0);
    Some(Plan {
        total: best.cost,
        steps,
        max_step,
    })
}

fn combine_piles(dp: &mut [Vec<Node>], sum_ench: &[i32], mask: u32, a: u32, b: u32) {
    // Sacrifice the pile with the smaller enchant sum; penalties are symmetric.
    let (tgt, sac) = if sum_ench[b as usize] <= sum_ench[a as usize] {
        (a, b)
    } else {
        (b, a)
    };
    let charge = sum_ench[sac as usize];
    let (tgt_nodes, sac_nodes) = (dp[tgt as usize].clone(), dp[sac as usize].clone());
    for t in &tgt_nodes {
        for s in &sac_nodes {
            let cost = t.cost + s.cost + penalty(t.work) + penalty(s.work) + charge;
            let work = t.work.max(s.work) + 1;
            let tree = Tree::Merge(Box::new(t.tree.clone()), Box::new(s.tree.clone()));
            pareto_push(&mut dp[mask as usize], Node { cost, work, tree });
        }
    }
}

/// Post-order walk: emit a step for every Merge, children before parents.
fn reconstruct(tree: &Tree, enchants: &[(usize, i32)], out: &mut Vec<Step>) {
    if let Tree::Merge(target, sacrifice) = tree {
        reconstruct(target, enchants, out);
        reconstruct(sacrifice, enchants, out);
        let cost =
            penalty(work_of(target)) + penalty(work_of(sacrifice)) + sac_sum(sacrifice, enchants);
        out.push(Step {
            target: leaves(target).iter().map(|&i| enchants[i].0).collect(),
            sacrifice: leaves(sacrifice).iter().map(|&i| enchants[i].0).collect(),
            onto_tool: is_tool_side(target),
            cost,
        });
    }
}

fn leaves(tree: &Tree) -> Vec<usize> {
    match tree {
        Tree::Tool => vec![],
        Tree::Book(i) => vec![*i],
        Tree::Merge(a, b) => {
            let mut v = leaves(a);
            v.extend(leaves(b));
            v
        }
    }
}

fn is_tool_side(tree: &Tree) -> bool {
    match tree {
        Tree::Tool => true,
        Tree::Book(_) => false,
        Tree::Merge(a, _) => is_tool_side(a),
    }
}

fn work_of(tree: &Tree) -> u32 {
    match tree {
        Tree::Tool | Tree::Book(_) => 0,
        Tree::Merge(a, b) => work_of(a).max(work_of(b)) + 1,
    }
}

fn sac_sum(tree: &Tree, enchants: &[(usize, i32)]) -> i32 {
    leaves(tree)
        .iter()
        .map(|&i| book_cost(enchants[i].0, enchants[i].1))
        .sum()
}
