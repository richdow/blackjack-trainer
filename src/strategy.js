/* ==========================================================================
 * STRATEGY + TEACHING LAYER  (no DOM)
 *  - generateChart(rules): total-dependent basic strategy built from the EV
 *    calculator for the ACTIVE rules (decks, H17/S17, DAS, double/split/
 *    surrender options). Nothing is hard-coded; published charts are only used
 *    in the tests to verify the output.
 *  - gradeDecision(): compares a player's choice with the chart (and, in count
 *    mode, with Hi-Lo index plays) and grades it by EV loss.
 *  - houseEdge(): full-game expected return for a rule set (self-computed) and
 *    publishedEdge(): Wizard of Odds rule-variation sum, for comparison.
 * ======================================================================== */
import { EVContext, shoeCounts, actionEVs, bestOf, canDoubleTotal, handTotal } from './evcalc.js';

export const ACTION_NAMES = { hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surrender', insure: 'Take insurance', noinsure: 'No insurance' };
// Chart codes: H S D(=double else hit) Ds(=double else stand) P Rh Rs Rp (surrender else hit/stand/split)
export const CODE_INFO = {
  H: 'Hit', S: 'Stand', D: 'Double (else hit)', Ds: 'Double (else stand)', P: 'Split',
  Rh: 'Surrender (else hit)', Rs: 'Surrender (else stand)', Rp: 'Surrender (else split)',
};

/** Grading thresholds (EV loss in fraction of the hand's original bet). */
export const GRADE = { slight: 0.005 }; // < 0.5% of a bet = "Slightly suboptimal"

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];

function codeFrom(evs) {
  const order = Object.keys(evs).filter((k) => evs[k] !== undefined).sort((a, b) => evs[b] - evs[a]);
  const best = order[0];
  const rest = order.filter((k) => k !== 'double' && k !== 'surrender');
  const fallback = rest[0]; // best of hit/stand/split
  if (best === 'double') return fallback === 'stand' ? 'Ds' : 'D';
  if (best === 'surrender') return fallback === 'stand' ? 'Rs' : fallback === 'split' ? 'Rp' : 'Rh';
  return { hit: 'H', stand: 'S', split: 'P' }[best];
}

/** Weighted (by probability of the two-card holding) average of action EVs. */
function avgEVs(list) {
  const out = {}; let w = 0;
  for (const { evs, p } of list) {
    w += p;
    for (const k in evs) out[k] = (out[k] || 0) + evs[k] * p;
  }
  for (const k in out) out[k] /= w;
  return out;
}

/**
 * Generate a total-dependent chart for the rules. Cost ~1 s on a phone, so
 * the UI calls it with yieldEvery (async) and caches the result per rule key.
 */
export async function generateChart(rules, { yieldFn } = {}) {
  const decks = rules.decks, chart = { hard: {}, soft: {}, pair: {}, ev: { hard: {}, soft: {}, pair: {} }, key: rulesKey(rules) };
  const surr = rules.surrender === 'late';
  for (const up of UPS) {
    const base = shoeCounts(decks); base[up]--;
    const ctx = new EVContext(base, up, rules, 1);
    const hardList = {}, softList = {};
    for (let a = 1; a <= 10; a++) for (let b = a; b <= 10; b++) {
      const c = base.slice(); c[a]--; c[b]--;
      if (c[a] < 0 || c[b] < 0) continue;
      const p = a === b ? base[a] * (base[a] - 1) : 2 * base[a] * base[b];
      const pair = a === b;
      const isBJ = (a === 1 && b === 10);
      if (isBJ) continue;
      const hard = a + b, ace = a === 1;
      const evs = actionEVs([a, b], up, c, rules, {
        ctx, canDouble: canDoubleTotal(rules, hard, ace), canSplit: pair, canSurrender: surr,
      });
      if (pair) {
        chart.pair[a] = chart.pair[a] || {};
        chart.pair[a][up] = codeFrom(evs); chart.ev.pair[a] = chart.ev.pair[a] || {}; chart.ev.pair[a][up] = evs;
      }
      const noSplit = { ...evs }; delete noSplit.split;
      if (ace && !(a === 1 && b === 1)) (softList[handTotal(hard, true).total] ||= []).push({ evs: noSplit, p });
      else if (!ace && !pair) (hardList[hard] ||= []).push({ evs: noSplit, p });
      else if (!ace && pair) (hardList['p' + hard] ||= []).push({ evs: noSplit, p });
    }
    for (let t = 4; t <= 21; t++) {
      const list = hardList[t] || hardList['p' + t];
      if (!list) continue;
      const evs = avgEVs(list);
      (chart.hard[t] ||= {})[up] = codeFrom(evs); (chart.ev.hard[t] ||= {})[up] = evs;
    }
    for (let t = 13; t <= 20; t++) {
      const list = softList[t]; if (!list) continue;
      const evs = avgEVs(list);
      (chart.soft[t] ||= {})[up] = codeFrom(evs); (chart.ev.soft[t] ||= {})[up] = evs;
    }
    if (yieldFn) await yieldFn(UPS.indexOf(up) + 1, UPS.length);
  }
  // Hard 21 and soft 21 always stand; A,A handled as a pair (soft 12 row shown as pair).
  chart.hard[21] = Object.fromEntries(UPS.map((u) => [u, 'S']));
  return chart;
}

