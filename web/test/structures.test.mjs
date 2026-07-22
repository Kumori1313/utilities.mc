// Structure-selection persistence across a list rebuild.
//
// The checkbox list is regenerated whenever the version or dimension changes. Before this, the
// rebuild wiped the selection, so switching 1.21.3 -> 1.20 to compare the same structures meant
// re-ticking them every time. The rule now is "keep what the new world has, drop and announce
// what it does not" — one rule covering both a version change and a dimension change.

import { carrySelection } from '../src/structures.js';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return console.log(`  ok    ${label}`);
  failures++;
  console.log(`  FAIL  ${label}\n          got  ${g}\n          want ${w}`);
};

console.log('carrying a structure selection across a rebuild');

const sel = new Set(['village', 'monument', 'trial_chambers']);

// A version that still has everything: nothing may be dropped. This is the case the old code
// got wrong — it dropped all three.
check('a version with every selected type keeps them all',
  carrySelection(sel, ['village', 'monument', 'trial_chambers', 'igloo']),
  { kept: ['village', 'monument', 'trial_chambers'], dropped: [] });

// Going back before trial chambers existed: that one goes, the rest stay.
check('an older version drops only what it lacks',
  carrySelection(sel, ['village', 'monument', 'igloo']),
  { kept: ['village', 'monument'], dropped: ['trial_chambers'] });

// A dimension change is the same rule, not a special case.
check('the Nether keeps nothing Overworld-only',
  carrySelection(sel, ['fortress', 'bastion']),
  { kept: [], dropped: ['village', 'monument', 'trial_chambers'] });

check('an empty target drops everything',
  carrySelection(sel, []),
  { kept: [], dropped: ['village', 'monument', 'trial_chambers'] });

check('an empty selection carries nothing and reports nothing',
  carrySelection(new Set(), ['village']), { kept: [], dropped: [] });

// Order is the selection's, so the announcement reads in a stable order rather than whatever
// order the availability list happened to have.
check('order follows the selection, not the available list',
  carrySelection(new Set(['b', 'a', 'c']), ['c', 'b', 'a']),
  { kept: ['b', 'a', 'c'], dropped: [] });

// Availability may arrive as a Set or an array; both are used in the app.
check('accepts a Set as well as an array',
  carrySelection(sel, new Set(['village'])),
  { kept: ['village'], dropped: ['monument', 'trial_chambers'] });

// The caller's Set must not be mutated — main.js rebuilds it from `kept`, and a function that
// both returned a result and edited its input would make that rebuild silently redundant, or
// silently wrong if the order of the two ever changed.
const before = new Set(['village', 'trial_chambers']);
carrySelection(before, ['village']);
check('the input selection is left untouched', [...before], ['village', 'trial_chambers']);

// kept and dropped must partition the input exactly: nothing invented, nothing lost.
const all = new Set(['a', 'b', 'c', 'd']);
const r = carrySelection(all, ['b', 'd']);
check('kept and dropped partition the selection',
  [...r.kept, ...r.dropped].sort(), [...all].sort());

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall structure-selection checks passed');
process.exit(failures ? 1 : 0);
