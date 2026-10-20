// Hi-Lo counting tests: tags, deck estimation, true count, tracker over real engine rounds, bet ramp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/counting.js';
import * as G from '../src/engine.js';

test('Hi-Lo tags: 2-6 +1, 7-9 0, 10-A -1; a full deck sums to 0', () => {
  for (const r of [2, 3, 4, 5, 6]) assert.equal(C.hiLo(r), 1);
  for (const r of [7, 8, 9]) assert.equal(C.hiLo(r), 0);
  for (const r of [1, 10, 11, 12, 13]) assert.equal(C.hiLo(r), -1);
  for (const d of [1, 2, 6]) assert.equal(G.buildShoe(d).reduce((a, c) => a + C.hiLo(c.r), 0), 0);
});

test('decks remaining rounds to the nearest half deck; true count floors', () => {
  assert.equal(C.decksRemainingEstimate(312), 6);
  assert.equal(C.decksRemainingEstimate(130), 2.5);
  assert.equal(C.decksRemainingEstimate(10), 0.5);
  assert.equal(C.trueCount(9, 156), 3);      // 9 / 3
  assert.equal(C.trueCount(7, 104), 3);      // 3.5 -> 3
  assert.equal(C.trueCount(-7, 104), -4);    // -3.5 -> -4 (floor)
  assert.equal(C.trueCount(5, 26), 10);      // half a deck left
  assert.ok(Math.abs(C.trueCountExact(6, 78) - 4) < 1e-9);
});

test('tracker over real engine rounds matches a brute-force count; hole card counted only when shown', () => {
  let seed = 7; const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const st = G.newTable({ decks: 2 }, rng);
  G.sit(st, 0, { id: 'a', name: 'A' }); G.sit(st, 3, { id: 'b', name: 'B' });
  const tr = new C.CountTracker();
  for (let round = 0; round < 40; round++) {
    G.placeBet(st, 0, 10); G.placeBet(st, 3, 10);
    G.deal(st, rng);
    const v0 = G.publicView(st);
    tr.update(v0); tr.update(v0); // idempotent
    const hole = v0.dealer.cards[1];
    if (!v0.dealer.revealed) assert.ok(hole.down && !hole.r, 'hole card hidden in the public view');
    for (const i of G.insurancePending(st)) G.insurance(st, i, false, rng);
    let guard = 0;
    while (st.phase === 'playing' && guard++ < 50) { const t = st.turn; const v = G.handValue(st.seats[t.seat].hands[t.hand].cards).total; G.act(st, t.seat, v < 15 ? 'hit' : 'stand', rng); tr.update(G.publicView(st)); }
    const vs = G.publicView(st); tr.update(vs);
    // brute force: every card dealt since the last shuffle is now face up
    const dealtSinceShuffle = st.shoe.cards.slice(0, st.shoe.pos);
    assert.equal(tr.rc, dealtSinceShuffle.reduce((a, c) => a + C.hiLo(c.r), 0), 'running count after round ' + round);
    const un = tr.unseen(2);
    assert.equal(un.slice(1).reduce((a, b) => a + b, 0), 104 - st.shoe.pos, 'unseen composition size');
    G.nextRound(st);
  }
  assert.ok(st.shuffles > 1, 'test crossed at least one reshuffle at the cut card');
});

test('bet ramp: 1 unit at TC<=1, rises with TC, capped (1-8 shoes, 1-4 pitch)', () => {
  assert.equal(C.betUnits(-3, 6), 1); assert.equal(C.betUnits(1, 6), 1);
  assert.equal(C.betUnits(2, 6), 2); assert.equal(C.betUnits(3, 6), 4); assert.equal(C.betUnits(9, 6), 8);
  assert.equal(C.betUnits(2, 1), 2); assert.equal(C.betUnits(9, 2), 4);
  assert.equal(C.betAdvice(3, 6, 10).amount, 40);
  assert.ok(Math.abs(C.edgeAtTc(3, 0.5) - 1.0) < 1e-9);
});
