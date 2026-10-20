/* ==========================================================================
 * TABLE DRIVERS
 * Both drivers expose the same interface to the UI, so the UI never knows
 * (or cares) whether the engine runs in this tab or on the server:
 *   view (public view), mySeat, onChange(cb), bet(n), deal(), act(a),
 *   insurance(take), next(), sit(i), leave(), chat(text), close()
 * LocalDriver: runs src/engine.js here, with AI seats.
 * NetDriver:   talks to the Cloudflare Durable Object, which runs the SAME
 *              src/engine.js server-side (authoritative, anti-cheat).
 * ======================================================================== */
import * as G from './engine.js';
import { CountTracker, trueCount, betAdvice } from './counting.js';
import { chartAction, countAction } from './strategy.js';

/** Crypto-quality RNG in [0,1) (rejection-free 32-bit). */
export function cryptoRng() {
  const buf = new Uint32Array(1);
  return () => { crypto.getRandomValues(buf); return buf[0] / 4294967296; };
}

/* AI personas: same engine, same rules, different decision policies. */
export const PERSONAS = {
  basic: { name: 'Bea', label: 'basic strategy, flat bets' },
  counter: { name: 'Carl', label: 'counts Hi-Lo, spreads 1-8, uses I18' },
  hunch: { name: 'Hank', label: 'plays hunches (common mistakes)' },
  basic2: { name: 'Dee', label: 'basic strategy, flat bets' },
  counter2: { name: 'Ezra', label: 'counts Hi-Lo, spreads 1-8' },
  hunch2: { name: 'Fran', label: 'never busts (stands on 12+)' },
};
const AI_ORDER = ['basic', 'counter', 'hunch', 'basic2', 'counter2', 'hunch2'];

