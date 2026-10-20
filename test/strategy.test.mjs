// Strategy-engine verification against published sources. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../src/evcalc.js';
import * as S from '../src/strategy.js';
import { sanitizeRules, DEFAULT_RULES } from '../src/engine.js';
import { WIZ, expectCode } from './fixtures/wizard-charts.js';

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
const rules = (o) => sanitizeRules({ ...DEFAULT_RULES, ...o });

export const nearTies = [];
function compareChart(chart, wiz, r) {
  const diffs = [];
  for (const kind of ['hard', 'soft', 'pair']) {
    for (const row in wiz[kind]) {
      const cells = wiz[kind][row].split(' ');
      UPS.forEach((u, i) => {
        const want = expectCode(cells[i], r);
        const got = kind === 'hard' ? chart.hard[row][u] : kind === 'soft' ? chart.soft[row][u] : chart.pair[row][u];
        if (got === want) return;
        // A disagreement is tolerated only if it's a near-tie (< 0.3% of a bet) between the two plays.
        const evs = chart.ev[kind][row][u];
        const act = (code) => ({ H: 'hit', S: 'stand', D: 'double', Ds: 'double', P: 'split', Rh: 'surrender', Rs: 'surrender', Rp: 'surrender' })[code];
        const gap = Math.abs((evs[act(got)] ?? -9) - (evs[act(want)] ?? -9));
        const msg = `${kind} ${row} vs ${u === 1 ? 'A' : u}: got ${got}, chart ${want} (EV gap ${(gap * 100).toFixed(2)}%)`;
        if (gap < 0.003) nearTies.push(msg); else diffs.push(msg);
      });
    }
  }
  return diffs;
}

const CASES = [
  ['4-8 decks H17', { decks: 6, h17: true, das: true, surrender: 'late' }],
  ['4-8 decks H17', { decks: 6, h17: true, das: false, surrender: 'late' }],
  ['4-8 decks H17', { decks: 4, h17: true, das: true, surrender: 'none' }],
  ['4-8 decks S17', { decks: 6, h17: false, das: true, surrender: 'late' }],
  ['4-8 decks S17', { decks: 6, h17: false, das: false, surrender: 'none' }],
  ['2 decks H17', { decks: 2, h17: true, das: true, surrender: 'late' }],
  ['2 decks H17', { decks: 2, h17: true, das: false, surrender: 'late' }],
  ['1 deck H17', { decks: 1, h17: true, das: false, surrender: 'none' }],
  ['1 deck H17', { decks: 1, h17: true, das: true, surrender: 'late' }],
];
for (const [name, o] of CASES) {
  test(`generated chart matches Wizard of Odds "${name}" (${JSON.stringify(o)})`, async () => {
    const r = rules(o);
    const chart = await S.generateChart(r);
    const diffs = compareChart(chart, WIZ[name], r);
    assert.deepEqual(diffs, []);
  });
}
test('near-tie chart cells (allowed, reported)', () => {
  console.log('# near-ties vs published charts:', JSON.stringify([...new Set(nearTies)]));
  assert.ok(new Set(nearTies).size <= 3);
});

// Composition-dependent EVs from Wizard of Odds Appendix 9 (exact recursive program).
const APPX = ['8ds17r4', '6ds17r4', '6dh17r4', '2dh17r4', '1ds17r4', '1dh17r4'];
for (const key of APPX) {
  test(`EV calculator matches Wizard of Odds Appendix 9 ${key}`, () => {
    const decks = +key[0], h17 = key.includes('h17');
    const r = { h17, das: true, doubleOn: 'any', maxSplitHands: 4, resplitAces: false, hitSplitAces: false, resplitPolicy: 'always', bjPays: 1.5, surrender: 'none', decks };
    const fx = JSON.parse(readFileSync(new URL(`./fixtures/${key}.json`, import.meta.url)));
    const rk = (s) => (s === 'A' ? 1 : +s);
    const ctxs = {}; let pairs = false, maxErr = 0, n = 0, worst = '';
    const tol = decks >= 4 ? 0.003 : decks === 2 ? 0.006 : 0.01;
    for (const row of fx.rows) {
      if (row[0] === 'Dealer') { pairs = row.length === 8; continue; }
      const up = rk(row[0]); const cards = row[1].split(',').map(rk);
      if (cards.length !== 2 || cards.includes(1) && cards.includes(10)) continue; // skip blackjack rows
      const base = E.shoeCounts(decks); base[up]--;
      const ctx = (ctxs[up] ||= new E.EVContext(base, up, r, 1));
      const c = base.slice(); c[cards[0]]--; c[cards[1]]--;
      const ev = E.actionEVs(cards, up, c, r, { ctx, canDouble: true, canSplit: pairs });
      const want = { stand: +row[2], hit: +row[3], double: +row[4] };
      if (pairs && cards[0] !== 10) want.split = +row[6]; // 10,10 split is never basic strategy; see README
      for (const k in want) { const e = Math.abs(ev[k] - want[k]); if (e > maxErr) { maxErr = e; worst = `${row[0]} ${row[1]} ${k}`; } }
      // Best action must agree unless Wizard's top two plays are within the tolerance.
      const sorted = Object.entries(want).sort((a, b) => b[1] - a[1]);
      const mine = E.bestOf(Object.fromEntries(Object.keys(want).map((k) => [k, ev[k]]))).action;
      if (mine !== sorted[0][0]) assert.ok(sorted[0][1] - want[mine] < tol, `${row.join(' ')}: best ${mine} vs ${sorted[0][0]}`);
      n++;
    }
    assert.ok(n >= 500);
    assert.ok(maxErr < tol, `max EV error ${maxErr.toFixed(5)} at ${worst}`);
  });
}

