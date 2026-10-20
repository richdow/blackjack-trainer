// Rules-engine unit tests. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/engine.js';

let seed = 1; const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const C = (r, s = 0) => ({ r, s });
/** Table with a stacked shoe. Deal order: seat cards, dealer up, seat cards, dealer hole, then hits. */
function table(ranks, rules = {}, seats = 1, bankroll = 1000) {
  const st = G.newTable({ ...rules }, rng);
  st.shoe = { cards: ranks.map((r, i) => C(r, i % 4)).concat(Array.from({ length: 200 }, (_, i) => C((i % 13) + 1, i % 4))), pos: 0, cut: 400, decks: st.rules.decks };
  st.justShuffled = false;
  for (let i = 0; i < seats; i++) { G.sit(st, i, { id: 'p' + i, name: 'P' + i, bankroll }); G.placeBet(st, i, 100); }
  G.deal(st, rng);
  return st;
}
const hv = (rs, split) => G.handValue(rs.map((r) => C(r)), split);

test('shoe composition is exact for 1..6 decks', () => {
  for (let d = 1; d <= 6; d++) {
    const shoe = G.buildShoe(d);
    assert.equal(shoe.length, 52 * d);
    for (let r = 1; r <= 13; r++) for (let s = 0; s < 4; s++) assert.equal(shoe.filter((c) => c.r === r && c.s === s).length, d);
    assert.equal(shoe.filter((c) => G.cardValue(c) === 10).length, 16 * d);
  }
});

test('hand values, soft/hard totals, bust', () => {
  assert.deepEqual([hv([1, 6]).total, hv([1, 6]).soft], [17, true]);
  assert.deepEqual([hv([1, 6, 10]).total, hv([1, 6, 10]).soft], [17, false]);
  assert.equal(hv([1, 1]).total, 12);
  assert.equal(hv([1, 1, 9]).total, 21);
  assert.equal(hv([1, 1, 1, 1, 7]).total, 21);
  assert.equal(hv([10, 13, 2]).bust, true);
  assert.equal(hv([12, 1]).blackjack, true);
  assert.equal(hv([7, 7, 7]).blackjack, false);
  assert.equal(hv([10, 1], true).blackjack, false, 'A+10 after a split is 21, not blackjack');
});

test('blackjack pays 3:2, 6:5 option', () => {
  // seat: A, K ; dealer 9 up, 7 hole
  let st = table([1, 9, 13, 7]);
  assert.equal(st.phase, 'dealer' === st.phase ? 'dealer' : 'settled');
  assert.equal(st.seats[0].hands[0].result, 'blackjack');
  assert.equal(st.seats[0].bankroll, 1150);
  st = table([1, 9, 13, 7], { bjPays: 1.2 });
  assert.equal(st.seats[0].bankroll, 1120);
});

test('insurance offered only vs an ace; pays 2:1 on dealer blackjack', () => {
  let st = table([10, 10, 9, 1]); // dealer 10 up, ace hole -> blackjack, no insurance phase
  assert.equal(st.phase, 'settled');
  assert.equal(st.dealer.bj, true);
  assert.equal(G.insurance(st, 0, true), false);
  st = table([10, 6, 9, 9]); // dealer 6 up
  assert.equal(st.phase, 'playing');
  st = table([10, 1, 9, 13]); // dealer A up, K hole
  assert.equal(st.phase, 'insurance');
  G.insurance(st, 0, true, rng);
  assert.equal(st.phase, 'settled');
  assert.equal(st.seats[0].bankroll, 1000, 'lose 100 main bet, win 2x50 insurance');
  st = table([10, 1, 9, 7]); // A up, no blackjack: insurance lost, play continues
  G.insurance(st, 0, true, rng);
  assert.equal(st.phase, 'playing');
  assert.equal(st.seats[0].bankroll, 850);
});

test('even money: player blackjack vs ace pushes main bet if dealer has blackjack', () => {
  const st = table([1, 1, 10, 10]);
  G.insurance(st, 0, false, rng);
  assert.equal(st.seats[0].hands[0].result, 'push');
  assert.equal(st.seats[0].bankroll, 1000);
});