export class LocalDriver {
  constructor({ rules, aiCount = 2, mySeat = 3, bankroll = 1000, getChart, speed = 1 }) {
    this.rng = cryptoRng();
    this.st = G.newTable(rules, this.rng);
    this.mySeat = mySeat; this.listeners = []; this.getChart = getChart; this.speed = speed;
    this.online = false; this.tracker = new CountTracker();
    G.sit(this.st, mySeat, { id: 'me', name: 'You', bankroll });
    const free = [0, 1, 2, 4, 5, 6, 3].filter((i) => i !== mySeat);
    // Spread AI seats around the table.
    const pick = [[], [1], [1, 5], [0, 2, 5], [0, 1, 5, 6], [0, 1, 2, 5, 6], [0, 1, 2, 4, 5, 6]][Math.min(6, aiCount)];
    let k = 0;
    for (const i of pick) {
      const seat = i === mySeat ? free.find((f) => !this.st.seats[f] && f !== mySeat) : i;
      if (seat === undefined || this.st.seats[seat]) continue;
      const p = AI_ORDER[k++ % AI_ORDER.length];
      G.sit(this.st, seat, { id: 'ai' + seat, name: PERSONAS[p].name, ai: p, bankroll: 5000 });
    }
    this.timer = null;
  }
  get view() { return G.publicView(this.st); }
  onChange(cb) { this.listeners.push(cb); }
  emit(ev) { const v = this.view; this.tracker.update(v); for (const cb of this.listeners) cb(v, ev); }
  bet(amount) { return G.placeBet(this.st, this.mySeat, amount); }
  setRules(r) { G.setRules(this.st, r); this.emit({ t: 'rules' }); }
  shuffleNow() { G.requestShuffle(this.st); this.emit({ t: 'rules' }); }
  refill(amount = 1000) { const s = this.st.seats[this.mySeat]; if (s && this.st.phase === 'betting') { s.bankroll = Math.max(s.bankroll, amount); this.emit({ t: 'refill' }); } }
  aiBets() {
    for (let i = 0; i < 7; i++) {
      const s = this.st.seats[i]; if (!s || !s.ai) continue;
      const min = this.st.rules.minBet;
      let amt = min * 2;
      if (s.ai.startsWith('counter')) {
        const tc = trueCount(this.tracker.rc, this.st.shoe.cards ? this.st.shoe.cards.length - this.st.shoe.pos : 312);
        amt = Math.min(this.st.rules.maxBet, betAdvice(tc, this.st.rules.decks, min).amount);
      }
      if (s.bankroll < amt) s.bankroll += 5000; // AI rebuys so the table stays full
      G.placeBet(this.st, i, amt);
    }
  }
  deal() {
    if (this.st.phase !== 'betting') return false;
    this.aiBets();
    if (this.st.cutCardOut) this.tracker.reset();
    const ok = G.deal(this.st, this.rng);
    if (!ok) return false;
    this.emit({ t: 'deal' });
    this.schedule();
    return true;
  }
  insurance(take) { const r = G.insurance(this.st, this.mySeat, take, this.rng); this.emit({ t: 'ins' }); this.schedule(); return r; }
  act(a) { const r = G.act(this.st, this.mySeat, a, this.rng); if (r) { this.emit({ t: 'act', a }); this.schedule(); } return r; }
  next() { const r = G.nextRound(this.st); this.emit({ t: 'next' }); return r; }
  /** Let AI seats take their turns (and insurance decisions) with a human-like pause. */
  schedule(delay) {
    clearTimeout(this.timer);
    const st = this.st;
    const wait = delay ?? (this.uiWait ? this.uiWait() : 0) + 650 * this.speed;
    if (st.phase === 'insurance') {
      const pend = G.insurancePending(st).filter((i) => st.seats[i].ai);
      if (pend.length) this.timer = setTimeout(() => { for (const i of pend) G.insurance(st, i, this.aiInsure(i), this.rng); this.emit({ t: 'ai' }); this.schedule(); }, wait);
      return;
    }
    if (st.phase === 'playing' && st.turn && st.seats[st.turn.seat].ai) {
      this.timer = setTimeout(() => {
        const seat = st.turn.seat, a = this.aiDecide(seat);
        if (!G.act(st, seat, a, this.rng)) G.act(st, seat, 'stand', this.rng);
        this.emit({ t: 'ai', seat, a }); this.schedule();
      }, wait);
    }
  }
  aiInsure(i) {
    const p = this.st.seats[i].ai;
    if (!p.startsWith('counter')) return false;
    return trueCount(this.tracker.rc, this.st.shoe.cards.length - this.st.shoe.pos) >= 3;
  }
  aiDecide(seat) {
    const s = this.st.seats[seat], hand = s.hands[this.st.turn.hand];
    const legal = G.legalActions(this.st, seat);
    const up = G.cardValue(this.st.dealer.cards[0]);
    const chart = this.getChart();
    if (s.ai.startsWith('hunch')) {
      const v = G.handValue(hand.cards);
      if (s.ai === 'hunch2') return v.total >= 12 ? 'stand' : 'hit';
      // Classic leaks: never double soft hands, stand on 16 vs anything, split 10s for fun sometimes.
      if (v.total >= 16 || (v.total >= 13 && up <= 6)) return 'stand';
      if (!chart) return 'hit';
      const a = chartAction(chart, hand.cards, up, legal);
      return a === 'double' && v.soft ? 'hit' : a;
    }
    if (!chart) return G.handValue(hand.cards).total >= 17 ? 'stand' : 'hit';
    if (s.ai.startsWith('counter')) {
      const tc = trueCount(this.tracker.rc, this.st.shoe.cards.length - this.st.shoe.pos);
      return countAction(chart, hand.cards, up, legal, tc, this.st.rules).action;
    }
    return chartAction(chart, hand.cards, up, legal);
  }
  sit() {} leave() {} chat() { return false; }
  close() { clearTimeout(this.timer); this.listeners = []; }
}

