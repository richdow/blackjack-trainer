/* ==========================================================================
 * RULES + GAME ENGINE  (shared verbatim by the browser and the Cloudflare
 * Worker, so single-player with AI seats and online tables behave identically)
 * --------------------------------------------------------------------------
 * The whole table is a plain JSON object (`state`) mutated only through the
 * exported functions below. No DOM, no timers, no network: the caller (local
 * driver or Durable Object) decides WHEN to call them. Randomness is injected
 * (`rng()` returns a float in [0,1)) and the Worker uses crypto randomness.
 *
 * Implemented casino procedure (US hole-card game):
 *   bets -> 1 card each seat (first base first) -> dealer upcard -> 2nd card
 *   each -> dealer hole card -> insurance if (and only if) upcard is an Ace ->
 *   dealer peeks with A or ten-value up -> players act seat by seat, hand by
 *   hand -> dealer reveals and draws (hits soft 17 if rules.h17) -> settle.
 * ======================================================================== */

/** Rule set. Every field is user-configurable; see README at top of index.html. */
export const DEFAULT_RULES = Object.freeze({
  decks: 6,            // 1..6 decks; a change takes effect at the next shuffle
  h17: true,           // dealer hits soft 17 (most US shoe games today)
  bjPays: 1.5,         // 3:2 (1.5) or 6:5 (1.2)
  doubleOn: 'any',     // 'any' two cards | '9-11' | '10-11'
  das: false,          // double after split
  maxSplitHands: 4,    // split up to 3 times = 4 hands (2..4)
  resplitAces: false,  // RSA
  hitSplitAces: false, // split aces receive exactly one card each
  surrender: 'late',   // 'late' (after peek) | 'none'
  penetration: 0.75,   // cut card position as fraction of the shoe
  minBet: 10,
  maxBet: 500,
});

export function sanitizeRules(r = {}) {
  const d = DEFAULT_RULES, o = {};
  const int = (v, lo, hi, def) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
  o.decks = int(r.decks ?? d.decks, 1, 6, d.decks);
  o.h17 = r.h17 === undefined ? d.h17 : !!r.h17;
  o.bjPays = +r.bjPays === 1.2 ? 1.2 : 1.5;
  o.doubleOn = ['any', '9-11', '10-11'].includes(r.doubleOn) ? r.doubleOn : d.doubleOn;
  o.das = r.das === undefined ? d.das : !!r.das;
  o.maxSplitHands = int(r.maxSplitHands ?? d.maxSplitHands, 2, 4, d.maxSplitHands);
  o.resplitAces = !!r.resplitAces;
  o.hitSplitAces = !!r.hitSplitAces;
  o.surrender = r.surrender === 'none' ? 'none' : 'late';
  const pen = +(r.penetration ?? d.penetration);
  o.penetration = Number.isFinite(pen) ? Math.min(0.9, Math.max(0.5, pen)) : d.penetration;
  o.minBet = int(r.minBet ?? d.minBet, 1, 1000, d.minBet);
  o.maxBet = int(r.maxBet ?? d.maxBet, o.minBet, 100000, Math.max(o.minBet, d.maxBet));
  return o;
}

/* ------------------------------ cards ---------------------------------- */
// A card is {r: 1..13 (A..K), s: 0..3 (♠♥♦♣)}. Blackjack value: A=1/11, 2-9, T/J/Q/K=10.
export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const cardValue = (c) => (c.r >= 10 ? 10 : c.r);

/** Exact shoe composition: n decks x 52 cards, 4 suits x 13 ranks each. */
export function buildShoe(decks) {
  const cards = [];
  for (let d = 0; d < decks; d++) for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) cards.push({ r, s });
  return cards;
}
/** Unbiased Fisher-Yates shuffle with an injected RNG. */
export function shuffle(cards, rng) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = cards[i]; cards[i] = cards[j]; cards[j] = t;
  }
  return cards;
}

/**
 * Hand value: aces count 11 when that doesn't bust ("soft"), else 1.
 * blackjack = exactly two cards totalling 21 on an UNSPLIT hand.
 * (A+10 after a split is a plain 21 and pays 1:1.)
 */
export function handValue(cards, fromSplit = false) {
  let hard = 0, aces = 0;
  for (const c of cards) { if (!c || c.down || !c.r) continue; /* face-down hole card isn't counted */ const v = cardValue(c); hard += v; if (v === 1) aces++; }
  const soft = aces > 0 && hard + 10 <= 21;
  const total = soft ? hard + 10 : hard;
  return { total, hard, soft, bust: total > 21, blackjack: !fromSplit && cards.length === 2 && total === 21 };
}

