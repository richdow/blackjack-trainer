/* ==========================================================================
 * EV CALCULATOR  (strategy layer, no DOM)
 * --------------------------------------------------------------------------
 * Combinatorial expected-value engine used to (a) generate basic strategy for
 * the active rules, (b) grade every live decision by EV loss, and (c) estimate
 * the house edge of a rule set.
 *
 * Model (documented so results can be audited):
 *  - Ranks are 1..10 (1 = ace, 10 = any ten-value card). A composition is an
 *    array c[0..10] of card counts still unseen (c[0] unused).
 *  - US hole-card game with dealer peek: decisions are made only after the
 *    dealer has checked for blackjack, so dealer outcome probabilities are
 *    CONDITIONED ON NO DEALER BLACKJACK (hole card can't be a ten under an ace
 *    or an ace under a ten). This is how published basic strategy is derived.
 *  - Dealer draws are exact, without replacement, from the composition left
 *    after removing the player's cards and the upcard.
 *  - Player hit/stand/double EVs are exact for the composition: every player
 *    draw removes that card from the shoe and the dealer distribution is
 *    recomputed for the new composition (memoised per removed-card multiset).
 *  - Splits: same simplification Wizard of Odds documents for its Appendix 9:
 *    each split hand is played with the shoe minus the pair, the upcard and its
 *    own cards, not the cards drawn to the sibling hands; resplits are handled
 *    exactly with a small Markov chain over "hands waiting for a 2nd card".
 *  - EVs are in units of the ORIGINAL bet (a double returns 2x outcomes, a
 *    split returns the sum over all split hands).
 * Verified against Wizard of Odds Appendix 9 (composition-dependent EVs for
 * 1-8 decks) in test/strategy.test.mjs.
 * ======================================================================== */

export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Full-shoe composition for n decks: 4 of each rank per deck, 16 tens. */
export function shoeCounts(decks) {
  const c = new Array(11).fill(0);
  for (let r = 1; r <= 9; r++) c[r] = 4 * decks;
  c[10] = 16 * decks;
  return c;
}
const sum = (c) => { let n = 0; for (let r = 1; r <= 10; r++) n += c[r]; return n; };

/** Best total of a hand given hard total and whether it holds an ace. */
export function handTotal(hard, hasAce) {
  return hasAce && hard + 10 <= 21 ? { total: hard + 10, soft: true } : { total: hard, soft: false };
}

/**
 * Dealer final-total distribution [17,18,19,20,21,bust] for a given upcard,
 * drawing without replacement from composition c (already excluding the
 * upcard and player cards). If peek is true and the upcard is A or 10 the hole
 * card is conditioned so the dealer does NOT have blackjack.
 */
export function dealerDist(c, up, h17, peek = true) {
  const out = [0, 0, 0, 0, 0, 0];
  const cc = c.slice();
  let n = sum(cc);
  const rec = (hard, ace, cards, p) => {
    const { total, soft } = handTotal(hard, ace);
    if (total > 21) { out[5] += p; return; }
    // Stand on 17+; with H17 the dealer hits a SOFT 17 (A-6, A-2-4, ...).
    if (total >= 17 && !(total === 17 && soft && h17)) {
      out[total - 17] += p; return;
    }
    let denom = n, excl = 0;
    if (cards === 1 && peek) {
      // Hole card: conditioned on no blackjack.
      if (up === 1) excl = 10; else if (up === 10) excl = 1;
      if (excl) denom -= cc[excl];
    }
    if (denom <= 0) { out[total >= 17 ? total - 17 : 5] += p; return; } // degenerate, empty shoe
    for (let r = 1; r <= 10; r++) {
      if (r === excl || cc[r] === 0) continue;
      const q = p * cc[r] / denom;
      cc[r]--; n--;
      rec(hard + r, ace || r === 1, cards + 1, q);
      cc[r]++; n++;
    }
  };
  rec(up, up === 1, 1, 1);
  return out;
}

/** EV of standing on `total` vs dealer distribution d. */
export function standEV(total, d) {
  if (total > 21) return -1;
  let ev = d[5]; // dealer bust
  for (let i = 0; i < 5; i++) {
    const dt = 17 + i;
    if (total > dt) ev += d[i]; else if (total < dt) ev -= d[i];
  }
  return ev;
}