/* ------------------------------- network ------------------------------- */
export const API_BASE = (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && location.search.includes('api='))
  ? decodeURIComponent(location.search.match(/api=([^&]+)/)[1])
  : 'https://blackjack-tables.dowdyrichard.workers.dev';

export async function createTable({ name, pin, rules, nick }) {
  const r = await fetch(API_BASE + '/v1/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin, rules, nick }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'create_failed');
  return j; // {code}
}

/**
 * NetDriver: reconnects with exponential backoff and resumes the same seat
 * using the per-table secret the server issued on first join.
 */
export class NetDriver {
  constructor({ code, pin, nick }) {
    this.code = code; this.pin = pin || ''; this.nick = nick; this.online = true;
    this.listeners = []; this.chatListeners = []; this.statusListeners = [];
    this.v = null; this.mySeat = -1; this.closed = false; this.tries = 0; this.status = 'connecting';
    this.tracker = new CountTracker(); this.offset = 0;
    const saved = JSON.parse(localStorage.getItem('bjt.net.' + code) || 'null');
    this.pid = saved && saved.pid; this.secret = saved && saved.secret;
    this.connect();
  }
  get view() { return this.v; }
  onChange(cb) { this.listeners.push(cb); }
  onChat(cb) { this.chatListeners.push(cb); }
  onStatus(cb) { this.statusListeners.push(cb); }
  setStatus(s, info) { this.status = s; for (const cb of this.statusListeners) cb(s, info); }
  connect() {
    if (this.closed) return;
    const url = API_BASE.replace(/^http/, 'ws') + '/v1/tables/' + encodeURIComponent(this.code) + '/ws';
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return this.retry(); }
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; ws.send(JSON.stringify({ t: 'hello', nick: this.nick, pin: this.pin, pid: this.pid, secret: this.secret })); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.t === 'welcome') {
        this.pid = m.pid; this.secret = m.secret; this.table = m.table;
        localStorage.setItem('bjt.net.' + this.code, JSON.stringify({ pid: m.pid, secret: m.secret, nick: this.nick, at: Date.now() }));
        this.setStatus('online', m);
        for (const c of m.chat || []) for (const cb of this.chatListeners) cb(c);
      } else if (m.t === 'state') {
        this.offset = m.now - Date.now();
        this.v = m.s; this.mySeat = m.you; this.deadline = m.deadline ? m.deadline - this.offset : null; this.deadlineKind = m.dk;
        this.tracker.update(this.v);
        for (const cb of this.listeners) cb(this.v, m.ev || {});
      } else if (m.t === 'chat') { for (const cb of this.chatListeners) cb(m); }
      else if (m.t === 'err') {
        if (['bad_pin', 'locked', 'not_found', 'full', 'bad_nick'].includes(m.code)) { this.closed = true; this.setStatus('error', m); ws.close(); }
        else this.setStatus(this.status, m);
      }
    };
    ws.onclose = () => { if (!this.closed) { this.setStatus('reconnecting'); this.retry(); } };
    ws.onerror = () => {};
  }
  retry() { if (this.closed) return; const d = Math.min(15000, 500 * 2 ** this.tries++); setTimeout(() => this.connect(), d); }
  send(o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; }
  bet(amount) { return this.send({ t: 'bet', amount }); }
  deal() { return this.send({ t: 'ready' }); }
  act(a) { return this.send({ t: 'act', a }); }
  insurance(take) { return this.send({ t: 'ins', take }); }
  next() { return true; } // server advances rounds itself
  sit(seat) { return this.send({ t: 'sit', seat }); }
  leave() { this.send({ t: 'leave' }); this.close(); localStorage.removeItem('bjt.net.' + this.code); }
  chat(text) { return this.send({ t: 'chat', text }); }
  setRules(r) { return this.send({ t: 'rules', rules: r }); }
  rebuy() { return this.send({ t: 'rebuy' }); }
  close() { this.closed = true; try { this.ws && this.ws.close(); } catch (_) {} this.listeners = []; this.chatListeners = []; this.statusListeners = []; }
}