/* ------------------------------ table ---------------------------------- */
export const MAX_SEATS = 7;

export function newTable(rules, rng) {
  const st = {
    v: 1, rules: sanitizeRules(rules), pendingRules: null,
    seq: 0, round: 0, phase: 'betting',
    shoe: null, discards: 0, shuffles: 0, justShuffled: false, cutCardOut: false,
    seats: new Array(MAX_SEATS).fill(null),
    dealer: { cards: [], revealed: false, bj: false },
    turn: null, // {seat, hand}
    log: [],    // public action log for the current round
  };
  freshShoe(st, rng);
  return st;
}

function freshShoe(st, rng) {
  if (st.pendingRules) { st.rules = sanitizeRules({ ...st.rules, ...st.pendingRules }); st.pendingRules = null; }
  const cards = shuffle(buildShoe(st.rules.decks), rng);
  // Cut card placed at the configured penetration (±2 cards to vary it a bit, like a human dealer).
  const cut = Math.round(cards.length * st.rules.penetration) + Math.floor(rng() * 5) - 2;
  st.shoe = { cards, pos: 0, cut: Math.min(cards.length - 10, Math.max(20, cut)), decks: st.rules.decks };
  st.discards = 0; st.shuffles++; st.justShuffled = true; st.cutCardOut = false;
}

/** Change rules; deck-count/penetration changes wait for the next shuffle (as in a casino). */
export function setRules(st, rules) {
  const next = sanitizeRules({ ...st.rules, ...rules });
  st.pendingRules = next;
  if (st.phase === 'betting' && st.shoe.pos === 0) { st.rules = next; st.pendingRules = null; st.shoe.cards = null; }
  return next;
}
/** Force a shuffle before the next round (e.g. new deck count chosen "before the shoe"). */
export function requestShuffle(st) { st.cutCardOut = true; }

function draw(st, rng, hidden = false) {
  const sh = st.shoe;
  if (!sh.cards || sh.pos >= sh.cards.length) {
    // Shoe exhausted mid-round (only possible with 7 seats and many splits):
    // reshuffle every card not currently on the table, as a real dealer would.
    const onTable = [];
    for (const s of st.seats) if (s) for (const h of s.hands) onTable.push(...h.cards);
    onTable.push(...st.dealer.cards);
    const pool = buildShoe(st.rules.decks);
    for (const c of onTable) { const i = pool.findIndex((p) => p.r === c.r && p.s === c.s); if (i >= 0) pool.splice(i, 1); }
    st.shoe = { cards: shuffle(pool, rng), pos: 0, cut: pool.length, decks: st.rules.decks };
    st.discards = 0; st.shuffles++; st.justShuffled = true; st.log.push({ t: 'midshuffle' });
  }
  const c = { ...sh.cards[sh.pos++], id: ++st.seq };
  if (hidden) c.down = true;
  if (sh.pos >= sh.cut && !st.cutCardOut) { st.cutCardOut = true; st.log.push({ t: 'cutcard' }); }
  return c;
}

export function sit(st, seat, player) {
  if (seat < 0 || seat >= MAX_SEATS || st.seats[seat]) return false;
  st.seats[seat] = {
    id: player.id, name: String(player.name || 'Player').slice(0, 20), ai: player.ai || null,
    bankroll: player.bankroll ?? 1000, bet: 0, lastBet: 0, insurance: null, hands: [], net: 0, last: '',
  };
  return true;
}
/** Leave the table. Mid-round, remaining hands stand and the seat is freed at the next round. */
export function leave(st, seat, rng) {
  const s = st.seats[seat]; if (!s) return;
  if (st.phase === 'betting' || st.phase === 'settled' || !s.hands.length) {
    if (st.phase === 'betting' && s.bet) s.bankroll += s.bet;
    if (st.phase === 'settled' && s.hands.length) { s.leaving = true; return; }
    st.seats[seat] = null; return;
  }
  s.leaving = true;
  for (const h of s.hands) h.done = true;
  if (st.phase === 'insurance' && s.insurance === null) { insurance(st, seat, false, rng); return; }
  if (st.phase === 'playing' && st.turn && st.turn.seat === seat) advance(st, rng);
}