export function rulesKey(r) {
  return [r.decks, r.h17 ? 'H17' : 'S17', r.das ? 'DAS' : 'NDAS', r.doubleOn, 'SP' + r.maxSplitHands, r.resplitAces ? 'RSA' : '', r.hitSplitAces ? 'HSA' : '', r.surrender].join('-');
}

/* --------------------------- live hand helpers -------------------------- */
const rankOf = (c) => (c.r >= 10 ? 10 : c.r);
export function upRank(view) { const c = view.dealer.cards[0]; return c && c.r ? rankOf(c) : null; }

/** Chart lookup for an actual hand + currently legal actions -> concrete action. */
export function chartAction(chart, cards, up, legal) {
  const ranks = cards.map(rankOf);
  let hard = 0, ace = false; for (const r of ranks) { hard += r; if (r === 1) ace = true; }
  const { total, soft } = handTotal(hard, ace);
  if (ranks.length === 2 && ranks[0] === ranks[1] && legal.split) {
    const pc = chart.pair[ranks[0]][up];
    if (pc === 'P') return 'split';
    if (pc === 'Rp') return legal.surrender ? 'surrender' : 'split';
    return resolveCode(pc, legal); // pair we don't split: pair-specific EVs (e.g. 5,5 doubles)
  }
  let code;
  if (soft) code = total >= 13 && total <= 20 ? chart.soft[total][up] : total <= 12 ? 'H' : 'S';
  else code = chart.hard[Math.max(5, Math.min(21, total))]?.[up] ?? (total >= 17 ? 'S' : 'H');
  return resolveCode(code, legal);
}

/** Turn a chart code into an action that is legal right now. */
export function resolveCode(code, legal) {
  switch (code) {
    case 'D': return legal.double ? 'double' : 'hit';
    case 'Ds': return legal.double ? 'double' : 'stand';
    case 'Rh': return legal.surrender ? 'surrender' : 'hit';
    case 'Rs': return legal.surrender ? 'surrender' : 'stand';
    case 'Rp': return legal.surrender ? 'surrender' : legal.split ? 'split' : 'hit';
    case 'P': return legal.split ? 'split' : 'hit';
    case 'S': return 'stand';
    default: return legal.hit ? 'hit' : 'stand';
  }
}

/* ------------------------- Hi-Lo index plays ---------------------------- */
/**
 * Illustrious 18 (Schlesinger, "Blackjack Attack"), Hi-Lo, multi-deck S17,
 * as republished by Wizard of Odds / countingedge.com / blackjackinfo.com.
 * H17 alternates (11vA -1, 10vA +3, 12v6 -3) and the Fab 4 15vA H17 value (-1)
 * follow the BJ Insider newsletter #194 footnotes. Rule: make the "at" play
 * when TC >= index, otherwise the "below" play.
 */
