/* ==========================================================================
 * blackjack-tables: Cloudflare Worker + Durable Objects (WebSocket Hibernation)
 * --------------------------------------------------------------------------
 * One Durable Object per table runs the SAME engine as the browser
 * (../../src/engine.js), so the server deals from its own crypto-shuffled
 * shoe and validates every bet and action: editing the client can't cheat.
 *
 * Routes (CORS/Origin restricted to ALLOWED_ORIGINS):
 *   GET  /v1/health
 *   POST /v1/tables                {name?, pin?, rules?, nick?}  -> {code}
 *   GET  /v1/tables/:code/ws       WebSocket (first message: hello)
 * Client -> server: hello{nick,pin,pid?,secret?} sit{seat} bet{amount} ready
 *   act{a} ins{take} chat{text} rules{rules} rebuy leave ping
 * Server -> client: welcome, state{s,you,now,deadline,dk,ev}, chat, err{code}
 *
 * Free plan guard rails: <= MAX_TABLES active tables, 7 seats + 7 watchers,
 * table creation rate-limited per IP (hashed), chat rate/length limits, idle
 * tables deleted 30 min after the last player disconnects. Play money only.
 * Privacy: no console logging of chat or actions; observability disabled.
 * ======================================================================== */
import * as G from '../../src/engine.js';
import { DurableObject } from 'cloudflare:workers';

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const T = { bet: 15000, ins: 12000, turn: 25000, turnAway: 8000, settle: 5000, idle: 30 * 60000, seatAway: 120000 };
const MAX_PLAYERS = 14, START_BANK = 1000;

function rng() { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] / 4294967296; }
function randCode(n = 6) { let s = ''; for (let i = 0; i < n; i++) s += CODE_ALPHA[Math.floor(rng() * CODE_ALPHA.length)]; return s; }
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function randToken(n = 18) { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
async function sha256(s) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return b64url(new Uint8Array(d)); }
function safeEq(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

import { cleanChat, cleanNick, CTRL } from './text.js';

function allowedOrigin(req, env) {
  const o = req.headers.get('Origin');
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return o && list.includes(o) ? o : null;
}
function cors(origin) { return origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : { Vary: 'Origin' }; }
const json = (obj, status = 200, origin = null) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = allowedOrigin(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: origin ? 204 : 403, headers: cors(origin) });
    if (url.pathname === '/v1/health') return json({ ok: true, service: 'blackjack-tables' }, 200, origin);
    if (!origin) return json({ error: 'bad_origin' }, 403);
    if (url.pathname === '/v1/tables' && req.method === 'POST') {
      let body = {}; try { body = await req.json(); } catch (_) { return json({ error: 'bad_json' }, 400, origin); }
      if (body.pin && !/^\d{4,8}$/.test(String(body.pin))) return json({ error: 'bad_pin' }, 400, origin);
      const ip = (env.ALLOW_TEST_IP === '1' && req.headers.get('X-Test-IP')) || req.headers.get('CF-Connecting-IP') || 'unknown';
      const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName('dir'));
      const res = await dir.reserve(await sha256('ip:' + ip), +env.MAX_TABLES || 100);
      if (res.error) return json({ error: res.error }, 429, origin);
      const table = env.TABLE.get(env.TABLE.idFromName(res.code));
      const r = await table.init({ code: res.code, name: String(body.name || '').replace(CTRL, '').replace(/[<>]/g, '').slice(0, 24), pin: body.pin ? String(body.pin) : '', rules: G.sanitizeRules(body.rules || {}) });
      if (r.error) return json({ error: r.error }, 500, origin);
      return json({ code: res.code }, 200, origin);
    }
    const m = url.pathname.match(/^\/v1\/tables\/([A-Za-z0-9]{4,8})\/ws$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426, origin);
      const code = m[1].toUpperCase();
      return env.TABLE.get(env.TABLE.idFromName(code)).fetch(req);
    }
    return json({ error: 'not_found' }, 404, origin);
  },
};