test('full-game expected return matches Wizard of Odds Appendix 9 within 0.01%', () => {
  const base = { doubleOn: 'any', maxSplitHands: 4, resplitAces: false, hitSplitAces: false, resplitPolicy: 'always', bjPays: 1.5, surrender: 'none' };
  for (const [decks, h17, das, want] of [[8, false, true, -0.004304], [6, true, true, -0.006151], [6, false, true, -0.004026], [2, true, true, -0.003797], [1, false, true, 0.001839], [1, true, false, -0.001513]]) {
    const ev = S.gameEV({ ...base, decks, h17, das });
    assert.ok(Math.abs(ev - want) < 0.0001, `${decks}D ${h17 ? 'H17' : 'S17'} ${das ? 'DAS' : 'noDAS'}: ${ev} vs ${want}`);
  }
});

test('published rule-variation sum (Wizard table) is close to our own calculator', () => {
  for (const o of [{ decks: 6, h17: true, das: true, surrender: 'late' }, { decks: 6, h17: false, das: true, surrender: 'none' }, { decks: 2, h17: true, das: false, surrender: 'none' }, { decks: 6, h17: true, bjPays: 1.2, das: true }]) {
    const r = rules(o);
    const pub = S.publishedEdge(r).edge, mine = -S.gameEV(r) * 100;
    assert.ok(Math.abs(pub - mine) < 0.12, `${JSON.stringify(o)} published ${pub} vs computed ${mine.toFixed(3)}`);
  }
});

test('grading: correct / slightly suboptimal / mistake by EV loss', async () => {
  const r = rules({ decks: 6, h17: true, das: true, surrender: 'late' });
  const chart = await S.generateChart(r);
  const legal = { hit: true, stand: true, double: true, split: false, surrender: true };
  const unseen = (cards, up) => { const c = E.shoeCounts(6); for (const x of [...cards, up]) c[x]--; return c; };
  const g = (cards, up, chosen, L = legal) => S.gradeDecision({ chart, rules: r, cards: cards.map((x) => ({ r: x })), up, legal: L, chosen, unseen: unseen(cards, up) });
  assert.equal(g([10, 2], 4, 'stand').grade, 'correct');
  assert.equal(g([10, 6], 10, 'surrender').grade, 'correct');
  assert.equal(g([10, 2], 4, 'hit').grade, 'slight', '12 v 4 hit costs ~0.8%? must be near threshold');
}, { skip: false });

test('grading: big mistakes explain the right play', async () => {
  const r = rules({ decks: 6, h17: true, das: true, surrender: 'late' });
  const chart = await S.generateChart(r);
  const c = E.shoeCounts(6); c[10] -= 2; c[6]--;
  const res = S.gradeDecision({ chart, rules: r, cards: [{ r: 10 }, { r: 13 }], up: 6, legal: { hit: true, stand: true, double: true, split: true, surrender: true }, chosen: 'hit', unseen: c });
  assert.equal(res.grade, 'mistake'); assert.equal(res.correct, 'stand');
  assert.ok(res.loss > 0.5);
  assert.match(res.reason, /Expected return/);
});