export const INDEX_PLAYS = [
  { id: 'ins', name: 'Insurance', up: 1, kind: 'insurance', idx: 3, at: 'insure', below: 'noinsure' },
  { id: '16v10', name: '16 vs 10', total: 16, up: 10, idx: 0, at: 'stand', below: 'hit' },
  { id: '15v10', name: '15 vs 10', total: 15, up: 10, idx: 4, at: 'stand', below: 'hit' },
  { id: 'TTv5', name: '10,10 vs 5', pair: 10, up: 5, idx: 5, at: 'split', below: 'stand' },
  { id: 'TTv6', name: '10,10 vs 6', pair: 10, up: 6, idx: 4, at: 'split', below: 'stand' },
  { id: '10v10', name: '10 vs 10', total: 10, up: 10, idx: 4, at: 'double', below: 'hit' },
  { id: '12v3', name: '12 vs 3', total: 12, up: 3, idx: 2, at: 'stand', below: 'hit' },
  { id: '12v2', name: '12 vs 2', total: 12, up: 2, idx: 3, at: 'stand', below: 'hit' },
  { id: '11vA', name: '11 vs A', total: 11, up: 1, idx: 1, idxH17: -1, at: 'double', below: 'hit' },
  { id: '9v2', name: '9 vs 2', total: 9, up: 2, idx: 1, at: 'double', below: 'hit' },
  { id: '10vA', name: '10 vs A', total: 10, up: 1, idx: 4, idxH17: 3, at: 'double', below: 'hit' },
  { id: '9v7', name: '9 vs 7', total: 9, up: 7, idx: 3, at: 'double', below: 'hit' },
  { id: '16v9', name: '16 vs 9', total: 16, up: 9, idx: 5, at: 'stand', below: 'hit' },
  { id: '13v2', name: '13 vs 2', total: 13, up: 2, idx: -1, at: 'stand', below: 'hit' },
  { id: '12v4', name: '12 vs 4', total: 12, up: 4, idx: 0, at: 'stand', below: 'hit' },
  { id: '12v5', name: '12 vs 5', total: 12, up: 5, idx: -2, at: 'stand', below: 'hit' },
  { id: '12v6', name: '12 vs 6', total: 12, up: 6, idx: -1, idxH17: -3, at: 'stand', below: 'hit' },
  { id: '13v3', name: '13 vs 3', total: 13, up: 3, idx: -2, at: 'stand', below: 'hit' },
];
/** Fab 4 late-surrender indices (Schlesinger). Surrender at TC >= index, else don't. */
export const FAB4 = [
  { id: 'S14v10', name: '14 vs 10 surrender', total: 14, up: 10, idx: 3 },
  { id: 'S15v10', name: '15 vs 10 surrender', total: 15, up: 10, idx: 0 },
  { id: 'S15v9', name: '15 vs 9 surrender', total: 15, up: 9, idx: 2 },
  { id: 'S15vA', name: '15 vs A surrender', total: 15, up: 1, idx: 1, idxH17: -1 },
];
export const indexValue = (p, rules) => (rules.h17 && p.idxH17 !== undefined ? p.idxH17 : p.idx);

/**
 * Count-aware correct play: basic strategy, then Fab 4 (if surrender is
 * available), then Illustrious 18. Returns {action, index?} where index is the
 * deviation that decided it (for teaching).
 */
export function countAction(chart, cards, up, legal, tc, rules) {
  let basic = chartAction(chart, cards, up, legal);
  const ranks = cards.map(rankOf);
  let hard = 0, ace = false; for (const r of ranks) { hard += r; if (r === 1) ace = true; }
  const { total, soft } = handTotal(hard, ace);
  const isPair = ranks.length === 2 && ranks[0] === ranks[1];
  if (soft) return { action: basic };
  let fab = null;
  // 1) Fab 4 surrenders (only where surrender is offered and legal now).
  if (legal.surrender && basic !== 'split') {
    fab = FAB4.find((p) => p.total === total && p.up === up) || null;
    if (fab) {
      if (tc >= indexValue(fab, rules)) return { action: 'surrender', index: fab, tc };
      legal = { ...legal, surrender: false };
      basic = chartAction(chart, cards, up, legal);
    }
  }
  if (basic === 'surrender') return { action: basic };
  // 2) Illustrious 18 playing deviations.
  for (const p of INDEX_PLAYS) {
    if (p.kind || p.up !== up) continue;
    if (p.pair !== undefined) { if (!(isPair && ranks[0] === p.pair && legal.split)) continue; }
    else if (p.total !== total || (isPair && basic === 'split')) continue;
    if (p.at === 'double' && !legal.double) continue;
    const below = p.below === 'hit' && !legal.hit ? 'stand' : p.below;
    return { action: tc >= indexValue(p, rules) ? p.at : below, index: p, tc };
  }
  return fab ? { action: basic, index: fab, tc } : { action: basic };
}

