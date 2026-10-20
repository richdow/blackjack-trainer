// Worker integration tests against `wrangler dev` (local workerd + SQLite Durable Objects).
// Run:  cd worker && npx wrangler dev --port 8797 --var ALLOWED_ORIGINS:http://127.0.0.1:8768 --var ALLOW_TEST_IP:1
//       API=http://127.0.0.1:8797 node --test test/worker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { cleanChat, cleanNick } from '../worker/src/text.js';

const API = process.env.API || 'http://127.0.0.1:8797';
const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:8768';
let ipn = 0; const ip = () => `10.1.${Math.floor(Math.random() * 250)}.${++ipn}`;
async function create(body = {}, origin = ORIGIN) {
  const r = await fetch(API + '/v1/tables', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Test-IP': ip() }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
/** A test client that records every message and can wait for a predicate. */
function client(code, hello, origin = ORIGIN) {
  const ws = new WebSocket(API.replace('http', 'ws') + `/v1/tables/${code}/ws`, { headers: { Origin: origin } });
  const c = { ws, msgs: [], state: null, you: null, welcome: null, waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)); c.msgs.push(m);
    if (m.t === 'state') { c.state = m.s; c.you = m.you; c.dk = m.dk; }
    if (m.t === 'welcome') c.welcome = m;
    for (const w of [...c.waiters]) if (w.pred(m, c)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.res(m); }
  });
  c.opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); ws.on('unexpected-response', (_, r) => rej(new Error('http ' + r.statusCode))); });
  c.closed = new Promise((res) => ws.on('close', (code) => res(code)));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = (pred, ms = 8000) => new Promise((res, rej) => { const where = new Error().stack.split('\n')[2];
    const hit = c.msgs.find((m) => pred(m, c)); if (hit && pred.allowPast) return res(hit);
    const w = { pred, res }; c.waiters.push(w); setTimeout(() => rej(new Error('timeout waiting at ' + where + ' last=' + JSON.stringify(c.msgs.slice(-3)).slice(0, 1500))), ms);
  });
  if (hello) c.opened.then(() => c.send({ t: 'hello', ...hello }));
  return c;
}
const isState = (f) => (m, c) => m.t === 'state' && f(m.s, c, m);

test('health, CORS and origin restriction', async () => {
  const h = await fetch(API + '/v1/health'); assert.equal(h.status, 200);
  const pre = await fetch(API + '/v1/tables', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  const evil = await create({}, 'https://evil.example');
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const bad = client('ABCDEF', null, 'https://evil.example');
  await assert.rejects(bad.opened);
});

test('create validates PIN, returns a short code', async () => {
  assert.equal((await create({ pin: '12' })).status, 400);
  const r = await create({ name: 'Test <b>', pin: '4821', rules: { decks: 2, h17: false } });
  assert.equal(r.status, 200); assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{6}$/);
});

test('two clients: join with PIN, seats, bets, server deals, actions broadcast, chat', async () => {
  const { body: { code } } = await create({ name: 'Two', pin: '4821', rules: { decks: 6 } });
  const wrong = client(code, { nick: 'Mallory', pin: '0000' });
  await wrong.wait((m) => m.t === 'err' && m.code === 'bad_pin');
  assert.equal(await wrong.closed, 4401);
  const a = client(code, { nick: 'Rich', pin: '4821' });
  await a.wait(isState((s, c) => c.you >= 0));
  const b = client(code, { nick: 'Sam<script>', pin: '4821' });
  await b.wait(isState((s, c) => c.you >= 0));
  assert.notEqual(a.you, b.you);
  await a.wait(isState((s) => s.seats.filter(Boolean).length === 2));
  assert.equal(b.state.seats[b.you].name, 'Samscript', 'nickname sanitised');
  assert.ok(a.welcome.table.host); assert.ok(!b.welcome.table.host);
  // Hole card is never sent to clients; shoe order never leaves the server.
  a.send({ t: 'bet', amount: 25 }); b.send({ t: 'bet', amount: 50 });
  await a.wait(isState((s) => s.seats[b.you] && s.seats[b.you].bet === 50));
  b.send({ t: 'bet', amount: 999999 });
  await b.wait((m) => m.t === 'err' && m.code === 'bad_amount');
  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  const dealt = await a.wait(isState((s) => s.phase !== 'betting'));
  assert.ok(dealt.s.dealer.cards.length === 2);
  assert.equal(dealt.s.dealer.cards[1].r === undefined || dealt.s.dealer.revealed, true, 'hole card hidden until revealed');
  assert.equal(JSON.stringify(dealt.s).includes('"cards":[{"r"') && dealt.s.shoe.cards, undefined);
  // Out-of-turn actions are rejected by the server engine.
  const s0 = a.state;
  if (s0.phase === 'insurance') { a.send({ t: 'ins', take: false }); b.send({ t: 'ins', take: false }); await a.wait(isState((s) => s.phase !== 'insurance')); }
  if (a.state.phase === 'playing') {
    const turnSeat = a.state.turn.seat; const [mover, other] = turnSeat === a.you ? [a, b] : [b, a];
    other.send({ t: 'act', a: 'stand' });
    await other.wait((m) => m.t === 'err' && m.code === 'illegal');
    mover.send({ t: 'act', a: 'stand' });
    await other.wait(isState((s, c, m) => m.ev && m.ev.t === 'act' && m.ev.a === 'stand'));
    // play out: stand whenever it's your turn
    const auto = (c) => c.ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'state' && m.s.phase === 'playing' && m.s.turn && m.s.turn.seat === m.you) c.send({ t: 'act', a: 'stand' }); });
    auto(a); auto(b);
    if (a.state.phase === 'playing' && a.state.turn) { const cur = a.state.turn.seat === a.you ? a : b; cur.send({ t: 'act', a: 'stand' }); }
  }
  const settled = await a.wait(isState((s) => s.phase === 'settled'), 15000);
  assert.ok(settled.s.dealer.revealed);
  for (const i of [a.you, b.you]) assert.ok(settled.s.seats[i].hands[0].result);
  // Chat: delivered to both, HTML neutralised, rate limited, length limited.
  a.send({ t: 'chat', text: 'nice hand <img src=x onerror=alert(1)>' });
  const got = await b.wait((m) => m.t === 'chat' && m.from === 'Rich');
  assert.ok(!got.text.includes('<')); assert.ok(got.text.startsWith('nice hand'));
  a.send({ t: 'chat', text: 'x'.repeat(201) });
  await a.wait((m) => m.t === 'err' && m.code === 'too_long');
  for (let i = 0; i < 6; i++) a.send({ t: 'chat', text: 'spam ' + i });
  await a.wait((m) => m.t === 'err' && m.code === 'rate');
  // Next round starts automatically after settling.
  await a.wait(isState((s) => s.phase === 'betting'), 12000);
  a.ws.close(); b.ws.close();
});