/* ======================= Directory: table cap + creation rate ======================= */
export class Directory extends DurableObject {
  async reserve(ipHash, maxTables) {
    const now = Date.now();
    const tables = (await this.ctx.storage.get('tables')) || {};
    for (const c in tables) if (now - tables[c] > 3 * 3600e3) delete tables[c]; // stale safety net
    if (Object.keys(tables).length >= maxTables) return { error: 'too_many_tables' };
    const rl = (await this.ctx.storage.get('rl:' + ipHash)) || [];
    const recent = rl.filter((t) => now - t < 3600e3);
    if (recent.length >= 8) return { error: 'rate' };
    recent.push(now);
    let code; do code = randCode(); while (tables[code]);
    tables[code] = now;
    await this.ctx.storage.put({ tables, ['rl:' + ipHash]: recent });
    await this.ctx.storage.setAlarm(now + 3600e3);
    return { code };
  }
  async touch(code) { const t = (await this.ctx.storage.get('tables')) || {}; if (t[code] !== undefined) { t[code] = Date.now(); await this.ctx.storage.put('tables', t); } }
  async remove(code) { const t = (await this.ctx.storage.get('tables')) || {}; delete t[code]; await this.ctx.storage.put('tables', t); }
  async count() { return Object.keys((await this.ctx.storage.get('tables')) || {}).length; }
  async alarm() {
    // Drop rate-limit entries older than an hour.
    const now = Date.now();
    const all = await this.ctx.storage.list({ prefix: 'rl:' });
    for (const [k, v] of all) if (!v.some((t) => now - t < 3600e3)) await this.ctx.storage.delete(k);
    if ((await this.ctx.storage.list({ prefix: 'rl:', limit: 1 })).size) await this.ctx.storage.setAlarm(now + 3600e3);
  }
}