/* ------------------------------ grading -------------------------------- */
/**
 * Grade one decision.
 *  view: public table view; seat/handIdx: whose hand; chosen: action taken.
 *  composition: unseen-card counts to evaluate EV with (full shoe minus the
 *    visible hand + upcard for basic strategy; the real unseen cards in count mode).
 * Grades: 'correct' | 'slight' | 'mistake' with EV loss in % of the hand bet.
 */
export function gradeDecision({ chart, rules, cards, up, legal, chosen, unseen, tc = null, useIndices = false }) {
  const rec = useIndices && tc !== null ? countAction(chart, cards, up, legal, tc, rules) : { action: chartAction(chart, cards, up, legal) };
  const ranks = cards.map(rankOf);
  const evs = actionEVs(ranks, up, unseen, rules, {
    canDouble: legal.double, canSplit: legal.split && ranks[0] === ranks[1], canSurrender: legal.surrender,
  });
  if (!legal.hit) delete evs.hit;
  const loss = Math.max(0, (evs[rec.action] ?? 0) - (evs[chosen] ?? 0));
  const compBest = bestOf(evs);
  let grade;
  if (chosen === rec.action) grade = 'correct';
  else if ((evs[chosen] ?? -9) >= (evs[rec.action] ?? -9) - 1e-9) grade = 'correct'; // composition-dependent play at least as good
  else grade = loss < GRADE.slight ? 'slight' : 'mistake';
  return { grade, correct: rec.action, chosen, loss, evs, index: rec.index || null, tc, compBest, reason: explain(rec, { cards: ranks, up, evs, chosen, rules }), because: because(rec, { cards: ranks, up, evs, chosen, rules }) };
}

/** Insurance grading: basic strategy never insures; with count, insure at TC >= +3. */
export function gradeInsurance({ take, tc, useIndices, unseen }) {
  const n = unseen.reduce((a, b, i) => (i ? a + b : a), 0);
  const pTen = unseen[10] / n;
  const ev = 2 * pTen - (1 - pTen); // per unit insured
  const should = useIndices && tc !== null ? tc >= 3 : false;
  const chosen = take ? 'insure' : 'noinsure', correct = should ? 'insure' : 'noinsure';
  const lossUnits = Math.max(0, (should ? ev : 0) - (take ? ev : 0)) / 2; // insurance = half a bet
  const grade = chosen === correct ? 'correct' : lossUnits < GRADE.slight ? 'slight' : 'mistake';
  const why = should
    ? `At true count ${fmtTc(tc)} the shoe is rich enough in tens (${(pTen * 100).toFixed(1)}%) that insurance pays: 2:1 needs over 33.3%.`
    : `Insurance pays 2:1, so it needs more than 1 in 3 unseen cards to be tens. Right now about ${(pTen * 100).toFixed(1)}% are${useIndices ? '' : ' (basic strategy: always decline)'}; take it only at Hi-Lo true count +3 or more.`;
  const short = should ? `tens are ${(pTen * 100).toFixed(1)}% of the unseen cards, above the 33.3% break-even` : `insurance needs over 33.3% tens to pay; about ${(pTen * 100).toFixed(1)}% remain`;
  return { grade, correct, chosen, loss: lossUnits, reason: why, because: short, tc, ev, insurance: true };
}

const fmtTc = (t) => (t > 0 ? '+' : '') + t;
const pct = (x) => (x * 100).toFixed(1) + '%';

/**
 * One short "because ..." clause for the feedback headline
 * ("Mistake — Stand, because ..."). Falls back to the EV difference.
 */