test('reconnect resumes the same seat with the issued secret', async () => {
  const { body: { code } } = await create({ name: 'Reconnect' });
  const a = client(code, { nick: 'Rich' });
  await a.wait(isState((s, c) => c.you >= 0));
  const seat = a.you, { pid, secret } = a.welcome;
  a.send({ t: 'bet', amount: 30 });
  await a.wait(isState((s, c) => s.seats[c.you].bet === 30));
  a.ws.terminate();
  await new Promise((r) => setTimeout(r, 300));
  const a2 = client(code, { nick: 'Ignored', pid, secret });
  await a2.wait(isState((s, c) => c.you >= 0));
  assert.equal(a2.you, seat); assert.equal(a2.welcome.pid, pid);
  assert.equal(a2.state.seats[seat].name, 'Rich');
  assert.equal(a2.state.seats[seat].bet, 30, 'bet survives reconnect');
  // A forged secret is treated as a new player.
  const f = client(code, { nick: 'Eve', pid, secret: 'x'.repeat(32) });
  await f.wait(isState((s, c) => c.you >= 0));
  assert.notEqual(f.welcome.pid, pid);
  a2.ws.close(); f.ws.close();
});

test('turn timer auto-stands an idle player (server-authoritative timers)', { timeout: 60000 }, async () => {
  const { body: { code } } = await create({ name: 'Timer' });
  const a = client(code, { nick: 'Idle' });
  await a.wait(isState((s, c) => c.you >= 0));
  a.send({ t: 'bet', amount: 10 }); a.send({ t: 'ready' });
  await a.wait(isState((s) => s.phase !== 'betting'));
  if (a.state.phase === 'insurance') a.send({ t: 'ins', take: false });
  if (a.state.phase !== 'settled') {
    const m = await a.wait((m) => m.t === 'state' && m.ev && m.ev.auto, 40000);
    assert.equal(m.ev.a, 'stand');
  }
  a.ws.close();
});

test('unknown table code reports not_found', async () => {
  const c = client('ZZZZZZ', { nick: 'x' });
  await c.wait((m) => m.t === 'err' && m.code === 'not_found');
});

test('chat/nick sanitisers', () => {
  assert.equal(cleanChat('  hi\u0000\u202e there  '), 'hi there');
  assert.equal(cleanChat('<b>x</b>'), '‹b›x‹/b›');
  assert.match(cleanChat('what the fuck'), /f\*\*\*/);
  assert.equal(cleanChat('a'.repeat(300)).length, 200);
  assert.equal(cleanNick('  Rich "<x>"  '), 'Rich x');
});

test('last player leaving deletes the table', async () => {
  const { body: { code } } = await create({ name: 'Bye' });
  const a = client(code, { nick: 'Solo' });
  await a.wait(isState((s, c) => c.you >= 0));
  a.send({ t: 'leave' });
  await a.closed;
  await new Promise((r) => setTimeout(r, 300));
  const b = client(code, { nick: 'Late' });
  await b.wait((m) => m.t === 'err' && m.code === 'not_found');
});
