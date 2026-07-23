//! CLI for cross-referencing the enchantment calculator (Part 10.5 aid).
//!
//!   cargo run -p enchant --example predict -- [--version <ver>] <xp_seed> <bookshelves> [item ...]
//!
//! xp_seed is the per-player value the other calculator also takes as input; both must
//! use the SAME seed or nothing will line up. Bookshelves 0..=15. Items default to a
//! representative spread if none are given. `--version` selects which transcribed table to
//! roll against (default: newest) — this is the tool for the per-version external cross-check
//! a new dataset needs (Part 13.3/10.5).

use enchant::{
    default_table, enchantments_in_slot, offered_levels, table as version_table, versions,
};

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();

    // Optional `--version <ver>`, resolved against the registry. An unknown version is a hard
    // error here (unlike the forgiving wasm surface) — a cross-check run must roll against the
    // version it names, not a silent fallback.
    let mut table = default_table();
    if let Some(i) = args.iter().position(|a| a == "--version") {
        let ver = args.get(i + 1).cloned().unwrap_or_else(|| {
            eprintln!(
                "--version needs a value; offered: {}",
                versions().join(", ")
            );
            std::process::exit(2);
        });
        table = version_table(&ver).unwrap_or_else(|| {
            eprintln!(
                "unknown version {ver:?}; offered: {}",
                versions().join(", ")
            );
            std::process::exit(2);
        });
        args.drain(i..=i + 1);
    }

    if args.len() < 2 {
        eprintln!("usage: predict [--version <ver>] <xp_seed> <bookshelves> [item ...]");
        eprintln!("  e.g. predict --version 1.16.5 -1234567 15 diamond_sword book");
        std::process::exit(2);
    }

    let xp_seed: i32 = args[0].parse().expect("xp_seed must be a 32-bit integer");
    let shelves: i32 = args[1].parse().expect("bookshelves must be an integer");
    let items: Vec<String> = if args.len() > 2 {
        args[2..].to_vec()
    } else {
        [
            "diamond_sword",
            "golden_sword",
            "iron_pickaxe",
            "book",
            "bow",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    };

    println!(
        "utilities.mc enchantment calculator — Minecraft {}",
        table.mc_version
    );
    println!("xp seed {xp_seed}, {shelves} bookshelves");
    println!("(offered levels are the green numbers; enchantments are what each slot rolls)\n");

    let levels = offered_levels(xp_seed, shelves);
    println!(
        "offered levels: {} / {} / {}\n",
        levels[0], levels[1], levels[2]
    );

    for item in &items {
        println!("{item}:");
        for (slot, &lv) in levels.iter().enumerate() {
            if lv == 0 {
                println!("  slot {}: (not offered)", slot + 1);
                continue;
            }
            let rolls = enchantments_in_slot(table, xp_seed, slot, item, lv);
            let list: Vec<String> = rolls
                .iter()
                .map(|r| format!("{} {}", r.name(table), r.level))
                .collect();
            println!(
                "  slot {} (lvl {lv:>2}): {}",
                slot + 1,
                if list.is_empty() {
                    "(nothing)".into()
                } else {
                    list.join(", ")
                }
            );
        }
        println!();
    }
}
