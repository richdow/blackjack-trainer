/* ==========================================================================
 * UI CONTROLLER: screens, play loop, feedback, stats, online lobby, chat.
 * Talks to the game only through a driver (drivers.js) and to teaching logic
 * only through strategy.js / counting.js, so each layer can be extended alone.
 * ======================================================================== */
import * as G from './engine.js';
import { generateChart, rulesKey, gradeDecision, gradeInsurance, chartAction, countAction, gameEV, publishedEdge, ACTION_NAMES, upRank } from './strategy.js';
import { shoeCounts } from './evcalc.js';
import { trueCount, decksRemainingEstimate, betAdvice, betUnits } from './counting.js';
import { LocalDriver, NetDriver, createTable, PERSONAS, API_BASE } from './drivers.js';
import { TableView, el, money, totalLabel } from './render.js';
import { loadSettings, saveSettings, loadStats, saveStats, recordDecision, recordHand, categoryOf, emptyStats } from './store.js';
import { lessons, chartHTML } from './learn.js';
import { DRILLS, runDrill } from './drills.js';

const $ = (s, r = document) => r.querySelector(s);
const S = loadSettings();
let stats = loadStats();
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const sign = (x) => (x > 0 ? '+' : '') + x;
const upName = (u) => (u === 1 ? 'A' : String(u));
const cardsText = (cards) => cards.map((c) => RANKS[c.r]).join(',');

/* ------------------------------ charts --------------------------------- */
const charts = new Map(), edges = new Map(), building = new Set();
if (window.__DEFAULT_CHART__) charts.set(window.__DEFAULT_CHART__.key, window.__DEFAULT_CHART__);
try { const c = JSON.parse(localStorage.getItem('bjt.chart.v1')); if (c && c.key) charts.set(c.key, c); } catch (_) {}
try { const e = JSON.parse(localStorage.getItem('bjt.edges.v1')) || {}; for (const k in e) edges.set(k, e[k]); } catch (_) {}
function chartFor(rules) {
  const key = rulesKey(rules);
  if (charts.has(key)) return charts.get(key);
  if (!building.has(key)) {
    building.add(key);
    setTimeout(async () => {
      const ch = await generateChart(rules, { yieldFn: () => new Promise((r) => setTimeout(r, 0)) });
      charts.set(key, ch); building.delete(key);
      try { localStorage.setItem('bjt.chart.v1', JSON.stringify(ch)); } catch (_) {}
      refreshAll();
    }, 30);
  }
  return null;
}
const edgeKey = (r) => rulesKey(r) + '-' + r.bjPays;
/** House edge in % for the rules (exact calculator, computed lazily and cached). */
function edgeFor(rules) {
  const k = edgeKey(rules);
  if (edges.has(k)) return edges.get(k);
  if (!building.has('e' + k)) {
    building.add('e' + k);
    setTimeout(() => {
      const e = -gameEV(rules) * 100; edges.set(k, e); building.delete('e' + k);
      try { localStorage.setItem('bjt.edges.v1', JSON.stringify(Object.fromEntries(edges))); } catch (_) {}
      refreshAll();
    }, 400);
  }
  const p = publishedEdge(rules).edge; return p; // published estimate until computed
}

/* ------------------------------ shell ---------------------------------- */
const app = $('#app');
function applyDisplay() {
  const h = document.documentElement;
  h.classList.toggle('large', !!S.largeText); h.classList.toggle('contrast', !!S.contrast); h.classList.toggle('fourcolor', !!S.fourColor);
  h.style.setProperty('--speed', S.speed);
}
applyDisplay();
const screens = {};
for (const sct of document.querySelectorAll('section.screen')) screens[sct.dataset.screen] = sct;
const tabs = [...document.querySelectorAll('nav.tabs button')];
let current = 'play'; const leaveHooks = [];
function show(name) {
  while (leaveHooks.length) leaveHooks.pop()();
  current = name;
  for (const k in screens) screens[k].classList.toggle('active', k === name);
  for (const t of tabs) t.setAttribute('aria-selected', t.dataset.go === name);
  if (name === 'learn') renderLearn(); if (name === 'stats') renderStats(); if (name === 'settings') renderSettings();
  if (name === 'drills') renderDrillList(); if (name === 'online') renderOnline();
  if (name === 'play') setTimeout(() => { if (driver && driver.view) onView(driver.view, { t: 'show' }); }, 0);
}
for (const t of tabs) t.onclick = () => show(t.dataset.go);
let toastT;
function toast(msg, ms = 2600) { const old = $('.toast'); if (old) old.remove(); const t = el('div', 'toast', msg); t.setAttribute('role', 'status'); document.body.append(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), ms); }
const overlay = $('#overlay'), sheet = $('#sheet');
function openSheet(build) { sheet.textContent = ''; build(sheet); overlay.classList.add('on'); const c = el('button', 'btn', 'Close'); c.style.marginTop = '12px'; c.style.width = '100%'; c.onclick = closeSheet; sheet.append(c); }
function closeSheet() { overlay.classList.remove('on'); }
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

/* ------------------------------ sound (off by default) ----------------- */
let actx = null;
function blip(f = 660, d = 0.04) {
  if (!S.sound) return;
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.value = 0.04; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + d); } catch (_) {}
}

/* ------------------------------ session -------------------------------- */
let session = JSON.parse(localStorage.getItem('bjt.session.v1') || 'null') || newSession();
function newSession() { return { start: Date.now(), hands: 0, net: 0, expected: 0, wagered: 0, decisions: [], ok: 0, n: 0, countChecks: 0, countOk: 0 }; }
const saveSession = () => { try { localStorage.setItem('bjt.session.v1', JSON.stringify(session)); } catch (_) {} };
function endSession() {
  if (session.hands || session.n) {
    stats.sessions.push({ start: session.start, end: Date.now(), hands: session.hands, net: session.net, expected: session.expected, acc: session.n ? session.ok / session.n : null, decisions: session.n, top: topMistakes(session.decisions, 5) });
    if (stats.sessions.length > 60) stats.sessions.shift();
    saveStats(stats);
  }
  const s = session; session = newSession(); saveSession(); return s;
}
function topMistakes(list, n) {
  return list.filter((d) => d.grade !== 'correct').sort((a, b) => b.lossMoney - a.lossMoney || b.loss - a.loss).slice(0, n)
    .map((d) => ({ sit: d.sit, chosen: d.chosen, correct: d.correct, loss: d.loss, lossMoney: d.lossMoney, tc: d.tc }));
}

/* ------------------------------ play ----------------------------------- */
const felt = $('#felt'); const actions = $('#actions');
const table = new TableView(felt); table.speed = S.speed;
let driver = null, mode = S.mode, pendingBet = 0, roundLog = [], recordedRound = -1, lastPhase = null, unread = 0, peekCount = false;
let lastFeedback = null, chatLog = [];
const isOnline = () => driver && driver.online;
function useIdx() { return S.useIndices || mode === 'count'; }
function countVisible() { return (S.showCount && mode !== 'count' && mode !== 'casino') || peekCount; }

function startLocal() {
  if (driver) driver.close();
  const aiCount = mode === 'strategy' ? 0 : S.aiCount;
  const saved = +localStorage.getItem('bjt.bankroll') || S.bankroll;
  driver = new LocalDriver({ rules: S.rules, aiCount, mySeat: S.mySeat, bankroll: saved, getChart: () => chartFor(driver.view.rules), speed: S.speed });
  driver.uiWait = () => table.wait();
  driver.onChange(onView);
  table.lastShuffles = null;
  pendingBet = Math.min(saved, Math.max(S.rules.minBet, +localStorage.getItem('bjt.lastbet') || S.rules.minBet * 2));
  onView(driver.view, { t: 'init' });
}

