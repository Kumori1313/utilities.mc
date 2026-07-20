//! Enchantment calculator panel: table roll + anvil combine.

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const roman = (n) => ROMAN[n] ?? String(n);
const fmt = (line) => {
  const i = line.lastIndexOf(' ');
  const name = line.slice(0, i).replace(/_/g, ' ');
  return `${name.replace(/\b\w/g, (c) => c.toUpperCase())} ${roman(+line.slice(i + 1))}`;
};

// A curated item spread rather than all 77 ids — friendlier, and covers the enchantability
// tiers the offered-level maths cares about.
const ITEMS = [
  'book', 'diamond_sword', 'netherite_sword', 'golden_sword', 'iron_sword',
  'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_helmet',
  'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'bow', 'crossbow',
  'trident', 'fishing_rod', 'mace', 'elytra', 'shears',
];

export function setupEnchant(root, app) {
  root.innerHTML = `
    <h2>Enchantment calculator</h2>
    <p class="sub">Predicts enchanting-table results for a given xp seed — Minecraft
      <strong>${app.enchant_version()}</strong>. The xp seed is a per-player value that
      re-rolls whenever you enchant.</p>

    <div class="grid">
      <label>xp seed <input id="e-seed" value="-1234567" spellcheck="false"></label>
      <label>bookshelves <input id="e-shelves" type="number" min="0" max="15" value="15"></label>
      <label>item
        <select id="e-item">${ITEMS.map((i) => `<option>${i}</option>`).join('')}</select>
      </label>
    </div>

    <table class="slots">
      <thead><tr><th>slot</th><th>level</th><th>enchantments</th></tr></thead>
      <tbody id="e-rows"></tbody>
    </table>

    <h3>Anvil combine</h3>
    <p class="sub">Level cost to merge two items. A book holding 2+ enchantments was itself
      combined in an anvil, so give it prior work ≥ 1. Item sources cost double a book.</p>
    <div class="anvil">
      <div>
        <div class="side-title">target (kept)</div>
        <label>item <input id="a-t-item" value="diamond_pickaxe" spellcheck="false"></label>
        <label>prior work <input id="a-t-pw" type="number" min="0" value="0"></label>
        <label>enchantments <input id="a-t-ench" placeholder="efficiency=4" spellcheck="false"></label>
      </div>
      <div>
        <div class="side-title">sacrifice</div>
        <label>item <input id="a-s-item" value="book" spellcheck="false"></label>
        <label>prior work <input id="a-s-pw" type="number" min="0" value="1"></label>
        <label>enchantments <input id="a-s-ench" value="fortune=3,unbreaking=3" spellcheck="false"></label>
      </div>
    </div>
    <label class="rename"><input id="a-rename" type="checkbox"> rename (+1)</label>
    <div id="a-out" class="out"></div>
  `;

  const $ = (id) => root.querySelector(id);

  function roll() {
    const seed = parseInt($('#e-seed').value, 10) | 0;
    const shelves = Math.max(0, Math.min(15, +$('#e-shelves').value | 0));
    const item = $('#e-item').value;
    const levels = app.enchant_offered_levels(seed, shelves);

    $('#e-rows').innerHTML = [0, 1, 2].map((slot) => {
      const lv = levels[slot];
      if (lv === 0) return `<tr class="empty"><td>${slot + 1}</td><td>—</td><td>not offered</td></tr>`;
      const rolls = app.enchant_slot(seed, slot, item, lv);
      const list = rolls ? rolls.split('\n').map(fmt).join(', ') : '(nothing)';
      return `<tr><td>${slot + 1}</td><td>${lv}</td><td>${list}</td></tr>`;
    }).join('');
  }

  function anvil() {
    const out = app.anvil_combine(
      $('#a-t-item').value.trim(), +$('#a-t-pw').value | 0, $('#a-t-ench').value.trim(),
      $('#a-s-item').value.trim(), +$('#a-s-pw').value | 0, $('#a-s-ench').value.trim(),
      $('#a-rename').checked,
    );
    const result = out.result ? out.result.split('\n').map(fmt).join(', ') : '(no change)';
    $('#a-out').innerHTML =
      `<span class="cost ${out.too_expensive ? 'bad' : ''}">${out.cost} levels</span>` +
      (out.too_expensive ? ` — too expensive in survival (cap ${out.limit})` : '') +
      `<div class="rlist">→ ${result}<span class="pw">next prior work ×${out.next_prior_work}</span></div>`;
  }

  root.querySelectorAll('#e-seed, #e-shelves, #e-item').forEach((el) =>
    el.addEventListener('input', roll));
  root.querySelectorAll('.anvil input, #a-rename').forEach((el) =>
    el.addEventListener('input', anvil));

  roll();
  anvil();
}