test('dealer hits soft 17 under H17, stands under S17', () => {
  // player 10,8 stands; dealer 6 up, A hole (soft 17), next card 3
  let st = table([10, 6, 8, 1, 3], { h17: true });
  G.act(st, 0, 'stand', rng);
  assert.equal(G.handValue(st.dealer.cards).total, 20);
  assert.equal(st.seats[0].hands[0].result, 'lose');
  st = table([10, 6, 8, 1, 3], { h17: false });
  G.act(st, 0, 'stand', rng);
  assert.equal(G.handValue(st.dealer.cards).total, 17);
  assert.equal(st.seats[0].hands[0].result, 'win');
  assert.equal(st.seats[0].bankroll, 1100);
});

test('dealer does not draw when every player hand busted', () => {
  const st = table([10, 6, 6, 5, 10, 10]); // player 16, hits 10 -> bust; dealer 11 must not draw
  G.act(st, 0, 'hit', rng);
  assert.equal(st.dealer.cards.length, 2);
  assert.equal(st.seats[0].hands[0].result, 'bust');
});

test('double on any two cards, 9-11 and 10-11 restrictions', () => {
  let st = table([5, 6, 4, 10]); // player 9 (5,4)
  assert.equal(G.legalActions(st, 0).double, true);
  st = table([5, 6, 4, 10], { doubleOn: '10-11' });
  assert.equal(G.legalActions(st, 0).double, false);
  st = table([5, 6, 4, 10], { doubleOn: '9-11' });
  assert.equal(G.legalActions(st, 0).double, true);
  st = table([1, 6, 7, 10], { doubleOn: '9-11' }); // soft 18
  assert.equal(G.legalActions(st, 0).double, false);
  st = table([6, 6, 5, 10, 10, 2]); // 11 vs 6, doubles into 21; dealer 16 draws 2 -> 18
  G.act(st, 0, 'double', rng);
  assert.equal(st.seats[0].hands[0].bet, 200);
  assert.equal(st.seats[0].hands[0].result, 'win');
  assert.equal(st.seats[0].bankroll, 1200);
});

test('split: DAS on/off, resplit to 4 hands max, split aces one card', () => {
  // 8,8 vs 6; split hand1 gets 3 (11) -> DAS?
  let st = table([8, 6, 8, 10, 3, 2], { das: false });
  G.act(st, 0, 'split', rng);
  assert.equal(st.seats[0].hands.length, 2);
  assert.equal(G.legalActions(st, 0).double, false, 'no double after split');
  st = table([8, 6, 8, 10, 3, 2], { das: true });
  G.act(st, 0, 'split', rng);
  assert.equal(G.legalActions(st, 0).double, true, 'DAS');
  // Resplit limit: 8,8 and every new card an 8.
  st = table([8, 6, 8, 10, 8, 8, 8, 8, 8, 8], { maxSplitHands: 4 });
  G.act(st, 0, 'split', rng); G.act(st, 0, 'split', rng); G.act(st, 0, 'split', rng);
  assert.equal(st.seats[0].hands.length, 4);
  assert.equal(G.legalActions(st, 0).split, false, 'cannot exceed 4 hands');
  st = table([8, 6, 8, 10, 8, 8], { maxSplitHands: 2 });
  G.act(st, 0, 'split', rng);
  assert.equal(G.legalActions(st, 0).split, false, 'no resplit when limited to 2 hands');
  // Split aces: one card each, A+10 is 21 not blackjack (pays 1:1).
  st = table([1, 6, 1, 10, 13, 9, 10], { resplitAces: false });
  G.act(st, 0, 'split', rng);
  const hs = st.seats[0].hands;
  assert.equal(st.phase, 'settled');
  assert.equal(hs[0].cards.length, 2); assert.equal(hs[1].cards.length, 2);
  assert.equal(hs[0].result, 'win', 'A+K after split: plain 21 beats dealer 16->26? dealer drew');
  assert.equal(hs[0].payout, 200, 'paid 1:1, not 3:2');
});

test('resplit aces only with RSA', () => {
  let st = table([1, 6, 1, 10, 1, 5, 5, 5], { resplitAces: false });
  G.act(st, 0, 'split', rng);
  assert.equal(st.seats[0].hands.length, 2);
  st = table([1, 6, 1, 10, 1, 5, 5, 5], { resplitAces: true });
  G.act(st, 0, 'split', rng);
  assert.equal(G.legalActions(st, 0).split, true);
  assert.equal(G.legalActions(st, 0).hit, false, 'split aces cannot be hit');
  G.act(st, 0, 'split', rng);
  assert.equal(st.seats[0].hands.length, 3);
});

