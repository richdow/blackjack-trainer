/* ==========================================================================
 * EDUCATION CONTENT: progressive lessons. Tables are generated from the live
 * strategy/counting engines, so they always match the active rules.
 * ======================================================================== */
import { INDEX_PLAYS, FAB4, indexValue, PUBLISHED, publishedEdge, CODE_INFO } from './strategy.js';

const UPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 1];
const upName = (u) => (u === 1 ? 'A' : String(u));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function chartHTML(chart, hl) {
  if (!chart) return '<p class="muted">Building the chart for these rules…</p>';
  const head = '<tr><th></th>' + UPS.map((u) => `<th>${upName(u)}</th>`).join('') + '</tr>';
  const row = (kind, key, label) => '<tr><th>' + label + '</th>' + UPS.map((u) => {
    const c = chart[kind][key][u]; const isHl = hl && hl.kind === kind && String(hl.key) === String(key) && hl.up === u;
    return `<td class="${c}${isHl ? ' hl' : ''}" data-k="${kind}" data-r="${key}" data-u="${u}">${c}</td>`;
  }).join('') + '</tr>';
  let h = '<table class="chart" aria-label="Hard totals">' + head;
  for (let t = 8; t <= 17; t++) h += row('hard', t, t === 8 ? '5-8' : t === 17 ? '17' : t);
  h += '</table><h3>Soft totals</h3><table class="chart" aria-label="Soft totals">' + head;
  for (let t = 13; t <= 20; t++) h += row('soft', t, 'A,' + (t - 11));
  h += '</table><h3>Pairs</h3><table class="chart" aria-label="Pairs">' + head;
  for (const p of [1, 10, 9, 8, 7, 6, 5, 4, 3, 2]) h += row('pair', p, p === 1 ? 'A,A' : p === 10 ? 'T,T' : p + ',' + p);
  h += '</table><p class="muted">' + Object.entries(CODE_INFO).map(([k, v]) => `<b>${k}</b> ${v}`).join(' · ') + '. Hard 18+ always stand. Tap a cell to see its expected values.</p>';
  return h;
}

export function indexHTML(rules) {
  const sign = (x) => (x > 0 ? '+' : '') + x;
  let h = '<table class="plain"><tr><th>Play</th><th class="num">Index</th><th>At/above</th><th>Below</th></tr>';
  for (const p of INDEX_PLAYS) h += `<tr><td>${esc(p.name)}</td><td class="num">${sign(indexValue(p, rules))}${p.idxH17 !== undefined ? ` <span class="muted">(S17 ${sign(p.idx)})</span>` : ''}</td><td>${p.at === 'insure' ? 'Insure' : p.at}</td><td>${p.below === 'noinsure' ? 'Decline' : p.below}</td></tr>`;
  h += '</table><h3>Fab 4 surrenders' + (rules.surrender === 'late' ? '' : ' (this table has no surrender)') + '</h3><table class="plain"><tr><th>Hand</th><th class="num">Surrender at TC ≥</th></tr>';
  for (const p of FAB4) h += `<tr><td>${esc(p.name.replace(' surrender', ''))}</td><td class="num">${sign(indexValue(p, rules))}</td></tr>`;
  return h + '</table><p class="muted">Hi-Lo indices from Don Schlesinger, <i>Blackjack Attack</i> (multi-deck, S17), as republished by Wizard of Odds and countingedge.com. H17 alternates (11 vs A, 10 vs A, 12 vs 6, 15 vs A surrender) from the BJ Insider newsletter #194 footnotes. Your rules: ' + (rules.h17 ? 'H17' : 'S17') + '.</p>';
}

export function variationsHTML(rules, computedEdge) {
  const pub = publishedEdge(rules);
  const P = PUBLISHED;
  const rows = [
    ['Single deck (vs 8 decks)', P.decks[1]], ['Double deck', P.decks[2]], ['Six decks', P.decks[6]],
    ['Dealer hits soft 17', P.h17], ['Blackjack pays 6:5', P.bj65], ['No double after split', P.noDAS],
    ['Double on 10-11 only', P.double1011], ['Double on 9-11 only', P.double911], ['No resplitting (2 hands max)', P.noResplit],
    ['Resplit aces', P.rsa], ['Hit split aces', P.hitSplitAces], ['Late surrender', P.lateSurrender],
  ];
  let h = '<table class="plain"><tr><th>Rule change</th><th class="num">Effect on player</th></tr>';
  for (const [n, v] of rows) h += `<tr><td>${n}</td><td class="num ${v < 0 ? 'g-mistake' : 'g-correct'}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</td></tr>`;
  h += '</table><p class="muted">Source: Wizard of Odds, "Blackjack Rule Variations" (relative to 8 decks, S17, DAS, double any two, split to 4, 3:2; base house edge 0.43%).</p>';
  h += '<h3>Your current rules</h3><table class="plain">';
  for (const it of pub.items) h += `<tr><td>${it.name}</td><td class="num">${it.effect === null ? '—' : (it.effect > 0 ? '+' : '') + it.effect.toFixed(2) + '%'}</td></tr>`;
  h += `<tr><th>House edge (published table, additive)</th><th class="num">${pub.edge === null ? 'n/a' : pub.edge.toFixed(2) + '%'}</th></tr>`;
  h += `<tr><th>House edge (this app's exact calculator)</th><th class="num">${computedEdge === null ? '…' : computedEdge.toFixed(2) + '%'}</th></tr></table>`;
  h += '<p class="muted">Our calculator computes the game exactly for a fresh shoe with optimal two-card decisions (no cut-card effect). Published effects are approximately additive. Shop for 3:2 blackjack first; 6:5 costs more than every other rule combined.</p>';
  return h;
}