function onView(view, ev = {}) {
  if (!view) return;
  if (current !== 'play') { if (view.phase === 'settled') maybeRecordRound(view); return; }
  // End-of-round sweep into the discard tray before the table clears.
  if (lastPhase === 'settled' && view.phase === 'betting' && table.cards.size && !ev.swept) {
    const d = table.sweep(); lastPhase = 'sweeping';
    setTimeout(() => onView(driver.view, { ...ev, swept: true }), d);
    return;
  }
  if (ev.t === 'deal' || (isOnline() && view.phase !== 'betting' && view.round !== roundLog.round)) { if (view.round !== roundLog.round) { roundLog = []; roundLog.round = view.round; } }
  const names = {};
  table.render(view, { mySeat: driver.mySeat, names, deadline: driver.deadline, deadlineKind: driver.deadlineKind });
  if (ev.t === 'deal' || ev.t === 'act' || ev.t === 'ai') blip(520 + Math.random() * 80);
  lastPhase = view.phase;
  updateHud(view);
  if (view.phase === 'settled') maybeRecordRound(view);
  clearTimeout(onView.t);
  renderActions(view, true);
  const w = table.wait();
  if (w > 0) onView.t = setTimeout(() => renderActions(driver.view, false), w);
  else renderActions(view, false);
  updateBank(view);
}

function me(view) { return view && driver.mySeat >= 0 ? view.seats[driver.mySeat] : null; }
function updateBank(view) {
  const s = me(view);
  $('#bank').innerHTML = '';
  const b = $('#bank'); b.append(document.createTextNode(s ? money(s.bankroll) : '—'));
  if (s && !isOnline()) { localStorage.setItem('bjt.bankroll', String(s.bankroll)); }
  $('#modeBtn').textContent = ({ coach: '🎓 Coach', casino: '🎰 Casino', strategy: '🧠 Strategy practice', count: '🔢 Count practice' })[mode] + (isOnline() ? ' · Online' : '');
}

function updateHud(view) {
  const tr = driver.tracker; tr.update(view);
  const left = view.shoe.left, est = decksRemainingEstimate(left), tc = trueCount(tr.rc, left);
  const adv = betAdvice(tc, view.rules.decks, view.rules.minBet);
  const vis = countVisible();
  const hud = `<div>Running <b class="v">${sign(tr.rc)}</b></div><div>Decks left <b>${est}</b> <span class="muted">(${(left / 52).toFixed(1)})</span></div><div>True <b class="v">${sign(tc)}</b></div>${vis ? `<div class="muted">Bet ${adv.units}u</div>` : ''}`;
  const showHud = vis || mode === 'count' || S.showCount;
  table.setHud(showHud ? hud : '', !vis);
  table.hud.onclick = () => { if (mode === 'count' || !S.showCount) { peekCount = !peekCount; if (peekCount) session.peeks = (session.peeks || 0) + 1; updateHud(driver.view); } };
  if (isOnline()) {
    table.net.style.display = '';
    table.net.innerHTML = '';
    const dot = el('span', 'dot' + (driver.status === 'online' ? '' : ' off'));
    table.net.append(dot, document.createTextNode(`${driver.code} · ${view.seats.filter(Boolean).length} seated${driver.status === 'online' ? '' : ' · ' + driver.status}`));
  } else table.net.style.display = 'none';
}

function legalFor(view) { return G.legalActions(view, driver.mySeat); }
function currentHand(view) { const s = me(view); return s && view.turn && view.turn.seat === driver.mySeat ? s.hands[view.turn.hand] : null; }
function situation(cards, up) {
  const v = G.handValue(cards); const pair = cards.length === 2 && G.cardValue(cards[0]) === G.cardValue(cards[1]);
  return { pair, soft: v.soft, total: v.total, label: `${pair ? 'Pair ' + cardsText(cards) : (v.soft ? 'Soft ' : 'Hard ') + v.total + ` (${cardsText(cards)})`} vs ${upName(up)}` };
}
function cellKey(cards, up, legal) {
  const v = G.handValue(cards); const ranks = cards.map(G.cardValue);
  if (ranks.length === 2 && ranks[0] === ranks[1] && legal.split) return `P${ranks[0]}v${up}`;
  return (v.soft ? 'S' : 'H') + v.total + 'v' + up;
}

/** The recommended play right now (chart or count-aware), or null while the chart builds. */
function recommend(view) {
  const hand = currentHand(view); if (!hand) return null;
  const chart = chartFor(view.rules); if (!chart) return null;
  const legal = legalFor(view), up = upRank(view);
  if (useIdx()) { const tc = trueCount(driver.tracker.rc, view.shoe.left); return countAction(chart, hand.cards, up, legal, tc, view.rules); }
  return { action: chartAction(chart, hand.cards, up, legal) };
}

function doAct(a) {
  const view = driver.view; const hand = currentHand(view); if (!hand) return;
  const legal = legalFor(view); if (!legal[a]) return;
  const chart = chartFor(view.rules); const up = upRank(view);
  if (chart) {
    const tc = trueCount(driver.tracker.rc, view.shoe.left);
    let unseen;
    if (useIdx()) unseen = driver.tracker.unseen(view.rules.decks);
    else { unseen = shoeCounts(view.rules.decks); for (const c of hand.cards) unseen[G.cardValue(c)]--; unseen[up]--; }
    const g = gradeDecision({ chart, rules: view.rules, cards: hand.cards, up, legal, chosen: a, unseen, tc, useIndices: useIdx() });
    noteDecision(g, hand.cards, up, legal, hand.bet, tc);
  }
  blip(440);
  driver.act(a);
}
function noteDecision(g, cards, up, legal, bet, tc) {
  const sit = situation(cards, up);
  const d = { grade: g.grade, loss: g.loss, lossMoney: g.loss * bet, chosen: g.chosen, correct: g.correct, sit: sit.label, tc: useIdx() ? tc : null, reason: g.reason, because: g.because, index: g.index && g.index.name };
  roundLog.push(d); session.decisions.push(d); if (session.decisions.length > 400) session.decisions.shift();
  session.n++; if (g.grade === 'correct') session.ok++;
  recordDecision(stats, { grade: g.grade, loss: g.loss, bet, cat: categoryOf({ ...g, pair: sit.pair && legal.split, soft: sit.soft }), cell: g.insurance ? 'INSv1' : cellKey(cards, up, legal), correct: g.correct, chosen: g.chosen });
  saveStats(stats); saveSession();
  if (mode !== 'casino') showFeedback(d);
}
function showFeedback(d) {
  lastFeedback = d;
  const fb = $('#fb'); fb.className = 'fb on ' + d.grade; fb.textContent = '';
  const x = el('button', 'x', '×'); x.setAttribute('aria-label', 'Dismiss'); x.onclick = () => fb.classList.remove('on');
  const title = d.grade === 'correct' ? `Correct: ${ACTION_NAMES[d.chosen]}` : d.grade === 'slight' ? `Slightly suboptimal — ${ACTION_NAMES[d.correct]} is a hair better${d.because ? ` (${d.because})` : ''}` : `Mistake — ${ACTION_NAMES[d.correct]}${d.because ? `, because ${d.because}` : ''}`;
  fb.append(x, el('div', 't', title), el('div', '', `${d.sit}${d.tc !== null && d.tc !== undefined ? ` · TC ${sign(d.tc)}` : ''}. ${d.grade === 'correct' ? '' : `Cost: ${(d.loss * 100).toFixed(1)}% of the bet. `}${d.reason || ''}`));
}