export function placeBet(st, seat, amount) {
  const s = st.seats[seat]; if (!s || st.phase !== 'betting') return 'bad_phase';
  amount = Math.round(+amount);
  if (amount === 0) { s.bankroll += s.bet; s.bet = 0; return true; }
  if (!(amount >= st.rules.minBet && amount <= st.rules.maxBet)) return 'bad_amount';
  if (amount > s.bankroll + s.bet) return 'insufficient';
  s.bankroll += s.bet; s.bet = amount; s.bankroll -= amount;
  return true;
}

const activeSeats = (st) => st.seats.map((s, i) => (s && s.hands.length ? i : -1)).filter((i) => i >= 0);
export const bettingSeats = (st) => st.seats.map((s, i) => (s && s.bet > 0 ? i : -1)).filter((i) => i >= 0);

function newHand(bet, extra = {}) {
  return { cards: [], bet, doubled: false, fromSplit: false, splitAces: false, done: false, surrendered: false, result: null, payout: 0, ...extra };
}

/** Start a round. Returns false if nobody has bet. */
export function deal(st, rng) {
  if (st.phase !== 'betting') return false;
  const seats = bettingSeats(st); if (!seats.length) return false;
  if (st.cutCardOut || !st.shoe.cards) freshShoe(st, rng); else st.justShuffled = false;
  st.round++; st.log = []; st.turn = null;
  st.dealer = { cards: [], revealed: false, bj: false };
  for (const i of seats) { const s = st.seats[i]; s.hands = [newHand(s.bet)]; s.lastBet = s.bet; s.bet = 0; s.insurance = null; s.last = ''; s.roundNet = 0; }
  for (const s of st.seats) if (s && !s.hands.length) s.last = '';
  // Two passes: each seat then dealer (upcard first pass, hole card second pass).
  for (let pass = 0; pass < 2; pass++) {
    for (const i of seats) st.seats[i].hands[0].cards.push(draw(st, rng));
    st.dealer.cards.push(draw(st, rng, pass === 1));
  }
  st.log.push({ t: 'deal' });
  const up = cardValue(st.dealer.cards[0]);
  if (up === 1) { st.phase = 'insurance'; return true; } // insurance ONLY vs an ace
  resolvePeek(st, rng);
  return true;
}

/** Insurance (or even money on a blackjack) costs half the bet and pays 2:1 if dealer has blackjack. */
export function insurance(st, seat, take, rng) {
  const s = st.seats[seat];
  if (st.phase !== 'insurance' || !s || !s.hands.length || s.insurance !== null) return false;
  const cost = s.hands[0].bet / 2;
  if (take && s.bankroll < cost) take = false;
  s.insurance = take ? cost : 0;
  if (take) s.bankroll -= cost;
  s.last = take ? 'insured' : 'no insurance';
  st.log.push({ t: 'ins', seat, take });
  if (activeSeats(st).every((i) => st.seats[i].insurance !== null)) resolvePeek(st, rng);
  return true;
}
export const insurancePending = (st) => st.phase === 'insurance' ? activeSeats(st).filter((i) => st.seats[i].insurance === null) : [];

/** Dealer peeks under an A or ten. A dealer blackjack ends the round immediately. */
function resolvePeek(st, rng) {
  const dv = handValue(st.dealer.cards.map((c) => ({ ...c, down: false })));
  const up = cardValue(st.dealer.cards[0]);
  if ((up === 1 || up === 10) && dv.total === 21) {
    st.dealer.bj = true; revealHole(st);
    st.log.push({ t: 'dealerbj' });
    settle(st); return;
  }
  for (const i of activeSeats(st)) { // lost insurance
    const s = st.seats[i];
    if (s.insurance) { s.roundNet -= s.insurance; s.insurance = 0; }
  }
  st.phase = 'playing';
  for (const i of activeSeats(st)) {
    const h = st.seats[i].hands[0];
    if (handValue(h.cards).blackjack) { h.done = true; h.bj = true; st.seats[i].last = 'Blackjack!'; }
  }
  st.turn = null; advance(st, rng);
}

function revealHole(st) { for (const c of st.dealer.cards) c.down = false; st.dealer.revealed = true; }

