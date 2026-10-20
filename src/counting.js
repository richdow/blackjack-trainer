/* ==========================================================================
 * COUNTING ENGINE (Hi-Lo)  (no DOM)
 *   2-6 = +1, 7-9 = 0, 10/J/Q/K/A = -1. A full deck sums to 0.
 *   Running count (RC): sum of tags of every card SEEN since the shuffle.
 *   True count (TC) = RC / decks remaining. Players estimate decks remaining
 *   from the discard tray to the nearest half deck, which is what we show too.
 * ======================================================================== */
export const hiLo = (rank) => (rank >= 2 && rank <= 6 ? 1 : rank >= 7 && rank <= 9 ? 0 : -1); // rank 1..13

/** Decks remaining, rounded to the nearest half deck (min 0.5), like reading a discard tray. */
export function decksRemainingEstimate(cardsLeft) { return Math.max(0.5, Math.round((cardsLeft / 52) * 2) / 2); }
/** TC floored to an integer (floor(tc) >= index  <=>  tc >= index for integer indices). */
export function trueCount(rc, cardsLeft) { return Math.floor(rc / decksRemainingEstimate(cardsLeft)); }
export function trueCountExact(rc, cardsLeft) { return rc / Math.max(0.25, cardsLeft / 52); }

/**
 * Tracks the count from successive public table views. Cards are identified
 * by their unique deal id, so re-rendering the same state never double counts
 * and the hole card is counted only once it is turned over.
 */
export class CountTracker {
  constructor() { this.reset(); }
  reset() { this.rc = 0; this.seen = new Set(); this.shuffles = -1; this.seenRanks = new Array(14).fill(0); this.cardsSeen = 0; }
  update(view) {
    if (view.shuffles !== this.shuffles) {
      // New shoe: start over, but keep cards from the current round if it was dealt from the new shoe.
      this.reset(); this.shuffles = view.shuffles;
    }
    const all = [];
    for (const s of view.seats) if (s) for (const h of s.hands) all.push(...h.cards);
    all.push(...view.dealer.cards);
    for (const c of all) {
      if (!c || c.down || !c.r || this.seen.has(c.id)) continue;
      this.seen.add(c.id); this.rc += hiLo(c.r); this.seenRanks[c.r]++; this.cardsSeen++;
    }
    return this.rc;
  }
  /** Unseen-card composition (rank 1..10 counts) from the player's point of view. */
  unseen(decks) {
    const c = new Array(11).fill(0);
    for (let r = 1; r <= 9; r++) c[r] = 4 * decks - this.seenRanks[r];
    c[10] = 16 * decks - (this.seenRanks[10] + this.seenRanks[11] + this.seenRanks[12] + this.seenRanks[13]);
    for (let r = 1; r <= 10; r++) if (c[r] < 0) c[r] = 0;
    return c;
  }
}

/**
 * Bet ramp in betting units (1 unit = table minimum). A common, moderate Hi-Lo
 * ramp: 1 unit at TC <= +1 ("bet the minimum or step out when it's negative"),
 * then roughly (TC - 1) x 2 units for shoes, capped at 8 units (1-8 spread)
 * for 4-6 decks; a tighter 1-4 spread for 1-2 decks where TC swings faster.
 */
export function betUnits(tc, decks) {
  const cap = decks <= 2 ? 4 : 8;
  if (tc <= 1) return 1;
  return Math.min(cap, decks <= 2 ? tc : (tc - 1) * 2);
}
export function betAdvice(tc, decks, minBet) {
  const u = betUnits(tc, decks);
  let note = tc <= -2 ? 'Negative shoe: minimum bet (a real counter might leave the table here).' : tc <= 1 ? 'No edge yet: bet the minimum.' : `Player edge ≈ ${edgeAtTc(tc, 0.5) >= 0 ? '+' : ''}${edgeAtTc(tc, 0.5).toFixed(1)}% (rule of thumb: ~0.5% house edge, +0.5% per true count): raise to ${u} units.`;
  return { units: u, amount: u * minBet, note };
}
/** Rule of thumb: each +1 TC is worth about +0.5% to the player (Hi-Lo). */
export const edgeAtTc = (tc, baseEdgePct) => -baseEdgePct + 0.5 * tc;