export function because(rec, { cards, up, evs, chosen, rules }) {
  const upName = up === 1 ? 'an Ace' : up === 10 ? 'a 10' : up === 8 ? 'an 8' : `a ${up}`;
  const a = rec.action;
  let hard = 0, ace = false; for (const r of cards) { hard += r; if (r === 1) ace = true; }
  const { total, soft } = handTotal(hard, ace);
  const weak = up >= 2 && up <= 6;
  if (rec.index) return `the true count (${fmtTc(rec.tc)}) is ${rec.tc >= indexValue(rec.index, rules) ? 'at or past' : 'short of'} the ${rec.index.name} index (${fmtTc(indexValue(rec.index, rules))})`;
  if (a === 'stand' && !soft && total >= 17) return `${total === 21 ? 'nothing improves 21' : total === 20 ? 'anything but an Ace busts 20' : `any card over ${21 - total} busts ${total}`}, and ${total} already beats or ties many dealer finishes`;
  if (a === 'stand' && !soft && total >= 12) return `the dealer showing ${upName} busts often; let the dealer take the risk`;
  if (a === 'stand' && soft) return `soft ${total} is already a strong total against ${upName}`;
  if (a === 'hit' && !soft && total <= 11) return `no card can bust ${total}, so a free hit only helps`;
  if (a === 'hit' && soft) return `a soft hand can't bust on one card, and soft ${total} is too weak vs ${upName}`;
  if (a === 'hit' && total >= 12 && total <= 16) return `the dealer showing ${upName} usually makes 17+, so ${total} has to improve`;
  if (a === 'double') return `you're the favorite against ${upName}${weak ? ' (a bust card)' : ''}, so getting more money out pays`;
  if (a === 'split' && cards[0] === 8) return '16 is the worst total; two hands starting with 8 lose much less';
  if (a === 'split' && cards[0] === 1) return 'two hands starting with an Ace beat one soft 12';
  if (a === 'split') return `two hands starting with ${cards[0] === 10 ? 'a 10' : cards[0]} do better than ${soft ? 'soft ' : ''}${total} against ${upName}`;
  if (a === 'surrender') return `${total} vs ${upName} loses more than half its bet on average; surrender costs exactly half`;
  const d = (evs[a] ?? 0) - (evs[chosen] ?? 0);
  return `it returns ${(d * 100).toFixed(1)}% more of your bet on average`;
}

function explain(rec, { cards, up, evs, chosen, rules }) {
  const upName = up === 1 ? 'A' : String(up);
  const a = rec.action;
  const parts = [];
  if (rec.index) {
    const p = rec.index;
    const iv = indexValue(p, rules);
    parts.push(`Index play ${p.name} (Hi-Lo ${fmtTc(iv)}): true count is ${fmtTc(rec.tc)}, ${rec.tc >= iv ? 'at or above' : 'below'} the index.`);
  }
  const weak = [4, 5, 6].includes(up), strong = [7, 8, 9, 10, 1].includes(up);
  let hard = 0, ace = false; for (const r of cards) { hard += r; if (r === 1) ace = true; }
  const { total, soft } = handTotal(hard, ace);
  if (a === 'stand' && total <= 16 && !soft) parts.push(weak || up <= 3 ? `Dealer ${upName} is a bust card; let the dealer take the risk of breaking.` : `Taking a card busts too often from ${total}.`);
  if (a === 'hit' && total >= 12 && total <= 16 && strong) parts.push(`Dealer ${upName} makes 17+ most of the time, so ${total} must improve.`);
  if (a === 'double') parts.push(`You're the favorite and the dealer ${weak ? 'is weak' : 'is beatable'}; doubling gets more money out with the edge.`);
  if (a === 'split' && cards[0] === 8) parts.push('16 is the worst hand; two hands starting with 8 do much better.');
  else if (a === 'split' && cards[0] === 1) parts.push('Each ace is a strong start; two of them beat one soft 12.');
  else if (a === 'split') parts.push(`Two hands starting with ${cards[0] === 10 ? 'a ten' : cards[0]} vs a ${upName} beat playing ${total}.`);
  if (a === 'surrender') parts.push(`You'd lose more than 75% of the time; surrender gives back half the bet.`);
  const fmt = (k) => (evs[k] !== undefined ? `${ACTION_NAMES[k]} ${evs[k] >= 0 ? '+' : ''}${(evs[k] * 100).toFixed(1)}%` : null);
  const shown = [a, chosen].filter((k, i, arr) => arr.indexOf(k) === i).map(fmt).filter(Boolean);
  if (shown.length) parts.push(`Expected return per bet: ${shown.join(' vs ')}.`);
  return parts.join(' ');
}

