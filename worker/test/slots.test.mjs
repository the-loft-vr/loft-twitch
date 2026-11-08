// node --test worker/test/   (r37 slot drift fix)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOTS, GRACE, REUSE_COOLDOWN, assignInto, markListed, normalizeSlots } from '../src/slots.js';

const T0 = 1_800_000_000;
const need = (...l) => l.map((login) => ({ login }));

test('1000 slots; old two-field rows are upgraded (listed = seen)', () => {
  assert.equal(SLOTS, 1000);
  const s = normalizeSlots([['a', 5], null, ['b', 7, 9]]);
  assert.equal(s.length, 1000);
  assert.deepEqual(s[0], ['a', 5, 5]);
  assert.deepEqual(s[2], ['b', 7, 9]);
  assert.equal(s[1], null);
});

test('a listed channel keeps its slot run after run', () => {
  const s = normalizeSlots([]);
  const r1 = assignInto(s, need('x', 'y'), [], T0); markListed(s, r1, T0);
  const r2 = assignInto(s, need('y', 'x', 'z'), [], T0 + 300); markListed(s, r2, T0 + 300);
  assert.equal(r2.get('x'), r1.get('x'));
  assert.equal(r2.get('y'), r1.get('y'));
  assert.notEqual(r2.get('z'), r1.get('x'));
});

test('full table: a slot published within 30 min is never given to another channel (-1 instead)', () => {
  const s = normalizeSlots([], 3);
  const r1 = assignInto(s, need('a', 'b', 'c'), [], T0); markListed(s, r1, T0);
  // next run: a, b, c dropped off the lists (still on players' screens), d wants a slot
  const r2 = assignInto(s, need('d'), [], T0 + 600);
  assert.equal(r2.get('d'), -1);
  assert.deepEqual(s.map((r) => r[0]), ['a', 'b', 'c']);
  // after the cooldown the oldest-published holder gives way
  const r3 = assignInto(s, need('d'), [], T0 + REUSE_COOLDOWN + 1);
  assert.ok(r3.get('d') >= 0);
});

test('channels listed this run are never evicted, even after the cooldown', () => {
  const s = normalizeSlots([], 2);
  const r1 = assignInto(s, need('a', 'b'), [], T0); markListed(s, r1, T0);
  const later = T0 + REUSE_COOLDOWN + GRACE + 10;
  const r2 = assignInto(s, need('a', 'b', 'c'), [], later);
  assert.equal(r2.get('a'), r1.get('a'));
  assert.equal(r2.get('b'), r1.get('b'));
  assert.equal(r2.get('c'), -1);
});

test('a new channel listed AFTER the old ones in need order cannot take their slots (protection is up-front)', () => {
  const s = normalizeSlots([], 2);
  assignInto(s, need('a', 'b'), [], T0);
  // a long time later, 'new' comes first in the need list, a and b are still listed
  const r = assignInto(s, need('new', 'a', 'b'), [], T0 + 10 * REUSE_COOLDOWN);
  assert.equal(r.get('new'), -1);
  assert.equal(r.get('a'), 0); assert.equal(r.get('b'), 1);
});

test('free slots first, then offline holders past grace + cooldown', () => {
  const s = normalizeSlots([], 3);
  const r1 = assignInto(s, need('a', 'b'), [], T0); markListed(s, r1, T0);
  const r2 = assignInto(s, need('c'), [], T0 + 60);
  assert.equal(r2.get('c'), 2);   // the free one
  const late = T0 + GRACE + REUSE_COOLDOWN + 60;
  const r3 = assignInto(s, need('d'), ['b'], late);   // b still live: its grace clock restarts; a is offline
  assert.equal(s[r3.get('d')][0], 'd');
  assert.equal(s.findIndex((r) => r && r[0] === 'b'), 1);
});

test('drift simulation: 1000 slots, ~660 listed per run with churn, published links never change owner within 30 min', () => {
  const s = normalizeSlots([]);
  const published = [];   // [time, Map(login -> slot)]
  let rnd = 12345; const next = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  let pool = Array.from({ length: 660 }, (_, i) => 'ch' + i); let fresh = 660;
  let wrong = 0, checked = 0, unslotted = 0;
  for (let run = 0; run < 288; run++) {   // one day of 5-minute runs
    const now = T0 + run * 300;
    pool = pool.map((l) => (next() < 0.04 ? 'ch' + fresh++ : l));   // ~4 % of the listed channels change each run
    const got = assignInto(s, need(...pool), [], now); markListed(s, got, now);
    for (const v of got.values()) if (v < 0) unslotted++;
    published.push([now, got]);
    for (const [t, m] of published) {
      if (now - t > REUSE_COOLDOWN) continue;
      for (const [login, slot] of m) { if (slot < 0) continue; checked++; if (!s[slot] || s[slot][0] !== login) wrong++; }
    }
  }
  assert.equal(wrong, 0, `wrong ${wrong} of ${checked}`);
  assert.equal(unslotted, 0, `unslotted ${unslotted}`);
});