/**
 * EVContext: memoised EV machinery for ONE upcard and one base composition.
 * Every composition handled is "base minus a small multiset of removed cards";
 * that multiset is encoded as a number (4 bits per rank) so lookups are cheap.
 * `depth` = how many extra player draws trigger an exact recomputation of the
 * dealer distribution (Infinity = fully exact). Deeper draws reuse the parent's
 * dealer distribution; the error is <0.001 per hand for 2+ decks (see tests).
 */
const W = [0, 1, 16, 256, 4096, 65536, 1048576, 16777216, 268435456, 4294967296, 68719476736];
export class EVContext {
  constructor(base, up, rules, depth = 2) {
    this.base = base.slice(); this.up = up; this.rules = rules; this.depth = depth;
    this.dmemo = new Map(); this.hmemo = new Map();
  }
  /**
   * Probability that the player's NEXT card is rank r. Under a peeked A/10 the
   * unseen hole card is known not to complete a blackjack, so it is "missing"
   * from the shoe as a non-excluded rank: P(excl) = c_ex/(N-1) and every other
   * rank is scaled by (N-c_ex-1)/(N-c_ex). (Without this, 11 vs A doubles are
   * underrated by ~1.7% of a bet in single deck.)
   */
  probs(c) {
    const n = sum(c), p = new Array(11).fill(0);
    const ex = this.up === 1 ? 10 : this.up === 10 ? 1 : 0;
    if (!ex || n < 2) { for (let r = 1; r <= 10; r++) p[r] = c[r] / n; return p; }
    const ce = c[ex], f = (n - ce - 1) / (n - ce);
    for (let r = 1; r <= 10; r++) p[r] = r === ex ? ce / (n - 1) : (c[r] / (n - 1)) * f;
    return p;
  }
  dealerFor(c, key) {
    let d = this.dmemo.get(key);
    if (!d) { d = dealerDist(c, this.up, this.rules.h17, true); this.dmemo.set(key, d); }
    return d;
  }
  /** Public helpers take an explicit composition; key derived from it. */
  keyOf(c) { let k = 0; for (let r = 1; r <= 10; r++) k += (this.base[r] - c[r]) * W[r]; return k; }
  stand(hard, ace, c) { return standEV(handTotal(hard, ace).total, this.dealerFor(c, this.keyOf(c))); }
  hit(hard, ace, c) { const k = this.keyOf(c); return this._hit(hard, ace, c, k, 0, k); }
  double(hard, ace, c) {
    const k = this.keyOf(c), P = this.probs(c); let ev = 0;
    for (let r = 1; r <= 10; r++) {
      if (!c[r]) continue;
      const p = P[r]; c[r]--;
      const kk = k + W[r];
      const d = this.depth >= 1 ? this.dealerFor(c, kk) : this.dealerFor(c, k);
      ev += p * standEV(handTotal(hard + r, ace || r === 1).total, d);
      c[r]++;
    }
    return 2 * ev;
  }
  hitOrStand(hard, ace, c) { const k = this.keyOf(c); return this._hos(hard, ace, c, k, 0, k); }
  // dk = key of the composition whose dealer distribution applies.
  _hos(hard, ace, c, k, drawn, dk) {
    const { total } = handTotal(hard, ace);
    if (total > 21) return -1;
    const s = standEV(total, this.dealerFor(c, dk));
    if (total === 21) return s;
    return Math.max(s, this._hit(hard, ace, c, k, drawn, dk));
  }
  _hit(hard, ace, c, k, drawn, dk) {
    const mk = k * 64 + hard * 2 + (ace ? 1 : 0) + dk * 1e-9; // dk only matters past depth
    const memoKey = drawn < this.depth ? k * 64 + hard * 2 + (ace ? 1 : 0) : mk + '|' + dk;
    const m = this.hmemo.get(memoKey); if (m !== undefined) return m;
    const P = this.probs(c); let ev = 0;
    for (let r = 1; r <= 10; r++) {
      if (!c[r]) continue;
      const p = P[r]; c[r]--;
      const kk = k + W[r];
      const ndk = drawn + 1 <= this.depth ? kk : dk;
      ev += p * this._hos(hard + r, ace || r === 1, c, kk, drawn + 1, ndk);
      c[r]++;
    }
    this.hmemo.set(memoKey, ev); return ev;
  }
}

