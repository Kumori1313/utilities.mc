use portal::*;
fn main() {
    println!("utilities.mc portal converter — Minecraft {MC_VERSION}\n");
    println!("Overworld -> Nether (Y unchanged):");
    for &(x, y, z) in &[(0, 64, 0), (-1, 64, -1), (-9, 70, -9), (1523, 72, -8871)] {
        let (nx, nz) = overworld_to_nether(x, z);
        println!("  ({x:>6}, {y:>3}, {z:>6})  ->  ({nx:>5}, {y:>3}, {nz:>5})");
    }
    println!(
        "\nsearch radius: overworld ±{}, nether ±{}",
        search_radius(Dimension::Overworld),
        search_radius(Dimension::Nether)
    );
    println!("a nether search spans ±{OVERWORLD_SPAN_OF_NETHER_SEARCH} overworld blocks\n");

    let (a, b) = ((100, 100), (180, 140));
    println!("two overworld portals {a:?} and {b:?}:");
    println!(
        "  nether targets {:?} and {:?}",
        overworld_to_nether(a.0, a.1),
        overworld_to_nether(b.0, b.1)
    );
    println!("  may collide: {}", portals_may_collide(a, b));

    let far = (100, 3000);
    println!(
        "\nportals {a:?} and {far:?}: may collide = {}",
        portals_may_collide(a, far)
    );

    println!("\nlink check, overworld (0,0) against nether candidates:");
    for c in [(0, 0), (16, 0), (17, 0), (40, 0)] {
        println!(
            "  nether {c:?}: {:?}",
            links(Dimension::Overworld, (0, 0), c)
        );
    }
}