/* --------------------------- house edge -------------------------------- */
/**
 * Expected return (fraction of initial bet) of the full game under the rules
 * with composition-dependent optimal 2-card decisions (off the top of a fresh
 * shoe, no cut-card effect). Matches Wizard of Odds Appendix 9 "expected return
 * of game" to within ~0.01% (see tests).
 */
export function gameEV(rules, depth = 1) {
  const decks = rules.decks, full = shoeCounts(decks), N = 52 * decks;
  let total = 0;
  for (let up = 1; up <= 10; up++) {
    const pUp = full[up] / N;
    const base = full.slice(); base[up]--;
    const ctx = new EVContext(base, up, { ...rules }, depth);
    const n1 = N - 1;
    for (let a = 1; a <= 10; a++) for (let b = a; b <= 10; b++) {
      const c = base.slice();
      const pa = c[a] / n1; c[a]--; if (c[a] < 0) continue;
      const pb = c[b] / (n1 - 1); c[b]--; if (c[b] < 0) continue;
      const p = pUp * pa * pb * (a === b ? 1 : 2);
      const n = n1 - 2;
      const pBJ = up === 1 ? c[10] / n : up === 10 ? c[1] / n : 0;
      const playerBJ = a === 1 && b === 10;
      let ev;
      if (playerBJ) ev = pBJ * 0 + (1 - pBJ) * rules.bjPays;
      else {
        const hard = a + b, ace = a === 1;
        const e = actionEVs([a, b], up, c, rules, { ctx, canDouble: canDoubleTotal(rules, hard, ace), canSplit: a === b, canSurrender: rules.surrender === 'late' });
        ev = pBJ * -1 + (1 - pBJ) * bestOf(e).ev;
      }
      total += p * ev;
    }
  }
  return total;
}

/**
 * Published rule effects (Wizard of Odds, "Blackjack Rule Variations",
 * https://wizardofodds.com/games/blackjack/rule-variations/), relative to its
 * base game: 8 decks, S17, double any two, DAS, split to 4, no RSA, no hitting
 * split aces, peek, 3:2, no surrender. Base house edge 0.43% (Wizard of Odds
 * Appendix 9, 8 decks S17: expected return -0.004304). Positive = player gain.
 */
export const PUBLISHED = {
  base: 0.43, source: 'Wizard of Odds rule-variations table and Appendix 9 (8D S17 base)',
  decks: { 1: 0.48, 2: 0.19, 4: 0.06, 5: 0.03, 6: 0.02, 8: 0 },
  h17: -0.22, bj65: -1.39, double911: -0.09, double1011: -0.18, noDAS: -0.14,
  rsa: 0.08, hitSplitAces: 0.19, split3: -0.01, noResplit: -0.10, lateSurrender: 0.07,
};
export function publishedEdge(r) {
  const P = PUBLISHED; const items = [];
  if (P.decks[r.decks] === undefined) return { edge: null, items: [{ name: `${r.decks} decks`, effect: null, note: 'not listed in the published table' }] };
  const add = (name, effect) => items.push({ name, effect });
  add(`${r.decks} deck${r.decks > 1 ? 's' : ''}`, P.decks[r.decks]);
  if (r.h17) add('Dealer hits soft 17', P.h17);
  if (r.bjPays === 1.2) add('Blackjack pays 6:5', P.bj65);
  if (r.doubleOn === '9-11') add('Double on 9-11 only', P.double911);
  if (r.doubleOn === '10-11') add('Double on 10-11 only', P.double1011);
  if (!r.das) add('No double after split', P.noDAS);
  if (r.resplitAces) add('Resplit aces', P.rsa);
  if (r.hitSplitAces) add('Hit split aces', P.hitSplitAces);
  if (r.maxSplitHands === 3) add('Split to 3 hands', P.split3);
  if (r.maxSplitHands === 2) add('No resplitting', P.noResplit);
  if (r.surrender === 'late') add('Late surrender', P.lateSurrender);
  const edge = P.base - items.reduce((a, b) => a + b.effect, 0);
  return { edge: Math.round(edge * 100) / 100, items };
}