function maybeRecordRound(view) {
  if (recordedRound === view.round) return;
  const s = me(view); if (!s || !s.hands.length) { recordedRound = view.round; return; }
  recordedRound = view.round;
  const initial = s.lastBet || s.hands[0].bet;
  const edge = edgeFor(view.rules) ?? 0.5;
  const errMoney = roundLog.reduce((a, d) => a + d.lossMoney, 0);
  const expected = -(edge / 100) * initial - errMoney;
  const net = s.roundNet || 0;
  recordHand(stats, { wagered: initial, net, expected });
  session.hands++; session.net += net; session.expected += expected; session.wagered += initial;
  saveStats(stats); saveSession();
  // Count practice: quiz the running count after some rounds.
  if (mode === 'count' && (Math.random() < 0.4 || view.cutCardOut)) setTimeout(() => countQuiz(), table.wait() + 700);
}

function countQuiz() {
  if (current !== 'play') return;
  const truth = driver.tracker.rc;
  openSheet((sh) => {
    sh.append(el('h2', '', 'Count check'), el('p', '', 'What is the running count right now?'));
    const box = el('div'); sh.append(box);
    let v = '';
    const entry = el('div', 'entry', '0'); const pad = el('div', 'numpad');
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '±', '0', '⌫']) {
      const b = el('button', 'btn', k); b.onclick = () => { if (k === '⌫') v = v.slice(0, -1); else if (k === '±') v = v.startsWith('-') ? v.slice(1) : '-' + v; else if (v.replace('-', '').length < 3) v += k; entry.textContent = (v || '0').replace('-', '−'); };
      pad.append(b);
    }
    const go = el('button', 'btn primary', 'Check'); go.style.cssText = 'width:100%;margin-top:8px';
    go.onclick = () => {
      const ans = parseInt(v || '0', 10) || 0; const ok = ans === truth;
      stats.countChecks.n++; if (ok) stats.countChecks.exact++; stats.countChecks.absErr += Math.abs(ans - truth);
      session.countChecks++; if (ok) session.countOk++;
      saveStats(stats); saveSession();
      box.textContent = '';
      const f = el('div', 'fb on ' + (ok ? 'correct' : 'mistake')); f.append(el('div', 't', ok ? 'Correct!' : `Running count is ${sign(truth)}`), el('div', '', ok ? `True count ${sign(trueCount(truth, driver.view.shoe.left))} with ${decksRemainingEstimate(driver.view.shoe.left)} decks left.` : `You said ${sign(ans)}. Off by ${Math.abs(ans - truth)}. Tip: count cards as they land, including the dealer's hole card and hits.`));
      box.append(f); entry.remove(); pad.remove(); go.remove();
    };
    box.append(entry, pad, go);
  });
}

function handReview(view) {
  const wrap = el('div', 'review');
  const s = me(view);
  if (s) {
    const res = s.roundNet || 0;
    wrap.append(el('div', '', `Result: ${res >= 0 ? '+' : '−'}${money(Math.abs(res))}  ·  Dealer ${totalLabel(view.dealer.cards)}`));
  }
  if (roundLog.length) {
    const ul = el('ul'); ul.style.cssText = 'margin:4px 0 0;padding-left:18px';
    for (const d of roundLog) { const li = el('li', 'g-' + d.grade, `${d.sit}: ${ACTION_NAMES[d.chosen]}${d.grade === 'correct' ? ' ✓' : ` ✗ → ${ACTION_NAMES[d.correct]} (−${(d.loss * 100).toFixed(1)}%)`}`); ul.append(li); }
    wrap.append(ul);
  }
  return wrap;
}

function renderActions(view, busy) {
  actions.querySelectorAll('.dyn').forEach((n) => n.remove());
  const box = el('div', 'dyn'); box.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const s = me(view);
  if (!s) {
    box.append(el('div', 'hint', isOnline() ? 'Tap an open seat on the table to sit down.' : 'Setting up the table…'));
    actions.prepend(box); renderChatPanel(); return;
  }
  const chart = chartFor(view.rules);
  const myTurn = view.phase === 'playing' && view.turn && view.turn.seat === driver.mySeat;
  if (view.phase === 'betting') {
    if (mode === 'strategy' && !isOnline()) { // no betting pressure: auto min bet & deal
      const b = el('button', 'btn primary', 'Deal next hand'); b.onclick = () => { driver.bet(view.rules.minBet); driver.deal(); };
      box.append(el('div', 'hint', 'Strategy practice: flat minimum bets, no other players.'), b);
      if (!busy && (!lastFeedback || lastFeedback.grade === 'correct')) { clearTimeout(renderActions.auto); renderActions.auto = setTimeout(() => { if (driver.view.phase === 'betting' && mode === 'strategy' && current === 'play') { driver.bet(view.rules.minBet); driver.deal(); } }, 900 * S.speed); }
    } else {
      const tc = trueCount(driver.tracker.rc, view.shoe.left), adv = betAdvice(tc, view.rules.decks, view.rules.minBet);
      if (isOnline() && s.bet) pendingBet = s.bet;
      pendingBet = Math.min(pendingBet, Math.floor(s.bankroll + (s.bet || 0)));
      const info = el('div', 'betinfo'); info.innerHTML = '';
      info.append(document.createTextNode('Bet '), el('b', '', money(pendingBet)), document.createTextNode(`  ·  min ${money(view.rules.minBet)} · max ${money(view.rules.maxBet)}`));
      const chips = el('div', 'chips');
      for (const v of [5, 25, 100, 500]) {
        const c = el('button', 'chip c' + v, String(v)); c.setAttribute('aria-label', `Add ${v}`);
        c.onclick = () => { pendingBet = Math.min(view.rules.maxBet, pendingBet + v, Math.floor(s.bankroll + (s.bet || 0))); blip(800, 0.02); if (isOnline()) driver.bet(pendingBet); renderActions(driver.view, false); };
        chips.append(c);
      }
      const row = el('div', 'row');
      const clr = el('button', 'btn small', 'Clear'); clr.onclick = () => { pendingBet = 0; if (isOnline()) driver.bet(0); renderActions(driver.view, false); };
      const minb = el('button', 'btn small', 'Min'); minb.onclick = () => { pendingBet = view.rules.minBet; if (isOnline()) driver.bet(pendingBet); renderActions(driver.view, false); };
      const deal = el('button', 'btn primary', isOnline() ? (s.bet ? 'Ready ✓' : 'Place bet') : 'Deal');
      deal.disabled = busy || pendingBet < view.rules.minBet || pendingBet > s.bankroll + (s.bet || 0);
      deal.onclick = () => {
        if (mode === 'count' || useIdx()) gradeBet(tc, adv, view);
        localStorage.setItem('bjt.lastbet', String(pendingBet));
        lastFeedback = null; $('#fb').classList.remove('on');
        const r = driver.bet(pendingBet);
        if (r !== true && !isOnline()) { toast(r === 'insufficient' ? 'Not enough chips. Refill in Settings.' : 'Bet must be between the table minimum and maximum.'); return; }
        driver.deal();
      };
      row.append(clr, minb, deal);
      box.append(info, chips, row);
      if (s.bankroll + (s.bet || 0) < view.rules.minBet) {
        const rf = el('button', 'btn', 'Out of chips — refill play money');
        rf.onclick = () => { if (isOnline()) driver.rebuy(); else driver.refill(S.bankroll); };
        box.append(rf);
      }
      if (countVisible() || mode === 'count') box.append(el('div', 'advice', countVisible() ? `Count says: ${adv.units} unit${adv.units > 1 ? 's' : ''} (${money(adv.amount)}). ${adv.note}` : 'Size your bet from your own count (tap the count box to peek).'));
      if (isOnline() && driver.deadline && driver.deadlineKind === 'bet') box.append(el('div', 'hint', `Dealing in ${Math.max(0, Math.ceil((driver.deadline - Date.now()) / 1000))} s`));
      if (view.justShuffled === false && view.shoe.pos === 0) box.append(el('div', 'hint', 'Fresh shoe.'));
    }
  } else if (view.phase === 'insurance' && s.hands.length && s.insurance === null) {
    const bj = G.handValue(s.hands[0].cards).blackjack;
    const q = el('div', 'hint'); q.innerHTML = '';
    q.append(el('b', '', bj ? 'Even money?' : 'Insurance?'), document.createTextNode(` Costs ${money(s.hands[0].bet / 2)}, pays 2:1 if the dealer has blackjack.`));
    const row = el('div', 'row');
    const yes = el('button', 'btn', bj ? 'Even money' : 'Insure'), no = el('button', 'btn primary', bj ? 'No, play it' : 'No insurance');
    const decide = (take) => {
      const tc = trueCount(driver.tracker.rc, view.shoe.left);
      const g = gradeInsurance({ take, tc, useIndices: useIdx(), unseen: driver.tracker.unseen(view.rules.decks) });
      noteDecision({ ...g, chosen: take ? 'insure' : 'noinsure' }, s.hands[0].cards, 1, { split: false }, s.hands[0].bet, tc);
      driver.insurance(take);
    };
    yes.onclick = () => decide(true); no.onclick = () => decide(false);
    yes.disabled = no.disabled = busy;
    row.append(yes, no); box.append(q, row);
  } else if (myTurn) {
    const legal = legalFor(view), rec = recommend(view);
    const row = el('div', 'row');
    const hand = currentHand(view);
    for (const a of ['hit', 'stand', 'double', 'split', 'surrender']) {
      if (a === 'surrender' && view.rules.surrender !== 'late') continue;
      const b = el('button', 'btn ' + a, ({ hit: 'Hit', stand: 'Stand', double: 'Double', split: 'Split', surrender: 'Surr.' })[a]);
      b.setAttribute('aria-label', ACTION_NAMES[a]);
      b.disabled = busy || !legal[a];
      if (S.alwaysHint && mode !== 'casino' && rec && rec.action === a) b.classList.add('suggest');
      b.onclick = () => doAct(a);
      row.append(b);
    }
    const info = el('div', 'hint');
    const v = G.handValue(hand.cards, hand.fromSplit);
    info.textContent = `Your ${v.soft ? 'soft ' : ''}${v.total} vs dealer ${upName(upRank(view))}${s.hands.length > 1 ? ` · hand ${view.turn.hand + 1} of ${s.hands.length}` : ''}`;
    box.append(info, row);
    if (mode !== 'casino') {
      const hrow = el('div', 'row');
      const hint = el('button', 'btn small', '💡 Hint');
      const out = el('div', 'hint'); out.style.flex = '1';
      hint.onclick = () => {
        const r = recommend(driver.view);
        out.textContent = '';
        if (!r) { out.textContent = 'Building strategy for these rules…'; return; }
        out.append(document.createTextNode(useIdx() ? 'With the count: ' : 'Basic strategy: '), el('b', '', ACTION_NAMES[r.action]));
        if (r.index) out.append(document.createTextNode(` (${r.index.name} index)`));
        session.hints = (session.hints || 0) + 1;
      };
      hrow.append(hint, out); box.append(hrow);
      if (!chart) box.append(el('div', 'hint', 'Preparing strategy for these rules…'));
    }
  } else if (view.phase === 'settled') {
    box.append(handReview(view));
    if (!isOnline()) {
      const row = el('div', 'row');
      const nx = el('button', 'btn primary', mode === 'strategy' ? 'Next hand' : 'Next round'); nx.disabled = busy;
      nx.onclick = () => { driver.next(); };
      row.append(nx); box.append(row);
      if (mode === 'strategy' && !busy && (!lastFeedback || lastFeedback.grade === 'correct')) { clearTimeout(renderActions.auto); renderActions.auto = setTimeout(() => { if (driver.view.phase === 'settled' && mode === 'strategy' && current === 'play') driver.next(); }, 1400 * S.speed); }
    } else box.append(el('div', 'hint', 'Next round starts in a moment…'));
  } else {
    const t = view.turn && view.seats[view.turn.seat];
    box.append(el('div', 'hint', view.phase === 'insurance' ? 'Waiting for insurance decisions…' : t ? `${t.name} is playing…` : 'Dealer is playing…'));
  }
  actions.prepend(box);
  renderChatPanel();
}

