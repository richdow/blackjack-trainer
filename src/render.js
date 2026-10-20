/* ==========================================================================
 * UI: table renderer. Pure presentation: takes a public view and draws it.
 * Cards are keyed by their deal id so every new card animates from the shoe
 * (Web Animations API, GPU transforms only) and the hole card flips in 3D.
 * ======================================================================== */
import { SUITS, RANK_LABEL, handValue } from './engine.js';

export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

// Classic pip layouts (x%, y%, flipped) inside the pip box for 2..10.
const PIPS = {
  2: [[50, 0], [50, 100, 1]], 3: [[50, 0], [50, 50], [50, 100, 1]],
  4: [[0, 0], [100, 0], [0, 100, 1], [100, 100, 1]], 5: [[0, 0], [100, 0], [50, 50], [0, 100, 1], [100, 100, 1]],
  6: [[0, 0], [100, 0], [0, 50], [100, 50], [0, 100, 1], [100, 100, 1]],
  7: [[0, 0], [100, 0], [50, 25], [0, 50], [100, 50], [0, 100, 1], [100, 100, 1]],
  8: [[0, 0], [100, 0], [50, 25], [0, 50], [100, 50], [50, 75, 1], [0, 100, 1], [100, 100, 1]],
  9: [[0, 0], [100, 0], [0, 33], [100, 33], [50, 50], [0, 67, 1], [100, 67, 1], [0, 100, 1], [100, 100, 1]],
  10: [[0, 0], [100, 0], [50, 17], [0, 33], [100, 33], [0, 67, 1], [100, 67, 1], [50, 83, 1], [0, 100, 1], [100, 100, 1]],
};

/** Build a card element. Face-down cards get their face filled in when revealed. */
export function cardEl(c) {
  const e = el('div', 'card');
  e.dataset.id = c.id;
  const inn = el('div', 'in'); const f = el('div', 'f'); const b = el('div', 'b');
  inn.append(f, b); e.append(inn);
  if (c.down || !c.r) e.classList.add('down'); else fillFace(e, c);
  return e;
}
export function fillFace(e, c) {
  const f = e.querySelector('.f'); f.textContent = '';
  const s = SUITS[c.s], r = RANK_LABEL[c.r];
  e.classList.toggle('red', c.s === 1 || c.s === 2); e.classList.add('s' + c.s);
  e.setAttribute('role', 'img');
  e.setAttribute('aria-label', `${({ A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King' })[r] || r} of ${['spades', 'hearts', 'diamonds', 'clubs'][c.s]}`);
  const ix = el('div', 'ix'); ix.dataset.s = s; ix.append(document.createTextNode(r)); ix.append(el('i', '', s));
  const ix2 = ix.cloneNode(true); ix2.classList.add('br');
  f.append(ix, ix2);
  if (c.r >= 11) { f.append(el('div', 'face', r + s)); }
  else if (c.r === 1) { const p = el('div', 'pips'); const i = el('i', 'big', s); i.style.left = '50%'; i.style.top = '50%'; p.append(i); f.append(p); }
  else { const p = el('div', 'pips'); for (const [x, y, fl] of PIPS[c.r]) { const i = el('i', fl ? 'flip' : '', s); i.style.left = x + '%'; i.style.top = y + '%'; p.append(i); } f.append(p); }
  e.dataset.r = c.r;
}

const fmt$ = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
export const money = (n) => (n < 0 ? '−$' : '$') + fmt$(Math.abs(n));
const chipClass = (b) => (b >= 500 ? 'b500' : b >= 100 ? 'b100' : b >= 25 ? 'b25' : '');
export function totalLabel(cards, fromSplit) {
  const shown = cards.filter((c) => c.r && !c.down);
  if (!shown.length) return '';
  const v = handValue(shown, fromSplit);
  if (v.blackjack && shown.length === cards.length) return 'BJ';
  return v.soft && v.total < 21 ? `${v.total - 10}/${v.total}` : String(v.total);
}

