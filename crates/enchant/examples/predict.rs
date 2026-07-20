use enchant::{MC_VERSION, enchantments_in_slot, offered_levels};

fn main() {
    let (xp_seed, shelves) = (-1234567, 15);
    println!("utilities.mc enchantment calculator — Minecraft {MC_VERSION}");
    println!("xp seed {xp_seed}, {shelves} bookshelves\n");
    for item in ["diamond_sword", "golden_sword", "book", "bow"] {
        println!("{item}:");
        let levels = offered_levels(xp_seed, shelves);
        for (slot, &lv) in levels.iter().enumerate() {
            if lv == 0 {
                println!("  slot {}: (not offered)", slot + 1);
                continue;
            }
            let rolls = enchantments_in_slot(xp_seed, slot, item, lv);
            let list: Vec<String> = rolls
                .iter()
                .map(|r| format!("{} {}", r.name(), r.level))
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