function gradeBet(tc, adv, view) {
  const units = Math.round(pendingBet / view.rules.minBet);
  const ok = Math.abs(units - adv.units) <= (adv.units >= 4 ? 1 : 0);
  stats.betChecks.n++; if (ok) stats.betChecks.ok++; saveStats(stats);
  if (mode === 'count' && !ok) toast(`Bet check: at TC ${sign(tc)} the ramp says ${adv.units} unit${adv.units > 1 ? 's' : ''} (${money(adv.amount)}). You bet ${units}.`, 3500);
}

$('#modeBtn').onclick = () => openSheet((sh) => {
  sh.append(el('h2', '', 'Training mode'));
  const modes = [
    ['coach', '🎓 Coach', 'Instant feedback after every decision, hints on request, post-hand review.'],
    ['casino', '🎰 Casino', 'No hints or instant feedback; review after each hand. Count hidden.'],
    ['strategy', '🧠 Strategy practice', 'Just you vs the dealer, flat bets, fast auto-deal. Pure basic strategy reps.'],
    ['count', '🔢 Count practice', 'Count is hidden (tap to peek). Bets and index plays are graded; surprise count checks.'],
  ];
  for (const [id, name, desc] of modes) {
    const b = el('button', 'btn' + (id === mode ? ' primary' : '')); b.style.cssText = 'width:100%;text-align:left;margin:4px 0;padding:10px 12px;min-height:60px';
    b.append(el('div', '', name), el('div', 'k', desc));
    b.onclick = () => { setMode(id); closeSheet(); };
    sh.append(b);
  }
});
function setMode(m) {
  const prev = mode; mode = m; S.mode = m; saveSettings(S); peekCount = false;
  if (!isOnline() && (prev === 'strategy') !== (m === 'strategy') && driver.view.phase === 'betting') startLocal();
  else if (!isOnline() && (prev === 'strategy') !== (m === 'strategy')) toast('Seats change after this round.');
  onView(driver.view, {});
}
$('#chartBtn').onclick = () => openSheet((sh) => {
  const v = driver.view; const ch = chartFor(v.rules); const hand = currentHand(v);
  let hl = null;
  if (hand && ch) { const legal = legalFor(v); const up = upRank(v); const k = cellKey(hand.cards, up, legal); const m = k.match(/^([HSP])(\d+)v(\d+)$/); hl = { kind: { H: 'hard', S: 'soft', P: 'pair' }[m[1]], key: m[1] === 'H' ? Math.max(8, Math.min(17, +m[2])) : +m[2], up: +m[3] }; }
  sh.append(el('h2', '', 'Basic strategy for this table'));
  const d = el('div'); d.innerHTML = chartHTML(ch, hl); sh.append(d);
  d.onclick = (e) => cellInfo(e, ch, d);
});
function cellInfo(e, ch, host) {
  const td = e.target.closest('td'); if (!td || !ch) return;
  const evs = ch.ev[td.dataset.k][td.dataset.r][td.dataset.u];
  const txt = Object.entries(evs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${ACTION_NAMES[k]} ${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`).join(' · ');
  let n = host.querySelector('.cellinfo'); if (!n) { n = el('div', 'fb on correct cellinfo'); host.prepend(n); }
  n.textContent = `${td.dataset.k} ${td.dataset.r} vs ${upName(+td.dataset.u)}: ${txt}`;
}
$('#reviewBtn').onclick = () => sessionReview(false);

/* ------------------------------ chat ----------------------------------- */
function renderChatPanel() {
  let panel = actions.querySelector('.chatpanel');
  if (!isOnline()) { if (panel) panel.remove(); $('#chatFab').style.display = 'none'; return; }
  $('#chatFab').style.display = '';
  if (!panel) { panel = el('div', 'chatpanel chat'); actions.append(panel); buildChat(panel); }
  panel.classList.toggle('on', innerWidth > innerHeight);
}
function buildChat(host) {
  host.textContent = '';
  const msgs = el('div', 'msgs'); msgs.setAttribute('aria-live', 'polite'); msgs.setAttribute('role', 'log');
  const form = el('form'); const inp = el('input'); inp.maxLength = 200; inp.placeholder = 'Message the table'; inp.setAttribute('aria-label', 'Chat message'); inp.enterKeyHint = 'send';
  const send = el('button', 'btn small primary', 'Send'); send.type = 'submit';
  form.append(inp, send);
  form.onsubmit = (e) => { e.preventDefault(); const t = inp.value.trim(); if (!t) return; if (driver.chat(t)) inp.value = ''; };
  host.append(msgs, form);
  for (const m of chatLog) msgs.append(chatLine(m));
  msgs.scrollTop = 1e9;
}
function chatLine(m) {
  // Chat text is ALWAYS inserted with textContent (never innerHTML) so nobody can inject markup.
  const d = el('div');
  if (m.sys) d.append(el('span', 'sys', m.text));
  else { d.append(el('span', 'who', m.from + ':'), document.createTextNode(m.text)); }
  return d;
}
function onChat(m) {
  chatLog.push(m); if (chatLog.length > 100) chatLog.shift();
  for (const box of document.querySelectorAll('.chat .msgs')) { box.append(chatLine(m)); box.scrollTop = 1e9; }
  const sheetOpen = overlay.classList.contains('on') && sheet.querySelector('.chat');
  const landscape = innerWidth > innerHeight;
  if (!sheetOpen && !(landscape && current === 'play') && !m.sys && !m.mine) { unread++; updateBadge(); }
  if (!m.sys && current === 'play') { const p = table.preview; p.textContent = ''; p.append(el('b', '', m.from + ': '), document.createTextNode(m.text)); p.classList.add('on'); clearTimeout(onChat.t); onChat.t = setTimeout(() => p.classList.remove('on'), 4000); }
}
function updateBadge() { const b = $('#chatFab .badge'); b.textContent = unread || ''; b.style.display = unread ? '' : 'none'; }
$('#chatFab').onclick = () => { unread = 0; updateBadge(); openSheet((sh) => { sh.append(el('h2', '', 'Table chat')); const c = el('div', 'chat'); c.style.height = '50vh'; sh.append(c); buildChat(c); setTimeout(() => c.querySelector('input').focus(), 50); }); };

/* ------------------------------ online --------------------------------- */
function startOnline({ code, pin, nick }) {
  if (driver) driver.close();
  chatLog = []; unread = 0; updateBadge();
  driver = new NetDriver({ code, pin, nick });
  table.lastShuffles = null; roundLog = []; recordedRound = -1;
  driver.onChange((v, ev) => onView(v, ev));
  driver.onChat((m) => onChat({ ...m, mine: m.pid === driver.pid }));
  driver.onStatus((s, info) => {
    if (s === 'error') {
      toast(({ bad_pin: 'Wrong PIN.', locked: 'Too many wrong PINs. Try again later.', not_found: 'No table with that code (it may have closed).', full: 'That table is full.', bad_nick: 'Pick a nickname (1-16 letters).' })[info.code] || 'Could not join.', 4000);
      leaveOnline(); show('online');
    } else if (s === 'online') { onChat({ sys: true, text: `Joined table ${code}.` }); renderOnline(); }
    else if (s === 'reconnecting') { onChat({ sys: true, text: 'Connection lost, reconnecting…' }); }
    if (driver.view) onView(driver.view, {});
    if (info && info.t === 'err' && s !== 'error') toast(({ rate: 'Slow down a little.', too_long: 'Message too long.', bad_phase: 'Not now.', bad_amount: 'Bet outside table limits.', insufficient: 'Not enough chips.', not_host: 'Only the table creator can do that.', seat_taken: 'That seat is taken.' })[info.code] || info.code);
  });
  table.seats.onclick = (e) => { const b = e.target.closest('[data-sit]'); if (b && isOnline()) driver.sit(+b.dataset.sit); };
  show('play');
}
function leaveOnline() { if (isOnline()) driver.leave(); startLocal(); }

function renderOnline() {
  const h = screens.online; h.textContent = '';
  const c1 = el('div', 'card-ui');
  c1.append(el('h2', '', 'Play with friends'), el('p', 'muted', 'Create a table and share its code. Everyone plays with free play money against the same server-dealt shoe, with live table chat. No sign-up, no real money.'));
  h.append(c1);
  if (isOnline()) {
    const c = el('div', 'card-ui');
    c.append(el('h2', '', `At table ${driver.code}`), el('p', '', driver.status === 'online' ? 'Connected.' : 'Reconnecting…'));
    const row = el('div', 'row wrap');
    const share = el('button', 'btn', 'Share invite'); share.onclick = () => shareInvite(driver.code);
    const go = el('button', 'btn primary', 'Go to table'); go.onclick = () => show('play');
    const lv = el('button', 'btn', 'Leave table'); lv.onclick = () => { leaveOnline(); renderOnline(); toast('Left the table.'); };
    row.append(go, share, lv); c.append(row, el('p', 'muted', 'The PIN is not in the invite link; tell friends separately.'));
    h.append(c);
  }
  const nickF = field('Nickname', 'Shown to other players', () => { const i = el('input'); i.type = 'text'; i.maxLength = 16; i.value = S.nick || ''; i.autocomplete = 'nickname'; i.oninput = () => { S.nick = i.value.trim(); saveSettings(S); }; return i; });
  const cc = el('div', 'card-ui'); cc.append(el('h2', '', 'Create a table'), nickF);
  const nameF = el('input'); nameF.type = 'text'; nameF.maxLength = 24; nameF.placeholder = 'Friday night';
  const pinF = el('input'); pinF.type = 'text'; pinF.inputMode = 'numeric'; pinF.maxLength = 8; pinF.placeholder = 'optional';
  cc.append(field('Table name', '', () => nameF), field('PIN', '4-8 digits, optional', () => pinF), el('p', 'muted', `Uses your current rules: ${describeRules(S.rules)}.`));
  const cb = el('button', 'btn primary', 'Create table'); cb.style.width = '100%';
  cb.onclick = async () => {
    if (!S.nick) return toast('Pick a nickname first.');
    if (pinF.value && !/^\d{4,8}$/.test(pinF.value)) return toast('PIN must be 4-8 digits.');
    cb.disabled = true; cb.textContent = 'Creating…';
    try { const r = await createTable({ name: nameF.value.trim(), pin: pinF.value, rules: S.rules, nick: S.nick }); startOnline({ code: r.code, pin: pinF.value, nick: S.nick }); setTimeout(() => toast(`Table ${r.code} created. Share the code${pinF.value ? ' and PIN' : ''}.`, 4000), 300); }
    catch (e) { toast(({ too_many_tables: 'The server is at its table limit right now. Try later.', rate: 'Too many tables created from here. Wait a bit.', bad_origin: 'Blocked origin.' })[e.message] || 'Could not reach the table server. Check your connection.'); }
    cb.disabled = false; cb.textContent = 'Create table';
  };
  cc.append(cb); h.append(cc);
  const cj = el('div', 'card-ui'); cj.append(el('h2', '', 'Join a table'));
  const codeF = el('input'); codeF.type = 'text'; codeF.maxLength = 8; codeF.autocapitalize = 'characters'; codeF.placeholder = 'ABC234'; codeF.value = (location.hash.match(/join=([A-Za-z0-9]+)/) || [])[1] || '';
  const jpin = el('input'); jpin.type = 'text'; jpin.inputMode = 'numeric'; jpin.maxLength = 8; jpin.placeholder = 'if the table has one';
  cj.append(field('Table code', '', () => codeF), field('PIN', '', () => jpin));
  const jb = el('button', 'btn primary', 'Join'); jb.style.width = '100%';
  jb.onclick = () => { const code = codeF.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!S.nick) return toast('Pick a nickname first.'); if (code.length < 4) return toast('Enter the table code.'); startOnline({ code, pin: jpin.value, nick: S.nick }); };
  cj.append(jb); h.append(cj);
  const recent = Object.keys(localStorage).filter((k) => k.startsWith('bjt.net.')).map((k) => [k.slice(8), JSON.parse(localStorage.getItem(k) || '{}')]).filter(([, v]) => Date.now() - (v.at || 0) < 864e5).slice(0, 5);
  if (recent.length && !isOnline()) {
    const cr = el('div', 'card-ui'); cr.append(el('h2', '', 'Rejoin'));
    for (const [code] of recent) { const b = el('button', 'btn', code); b.style.margin = '4px'; b.onclick = () => startOnline({ code, pin: '', nick: S.nick || 'Player' }); cr.append(b); }
    h.append(cr);
  }
  h.append(el('p', 'muted', `Server: ${API_BASE.replace('https://', '')}. Tables close after 30 minutes with nobody connected. Chat is not stored after the table closes and is never logged.`));
}
function shareInvite(code) {
  const url = location.origin + location.pathname + '#join=' + code;
  if (navigator.share) navigator.share({ title: 'Blackjack table', text: `Join my blackjack table ${code}`, url }).catch(() => {});
  else { navigator.clipboard?.writeText(url); toast('Invite link copied.'); }
}
function describeRules(r) { return `${r.decks} deck${r.decks > 1 ? 's' : ''}, ${r.h17 ? 'H17' : 'S17'}, BJ ${r.bjPays === 1.2 ? '6:5' : '3:2'}, double ${r.doubleOn}, ${r.das ? 'DAS' : 'no DAS'}, split to ${r.maxSplitHands}${r.resplitAces ? ', RSA' : ''}${r.hitSplitAces ? ', hit split aces' : ''}, ${r.surrender === 'late' ? 'late surrender' : 'no surrender'}`; }

/* ------------------------------ learn ---------------------------------- */
function renderLearn() {
  const h = screens.learn; h.textContent = '';
  const rules = driver ? driver.view.rules : S.rules;
  const ch = chartFor(rules), edge = edges.get(edgeKey(rules)) ?? null; edgeFor(rules);
  h.append(el('p', 'muted', 'Work top to bottom. Each lesson links to a drill; finished lessons are ticked.'));
  lessons({ chart: ch, rules, edge }).forEach((L, i) => {
    const d = el('details', 'lesson');
    const s = el('summary'); const n = el('span', 'n' + (stats.lessons[L.id] ? ' done' : ''), stats.lessons[L.id] ? '✓' : String(i + 1));
    s.append(n, document.createTextNode(L.title));
    const body = el('div', 'body'); body.innerHTML = L.html;
    const row = el('div', 'row wrap');
    const done = el('button', 'btn small', stats.lessons[L.id] ? 'Done ✓' : 'Mark done'); done.onclick = () => { stats.lessons[L.id] = true; saveStats(stats); n.textContent = '✓'; n.classList.add('done'); done.textContent = 'Done ✓'; };
    row.append(done);
    if (L.drill) { const b = el('button', 'btn small primary', 'Practice: ' + DRILLS.find((x) => x.id === L.drill).title); b.onclick = () => { show('drills'); openDrill(L.drill); }; row.append(b); }
    body.append(row);
    body.onclick = (e) => { if (e.target.closest('td[data-k]')) cellInfo(e, ch, e.target.closest('.chartwrap') || body); };
    d.append(s, body); h.append(d);
  });
}

/* ------------------------------ drills --------------------------------- */
const drillCtx = {
  get stats() { return stats; }, saveStats: () => saveStats(stats), toast,
  showDrillList: () => renderDrillList(), onLeave: (f) => leaveHooks.push(f),
  chart: () => chartFor(driver ? driver.view.rules : S.rules), rules: () => (driver ? driver.view.rules : S.rules),
  grade(cards, up, legal, chosen) {
    const rules = this.rules(); const unseen = shoeCounts(rules.decks); for (const c of cards) unseen[G.cardValue(c)]--; unseen[up]--;
    return gradeDecision({ chart: this.chart(), rules, cards, up, legal, chosen, unseen });
  },
  recordDrillDecision(g, cards, up) {
    const sit = situation(cards, up);
    recordDecision(stats, { grade: g.grade, loss: g.loss, bet: 0, cat: categoryOf({ ...g, pair: sit.pair, soft: sit.soft }), cell: cellKey(cards, up, { split: sit.pair }), correct: g.correct, chosen: g.chosen });
    saveStats(stats);
  },
};
function renderDrillList() {
  while (leaveHooks.length) leaveHooks.pop()();
  const h = screens.drills; h.textContent = '';
  h.append(el('p', 'muted', 'Short, scored drills. Your best and recent results are saved.'));
  for (const d of DRILLS) {
    const c = el('button', 'card-ui'); c.style.cssText = 'display:block;width:100%;text-align:left;color:inherit';
    const res = stats.drills[d.id] || []; const last = res.slice(-10);
    const avg = last.length ? last.reduce((a, r) => a + r.score, 0) / last.length : null;
    c.append(el('h2', '', d.title), el('div', 'muted', d.desc), el('div', 'pill', avg === null ? 'Not tried yet' : `Recent accuracy ${(avg * 100).toFixed(0)}% · ${res.length} attempts`));
    c.onclick = () => openDrill(d.id);
    h.append(c);
  }
}
function openDrill(id) { while (leaveHooks.length) leaveHooks.pop()(); runDrill(id, screens.drills, drillCtx); }

/* ------------------------------ stats ---------------------------------- */
function renderStats() {
  const h = screens.stats; h.textContent = '';
  const rules = driver ? driver.view.rules : S.rules;
  const edge = edgeFor(rules) ?? 0.5;
  const acc = stats.decisions ? stats.correct / stats.decisions : null;
  const lossPerDecision = stats.decisions ? stats.evLoss / stats.decisions : 0;
  const earlyRate = stats.early.n ? stats.early.loss / stats.early.n : 0;
  const recentRate = stats.recent.length ? stats.recent.reduce((a, b) => a + b, 0) / stats.recent.length : 0;
  const errEdge = stats.wagered ? (stats.evLossMoney / stats.wagered) * 100 : lossPerDecision * 100 * 1.3;
  const reduction = (earlyRate - recentRate) * 100 * 1.3; // ~1.3 decisions per hand
  const grid = el('div', 'statgrid');
  const stat = (v, l) => { const s = el('div', 'stat'); s.append(el('div', 'v', v), el('div', 'l', l)); grid.append(s); };
  stat(acc === null ? '—' : (acc * 100).toFixed(1) + '%', `Decisions correct (${stats.decisions})`);
  stat(stats.decisions ? `${((stats.slight / stats.decisions) * 100).toFixed(0)}% / ${((stats.mistake / stats.decisions) * 100).toFixed(0)}%` : '—', 'Slight / mistakes');
  stat((edge + errEdge).toFixed(2) + '%', `House edge with your play (perfect: ${edge.toFixed(2)}%)`);
  stat(stats.early.n >= 50 && stats.recent.length >= 50 ? (reduction >= 0 ? '−' : '+') + Math.abs(reduction).toFixed(2) + ' pts' : 'needs 50+', 'House edge reduction (first 200 vs last 200 decisions)');
  stat(money(session.net), `Session result (${session.hands} hands)`);
  stat(money(session.expected), 'Session EV (expected result of your play)');
  stat(money(stats.net), `All-time result (${stats.hands} hands)`);
  stat(stats.wagered ? ((stats.net / stats.wagered) * 100).toFixed(2) + '%' : '—', `Return on action (EV ${stats.wagered ? ((stats.expected / stats.wagered) * 100).toFixed(2) + '%' : '—'})`);
  stat(stats.countChecks.n ? `${((stats.countChecks.exact / stats.countChecks.n) * 100).toFixed(0)}%` : '—', `Count checks exact (avg error ${stats.countChecks.n ? (stats.countChecks.absErr / stats.countChecks.n).toFixed(1) : '—'})`);
  stat(stats.betChecks.n ? `${((stats.betChecks.ok / stats.betChecks.n) * 100).toFixed(0)}%` : '—', 'Bets matching the count ramp');
  const c0 = el('div', 'card-ui'); c0.append(el('h2', '', 'Your progress'), grid);
  const rv = el('button', 'btn primary', 'Session review'); rv.style.cssText = 'width:100%;margin-top:10px'; rv.onclick = () => sessionReview(false);
  c0.append(rv); h.append(c0);

  const c1 = el('div', 'card-ui'); c1.append(el('h2', '', 'Results vs expectation'), el('p', 'muted', 'Gold = actual winnings, blue = expected value of your decisions. The gap is luck; the blue line\'s slope is your skill.'));
  const cv = el('canvas', 'spark'); c1.append(cv); h.append(c1);
  requestAnimationFrame(() => drawCurve(cv, stats.curve));

  const c2 = el('div', 'card-ui'); c2.append(el('h2', '', 'By decision type'));
  const t = el('table', 'plain'); t.innerHTML = '<tr><th>Type</th><th class="num">Hands</th><th class="num">Correct</th><th class="num">EV lost</th></tr>';
  for (const [k, v] of Object.entries(stats.cat).sort((a, b) => b[1].loss - a[1].loss)) { const tr = el('tr'); tr.innerHTML = `<td>${k}</td><td class="num">${v.n}</td><td class="num">${((v.ok / v.n) * 100).toFixed(0)}%</td><td class="num">${(v.loss * 100).toFixed(0)}%</td>`; t.append(tr); }
  c2.append(t, el('p', 'muted', 'EV lost is in % of one bet, summed. 100% = one full bet thrown away.')); h.append(c2);

  const c3 = el('div', 'card-ui'); c3.append(el('h2', '', 'Highest-impact leaks'));
  const leaks = Object.entries(stats.cells).filter(([, c]) => c.wrong).sort((a, b) => b[1].loss - a[1].loss).slice(0, 8);
  if (!leaks.length) c3.append(el('p', 'muted', 'No mistakes recorded yet.'));
  else { const ul = el('ul'); for (const [k, c] of leaks) ul.append(el('li', '', `${cellName(k)}: you ${ACTION_NAMES[c.last] || c.last}, should ${ACTION_NAMES[c.correct] || c.correct} — wrong ${c.wrong}/${c.n}, cost ${(c.loss * 100).toFixed(0)}% of a bet`)); c3.append(ul); const b = el('button', 'btn small primary', 'Drill these'); b.onclick = () => { show('drills'); openDrill('strategy'); }; c3.append(b); }
  h.append(c3);

  const c4 = el('div', 'card-ui'); c4.append(el('h2', '', 'Drills'));
  const t4 = el('table', 'plain'); t4.innerHTML = '<tr><th>Drill</th><th class="num">Tries</th><th class="num">Last 10</th></tr>';
  for (const d of DRILLS) { const r = stats.drills[d.id] || []; const l = r.slice(-10); const tr = el('tr'); tr.innerHTML = `<td>${d.title}</td><td class="num">${r.length}</td><td class="num">${l.length ? ((l.reduce((a, x) => a + x.score, 0) / l.length) * 100).toFixed(0) + '%' : '—'}</td>`; t4.append(tr); }
  c4.append(t4); h.append(c4);

  const c5 = el('div', 'card-ui'); c5.append(el('h2', '', 'Past sessions'));
  if (!stats.sessions.length) c5.append(el('p', 'muted', 'End a session from the review to archive it here.'));
  for (const s of stats.sessions.slice(-8).reverse()) c5.append(el('div', 'muted', `${new Date(s.start).toLocaleDateString()} · ${s.hands} hands · ${s.acc === null ? '—' : (s.acc * 100).toFixed(0) + '% correct'} · result ${money(s.net)} (EV ${money(s.expected)})`));
  const reset = el('button', 'btn small', 'Reset all stats'); reset.style.marginTop = '10px';
  reset.onclick = () => { if (confirm('Erase all statistics and drill history?')) { stats = emptyStats(); saveStats(stats); session = newSession(); saveSession(); renderStats(); } };
  c5.append(reset); h.append(c5);
}
function cellName(k) { const m = k.match(/^([HSP]|INS)(\d+)v(\d+)$/); if (!m) return k; if (m[1] === 'INS') return 'Insurance'; return `${{ H: 'Hard', S: 'Soft', P: 'Pair' }[m[1]]} ${m[1] === 'P' ? (m[2] === '1' ? 'A,A' : m[2] + ',' + m[2]) : m[2]} vs ${upName(+m[3])}`; }
function drawCurve(cv, curve) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  if (curve.length < 2) { g.fillStyle = '#b9c7bd'; g.font = '13px system-ui'; g.fillText('Play some hands to see your curve.', 12, h / 2); return; }
  const vals = curve.flat(); const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals); const span = hi - lo || 1;
  const X = (i) => 8 + (i / (curve.length - 1)) * (w - 16), Y = (v) => h - 10 - ((v - lo) / span) * (h - 20);
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.moveTo(8, Y(0)); g.lineTo(w - 8, Y(0)); g.stroke();
  for (const [idx, col] of [[1, '#6cb4ff'], [0, '#e2c26b']]) { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); curve.forEach((p, i) => (i ? g.lineTo(X(i), Y(p[idx])) : g.moveTo(X(i), Y(p[idx])))); g.stroke(); }
}
function sessionReview(end) {
  openSheet((sh) => {
    const s = session; sh.append(el('h2', '', 'Session review'));
    const acc = s.n ? (s.ok / s.n) * 100 : null;
    sh.append(el('p', '', `${s.hands} hands · ${s.n} decisions · ${acc === null ? '—' : acc.toFixed(0) + '% correct'}${s.countChecks ? ` · count checks ${s.countOk}/${s.countChecks}` : ''}${s.hints ? ` · ${s.hints} hints` : ''}`));
    sh.append(el('p', '', `Result ${money(s.net)}; expected ${money(s.expected)} (${s.net >= s.expected ? 'you ran above expectation' : 'you ran below expectation'}).`));
    const tops = topMistakes(s.decisions, 5);
    sh.append(el('h3', '', 'Highest-impact mistakes'));
    if (!tops.length) sh.append(el('p', 'muted', 'None this session. 👏'));
    else { const ul = el('ul'); for (const t of tops) ul.append(el('li', '', `${t.sit}${t.tc !== null && t.tc !== undefined ? ` (TC ${sign(t.tc)})` : ''}: ${ACTION_NAMES[t.chosen]} instead of ${ACTION_NAMES[t.correct]} — cost ${(t.loss * 100).toFixed(1)}% of the bet (${money(t.lossMoney)})`)); sh.append(ul); }
    const b = el('button', 'btn primary', 'End session & archive'); b.style.cssText = 'width:100%;margin-top:8px';
    b.onclick = () => { endSession(); closeSheet(); toast('Session archived. New session started.'); };
    sh.append(b);
  });
}

/* ------------------------------ settings ------------------------------- */
function field(label, sub, make) { const f = el('div', 'field'); const l = el('label'); l.append(document.createTextNode(label)); if (sub) l.append(el('span', 'sub', sub)); const c = make(); const id = 'f' + Math.random().toString(36).slice(2); c.id = id; l.htmlFor = id; f.append(l, c); return f; }
function sel(opts, val, on) { const s = el('select'); for (const [v, t] of opts) { const o = el('option', '', t); o.value = String(v); if (String(v) === String(val)) o.selected = true; s.append(o); } s.onchange = () => on(s.value); return s; }
function sw(val, on) { const i = el('input', 'switch'); i.type = 'checkbox'; i.checked = !!val; i.onchange = () => on(i.checked); return i; }
function renderSettings() {
  const h = screens.settings; h.textContent = '';
  const setRule = (k, v) => {
    S.rules = G.sanitizeRules({ ...S.rules, [k]: v }); saveSettings(S);
    if (!isOnline()) driver.setRules(S.rules);
    chartFor(S.rules); edgeFor(S.rules); renderSettings();
  };
  const c1 = el('div', 'card-ui'); c1.append(el('h2', '', 'Table rules'));
  c1.append(
    field('Decks', 'Takes effect at the next shuffle', () => sel([1, 2, 3, 4, 5, 6].map((d) => [d, d + (d > 1 ? ' decks' : ' deck')]), S.rules.decks, (v) => setRule('decks', +v))),
    field('Dealer soft 17', '', () => sel([[1, 'Hits soft 17 (H17)'], [0, 'Stands (S17)']], S.rules.h17 ? 1 : 0, (v) => setRule('h17', v === '1'))),
    field('Blackjack pays', '', () => sel([[1.5, '3 to 2'], [1.2, '6 to 5']], S.rules.bjPays, (v) => setRule('bjPays', +v))),
    field('Double on', '', () => sel([['any', 'Any two cards'], ['9-11', '9, 10, 11 only'], ['10-11', '10, 11 only']], S.rules.doubleOn, (v) => setRule('doubleOn', v))),
    field('Double after split', '', () => sw(S.rules.das, (v) => setRule('das', v))),
    field('Split up to', '', () => sel([[2, '2 hands (no resplit)'], [3, '3 hands'], [4, '4 hands']], S.rules.maxSplitHands, (v) => setRule('maxSplitHands', +v))),
    field('Resplit aces', '', () => sw(S.rules.resplitAces, (v) => setRule('resplitAces', v))),
    field('Hit split aces', '', () => sw(S.rules.hitSplitAces, (v) => setRule('hitSplitAces', v))),
    field('Surrender', '', () => sel([['late', 'Late surrender'], ['none', 'Not offered']], S.rules.surrender, (v) => setRule('surrender', v))),
    field('Penetration (cut card)', '', () => sel([[0.5, '50%'], [0.65, '65%'], [0.75, '75%'], [0.83, '83%']], S.rules.penetration, (v) => setRule('penetration', +v))),
    field('Minimum bet', '', () => sel([[5, '$5'], [10, '$10'], [15, '$15'], [25, '$25']], S.rules.minBet, (v) => setRule('minBet', +v))),
  );
  const pub = publishedEdge(S.rules); const calc = edges.get(edgeKey(S.rules));
  c1.append(el('p', '', `House edge with perfect basic strategy: ${calc !== undefined ? calc.toFixed(2) + '% (exact calculator)' : 'calculating…'}${pub.edge !== null ? ` · ${pub.edge.toFixed(2)}% (Wizard of Odds rule table)` : ''}.`));
  const shuf = el('button', 'btn small', 'Shuffle now (apply deck change)'); shuf.onclick = () => { if (!isOnline()) { driver.shuffleNow(); toast('New shoe before the next round.'); } };
  c1.append(shuf);
  if (isOnline()) c1.append(el('p', 'muted', 'Online tables use the rules chosen when the table was created.'));
  h.append(c1);
  const c2 = el('div', 'card-ui'); c2.append(el('h2', '', 'Table'));
  const restart = () => { if (!isOnline() && driver.view.phase === 'betting') startLocal(); else if (!isOnline()) toast('Applies after this round (open Play, finish the hand, then change again).'); };
  c2.append(
    field('AI players', 'Bea = basic strategy, Carl = counter, Hank = hunches…', () => sel([0, 1, 2, 3, 4, 5, 6].map((n) => [n, String(n)]), S.aiCount, (v) => { S.aiCount = +v; saveSettings(S); restart(); })),
    field('Your seat', '1 = first base (acts first), 7 = third base', () => sel([0, 1, 2, 3, 4, 5, 6].map((n) => [n, String(n + 1)]), S.mySeat, (v) => { S.mySeat = +v; saveSettings(S); restart(); })),
  );
  const refill = el('button', 'btn small', 'Refill play money to $' + S.bankroll); refill.onclick = () => { if (!isOnline()) { localStorage.setItem('bjt.bankroll', String(S.bankroll)); driver.refill(S.bankroll); toast('Bankroll refilled.'); } };
  c2.append(refill); h.append(c2);
  const c3 = el('div', 'card-ui'); c3.append(el('h2', '', 'Training'));
  c3.append(
    field('Show count', 'Running / true count and bet suggestion on the table', () => sw(S.showCount, (v) => { S.showCount = v; saveSettings(S); })),
    field('Highlight correct button', 'Before you act (Coach mode)', () => sw(S.alwaysHint, (v) => { S.alwaysHint = v; saveSettings(S); })),
    field('Grade with index plays', 'Illustrious 18 + Fab 4 at the current true count', () => sw(S.useIndices, (v) => { S.useIndices = v; saveSettings(S); })),
  );
  h.append(c3);
  const c4 = el('div', 'card-ui'); c4.append(el('h2', '', 'Display & sound'));
  c4.append(
    field('Large text & cards', '', () => sw(S.largeText, (v) => { S.largeText = v; saveSettings(S); applyDisplay(); })),
    field('High contrast', '', () => sw(S.contrast, (v) => { S.contrast = v; saveSettings(S); applyDisplay(); })),
    field('Four-color deck', 'Blue diamonds, green clubs', () => sw(S.fourColor, (v) => { S.fourColor = v; saveSettings(S); applyDisplay(); })),
    field('Animation speed', '', () => sel([[0.5, 'Fast'], [1, 'Normal'], [1.6, 'Slow']], S.speed, (v) => { S.speed = +v; table.speed = S.speed; if (driver) driver.speed = S.speed; saveSettings(S); applyDisplay(); })),
    field('Sounds', 'Off by default', () => sw(S.sound, (v) => { S.sound = v; saveSettings(S); blip(); })),
  );
  h.append(c4);
  h.append(el('p', 'muted', 'Play money only. Practice here; never use a phone or any device to count at a real table (illegal in Nevada and most states). Settings, stats and progress are stored only on this device.'));
}

/* ------------------------------ boot ----------------------------------- */
function refreshAll() {
  if (current === 'play' && driver && driver.view) renderActions(driver.view, table.wait() > 0);
  if (current === 'learn') renderLearn(); if (current === 'settings') renderSettings(); if (current === 'stats') renderStats();
}
startLocal();
chartFor(S.rules); edgeFor(S.rules);
addEventListener('resize', () => { if (driver && driver.view && current === 'play') { table.render(driver.view, { mySeat: driver.mySeat }); renderChatPanel(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) { saveStats(stats); saveSession(); } });
if (/join=/.test(location.hash)) show('online'); else show('play');
window.__bj = { get driver() { return driver; }, get stats() { return stats; }, show, setMode, startOnline, get session() { return session; } };