/** Double-down eligibility by rule ("any" | "9-11" | "10-11") on a hard/soft total. */
export function canDoubleTotal(rules, hard, ace) {
  const { total, soft } = handTotal(hard, ace);
  if (rules.doubleOn === 'any') return true;
  // Restricted doubling applies to hard totals (soft 19-21 never qualify as 9-11).
  const t = soft ? total : hard;
  if (rules.doubleOn === '9-11') return !soft && t >= 9 && t <= 11;
  if (rules.doubleOn === '10-11') return !soft && t >= 10 && t <= 11;
  return true;
}

/**
 * EV of splitting a pair of rank r, composition c = unseen cards AFTER removing
 * both pair cards and the upcard. Returns sum of EVs over all resulting hands.
 */
export function splitEV(ctx, r, c, rules) {
  const isAce = r === 1;
  const maxHands = isAce && !rules.resplitAces ? 2 : rules.maxSplitHands;
  if (maxHands < 2) return -Infinity;
  // Value of a post-split 2-card hand [r, x], with composition minus x.
  const postSplit = (x) => {
    c[x]--;
    const hard = r + x, ace = isAce || x === 1;
    let v;
    if (isAce && !rules.hitSplitAces) {
      v = ctx.stand(hard, ace, c);           // split aces get one card; A+10 is 21, NOT blackjack
    } else {
      v = ctx.hitOrStand(hard, ace, c);
      if (rules.das && canDoubleTotal(rules, hard, ace) && !(isAce && !rules.hitSplitAces)) v = Math.max(v, ctx.double(hard, ace, c));
    }
    c[x]++;
    return v;
  };
  const P = ctx.probs(c), p = P[r];
  let Ex = 0;
  for (let x = 1; x <= 10; x++) if (x !== r && c[x]) Ex += P[x] * postSplit(x);
  Ex = p < 1 ? Ex / (1 - p) : 0;
  const Epp = c[r] ? postSplit(r) : 0; // pair drawn but not (re)split
  // Markov chain: f(u,h) = EV of u hands waiting for a second card, h hands total.
  const solve = (M) => {
    const memo = new Map();
    const f = (u, h) => {
      if (u === 0) return 0;
      const k = u * 10 + h; if (memo.has(k)) return memo.get(k);
      let v = (1 - p) * (Ex + f(u - 1, h));
      v += p * (h < M ? f(u + 1, h + 1) : Epp + f(u - 1, h));
      memo.set(k, v); return v;
    };
    return f(2, 2);
  };
  // rules.resplitPolicy 'always' reproduces published tables (resplit whenever
  // allowed); default 'best' lets the player stop resplitting when it hurts.
  if (rules.resplitPolicy === 'always') return solve(maxHands);
  let best = -Infinity;
  for (let M = 2; M <= maxHands; M++) best = Math.max(best, solve(M));
  return best;
}

/**
 * Full action EVs for a live or hypothetical hand.
 *  cards: player's cards (ranks); up: dealer upcard; unseen: composition the
 *  draws come from (must already EXCLUDE the player's cards and the upcard).
 *  opts: { canDouble, canSplit, canSurrender, splitHand, ctx }
 * Returns { stand, hit, double?, split?, surrender? } (EV per original bet).
 */
export function actionEVs(cards, up, unseen, rules, opts = {}) {
  const ctx = opts.ctx || new EVContext(unseen, up, rules);
  const c = unseen.slice();
  let hard = 0, ace = false;
  for (const r of cards) { hard += r; if (r === 1) ace = true; }
  const res = {};
  res.stand = ctx.stand(hard, ace, c);
  res.hit = hard >= 21 ? -1 : ctx.hit(hard, ace, c); // soft 21 may legally be hit
  if (opts.canDouble) res.double = ctx.double(hard, ace, c);
  if (opts.canSplit && cards.length === 2 && cards[0] === cards[1]) {
    res.split = splitEV(ctx, cards[0], c, rules);
  }
  if (opts.canSurrender) res.surrender = -0.5;
  return res;
}

export function bestOf(evs) {
  let b = null, v = -Infinity;
  for (const k of ['stand', 'hit', 'double', 'split', 'surrender']) {
    if (evs[k] !== undefined && evs[k] > v + 1e-12) { v = evs[k]; b = k; }
  }
  return { action: b, ev: v };
}
