/* ==========================================================================
 * DRILLS: counting + strategy practice with scoring. Results are stored in
 * stats.drills[id] = [{t, score, n, ms, ...}] (last 50 attempts) and feed the
 * Stats screen. Every drill gives immediate feedback.
 * ======================================================================== */
import { buildShoe, shuffle, cardValue, handValue } from './engine.js';
import { hiLo, decksRemainingEstimate, trueCount, betUnits } from './counting.js';
import { chartAction, countAction, ACTION_NAMES, INDEX_PLAYS, FAB4, indexValue } from './strategy.js';
import { cardEl, el } from './render.js';
import { cryptoRng } from './drivers.js';

const rng = cryptoRng();
const pick = (a) => a[Math.floor(rng() * a.length)];
let uid = 1e6;
const mk = (r, s) => ({ r, s: s ?? Math.floor(rng() * 4), id: ++uid });
const sign = (x) => (x > 0 ? '+' : '') + x;

export const DRILLS = [
  { id: 'values', title: 'Card values', desc: 'Tag each card +1 / 0 / −1 as fast as you can (25 cards).' },
  { id: 'running', title: 'Running count', desc: 'Cards flash in groups; then enter the running count.' },
  { id: 'deck', title: 'Deck countdown', desc: 'Count down a deck with a few cards hidden. Enter the count. Goal: < 30 s, no errors.' },
  { id: 'truecount', title: 'True count + bet', desc: 'Read the discard tray, convert RC to TC, then size the bet.' },
  { id: 'strategy', title: 'Basic strategy flash', desc: 'Random hands, focused on the cells you miss most.' },
  { id: 'index', title: 'Index plays', desc: 'Hand + true count: basic play or deviation?' },
];

function saveResult(ctx, id, r) {
  const arr = (ctx.stats.drills[id] ||= []); arr.push({ t: Date.now(), ...r }); if (arr.length > 50) arr.shift(); ctx.saveStats();
}
function numpad(onDone, { allowNeg = true, label = 'Enter' } = {}) {
  const wrap = el('div'); const entry = el('div', 'entry', '0'); entry.setAttribute('aria-live', 'polite'); let v = '';
  const pad = el('div', 'numpad');
  const show = () => (entry.textContent = v === '' ? '0' : v === '-' ? '−' : v.replace('-', '−'));
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowNeg ? '±' : '', '0', '⌫']) {
    const b = el('button', 'btn', k); if (!k) { b.disabled = true; b.style.visibility = 'hidden'; }
    b.onclick = () => {
      if (k === '⌫') v = v.slice(0, -1);
      else if (k === '±') v = v.startsWith('-') ? v.slice(1) : '-' + v;
      else if (v.replace('-', '').length < 3) v += k;
      show();
    };
    pad.append(b);
  }
  const go = el('button', 'btn primary', label); go.style.marginTop = '8px'; go.style.width = '100%';
  go.onclick = () => onDone(parseInt(v || '0', 10) || 0);
  wrap.append(entry, pad, go);
  return wrap;
}
const fbBox = (ok, title, body) => { const f = el('div', 'fb on ' + (ok ? 'correct' : 'mistake')); f.append(el('div', 't', title)); if (body) f.append(el('div', '', body)); return f; };