/** Lessons in teaching order; `drill` links to a drill id. */
export function lessons(ctx) {
  const { chart, rules, edge } = ctx;
  return [
    { id: 'rules', title: 'How the game works', drill: null, html: `
      <p>You and the dealer each start with two cards; the dealer shows one (the <b>upcard</b>). Cards 2-10 count face value, J/Q/K count 10, an ace counts 1 or 11. A hand with an ace counted as 11 is <b>soft</b> (it can't bust on the next card).</p>
      <p>Get closer to 21 than the dealer without going over. Two-card 21 is a <b>blackjack</b> and pays ${rules.bjPays === 1.2 ? '6:5' : '3:2'}; other wins pay 1:1, ties push. A&nbsp;+&nbsp;10 after splitting is just 21.</p>
      <p>The dealer has no choices: draws to 17 and ${rules.h17 ? '<b>hits soft 17</b>' : '<b>stands on all 17s</b>'}. The house edge comes from one thing: <b>you act first</b>, so if you bust you lose even if the dealer busts later.</p>
      <p><b>Your options:</b> Hit, Stand, Double (double the bet, take exactly one card${rules.doubleOn === 'any' ? ', any two cards' : ', ' + rules.doubleOn + ' only'}), Split a pair (up to ${rules.maxSplitHands} hands; ${rules.das ? 'double after split allowed' : 'no doubling after split'}; split aces get one card each), ${rules.surrender === 'late' ? 'Surrender (give up half the bet before acting, after the dealer checks for blackjack), ' : ''}and Insurance (only when the dealer shows an ace).</p>` },
    { id: 'basic', title: 'Basic strategy for your rules', drill: 'strategy', html: `
      <p>Basic strategy is the mathematically best play for every hand vs every upcard. This chart is <b>computed live</b> from the exact rules you've chosen (${rules.decks} deck${rules.decks > 1 ? 's' : ''}, ${rules.h17 ? 'H17' : 'S17'}, ${rules.das ? 'DAS' : 'no DAS'}, ${rules.surrender === 'late' ? 'late surrender' : 'no surrender'}), and matches the Wizard of Odds published charts.</p>
      <div class="chartwrap">${chartHTML(chart)}</div>
      <h3>Patterns that make it easy</h3>
      <ul><li>Dealer 2-6 is weak (busts 35-42%): stand on stiff 12-16 (except 12 vs 2-3), double and split aggressively.</li>
      <li>Dealer 7-A is strong: hit stiffs until 17.</li><li>Always split aces and 8s; never split 10s or 5s.</li>
      <li>Soft 17 or less: never stand. Soft 18: stand vs 2/7/8, double vs 3-6, hit vs 9/10/A.</li><li>Never take insurance (without counting).</li></ul>
      <p class="muted">Perfect basic strategy under these rules: house edge about ${edge === null ? '…' : edge.toFixed(2) + '%'}.</p>` },
    { id: 'ev', title: 'Why: expected value and the grading', drill: null, html: `
      <p>Every decision has an <b>expected return</b>: the average result per $1 bet if you played the hand millions of times. The app computes these exactly from the cards remaining (dealer outcomes are enumerated, not simulated).</p>
      <p>After each decision you'll see: <span class="g-correct">Correct</span> (the best play), <span class="g-slight">Slightly suboptimal</span> (costs less than 0.5% of the bet; a close call), or <span class="g-mistake">Mistake</span> (costs 0.5% or more, with the right play and why).</p>
      <p>Mistakes add straight onto the house edge. Standing on 12 vs 7 costs about ${chart && chart.ev.hard[12] ? Math.round((chart.ev.hard[12][7].hit - chart.ev.hard[12][7].stand) * 100) : 10}% of that bet; over a session a few leaks like that can triple the casino's edge. The Stats tab tracks exactly how much your errors cost.</p>` },
    { id: 'hilo', title: 'Card counting 1: Hi-Lo values', drill: 'values', html: `
      <p>Big cards (10s and aces) help you: more blackjacks (paid 3:2 to you, only 1:1 to the dealer), better doubles, and more dealer busts. Small cards help the dealer.</p>
      <table class="plain"><tr><th>Cards</th><th class="num">Hi-Lo value</th></tr><tr><td>2, 3, 4, 5, 6</td><td class="num g-correct">+1</td></tr><tr><td>7, 8, 9</td><td class="num">0</td></tr><tr><td>10, J, Q, K, A</td><td class="num g-mistake">−1</td></tr></table>
      <p>Every deck sums to 0. A positive count means the remaining cards are rich in tens and aces.</p>
      <p>Tip: learn to cancel pairs: a 5 and a K together are 0, so you can skip them.</p>` },
    { id: 'running', title: 'Card counting 2: the running count', drill: 'running', html: `
      <p>Start at 0 after the shuffle and add the value of every card you see: everyone's cards, the dealer's upcard, the hole card when it's turned over, and every hit.</p>
      <p>Goal: count down a full deck in under 30 seconds with zero errors. Try the Deck countdown drill. At the table, count in pairs and keep a running total; never move your lips.</p>
      <p>On the Play tab, turn on <b>Show count</b> to check yourself, or use <b>Count practice</b> mode, where the count is hidden and you're quizzed between hands.</p>` },
    { id: 'true', title: 'Card counting 3: true count', drill: 'truecount', html: `
      <p>A running count of +6 means a lot with one deck left and little with five. Divide by the decks <b>remaining</b>:</p>
      <p style="text-align:center"><b>True count = running count ÷ decks remaining</b></p>
      <p>Estimate decks remaining by looking at the discard tray (decks played) and subtracting from the shoe size. Round to the nearest half deck. This app floors the true count (+2.7 → +2, −0.4 → −1), which is the standard convention.</p>
      <p>Example: 6-deck shoe, 2 decks in the tray → 4 remaining. RC +8 → TC +2.</p>` },
    { id: 'betting', title: 'Card counting 4: betting with the count', drill: 'truecount', html: `
      <p>Each +1 of true count is worth roughly <b>+0.5%</b> to you. With a ${edge === null ? '~0.5' : edge.toFixed(2)}% house edge, you have the advantage from about TC +${edge === null ? 1 : Math.max(1, Math.ceil(edge / 0.5))}.</p>
      <table class="plain"><tr><th>True count</th><th class="num">Bet (units)</th></tr><tr><td>≤ +1</td><td class="num">1 (table minimum)</td></tr>${rules.decks <= 2 ? '<tr><td>+2</td><td class="num">2</td></tr><tr><td>+3</td><td class="num">3</td></tr><tr><td>+4 or more</td><td class="num">4</td></tr>' : '<tr><td>+2</td><td class="num">2</td></tr><tr><td>+3</td><td class="num">4</td></tr><tr><td>+4</td><td class="num">6</td></tr><tr><td>+5 or more</td><td class="num">8</td></tr>'}</table>
      <p>A 1-to-8 spread like this is common for shoe games (1-to-4 for one or two decks). Bigger spreads earn more but draw attention. The bankroll needs to be large (often 100+ top bets) because variance is huge even with an edge.</p>` },
    { id: 'index', title: 'Card counting 5: index plays (deviations)', drill: 'index', html: `
      <p>The count also changes the best <i>play</i>. These are the 18 most valuable deviations (the "Illustrious 18") plus the "Fab 4" surrenders. Make the listed play when the true count is <b>at or above</b> the index.</p>${indexHTML(rules)}
      <p>Insurance at +3 is the single most valuable deviation. 16 vs 10 at 0 is next: stand at any non-negative count.</p>` },
    { id: 'variations', title: 'Casino rules and the house edge', drill: null, html: variationsHTML(rules, edge) },
    { id: 'casino', title: 'At a real casino', drill: null, html: `
      <ul><li><b>Hand signals:</b> tap the felt to hit, wave a flat hand to stand. Double or split by placing a matching stack next to your bet (say "double" or "split"). In face-up shoe games you never touch the cards.</li>
      <li>Read the felt: "Blackjack pays 3 to 2" and "Dealer stands/hits soft 17". Walk away from 6:5.</li>
      <li>The <b>cut card</b> sets penetration. Deeper penetration (75%+) is better for counters.</li>
      <li>Card counting with your own mind is legal, but casinos can back you off or ban you, and many shuffle early when bets jump.</li>
      <li><b>Never use a phone or any device to count or decide at a real table.</b> In Nevada that is a felony (NRS 465.075), and most states have similar laws. Practice here, play from memory there.</li>
      <li>Set a loss limit before you sit down. Even perfect basic strategy loses over time; only counting with good rules and penetration gives a small edge.</li></ul>` },
  ];
}