test('index plays: I18 + Fab 4 decisions flip at the published true counts', async () => {
  const r = rules({ decks: 6, h17: false, das: true, surrender: 'late' });
  const chart = await S.generateChart(r);
  const L = { hit: true, stand: true, double: true, split: true, surrender: false };
  const ca = (cards, up, tc, l = L) => S.countAction(chart, cards.map((x) => ({ r: x })), up, l, tc, r).action;
  assert.equal(ca([10, 6], 10, -1), 'hit'); assert.equal(ca([10, 6], 10, 0), 'stand');
  assert.equal(ca([10, 5], 10, 3), 'hit'); assert.equal(ca([10, 5], 10, 4), 'stand');
  assert.equal(ca([10, 10], 6, 3), 'stand'); assert.equal(ca([10, 10], 6, 4), 'split');
  assert.equal(ca([10, 10], 5, 5), 'split');
  assert.equal(ca([6, 4], 10, 3), 'hit'); assert.equal(ca([6, 4], 10, 4), 'double');
  assert.equal(ca([10, 2], 3, 1), 'hit'); assert.equal(ca([10, 2], 3, 2), 'stand');
  assert.equal(ca([10, 2], 2, 3), 'stand'); assert.equal(ca([10, 2], 4, -1), 'hit');
  assert.equal(ca([10, 2], 5, -2), 'stand'); assert.equal(ca([10, 2], 5, -3), 'hit');
  assert.equal(ca([10, 3], 2, -2), 'hit'); assert.equal(ca([10, 3], 2, -1), 'stand');
  assert.equal(ca([6, 5], 1, 0), 'hit'); assert.equal(ca([6, 5], 1, 1), 'double');
  assert.equal(ca([5, 4], 2, 1), 'double'); assert.equal(ca([5, 4], 7, 3), 'double'); assert.equal(ca([5, 4], 7, 2), 'hit');
  assert.equal(ca([10, 6], 9, 5), 'stand'); assert.equal(ca([10, 6], 9, 4), 'hit');
  const LS = { ...L, surrender: true };
  assert.equal(ca([10, 4], 10, 3, LS), 'surrender'); assert.equal(ca([10, 4], 10, 2, LS), 'hit');
  assert.equal(ca([10, 5], 10, -1, LS), 'hit'); assert.equal(ca([10, 5], 10, 0, LS), 'surrender');
  assert.equal(ca([10, 5], 9, 2, LS), 'surrender'); assert.equal(ca([10, 5], 1, 1, LS), 'surrender'); assert.equal(ca([10, 5], 1, 0, LS), 'hit');
  // H17 alternates
  const rh = rules({ decks: 6, h17: true, das: true, surrender: 'late' });
  const ch = await S.generateChart(rh);
  assert.equal(S.countAction(ch, [{ r: 6 }, { r: 5 }], 1, L, -1, rh).action, 'double');
  assert.equal(S.countAction(ch, [{ r: 6 }, { r: 5 }], 1, L, -2, rh).action, 'hit');
  assert.equal(S.countAction(ch, [{ r: 10 }, { r: 5 }], 1, LS, -1, rh).action, 'surrender');
});

test('insurance grading: decline at TC < 3, take at TC >= 3 when counting', () => {
  const c = E.shoeCounts(6);
  assert.equal(S.gradeInsurance({ take: true, tc: 0, useIndices: false, unseen: c }).grade !== 'correct', true);
  assert.equal(S.gradeInsurance({ take: false, tc: 0, useIndices: false, unseen: c }).grade, 'correct');
  assert.equal(S.gradeInsurance({ take: true, tc: 3, useIndices: true, unseen: c }).grade, 'correct');
});

test('feedback headline has a "because" clause for every action', async () => {
  const { gradeDecision, generateChart } = await import('../src/strategy.js');
  const { DEFAULT_RULES } = await import('../src/engine.js');
  const chart = await generateChart(DEFAULT_RULES);
  const cases = [[[10, 8], 6, 'hit'], [[5, 6], 10, 'stand'], [[10, 6], 10, 'stand'], [[8, 8], 10, 'hit'], [[1, 6], 3, 'stand'], [[10, 3], 4, 'hit']];
  for (const [cards, up, chosen] of cases) {
    const unseen = E.shoeCounts(DEFAULT_RULES.decks); for (const r of [...cards, up]) unseen[r]--;
    const g = gradeDecision({ cards: cards.map((r) => ({ r })), up, chosen, rules: DEFAULT_RULES, chart, legal: { hit: true, stand: true, double: true, split: cards[0] === cards[1], surrender: true }, unseen });
    assert.equal(g.grade === 'correct', false, `${cards} v ${up} ${chosen} should be wrong`);
    assert.ok(g.because && g.because.length > 10, `because for ${cards} v ${up}: ${g.because}`);
  }
});
