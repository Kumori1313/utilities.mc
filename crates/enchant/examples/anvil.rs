//! Anvil cost CLI for cross-checking (Part 10.6).
//!
//!   cargo run -p enchant --example anvil -- \
//!       <target_item>[:pw] [ench=lvl ...] + <sacrifice>[:pw] [ench=lvl ...] [--rename]
//!
//! `+` separates the target (left) from the sacrifice (right). `:pw` on an item id is its
//! prior-work count (times already anvil-worked; default 0). Use `book` for an enchanted
//! book sacrifice.
//!
//! # Two things that make in-game costs differ from a naive guess — get these right
//! before deciding a number is "wrong":
//!
//! * **Prior work compounds.** Every anvil operation raises an item's prior-work count, and
//!   each input's `2^pw - 1` penalty is added to the next combine. A **book that already
//!   holds two or more enchantments was itself made in an anvil**, so in survival it has
//!   `pw >= 1` — spell it out as `book:1`, or the cost comes out one (or more) levels low.
//!   The tool warns when you give a multi-enchantment book `pw 0`, since that is rarely a
//!   real survival item.
//! * **Item source costs double a book.** Moving an enchantment off another *item* uses the
//!   full multiplier; off a *book*, half. So `sword + sword sharpness=5` costs twice
//!   `sword + book sharpness=5`. And which item is the target vs the sacrifice decides which
//!   enchantment transfers — swapping them can change the cost a lot.
//!
//! Examples:
//!   anvil diamond_sword + book sharpness=5
//!   anvil diamond_sword sharpness=3 + diamond_sword sharpness=3
//!   anvil diamond_pickaxe + book:1 fortune=3 unbreaking=3   # book pre-combined -> pw 1
//!   anvil diamond_pickaxe:1 fortune=3 + diamond_pickaxe:1 unbreaking=3  # two worked items
//!
//! The printed cost is what a survival anvil's level counter should show — compare it there.

use enchant::anvil::TOO_EXPENSIVE_LIMIT;
use enchant::data::VersionTable;
use enchant::{AnvilItem, MC_VERSION, combine, default_table};

fn parse_side(table: &VersionTable, tokens: &[String]) -> AnvilItem {
    let (item_tok, ench_toks) = tokens.split_first().expect("each side needs an item");
    let (name, pw) = match item_tok.split_once(':') {
        Some((n, p)) => (
            n.to_string(),
            p.parse().expect("prior work must be an integer"),
        ),
        None => (item_tok.clone(), 0u32),
    };
    let enchantments = ench_toks
        .iter()
        .map(|t| {
            let (e, l) = t
                .split_once('=')
                .unwrap_or_else(|| panic!("expected ench=level, got {t}"));
            let idx = table
                .index_of(e)
                .unwrap_or_else(|| panic!("unknown enchantment: {e}"));
            (idx, l.parse::<i32>().expect("level must be an integer"))
        })
        .collect();
    AnvilItem::new(&name, pw, enchantments)
}

fn describe(table: &VersionTable, it: &AnvilItem) -> String {
    let ench: Vec<String> = it
        .enchantments
        .iter()
        .map(|&(i, l)| format!("{} {l}", table.get(i).name))
        .collect();
    format!(
        "{}{} [{}]",
        it.item,
        if it.prior_work > 0 {
            format!(" (worked x{})", it.prior_work)
        } else {
            String::new()
        },
        if ench.is_empty() {
            "no enchantments".into()
        } else {
            ench.join(", ")
        }
    )
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let rename = args.iter().any(|a| a == "--rename");
    args.retain(|a| a != "--rename");

    let split = args.iter().position(|a| a == "+").unwrap_or_else(|| {
        eprintln!("usage: anvil <target> [ench=lvl ...] + <sacrifice> [ench=lvl ...] [--rename]");
        std::process::exit(2);
    });
    let table = default_table();
    let target = parse_side(table, &args[..split]);
    let sacrifice = parse_side(table, &args[split + 1..]);

    // A multi-enchantment book at pw 0 is almost always a modelling slip: in survival such
    // a book was combined from single-enchantment books and so carries prior work. Warn,
    // don't block — a creative/command book really can be pw 0.
    for (role, it) in [("target", &target), ("sacrifice", &sacrifice)] {
        if it.is_book() && it.enchantments.len() >= 2 && it.prior_work == 0 {
            eprintln!(
                "warning: {role} is a book with {} enchantments at prior work 0. A survival \
                 book with multiple enchantments was combined in an anvil first, so it has \
                 prior work >= 1 — try `book:1`. (Ignore this for a creative/command book.)",
                it.enchantments.len()
            );
        }
    }

    let r = combine(table.enchantments, &target, &sacrifice, rename);

    println!("utilities.mc anvil calculator — Minecraft {MC_VERSION}\n");
    println!("target    : {}", describe(table, &target));
    println!("sacrifice : {}", describe(table, &sacrifice));
    if rename {
        println!("rename    : yes (+1)");
    }
    println!();
    println!(
        "cost      : {} levels{}",
        r.cost,
        if r.too_expensive {
            format!("  — TOO EXPENSIVE in survival (cap {TOO_EXPENSIVE_LIMIT})")
        } else {
            String::new()
        }
    );
    let result: Vec<String> = r
        .result
        .iter()
        .map(|&(i, l)| format!("{} {l}", table.get(i).name))
        .collect();
    println!("result    : {} [{}]", target.item, result.join(", "));
    println!("next prior work: x{}", r.result_prior_work);
}