/** Move the turn pointer to the next undone hand, dealing 2nd cards to split hands as they come up. */
function advance(st, rng) {
  for (let i = st.turn ? st.turn.seat : 0; i < MAX_SEATS; i++) {
    const s = st.seats[i]; if (!s || !s.hands.length) continue;
    for (let h = (st.turn && st.turn.seat === i) ? st.turn.hand : 0; h < s.hands.length; h++) {
      const hand = s.hands[h];
      if (hand.done) continue;
      if (hand.cards.length === 1 && rng) { // split hand waiting for its second card
        hand.cards.push(draw(st, rng));
        if (hand.splitAces && !st.rules.hitSplitAces && !(canResplit(st, s, hand))) { hand.done = true; continue; }
      }
      if (handValue(hand.cards).total >= 21) { hand.done = true; continue; } // 21 stands automatically
      st.turn = { seat: i, hand: h };
      return;
    }
    if (st.turn) st.turn = { seat: i + 1, hand: 0 };
  }
  st.turn = null;
  dealerPlay(st, rng);
}

function canResplit(st, s, hand) {
  if (hand.cards.length !== 2 || cardValue(hand.cards[0]) !== cardValue(hand.cards[1])) return false;
  if (s.hands.length >= st.rules.maxSplitHands) return false;
  if (cardValue(hand.cards[0]) === 1 && hand.fromSplit && !st.rules.resplitAces) return false;
  return s.bankroll >= hand.bet;
}

/** Legal actions for the seat whose turn it is. */
export function legalActions(st, seat) {
  const none = { hit: false, stand: false, double: false, split: false, surrender: false };
  if (st.phase !== 'playing' || !st.turn || st.turn.seat !== seat) return none;
  const s = st.seats[seat], hand = s.hands[st.turn.hand];
  const v = handValue(hand.cards, hand.fromSplit);
  const two = hand.cards.length === 2;
  const r = st.rules;
  const doubleTotalOk = r.doubleOn === 'any' || (!v.soft && v.total >= (r.doubleOn === '9-11' ? 9 : 10) && v.total <= 11);
  const lockedAces = hand.splitAces && !r.hitSplitAces;
  return {
    hit: !lockedAces && v.total < 21,
    stand: true,
    double: two && !lockedAces && doubleTotalOk && (!hand.fromSplit || r.das) && s.bankroll >= hand.bet,
    split: two && canResplit(st, s, hand) && (!hand.splitAces || r.resplitAces),
    surrender: r.surrender === 'late' && two && s.hands.length === 1 && !hand.fromSplit && !hand.acted,
  };
}

/** Apply a player decision. Returns true if it was legal. */
export function act(st, seat, action, rng) {
  const legal = legalActions(st, seat);
  if (!legal[action]) return false;
  const s = st.seats[seat], hi = st.turn.hand, hand = s.hands[hi];
  hand.acted = true;
  st.log.push({ t: 'act', seat, hand: hi, a: action });
  switch (action) {
    case 'hit': {
      hand.cards.push(draw(st, rng));
      const v = handValue(hand.cards);
      s.last = v.bust ? 'bust' : 'hit';
      if (v.total >= 21) hand.done = true;
      break;
    }
    case 'stand': hand.done = true; s.last = 'stand'; break;
    case 'double':
      s.bankroll -= hand.bet; hand.bet *= 2; hand.doubled = true;
      hand.cards.push(draw(st, rng)); hand.done = true; s.last = 'double';
      break;
    case 'split': {
      const aces = cardValue(hand.cards[0]) === 1;
      const second = hand.cards.pop();
      s.bankroll -= hand.bet;
      hand.fromSplit = true; hand.splitAces = aces;
      const nh = newHand(hand.bet, { fromSplit: true, splitAces: aces });
      nh.cards.push(second);
      s.hands.splice(hi + 1, 0, nh);
      hand.cards.push(draw(st, rng)); // first split hand gets its second card now
      s.last = 'split';
      // Split aces get one card each (unless hitSplitAces); may resplit only if RSA.
      if (aces && !st.rules.hitSplitAces && !canResplit(st, s, hand)) hand.done = true;
      else if (handValue(hand.cards).total >= 21) hand.done = true;
      break;
    }
    case 'surrender': hand.surrendered = true; hand.done = true; s.last = 'surrender'; break;
  }
  if (hand.done) advance(st, rng);
  return true;
}

