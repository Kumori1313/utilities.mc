//! Anvil cost CLI for cross-checking (Part 10.6).
//!
//!   cargo run -p enchant --example anvil -- \
//!       <target_item>[:pw] [ench=lvl ...] + <sacrifice>[:pw] [ench=lvl ...] [--rename]
//!
//! `+` separates the target (left) from the sacrifice (right). `:pw` on an item id is its
//! prior-work count (times already anvil-worked; default 0). Use `book` for an enchanted
//! book sacrifice.
//!
//! Examples:
//!   anvil diamond_sword + book sharpness=5
//!   anvil diamond_sword sharpness=3 + diamond_sword sharpness=3
//!   anvil diamond_pickaxe:2 efficiency=4 + book:1 fortune=3 unbreaking=3
//!
//! The printed cost is what a survival anvil's level counter should show — compare it there.

use enchant::anvil::TOO_EXPENSIVE_LIMIT;
use enchant::data::index_of;
use enchant::{AnvilItem, ENCHANTMENTS, MC_VERSION, combine};

fn parse_side(tokens: &[String]) -> AnvilItem {
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
            let idx = index_of(e).unwrap_or_else(|| panic!("unknown enchantment: {e}"));
            (idx, l.parse::<i32>().expect("level must be an integer"))
        })
        .collect();
    AnvilItem::new(&name, pw, enchantments)
}

fn describe(it: &AnvilItem) -> String {
    let ench: Vec<String> = it
        .enchantments
        .iter()
        .map(|&(i, l)| format!("{} {l}", ENCHANTMENTS[i].name))
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
    let target = parse_side(&args[..split]);
    let sacrifice = parse_side(&args[split + 1..]);

    let r = combine(&target, &sacrifice, rename);

    println!("utilities.mc anvil calculator — Minecraft {MC_VERSION}\n");
    println!("target    : {}", describe(&target));
    println!("sacrifice : {}", describe(&sacrifice));
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
        .map(|&(i, l)| format!("{} {l}", ENCHANTMENTS[i].name))
        .collect();
    println!("result    : {} [{}]", target.item, result.join(", "));
    println!("next prior work: x{}", r.result_prior_work);
}