export function runDrill(id, host, ctx) {
  host.textContent = '';
  const back = el('button', 'btn small ghost', '‹ All drills'); back.onclick = () => ctx.showDrillList();
  const title = el('h2', '', DRILLS.find((d) => d.id === id).title);
  const stage = el('div', 'drill-stage'); const below = el('div');
  host.append(back, title, stage, below);
  const timers = []; ctx.onLeave(() => timers.forEach(clearTimeout));
  const later = (f, ms) => timers.push(setTimeout(f, ms));
  const cardsRow = (cards) => { const r = el('div', 'cards'); r.style.gap = '6px'; for (const c of cards) { const e = cardEl(c); e.style.marginLeft = '0'; r.append(e); } return r; };

  if (id === 'values') {
    const N = 25; let i = 0, ok = 0; const t0 = performance.now(); let shownAt = 0; const times = [];
    const deck = shuffle(buildShoe(1), rng).slice(0, N).map((c) => ({ ...c, id: ++uid }));
    const btns = el('div', 'row'); const status = el('div', 'muted');
    const next = () => {
      if (i >= N) {
        const ms = performance.now() - t0, avg = times.reduce((a, b) => a + b, 0) / times.length;
        stage.textContent = ''; stage.append(el('div', 'big-num', `${ok}/${N}`), el('div', '', `avg ${(avg / 1000).toFixed(2)} s per card`));
        btns.remove(); saveResult(ctx, id, { score: ok / N, n: N, ms, avg });
        below.append(fbBox(ok === N, ok === N ? 'Perfect!' : 'Keep drilling', ok === N ? 'Next: try the Running count drill.' : 'Remember: 2-6 = +1, 7-9 = 0, tens and aces = −1.'));
        const again = el('button', 'btn primary', 'Again'); again.onclick = () => runDrill(id, host, ctx); below.append(again); return;
      }
      stage.textContent = ''; stage.append(cardsRow([deck[i]]), status); status.textContent = `${i + 1} / ${N}`; shownAt = performance.now();
    };
    for (const v of [-1, 0, 1]) {
      const b = el('button', 'btn ' + (v > 0 ? 'hit' : v < 0 ? 'stand' : ''), sign(v).replace('-', '−')); b.style.minHeight = '60px';
      b.onclick = () => {
        if (i >= N) return;
        times.push(performance.now() - shownAt);
        const right = hiLo(deck[i].r) === v; if (right) ok++;
        if (!right) ctx.toast(`${['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][deck[i].r]} is ${sign(hiLo(deck[i].r))}`);
        i++; next();
      };
      btns.append(b);
    }
    below.append(btns); next();
  }

  if (id === 'running' || id === 'deck') {
    const speedSel = el('div', 'seg'); let speed = ctx.stats.drills._speed || 800;
    for (const [lbl, ms] of [['Slow', 1200], ['Medium', 800], ['Fast', 450], ['Casino', 300]]) {
      const b = el('button', '', lbl); b.setAttribute('aria-pressed', ms === speed); b.onclick = () => { speed = ms; ctx.stats.drills._speed = ms; for (const x of speedSel.children) x.setAttribute('aria-pressed', x === b); };
      speedSel.append(b);
    }
    const start = el('button', 'btn primary', 'Start'); start.style.width = '100%'; start.style.marginTop = '8px';
    const manual = id === 'deck';
    below.append(el('p', 'muted', manual ? 'Tap the card (or wait) to advance. Two cards appear at a time once you are fast. The hidden cards make the answer non-zero.' : 'Watch 12-20 cards dealt 1-3 at a time, then enter the running count.'), speedSel, start);
    stage.append(el('div', 'muted', 'Ready when you are.'));
    start.onclick = () => {
      below.textContent = '';
      let cards, hidden = [];
      if (manual) { const d = shuffle(buildShoe(1), rng).map((c) => ({ ...c, id: ++uid })); const h = 1 + Math.floor(rng() * 3); hidden = d.slice(0, h); cards = d.slice(h); }
      else cards = shuffle(buildShoe(2), rng).slice(0, 12 + Math.floor(rng() * 9)).map((c) => ({ ...c, id: ++uid }));
      const truth = cards.reduce((a, c) => a + hiLo(c.r), 0);
      let i = 0; const t0 = performance.now(); const timer = el('div', 'muted');
      const groups = []; while (i < cards.length) { const g = manual ? (speed <= 450 ? 2 : 1) : 1 + Math.floor(rng() * 3); groups.push(cards.slice(i, i + g)); i += g; }
      let gi = 0;
      const ask = () => {
        const ms = performance.now() - t0;
        stage.textContent = ''; stage.append(el('div', '', manual ? `Done in ${(ms / 1000).toFixed(1)} s. What is the count?` : 'What is the running count?'));
        below.append(numpad((v) => {
          const ok = v === truth;
          saveResult(ctx, id, { score: ok ? 1 : 0, n: cards.length, ms, err: v - truth, speed });
          below.textContent = '';
          const body = manual ? `Count was ${sign(truth)} (hidden cards: ${hidden.map((c) => ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][c.r]).join(', ')} sum to ${sign(-truth)}). Time ${(ms / 1000).toFixed(1)} s${ms < 30000 && ok ? ' — under 30 s!' : ''}.` : `The count was ${sign(truth)}${ok ? '' : `; you were off by ${Math.abs(v - truth)}`}.`;
          below.append(fbBox(ok, ok ? 'Correct' : 'Not quite', body));
          const again = el('button', 'btn primary', 'Again'); again.onclick = () => runDrill(id, host, ctx); below.append(again);
        }));
      };
      const show = () => {
        if (gi >= groups.length) return ask();
        stage.textContent = ''; const row = cardsRow(groups[gi]); stage.append(row, timer);
        timer.textContent = manual ? `${Math.min(cards.length, groups.slice(0, gi + 1).flat().length)} / ${cards.length}` : '';
        gi++;
        if (manual) { stage.onclick = () => { stage.onclick = null; clearTimeout(tm); show(); }; }
        const tm = setTimeout(show, speed); timers.push(tm);
      };
      show();
    };
  }

  if (id === 'truecount') {
    const decks = pick([1, 2, 6, 6, 6, 8].filter((d) => d <= 6));
    const played = Math.round((0.5 + rng() * (decks - 0.75)) * 2) / 2 || 0.5;
    const remaining = decks - played;
    const rc = Math.round((rng() * 2 - 0.8) * 4 * Math.max(1, remaining) * 1.5);
    const cardsLeft = Math.round(remaining * 52 + (rng() * 10 - 5));
    const est = decksRemainingEstimate(cardsLeft), truth = trueCount(rc, cardsLeft);
    const tray = el('div'); tray.style.cssText = 'display:flex;gap:16px;align-items:flex-end';
    const vis = el('div'); vis.style.cssText = `width:70px;height:${Math.max(40, decks * 22)}px;border-radius:6px;background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 2px rgba(255,255,255,.2);position:relative`;
    const pile = el('div'); pile.style.cssText = `position:absolute;left:6px;right:6px;bottom:3px;height:${((decks * 52 - cardsLeft) / 52) * 22}px;background:repeating-linear-gradient(0deg,#f3efe4 0 1px,#b8ae96 1px 2px);border-radius:2px`;
    for (let d = 1; d < decks + 1; d++) { const m = el('div'); m.style.cssText = `position:absolute;left:0;right:0;bottom:${d * 22 + 3}px;border-top:1px dashed rgba(226,194,107,.6)`; vis.append(m); }
    vis.append(pile);
    const info = el('div'); info.append(el('div', '', `${decks}-deck shoe`), el('div', 'big-num', `RC ${sign(rc)}`), el('div', 'muted', 'Tray: dashed line = 1 deck'));
    tray.append(vis, info); stage.append(tray);
    below.append(el('p', '', 'True count (floored)?'));
    below.append(numpad((v) => {
      const ok = v === truth; below.textContent = '';
      below.append(fbBox(ok, ok ? 'Correct' : `True count is ${sign(truth)}`, `About ${(decks * 52 - cardsLeft) / 52 > 0 ? ((decks * 52 - cardsLeft) / 52).toFixed(1) : 0} decks in the tray → ${est} decks left. ${sign(rc)} ÷ ${est} = ${(rc / est).toFixed(2)} → floor ${sign(truth)}.`));
      const units = betUnits(truth, decks);
      below.append(el('p', '', 'Bet with a 1-unit minimum (units)?'));
      below.append(numpad((u) => {
        const okb = u === units;
        saveResult(ctx, id, { score: (ok ? 0.5 : 0) + (okb ? 0.5 : 0), tcOk: ok, betOk: okb });
        below.append(fbBox(okb, okb ? 'Right bet' : `Ramp says ${units} unit${units > 1 ? 's' : ''}`, decks <= 2 ? 'Ramp (1-2 decks): TC≤1 → 1, then TC units, max 4.' : 'Ramp (shoe): TC≤1 → 1, +2 → 2, +3 → 4, +4 → 6, +5 → 8.'));
        const again = el('button', 'btn primary', 'Next'); again.onclick = () => runDrill(id, host, ctx); below.append(again);
      }, { allowNeg: false, label: 'Bet' }));
    }));
  }

  if (id === 'strategy' || id === 'index') {
    const chart = ctx.chart(); if (!chart) { stage.append(el('div', '', 'Building strategy…')); later(() => runDrill(id, host, ctx), 600); return; }
    const rules = ctx.rules(); let n = 0, ok = 0;
    const round = () => {
      below.textContent = ''; stage.textContent = '';
      let cards, up, tc = null, focus = null;
      if (id === 'index') {
        const pool = [...INDEX_PLAYS.filter((p) => !p.kind), ...(rules.surrender === 'late' ? FAB4 : [])];
        focus = pick(pool); up = focus.up;
        if (focus.pair) cards = [mk(10), mk(pick([10, 11, 12, 13]))];
        else { const t = focus.total; let a = Math.max(2, Math.min(10, t - pick([2, 3, 4, 5, 6, 7, 8, 9, 10].filter((x) => t - x >= 2 && t - x <= 10 && x !== t - x)))); cards = [mk(a), mk(Math.min(13, t - a))]; if (t - a === 10) cards[1] = mk(pick([10, 11, 12, 13])); }
        const iv = indexValue(focus, rules); tc = iv + pick([-2, -1, 0, 0, 1, 2]);
      } else {
        // Weighted toward cells you have missed (spaced-repetition-lite).
        const weak = Object.entries(ctx.stats.cells).filter(([, c]) => c.wrong > 0).sort((a, b) => b[1].loss - a[1].loss).slice(0, 12);
        if (weak.length && rng() < 0.45) {
          const [key] = pick(weak); const m = key.match(/^([HSP])(\d+)v(\d+)$/);
          if (m) {
            const [, k, x, u] = m; up = +u;
            if (k === 'P') { cards = [mk(+x === 10 ? 13 : +x), mk(+x)]; }
            else if (k === 'S') { cards = [mk(1), mk(+x - 11)]; }
            else {
              const t = +x; const opts = [];
              for (let a = 2; a <= 10; a++) { const b = t - a; if (b >= 2 && b <= 10 && b !== a) opts.push(a); }
              if (opts.length) { const a = pick(opts); cards = [mk(a === 10 ? pick([10, 11, 12, 13]) : a), mk(t - a === 10 ? pick([10, 11, 12, 13]) : t - a)]; }
            }
          }
        }
        if (!cards || cards.some((c) => c.r < 1 || c.r > 13)) {
          up = pick([2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 1]);
          cards = [mk(Math.floor(rng() * 13) + 1), mk(Math.floor(rng() * 13) + 1)];
          if (handValue(cards).total === 21) cards[1] = mk(5);
        }
      }
      const upCard = mk(up === 10 ? pick([10, 11, 12, 13]) : up);
      const isPair = cardValue(cards[0]) === cardValue(cards[1]);
      const legal = { hit: true, stand: true, double: rules.doubleOn === 'any' || [9, 10, 11].includes(handValue(cards).total), split: isPair, surrender: rules.surrender === 'late' };
      const correct = id === 'index' ? countAction(chart, cards, cardValue(upCard), legal, tc, rules).action : chartAction(chart, cards, cardValue(upCard), legal);
      const d = el('div', 'muted', 'Dealer'); const dr = cardsRow([upCard]); const pr = cardsRow(cards);
      stage.append(d, dr, pr, el('div', '', `You: ${handValue(cards).soft ? 'soft ' : ''}${handValue(cards).total}${tc !== null ? ` · True count ${sign(tc)}` : ''}`));
      const row = el('div', 'row wrap');
      for (const a of ['hit', 'stand', 'double', 'split', 'surrender']) {
        if (!legal[a]) continue;
        const b = el('button', 'btn ' + a, ACTION_NAMES[a]);
        b.onclick = () => {
          n++; const right = a === correct; if (right) ok++;
          row.remove();
          let why = '';
          if (id === 'index') { const iv = indexValue(focus, rules); why = `${focus.name}: index ${sign(iv)}. TC ${sign(tc)} is ${tc >= iv ? 'at/above' : 'below'} it → ${ACTION_NAMES[correct]}.`; }
          else {
            const g = ctx.grade(cards, cardValue(upCard), legal, a);
            why = g.reason;
            ctx.recordDrillDecision(g, cards, cardValue(upCard));
          }
          below.append(fbBox(right, right ? 'Correct' : `Correct play: ${ACTION_NAMES[correct]}`, why), el('div', 'muted', `Score ${ok}/${n}`));
          const nx = el('button', 'btn primary', 'Next hand'); nx.onclick = round; below.append(nx);
          if (n % 10 === 0) saveResult(ctx, id, { score: ok / n, n });
        };
        row.append(b);
      }
      below.append(row);
    };
    round();
  }
}