/** Dealer reveals and draws to 17 (hitting soft 17 under H17) unless no live hands remain. */
function dealerPlay(st, rng) {
  st.phase = 'dealer';
  revealHole(st);
  let live = false;
  for (const s of st.seats) if (s) for (const h of s.hands) if (!h.surrendered && !h.bj && !handValue(h.cards).bust) live = true;
  if (live && rng) {
    for (;;) {
      const v = handValue(st.dealer.cards);
      if (v.total > 21 || v.total > 17 || (v.total === 17 && !(v.soft && st.rules.h17))) break;
      st.dealer.cards.push(draw(st, rng));
    }
  }
  settle(st);
}

/**
 * Payouts (net to the player, bet already deducted when placed):
 *  blackjack: stake + bet*bjPays | win: 2x stake | push: stake back
 *  surrender: half the stake back | loss/bust: nothing | insurance: 3x insurance if dealer BJ.
 */
function settle(st) {
  const d = handValue(st.dealer.cards);
  for (const s of st.seats) {
    if (!s || !s.hands.length) continue;
    let ret = 0, staked = 0;
    for (const h of s.hands) {
      staked += h.bet;
      const v = handValue(h.cards, h.fromSplit);
      let res;
      if (st.dealer.bj) res = v.blackjack ? 'push' : 'lose';
      else if (h.surrendered) res = 'surrender';
      else if (v.blackjack) res = 'blackjack';
      else if (v.bust) res = 'bust';
      else if (d.bust || v.total > d.total) res = 'win';
      else if (v.total === d.total) res = 'push';
      else res = 'lose';
      const pay = res === 'blackjack' ? h.bet * (1 + st.rules.bjPays) : res === 'win' ? 2 * h.bet : res === 'push' ? h.bet : res === 'surrender' ? h.bet / 2 : 0;
      h.result = res; h.payout = pay; ret += pay;
    }
    if (s.insurance && st.dealer.bj) { ret += s.insurance * 3; staked += s.insurance; }
    else if (s.insurance) staked += s.insurance; // (already zeroed after peek if lost)
    s.bankroll = Math.round((s.bankroll + ret) * 100) / 100;
    const net = Math.round((ret - staked) * 100) / 100 + (s.roundNet || 0);
    s.roundNet = net; s.net = Math.round(((s.net || 0) + net) * 100) / 100;
  }
  st.phase = 'settled'; st.turn = null;
  st.log.push({ t: 'settle' });
}

/** Clear the table for the next round; discards move to the tray; reshuffle if the cut card came out. */
export function nextRound(st) {
  if (st.phase !== 'settled') return false;
  let n = st.dealer.cards.length;
  for (const s of st.seats) if (s) { for (const h of s.hands) n += h.cards.length; s.hands = []; s.insurance = null; }
  st.discards += n;
  st.dealer = { cards: [], revealed: false, bj: false };
  st.phase = 'betting'; st.turn = null; st.justShuffled = false;
  st.seats = st.seats.map((s) => (s && s.leaving ? null : s));
  return true;
}

/**
 * Public view: what a player at the table may see. The hole card is masked
 * until revealed and the undealt shoe order never leaves the engine, so a
 * client (or a curious user with dev tools) cannot peek.
 */
export function publicView(st) {
  const mask = (c) => (c.down ? { id: c.id, down: true } : c);
  return {
    v: st.v, rules: st.rules, pendingRules: st.pendingRules, round: st.round, phase: st.phase,
    shoe: { total: st.shoe.cards ? st.shoe.cards.length : st.rules.decks * 52, left: st.shoe.cards ? st.shoe.cards.length - st.shoe.pos : st.rules.decks * 52, cut: st.shoe.cut, pos: st.shoe.pos, decks: st.shoe.decks },
    discards: st.discards, shuffles: st.shuffles, justShuffled: st.justShuffled, cutCardOut: st.cutCardOut,
    seats: st.seats.map((s) => s && ({
      id: s.id, name: s.name, ai: s.ai, bankroll: s.bankroll, bet: s.bet, lastBet: s.lastBet, insurance: s.insurance, net: s.net, roundNet: s.roundNet, last: s.last,
      hands: s.hands.map((h) => ({ cards: h.cards, bet: h.bet, doubled: h.doubled, fromSplit: h.fromSplit, splitAces: h.splitAces, done: h.done, surrendered: h.surrendered, result: h.result, payout: h.payout, acted: !!h.acted })),
    })),
    dealer: { cards: st.dealer.cards.map(mask), revealed: st.dealer.revealed, bj: st.dealer.bj },
    turn: st.turn, log: st.log.slice(-30),
  };
}
