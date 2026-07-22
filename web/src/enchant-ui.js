//! Enchantment calculator panel: table roll (top) + anvil planner (grid + auto-optimizer).

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const roman = (n) => ROMAN[n] ?? String(n);
// In-game names that don't follow the id's word order or capitalisation.
const DISPLAY = {
  vanishing_curse: 'Curse of Vanishing',
  binding_curse: 'Curse of Binding',
  flint_and_steel: 'Flint and Steel',
  carrot_on_a_stick: 'Carrot on a Stick',
  warped_fungus_on_a_stick: 'Warped Fungus on a Stick',
};
const title = (id) =>
  DISPLAY[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
// "sharpness 5" -> "Sharpness V"; used on the roll table.
const fmt = (line) => {
  const i = line.lastIndexOf(' ');
  return `${title(line.slice(0, i))} ${roman(+line.slice(i + 1))}`;
};
// Romanise every "name level" occurrence within a longer string (the optimizer steps).
const prettify = (s) => s.replace(/([a-z_]+) (\d+)/g, (_, n, l) => `${title(n)} ${roman(+l)}`);

// Item lists arrive as "kind|id". Within a kind the id's distinguishing part is its material
// ("diamond_sword" in kind "sword" -> "Diamond"); an item that is its own kind reads whole.
const optLabel = (kind, id) => title(id.endsWith(`_${kind}`) ? id.slice(0, -kind.length - 1) : id);

// Group by kind, using an <optgroup> only where a kind actually has variants to distinguish.
function itemOptions(lines) {
  const groups = new Map();
  for (const line of lines) {
    const [kind, id] = line.split('|');
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push([kind, id]);
  }
  return [...groups]
    .map(([kind, items]) => {
      const opts = items
        .map(([k, id]) => `<option value="${id}">${optLabel(k, id)}</option>`)
        .join('');
      return items.length > 1 ? `<optgroup label="${title(kind)}">${opts}</optgroup>` : opts;
    })
    .join('');
}

export function setupEnchant(root, app) {
  // Two dropdowns, deliberately different. The table roll depends on the item's
  // enchantability, so every material variant is a distinct choice. An anvil plan does not —
  // the applicable set is identical across a kind's variants and cost is material-independent
  // — so the planner lists each kind once.
  const tableItems = itemOptions(app.enchant_table_items());
  const anvilItemOpts = app
    .anvil_items()
    .map((line) => {
      const [kind, id] = line.split('|');
      return `<option value="${id}">${title(kind)}</option>`;
    })
    .join('');

  root.innerHTML = `
    <h2>Enchantment calculator</h2>
    <p class="sub">Predicts enchanting-table results for a given xp seed — Minecraft
      <strong>${app.enchant_version()}</strong>. The xp seed is a per-player value that
      re-rolls whenever you enchant.</p>

    <div class="grid">
      <label>xp seed <input id="e-seed" value="-1234567" spellcheck="false"></label>
      <label>bookshelves <input id="e-shelves" type="number" min="0" max="15" value="15"></label>
      <label>item
        <select id="e-item">${tableItems}</select>
      </label>
    </div>

    <div class="slots-wrap">
      <table class="slots">
        <thead><tr><th>slot</th><th>level</th><th>enchantments</th></tr></thead>
        <tbody id="e-rows"></tbody>
      </table>
    </div>

    <h3>Anvil planner</h3>
    <p class="sub">Choose an item and the enchantments you want. The cheapest combining order
      and its total level cost are worked out automatically. Conflicting enchantments grey out;
      tick <em>have</em> on one already on the item so it is not counted as a book to add.
      Material is not listed because it cannot change an anvil plan — unlike the table above,
      where enchantability makes a golden sword roll differently from a diamond one.</p>

    <div class="grid">
      <label>item
        <select id="an-item">${anvilItemOpts}</select>
      </label>
      <label>item's prior work <input id="an-pw" type="number" min="0" value="0"></label>
      <label class="chk"><input id="an-bypass" type="checkbox"> bypass conflict restrictions</label>
    </div>

    <div id="an-grid"></div>
    <div id="an-out" class="out"></div>
  `;

  const $ = (id) => root.querySelector(id);

  // --- table roll -----------------------------------------------------------
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
  root.querySelectorAll('#e-seed, #e-shelves, #e-item').forEach((el) => el.addEventListener('input', roll));

  // --- anvil planner --------------------------------------------------------
  const sel = new Map(); // enchantment name -> { level, existing }
  const conflictCache = new Map();
  const conflictsOf = (name) => {
    if (!conflictCache.has(name)) conflictCache.set(name, new Set(app.enchant_conflicts(name)));
    return conflictCache.get(name);
  };

  function renderGrid() {
    const item = $('#an-item').value;
    const bypass = $('#an-bypass').checked;
    const applicable = app.enchant_applicable(item);
    // Drop selections that no longer apply to the chosen item.
    for (const n of [...sel.keys()]) if (!applicable.includes(n)) sel.delete(n);
    const chosen = [...sel.keys()];

    const rows = applicable.map((name) => {
      const max = app.enchant_max_level(name);
      const cur = sel.get(name);
      const conflicted = !bypass && !cur && chosen.some((s) => conflictsOf(name).has(s));
      const cells = [1, 2, 3, 4, 5].map((L) => {
        if (L > max) return '<td class="tier off"></td>';
        const on = cur && cur.level === L;
        const dis = conflicted && !on;
        return `<td class="tier${on ? ' on' : ''}${dis ? ' dis' : ''}" data-name="${name}" data-lvl="${L}">${ROMAN[L]}</td>`;
      }).join('');
      const have = cur
        ? `<label class="have"><input type="checkbox" data-have="${name}"${cur.existing ? ' checked' : ''}> have</label>`
        : '';
      const cls = conflicted ? 'row-dis' : cur ? (cur.existing ? 'row-have' : 'row-add') : '';
      return `<tr class="${cls}"><td class="ename">${title(name)}${have}</td>${cells}</tr>`;
    }).join('');

    $('#an-grid').innerHTML =
      `<table class="egrid"><thead><tr><th>enchantment</th>` +
      ROMAN.slice(1).map((r) => `<th>${r}</th>`).join('') +
      `</tr></thead><tbody>${rows}</tbody></table>`;
    compute();
  }

  function compute() {
    const pw = Math.max(0, +$('#an-pw').value | 0);
    const toAdd = [...sel.entries()].filter(([, v]) => !v.existing);
    const spec = toAdd.map(([n, v]) => `${n}=${v.level}`).join(',');

    // A conflicting pair among the whole selection is only reachable with bypass on.
    const all = [...sel.keys()];
    let clash = null;
    for (const a of all) for (const b of all) if (a < b && conflictsOf(a).has(b)) clash = [a, b];

    const out = $('#an-out');
    if (sel.size === 0) { out.innerHTML = '<span class="pw">select enchantments to plan a combine</span>'; return; }

    const plan = app.anvil_optimize(spec, pw);
    if (!plan) { out.innerHTML = '<span class="cost bad">too many enchantments to optimise</span>'; return; }

    const steps = plan.steps
      ? plan.steps.split('\n').map((line) => {
          const [t, s, c] = line.split(' | ');
          return `<div class="step">${prettify(t)} <span class="op">+</span> ${prettify(s)} <span class="sc">${c}</span></div>`;
        }).join('')
      : '<div class="step">nothing to add (all marked as already on the item)</div>';

    out.innerHTML =
      `<span class="cost${plan.too_expensive ? ' bad' : ''}">${plan.total} levels</span>` +
      (plan.too_expensive ? ` — a single step exceeds the survival cap (${plan.limit}); needs creative` : '') +
      (clash ? `<div class="warn">⚠ ${title(clash[0])} and ${title(clash[1])} cannot coexist in vanilla — bypass is on, so this plan is not obtainable normally</div>` : '') +
      `<div class="steps">${steps}</div>`;
  }

  // Cell clicks and the "have" checkbox, via delegation (the grid re-renders each change).
  $('#an-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.tier');
    if (!cell || cell.classList.contains('off') || cell.classList.contains('dis')) return;
    const name = cell.dataset.name, lvl = +cell.dataset.lvl;
    const cur = sel.get(name);
    if (cur && cur.level === lvl) sel.delete(name);
    else sel.set(name, { level: lvl, existing: cur ? cur.existing : false });
    renderGrid();
  });
  $('#an-grid').addEventListener('change', (e) => {
    const name = e.target.dataset?.have;
    if (name && sel.has(name)) { sel.get(name).existing = e.target.checked; renderGrid(); }
  });
  $('#an-item').addEventListener('change', renderGrid);
  $('#an-bypass').addEventListener('change', renderGrid);
  $('#an-pw').addEventListener('input', compute);

  // Diamond is the interesting default; the lists themselves start at wooden.
  const eItem = $('#e-item');
  if ([...eItem.options].some((o) => o.value === 'diamond_sword')) eItem.value = 'diamond_sword';

  roll();
  renderGrid();
}