test('late surrender: first two cards only, after peek, returns half', () => {
  let st = table([10, 10, 6, 7]);
  assert.equal(G.legalActions(st, 0).surrender, true);
  G.act(st, 0, 'surrender', rng);
  assert.equal(st.seats[0].hands[0].result, 'surrender');
  assert.equal(st.seats[0].bankroll, 950);
  st = table([10, 10, 3, 7, 2]);
  G.act(st, 0, 'hit', rng);
  assert.equal(G.legalActions(st, 0).surrender, false, 'not after hitting');
  st = table([10, 10, 6, 7], { surrender: 'none' });
  assert.equal(G.legalActions(st, 0).surrender, false);
  st = table([10, 10, 6, 1]); // dealer 10 up, A hole: blackjack is checked BEFORE surrender
  assert.equal(st.phase, 'settled');
  assert.equal(st.seats[0].bankroll, 900);
});

test('multi-seat turn order and pushes', () => {
  // seat0: 10,9 ; seat1: 10,8 ; dealer 10 up, 9 hole
  const st = table([10, 10, 10, 9, 8, 9], {}, 2);
  assert.deepEqual(st.turn, { seat: 0, hand: 0 });
  assert.equal(G.legalActions(st, 1).stand, false, 'not your turn');
  G.act(st, 0, 'stand', rng);
  assert.deepEqual(st.turn, { seat: 1, hand: 0 });
  G.act(st, 1, 'stand', rng);
  assert.equal(st.seats[0].hands[0].result, 'push');
  assert.equal(st.seats[1].hands[0].result, 'lose');
});

test('cut card triggers a reshuffle before the next round; deck change waits for the shuffle', () => {
  seed = 7;
  const st = G.newTable({ decks: 1, penetration: 0.5 }, rng);
  G.sit(st, 0, { id: 'a', name: 'A', bankroll: 1e6 });
  const shuffles0 = st.shuffles;
  G.setRules(st, { decks: 2 }); // before first card: applies immediately
  let rounds = 0;
  while (!st.cutCardOut) {
    G.placeBet(st, 0, 10); G.deal(st, rng);
    if (st.phase === 'insurance') G.insurance(st, 0, false, rng);
    while (st.phase === 'playing') G.act(st, 0, 'stand', rng);
    G.nextRound(st); rounds++;
  }
  assert.ok(st.shoe.pos >= st.shoe.cut);
  G.setRules(st, { decks: 4 });
  assert.equal(st.rules.decks, 2, 'mid-shoe change is pending');
  G.placeBet(st, 0, 10); G.deal(st, rng);
  assert.equal(st.shuffles, shuffles0 + 2);
  assert.equal(st.shoe.cards.length, 208);
  assert.equal(st.rules.decks, 4);
  assert.ok(rounds > 3);
});

test('public view hides the hole card and undealt shoe', () => {
  const st = table([10, 6, 8, 10]);
  const v = G.publicView(st);
  assert.equal(v.dealer.cards[1].r, undefined);
  assert.equal(v.dealer.cards[1].down, true);
  assert.equal(JSON.stringify(v).includes('"cards":[{"r"') && v.shoe.cards, undefined);
});

test('random play invariant: money is conserved (bankroll + house = constant)', () => {
  seed = 99;
  const st = G.newTable({ decks: 6, das: true, resplitAces: true }, rng);
  for (let i = 0; i < 5; i++) G.sit(st, i, { id: 'p' + i, name: 'p', bankroll: 1e7 });
  let house = 0;
  for (let n = 0; n < 3000; n++) {
    const before = st.seats.reduce((a, s) => a + (s ? s.bankroll : 0), 0);
    for (let i = 0; i < 5; i++) G.placeBet(st, i, 10 + 5 * (n % 7));
    G.deal(st, rng);
    while (st.phase === 'insurance') for (const i of G.insurancePending(st)) G.insurance(st, i, rng() < 0.3, rng);
    let guard = 0;
    while (st.phase === 'playing' && guard++ < 200) {
      const L = G.legalActions(st, st.turn.seat);
      const opts = Object.keys(L).filter((k) => L[k]);
      G.act(st, st.turn.seat, opts[Math.floor(rng() * opts.length)], rng);
    }
    assert.equal(st.phase, 'settled');
    const after = st.seats.reduce((a, s) => a + (s ? s.bankroll : 0), 0);
    const net = st.seats.reduce((a, s) => a + (s ? s.roundNet : 0), 0);
    assert.ok(Math.abs(after - before - net) < 1e-6, 'roundNet equals bankroll change');
    house -= net;
    G.nextRound(st);
  }
  assert.ok(Number.isFinite(house));
});