export class TableView {
  constructor(root) {
    this.root = root; this.cards = new Map(); this.busyUntil = 0; this.lastShuffles = null; this.speed = 1;
    root.classList.add('felt');
    root.innerHTML = '';
    this.tray = el('div', 'tray'); this.tray.innerHTML = '<div class="cap">Discards</div><div class="box"><div class="pile"></div><div class="marks"></div></div>';
    this.shoe = el('div', 'shoe'); this.shoe.innerHTML = '<div class="cap">Shoe</div><div class="box"><div class="stack"></div><div class="cut"></div></div><div class="mouth"></div>';
    this.shuf = el('div', 'shufflefx'); this.shuf.innerHTML = '<i></i><i></i><i></i><span>Shuffling…</span>';
    this.dealer = el('div', 'dealer');
    this.dealerCards = el('div', 'cards'); this.dealerTotal = el('div', 'total');
    this.dealer.append(el('div', 'label', 'Dealer'), this.dealerCards, this.dealerTotal);
    this.print = el('div', 'felt-print');
    this.seats = el('div', 'seats');
    this.hud = el('div', 'hud'); this.hud.setAttribute('aria-live', 'off');
    this.net = el('div', 'netbar'); this.net.style.display = 'none';
    this.preview = el('div', 'preview-msg');
    root.append(this.print, this.tray, this.shoe, this.shuf, this.dealer, this.seats, this.hud, this.net, this.preview);
  }
  wait() { return Math.max(0, this.busyUntil - performance.now()); }
  setPrint(rules) {
    this.print.innerHTML = '';
    const b = el('b', '', `Blackjack pays ${rules.bjPays === 1.2 ? '6 to 5' : '3 to 2'}`);
    this.print.append(b, document.createTextNode(`Dealer ${rules.h17 ? 'hits' : 'stands on'} soft 17`), el('br'), document.createTextNode('Insurance pays 2 to 1'));
  }
  /** Seat geometry: me bottom-centre, others on an arc right (first base) to left (third base). */
  layout(view, mySeat) {
    const land = innerWidth > innerHeight;
    const others = []; for (let i = 0; i < 7; i++) if (i !== mySeat) others.push(i);
    // Landscape (short felt): spread seats wider and lift them so the player's chips stay on screen.
    const xs = land ? [93, 79, 64, 36, 21, 7] : [91, 76, 61, 39, 24, 9], ys = land ? [36, 41, 44, 44, 41, 36] : [46, 50, 52, 52, 50, 46];
    const pos = {}; others.forEach((s, k) => (pos[s] = [xs[k], ys[k]]));
    pos[mySeat] = [50, land ? 49 : 66];
    return pos;
  }
  render(view, { mySeat = -1, names = {}, deadline = null, deadlineKind = null } = {}) {
    if (!view) return;
    this.setPrint(view.rules);
    const now = performance.now();
    let delay = Math.max(0, this.busyUntil - now);
    // Shuffle animation whenever a new shoe was started.
    if (this.lastShuffles !== null && view.shuffles !== this.lastShuffles) {
      this.shuf.classList.add('on');
      const d = 1600 * this.speed;
      setTimeout(() => this.shuf.classList.remove('on'), delay + d);
      delay += d;
    }
    this.lastShuffles = view.shuffles;
    // Shoe and discard tray (cut card position shown to scale).
    const total = view.shoe.total, left = view.shoe.left;
    this.shoe.querySelector('.stack').style.width = `calc((100% - 23px) * ${(left / total).toFixed(3)})`;
    this.shoe.querySelector('.stack').style.height = '30px';
    const cut = this.shoe.querySelector('.cut');
    cut.style.left = `calc(7px + (100% - 23px) * ${((total - view.shoe.cut) / total).toFixed(3)})`;
    cut.style.display = view.cutCardOut ? 'none' : '';
    this.shoe.title = `${left} cards left of ${total}`;
    const trayH = 50, deckPx = trayH / view.shoe.decks;
    this.tray.querySelector('.pile').style.height = Math.min(trayH, (view.discards / 52) * deckPx).toFixed(1) + 'px';
    this.tray.style.setProperty('--deckpx', deckPx.toFixed(2) + 'px');
    this.tray.title = `${view.discards} cards in the discard tray (gold lines = 1 deck)`;

    // Collect card placements.
    const queue = []; const seen = new Set();
    const place = (container, c, isDealer, idx) => {
      seen.add(c.id);
      let e = this.cards.get(c.id);
      if (!e) {
        e = cardEl(c); this.cards.set(c.id, e); container.append(e);
        queue.push({ kind: 'new', e, id: c.id, late: isDealer && idx >= 2 });
      } else {
        if (e.parentNode !== container) container.append(e);
        if (e.classList.contains('down') && c.r && !c.down) { fillFace(e, c); queue.push({ kind: 'flip', e, id: c.id }); }
      }
    };
    this.dealerCards.textContent = '';
    for (const [i, c] of view.dealer.cards.entries()) { place(this.dealerCards, c, true, i); }
    // Re-append in order (moving keeps elements; order matters for overlap).
    for (const c of view.dealer.cards) this.dealerCards.append(this.cards.get(c.id));

    const pos = this.layout(view, mySeat);
    this.seats.textContent = '';
    const labels = [];
    view.seats.forEach((s, i) => {
      const seat = el('div', 'seat' + (i === mySeat ? ' me' : '') + (s ? '' : ' empty'));
      seat.style.left = pos[i][0] + '%'; seat.style.top = pos[i][1] + '%';
      seat.dataset.seat = i;
      if (!s) {
        const spot = el('button', 'spot', view.online ? 'Sit' : ''); spot.dataset.sit = i; spot.setAttribute('aria-label', 'Empty seat ' + (i + 1)); spot.tabIndex = -1;
        seat.append(spot); this.seats.append(seat); return;
      }
      const hands = el('div', 'hands');
      const isTurn = view.turn && view.turn.seat === i;
      if (!s.hands.length) {
        const spot = el('div', 'spot');
        if (s.bet) { const ch = el('div', 'betchip ' + chipClass(s.bet), fmt$(s.bet)); spot.textContent = ''; spot.append(ch); }
        hands.append(spot);
      }
      s.hands.forEach((h, hi) => {
        const he = el('div', 'hand' + (isTurn && view.turn.hand === hi && view.phase === 'playing' ? ' active' : ''));
        const ce = el('div', 'cards');
        for (const c of h.cards) place(ce, c, false);
        for (const c of h.cards) ce.append(this.cards.get(c.id));
        const tot = el('div', 'total');
        const chip = el('div', 'betchip ' + chipClass(h.bet), fmt$(h.bet) + (h.doubled ? '×2' : ''));
        if (h.doubled) chip.textContent = fmt$(h.bet);
        he.append(ce, tot);
        if (i === mySeat || s.hands.length === 1) he.append(chip);
        labels.push(() => {
          tot.textContent = totalLabel(h.cards, h.fromSplit);
          if (h.result) { const r = el('div', 'res ' + h.result, ({ win: 'WIN', lose: 'LOSE', bust: 'BUST', push: 'PUSH', blackjack: 'BLACKJACK', surrender: 'SURRENDER' })[h.result]); he.append(r); }
        });
        hands.append(he);
      });
      const nm = el('div', 'nm' + (isTurn && view.phase === 'playing' ? ' turn' : ''), (names[i] || s.name) + ' · ' + money(s.bankroll));
      const act = el('div', 'act', s.last || '');
      seat.append(hands, nm, act);
      if (isTurn && deadline && deadlineKind === 'turn') {
        const t = el('div', 'timer'); const bar = el('i'); t.append(bar); t.style.visibility = 'visible';
        const ms = Math.max(0, deadline - Date.now());
        bar.animate([{ transform: `scaleX(${Math.min(1, ms / 30000)})` }, { transform: 'scaleX(0)' }], { duration: ms, fill: 'forwards' });
        seat.append(t);
      }
      this.seats.append(seat);
    });
    // Remove cards no longer on the table (round cleared).
    for (const [id, e] of this.cards) if (!seen.has(id)) { e.remove(); this.cards.delete(id); }

    // Animate: player/first-two dealer cards in deal order, then the hole-card flip, then dealer hits.
    const first = queue.filter((q) => q.kind === 'new' && !q.late).sort((a, b) => a.id - b.id);
    const flips = queue.filter((q) => q.kind === 'flip');
    const late = queue.filter((q) => q.kind === 'new' && q.late).sort((a, b) => a.id - b.id);
    const step = 260 * this.speed, sr = this.shoe.getBoundingClientRect();
    const fly = (e, d) => {
      const r = e.getBoundingClientRect();
      const dx = sr.left + sr.width / 2 - (r.left + r.width / 2), dy = sr.top + sr.height / 2 - (r.top + r.height / 2);
      e.animate([{ transform: `translate(${dx}px, ${dy}px) rotate(-12deg) scale(.6)`, opacity: 0.85 }, { transform: 'none', opacity: 1 }], { duration: 340 * this.speed, delay: d, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' });
    };
    for (const q of first) { fly(q.e, delay); delay += step; }
    for (const q of flips) { const e = q.e; e.classList.add('down'); setTimeout(() => e.classList.remove('down'), delay); delay += 450 * this.speed; }
    for (const q of late) { fly(q.e, delay); delay += step + 120 * this.speed; }
    this.busyUntil = now + delay + (queue.length ? 200 * this.speed : 0);
    const showLabels = () => {
      for (const f of labels) f();
      this.dealerTotal.textContent = totalLabel(view.dealer.cards);
    };
    clearTimeout(this.labelTimer);
    this.dealerTotal.textContent = '';
    if (delay > 0) this.labelTimer = setTimeout(showLabels, delay + 60); else showLabels();
    return delay;
  }
  /** Sweep every card on the table into the discard tray (end of round). */
  sweep() {
    const tr = this.tray.getBoundingClientRect(); let d = 0;
    for (const e of this.cards.values()) {
      const r = e.getBoundingClientRect();
      e.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${tr.left + tr.width / 2 - r.left - r.width / 2}px, ${tr.top + tr.height / 2 - r.top - r.height / 2}px) scale(.4) rotate(90deg)`, opacity: 0.2 }], { duration: 320 * this.speed, delay: d, easing: 'ease-in', fill: 'forwards' });
      d += 18;
    }
    return 320 * this.speed + d;
  }
  setHud(html, hidden) { this.hud.innerHTML = html; this.hud.classList.toggle('hidden-count', !!hidden); this.hud.style.display = html ? '' : 'none'; }
}
