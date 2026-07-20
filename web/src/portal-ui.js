//! Nether ↔ Overworld converter panel.

export function setupPortal(root, app) {
  const span = app.portal_collision_span();
  root.innerHTML = `
    <h2>Nether ↔ Overworld converter</h2>
    <p class="sub">1 Nether block = 8 Overworld blocks, horizontally. Y is never scaled.
      Enter a coordinate in either dimension.</p>

    <div class="grid">
      <label>Overworld X <input id="p-ox" type="number" value="1000"></label>
      <label>Overworld Z <input id="p-oz" type="number" value="-2000"></label>
    </div>
    <div class="out" id="p-to-nether"></div>

    <div class="grid">
      <label>Nether X <input id="p-nx" type="number" value="125"></label>
      <label>Nether Z <input id="p-nz" type="number" value="-250"></label>
    </div>
    <div class="out" id="p-to-over"></div>

    <h3>Portal linking</h3>
    <p class="sub">Two Overworld portals within ~${span} blocks of each other share one
      Nether portal — the usual cause of portals linking to the wrong place.</p>
    <div class="grid">
      <label>portal A X <input id="p-ax" type="number" value="0"></label>
      <label>portal A Z <input id="p-az" type="number" value="0"></label>
      <label>portal B X <input id="p-bx" type="number" value="100"></label>
      <label>portal B Z <input id="p-bz" type="number" value="0"></label>
    </div>
    <div class="out" id="p-collide"></div>
  `;

  const $ = (id) => root.querySelector(id);
  const v = (id) => +$(id).value | 0;

  function update() {
    const [nx, nz] = app.portal_to_nether(v('#p-ox'), v('#p-oz'));
    $('#p-to-nether').innerHTML = `→ Nether <strong>${nx}, ${nz}</strong> (same Y)`;

    const [ox, oz] = app.portal_to_overworld(v('#p-nx'), v('#p-nz'));
    $('#p-to-over').innerHTML = `→ Overworld <strong>${ox}, ${oz}</strong> (same Y)`;

    const collide = app.portal_may_collide(v('#p-ax'), v('#p-az'), v('#p-bx'), v('#p-bz'));
    $('#p-collide').innerHTML = collide
      ? `<span class="cost bad">may collide</span> — both portals fall in one Nether search area`
      : `<span class="cost">independent</span> — far enough apart to link separately`;
  }

  root.querySelectorAll('input').forEach((el) => el.addEventListener('input', update));
  update();
}