/* ======================= Table: one live blackjack table ======================= */
export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const [meta, st, players, chat, dl] = await Promise.all(['meta', 'st', 'players', 'chat', 'dl'].map((k) => ctx.storage.get(k)));
      this.meta = meta || null; this.st = st || null; this.players = players || {}; this.chat = chat || []; this.dl = dl || null;
    });
    this.rate = new Map(); // pid -> recent chat timestamps (memory only; resets on hibernation, which is fine)
  }
  async init({ code, name, pin, rules }) {
    if (this.meta) return { error: 'exists' };
    const salt = randToken(12);
    this.meta = { code, name: name || 'Table ' + code, salt, pinHash: pin ? await sha256(salt + ':' + pin) : null, created: Date.now(), host: null, fails: 0, lockUntil: 0, last: Date.now() };
    this.st = G.newTable(rules, rng); this.players = {}; this.chat = []; this.dl = null;
    await this.persist();
    await this.ctx.storage.setAlarm(Date.now() + T.idle);
    return { ok: true };
  }
  async persist() { await this.ctx.storage.put({ meta: this.meta, st: this.st, players: this.players, chat: this.chat, dl: this.dl }); }

  async fetch(req) {
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null });
    if (!this.meta) { server.send(JSON.stringify({ t: 'err', code: 'not_found' })); server.close(4404, 'not_found'); }
    return new Response(null, { status: 101, webSocket: client });
  }
  sockets() { return this.ctx.getWebSockets(); }
  pidOf(ws) { try { return ws.deserializeAttachment()?.pid || null; } catch (_) { return null; } }
  seatOf(pid) { return this.st.seats.findIndex((s) => s && s.id === pid); }
  connected(pid) { return this.sockets().some((w) => this.pidOf(w) === pid); }
  err(ws, code) { try { ws.send(JSON.stringify({ t: 'err', code })); } catch (_) {} }

  async webSocketMessage(ws, raw) {
    if (!this.meta) return;
    if (typeof raw !== 'string' || raw.length > 2000) return this.err(ws, 'too_long');
    let m; try { m = JSON.parse(raw); } catch (_) { return this.err(ws, 'bad_json'); }
    const pid = this.pidOf(ws);
    if (m.t === 'ping') { ws.send('{"t":"pong"}'); return; }
    if (m.t === 'hello') return this.hello(ws, m);
    if (!pid || !this.players[pid]) return this.err(ws, 'hello_first');
    const P = this.players[pid]; const seat = this.seatOf(pid); const st = this.st;
    let ev = { t: m.t, seat };
    this.meta.last = Date.now();
    switch (m.t) {
      case 'sit': {
        const i = +m.seat;
        if (seat >= 0) return this.err(ws, 'already_seated');
        if (!(i >= 0 && i < 7) || st.seats[i]) return this.err(ws, 'seat_taken');
        G.sit(st, i, { id: pid, name: P.nick, bankroll: P.bankroll ?? START_BANK });
        if (st.phase !== 'betting') st.seats[i].hands = []; // joins next round
        break;
      }
      case 'bet': {
        if (seat < 0) return this.err(ws, 'not_seated');
        const r = G.placeBet(st, seat, +m.amount || 0);
        if (r !== true) return this.err(ws, r);
        P.ready = false;
        break;
      }
      case 'ready': {
        if (seat < 0 || st.phase !== 'betting') return this.err(ws, 'bad_phase');
        if (!st.seats[seat].bet) return this.err(ws, 'no_bet');
        P.ready = true;
        break;
      }
      case 'act': {
        if (seat < 0) return this.err(ws, 'not_seated');
        if (!['hit', 'stand', 'double', 'split', 'surrender'].includes(m.a)) return this.err(ws, 'bad_action');
        if (!G.act(st, seat, m.a, rng)) return this.err(ws, 'illegal');
        ev = { t: 'act', seat, a: m.a };
        break;
      }
      case 'ins': {
        if (seat < 0 || !G.insurance(st, seat, !!m.take, rng)) return this.err(ws, 'bad_phase');
        break;
      }
      case 'chat': return this.onChat(ws, pid, P, m.text);
      case 'rules': {
        if (pid !== this.meta.host) return this.err(ws, 'not_host');
        G.setRules(st, G.sanitizeRules({ ...st.rules, ...(m.rules || {}) }));
        this.sys(`Host changed the rules; they apply at the next shuffle.`);
        break;
      }
      case 'rebuy': {
        if (seat < 0 || st.phase !== 'betting') return this.err(ws, 'bad_phase');
        const s = st.seats[seat];
        if (s.bankroll + s.bet >= st.rules.minBet) return this.err(ws, 'not_broke');
        s.bankroll = START_BANK; P.rebuys = (P.rebuys || 0) + 1;
        this.sys(`${P.nick} rebought play money.`);
        break;
      }
      case 'leave': {
        if (seat >= 0) { P.bankroll = st.seats[seat].bankroll; G.leave(st, seat, rng); }
        delete this.players[pid];
        this.sys(`${P.nick} left.`);
        ws.serializeAttachment({ pid: null });
        try { ws.close(1000, 'bye'); } catch (_) {}
        // Last player out: delete the table now instead of waiting for the idle alarm.
        if (!Object.keys(this.players).length) return this.destroy();
        await this.tick(ev);
        return;
      }
      default: return this.err(ws, 'unknown');
    }
    await this.tick(ev);
  }

  async hello(ws, m) {
    const now = Date.now(); const meta = this.meta;
    if (this.pidOf(ws)) return;
    let pid = null;
    if (m.pid && m.secret && this.players[m.pid] && safeEq(await sha256(m.secret), this.players[m.pid].secretHash)) pid = m.pid; // resume
    if (!pid) {
      if (meta.pinHash) {
        if (meta.lockUntil > now) { this.err(ws, 'locked'); return ws.close(4403, 'locked'); }
        const ok = typeof m.pin === 'string' && /^\d{4,8}$/.test(m.pin) && safeEq(await sha256(meta.salt + ':' + m.pin), meta.pinHash);
        if (!ok) {
          meta.fails = (meta.fails || 0) + 1;
          if (meta.fails >= 8) { meta.lockUntil = now + 15 * 60000; meta.fails = 0; }
          await this.persist(); this.err(ws, 'bad_pin'); return ws.close(4401, 'bad_pin');
        }
        meta.fails = 0;
      }
      const nick = cleanNick(m.nick);
      if (!nick) { this.err(ws, 'bad_nick'); return ws.close(4400, 'bad_nick'); }
      if (Object.keys(this.players).length >= MAX_PLAYERS) { this.err(ws, 'full'); return ws.close(4409, 'full'); }
      pid = randToken(12);
      const secret = randToken(24);
      this.players[pid] = { nick, secretHash: await sha256(secret), joined: now, bankroll: START_BANK };
      m.secret = secret;
      if (!meta.host) meta.host = pid;
      // Auto-sit in the first free seat, middle first.
      const free = [3, 2, 4, 1, 5, 0, 6].find((i) => !this.st.seats[i]);
      if (free !== undefined) { G.sit(this.st, free, { id: pid, name: nick, bankroll: START_BANK }); }
      this.sys(`${nick} joined.`);
    } else {
      // Close an older socket for the same player (e.g. phone woke up).
      for (const w of this.sockets()) if (w !== ws && this.pidOf(w) === pid) { w.serializeAttachment({ pid: null }); try { w.close(4000, 'replaced'); } catch (_) {} }
      this.players[pid].away = null;
    }
    ws.serializeAttachment({ pid });
    const P = this.players[pid];
    ws.send(JSON.stringify({ t: 'welcome', pid, secret: m.secret, table: { code: meta.code, name: meta.name, host: meta.host === pid, pin: !!meta.pinHash }, chat: this.chat.slice(-20) }));
    await this.tick({ t: 'join' });
  }

  sys(text) { const msg = { t: 'chat', sys: true, text, ts: Date.now() }; this.chat.push(msg); if (this.chat.length > 30) this.chat.shift(); this.broadcastRaw(msg); }
  async onChat(ws, pid, P, text) {
    const now = Date.now();
    if (typeof text !== 'string') return this.err(ws, 'bad_chat');
    if (text.length > 200) return this.err(ws, 'too_long');
    const arr = (this.rate.get(pid) || []).filter((t) => now - t < 10000);
    if (arr.length >= 5 || (arr.length && now - arr[arr.length - 1] < 600)) return this.err(ws, 'rate');
    const clean = cleanChat(text); if (!clean) return;
    arr.push(now); this.rate.set(pid, arr);
    const msg = { t: 'chat', from: P.nick, pid, text: clean, ts: now };
    this.chat.push(msg); if (this.chat.length > 30) this.chat.shift();
    this.broadcastRaw(msg);
    await this.ctx.storage.put('chat', this.chat);
  }
  broadcastRaw(obj) { const s = JSON.stringify(obj); for (const w of this.sockets()) if (this.pidOf(w)) { try { w.send(s); } catch (_) {} } }

  /** Advance automatic table flow (deal when everyone is ready, etc.), persist, broadcast, schedule alarm. */
  async tick(ev = {}) {
    const st = this.st, now = Date.now();
    // Betting: deal once every connected seated player with a bet is ready, or the bet timer expires.
    if (st.phase === 'betting') {
      const bettors = G.bettingSeats(st);
      const seatedLive = st.seats.map((s, i) => (s && this.connected(s.id) ? i : -1)).filter((i) => i >= 0);
      const allReady = bettors.length && seatedLive.length && seatedLive.every((i) => st.seats[i].bet > 0 && this.players[st.seats[i].id]?.ready);
      if (allReady) this.startRound();
      else if (bettors.length && (!this.dl || this.dl.kind !== 'bet')) this.dl = { kind: 'bet', at: now + T.bet };
      else if (!bettors.length) this.dl = null;
    }
    this.setDeadlines(now);
    await this.persist();
    this.broadcast(ev);
    await this.schedule();
  }
  startRound() {
    for (const p of Object.values(this.players)) p.ready = false;
    G.deal(this.st, rng); this.dl = null; this.turnKey = null;
  }
  setDeadlines(now) {
    const st = this.st;
    if (st.phase === 'insurance') { if (!this.dl || this.dl.kind !== 'ins') this.dl = { kind: 'ins', at: now + T.ins }; }
    else if (st.phase === 'playing' && st.turn) {
      const s = st.seats[st.turn.seat], h = s.hands[st.turn.hand];
      const key = `${st.round}:${st.turn.seat}:${st.turn.hand}:${h.cards.length}`;
      if (!this.dl || this.dl.kind !== 'turn' || this.dl.key !== key) this.dl = { kind: 'turn', key, at: now + (this.connected(s.id) ? T.turn : T.turnAway) };
    } else if (st.phase === 'settled') { if (!this.dl || this.dl.kind !== 'next') this.dl = { kind: 'next', at: now + T.settle }; }
    else if (st.phase !== 'betting') this.dl = null;
  }
  async schedule() {
    const now = Date.now();
    const idleAt = this.sockets().some((w) => this.pidOf(w)) ? now + T.idle : (this.meta.last || now) + T.idle;
    const at = Math.min(this.dl ? this.dl.at : Infinity, idleAt, this.awayCheck(now));
    await this.ctx.storage.setAlarm(Math.max(now + 50, at));
  }
  awayCheck(now) {
    let next = Infinity;
    for (const s of this.st.seats) if (s && !this.connected(s.id)) { const p = this.players[s.id]; if (p) { p.away ||= now; next = Math.min(next, p.away + T.seatAway); } }
    return next;
  }
  broadcast(ev) {
    const view = G.publicView(this.st); view.online = true; view.tableName = this.meta.name;
    for (const s of view.seats) if (s) s.away = !this.connected(s.id);
    for (const w of this.sockets()) {
      const pid = this.pidOf(w); if (!pid) continue;
      const msg = { t: 'state', s: view, you: this.seatOf(pid), now: Date.now(), deadline: this.dl ? this.dl.at : null, dk: this.dl ? this.dl.kind : null, ev, host: this.meta.host === pid };
      try { w.send(JSON.stringify(msg)); } catch (_) {}
    }
  }
  async alarm() {
    if (!this.meta) return;
    const now = Date.now(), st = this.st;
    const live = this.sockets().some((w) => this.pidOf(w));
    if (!live && now - (this.meta.last || 0) >= T.idle - 1000) return this.destroy();
    // Free seats of players gone for a while (only between rounds).
    if (st.phase === 'betting' || st.phase === 'settled') {
      st.seats.forEach((s, i) => {
        if (!s || this.connected(s.id)) return;
        const p = this.players[s.id]; if (p && p.away && now - p.away >= T.seatAway) { p.bankroll = s.bankroll; G.leave(st, i, rng); this.sys(`${p.nick}'s seat was released (disconnected).`); }
      });
    }
    let ev = { t: 'timer' };
    if (this.dl && now >= this.dl.at - 25) {
      const k = this.dl.kind; this.dl = null;
      if (k === 'bet' && st.phase === 'betting' && G.bettingSeats(st).length) { this.startRound(); ev = { t: 'deal' }; }
      else if (k === 'ins' && st.phase === 'insurance') { for (const i of G.insurancePending(st)) G.insurance(st, i, false, rng); }
      else if (k === 'turn' && st.phase === 'playing' && st.turn) { const seat = st.turn.seat; G.act(st, seat, 'stand', rng); ev = { t: 'act', seat, a: 'stand', auto: true }; }
      else if (k === 'next' && st.phase === 'settled') { G.nextRound(st); ev = { t: 'next' }; }
    }
    await this.tick(ev);
  }
  async webSocketClose(ws) {
    const pid = this.pidOf(ws); ws.serializeAttachment({ pid: null });
    if (!pid || !this.meta) return;
    if (this.players[pid] && !this.connected(pid)) { this.players[pid].away = Date.now(); this.players[pid].ready = false; }
    this.meta.last = Date.now();
    await this.tick({ t: 'away' });
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
  async destroy() {
    const code = this.meta && this.meta.code;
    for (const w of this.sockets()) { try { w.close(4410, 'closed'); } catch (_) {} }
    await this.ctx.storage.deleteAlarm(); await this.ctx.storage.deleteAll();
    this.meta = null; this.st = null; this.players = {}; this.chat = [];
    if (code) await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('dir')).remove(code);
  }
}
