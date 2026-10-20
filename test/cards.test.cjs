/* Card legibility + layout geometry test (Playwright).
 * For every rank A..K in red and black, at 320x568, 390x844, 412x915 and 844x390:
 *  - the corner index never intersects a pip / face panel,
 *  - a "10" never overflows its index column,
 *  - in a fanned hand the next card never covers the underlying card's index (player and AI-seat sizes),
 *  - the felt rules text fits the felt and doesn't touch the dealer or seat cards,
 *  - result badges (WIN/LOSE...) never overlap any card face.
 * Writes shots/cards-after.png (390 wide gallery) and shots/table-portrait-after.png.
 * Run: (cd dist && python3 -m http.server 8768) & URL=http://127.0.0.1:8768/ node test/cards.test.cjs */
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8768/';
const OUT = process.env.OUT || __dirname + '/../shots';
let fails = 0; const check = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

async function gallery(p) {
  return p.evaluate(() => {
    const g = document.createElement('div'); g.id = 'gal';
    g.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0e5a3a;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px;color:#fff;font:12px system-ui';
    const mk = (r, s, id) => window.__bj.cardEl({ r, s, id });
    let id = 1;
    for (const mini of [false, true]) {
      const t = document.createElement('div'); t.textContent = mini ? 'AI seats (small cards)' : 'Your seat / dealer'; g.append(t);
      const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 10px';
      for (let r = 1; r <= 13; r++) {
        const seat = document.createElement('div'); seat.className = 'seat' + (mini ? '' : ' me'); seat.style.cssText = 'position:static;transform:none;min-width:0';
        const hand = document.createElement('div'); hand.className = 'hand';
        const cards = document.createElement('div'); cards.className = 'cards';
        cards.append(mk(r, 0, id++), mk(r, 1, id++), mk(r === 13 ? 1 : r + 1, r % 2 ? 2 : 3, id++));
        hand.append(cards); seat.append(hand); row.append(seat);
      }
      g.append(row);
    }
    document.body.append(g);
    // geometry
    const R = (e) => e.getBoundingClientRect();
    const hit = (a, b, pad = 0) => a.left < b.right - pad && b.left < a.right - pad && a.top < b.bottom - pad && b.top < a.bottom - pad;
    const problems = [];
    for (const card of g.querySelectorAll('.card')) {
      const ix = card.querySelector('.ix'), ir = R(ix), cr = R(card);
      const lab = card.getAttribute('aria-label') + (card.closest('.seat.me') ? '' : ' (small)');
      if (ir.right > cr.right || ir.bottom > cr.bottom || ir.left < cr.left) problems.push(lab + ': index outside card');
      const rk = card.querySelector('.rk'); const rr = R(rk);
      if (rr.left < ir.left - 0.5 || rr.right > ir.right + 0.5) problems.push(lab + `: rank wider than index column (${rr.width.toFixed(1)} > ${ir.width.toFixed(1)})`);
      for (const x of card.querySelectorAll('.pips i, .face')) { if (x.offsetParent === null) continue; if (hit(ir, R(x))) problems.push(lab + ': index touches ' + (x.className || 'pip')); }
      const next = card.nextElementSibling;
      if (next) { const nr = R(next); if (nr.left < ir.right + 1) problems.push(lab + `: covered by next card (${(ir.right - nr.left + 1).toFixed(1)}px)`); }
    }
    return problems;
  });
}

(async () => {
  const b = await chromium.launch();
  for (const [w, h] of [[320, 568], [390, 844], [412, 915], [844, 390]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p.goto(URL); await p.waitForTimeout(1200);
    // felt print fit (portrait only; hidden on short landscape felt)
    const felt = await p.evaluate(() => {
      const pr = document.querySelector('.felt-print'); if (!pr || getComputedStyle(pr).display === 'none') return { hidden: true };
      const range = document.createRange(); range.selectNodeContents(pr); const rects = [...range.getClientRects()];
      const felt = pr.parentElement.getBoundingClientRect();
      const out = rects.some((r) => r.left < felt.left - 0.5 || r.right > felt.right + 0.5);
      return { hidden: false, out, w: Math.max(...rects.map((r) => r.width)), fw: felt.width };
    });
    check(felt.hidden || !felt.out, `${w}x${h}: felt rules text fits (${felt.hidden ? 'hidden' : felt.w.toFixed(0) + ' of ' + felt.fw.toFixed(0) + 'px'})`);
    // play a round to settle and check badges + felt vs cards
    await p.getByRole('button', { name: 'Deal', exact: true }).click();
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(600);
      const st = await p.evaluate(() => window.__bj.driver.view.phase);
      if (st === 'settled') break;
      for (const n of ['No insurance', 'No, play it', 'Stand']) { const bt = p.getByRole('button', { name: n, exact: true }); if (await bt.count() && await bt.first().isEnabled()) { await bt.first().click({ timeout: 1500 }).catch(() => {}); break; } }
    }
    await p.waitForTimeout(1500);
    const lay = await p.evaluate(() => {
      const R = (e) => e.getBoundingClientRect();
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const cards = [...document.querySelectorAll('.table .card, .felt .card, section.play .card')].filter((c) => !c.classList.contains('flight')).map(R);
      const res = [...document.querySelectorAll('.res')].map(R);
      const badgeHits = res.filter((r) => cards.some((c) => hit(r, c))).length;
      const pr = document.querySelector('.felt-print'); let printHits = 0;
      if (pr && getComputedStyle(pr).display !== 'none') { const range = document.createRange(); range.selectNodeContents(pr); const lines = [...range.getClientRects()]; const blockers = [...document.querySelectorAll('section.play .card, .dealer .total, .seat .nm, .seat .total, .seat .betchip')].map(R); printHits = lines.filter((l) => blockers.some((b) => hit(l, b))).length; window.__printHit = lines.flatMap((l) => [...document.querySelectorAll('section.play .card, .dealer .total, .seat .nm, .seat .total, .seat .betchip')].filter((b) => hit(l, R(b))).map((b) => b.className + ' ' + JSON.stringify(R(b)) + ' line ' + JSON.stringify(l))); }
      return { badges: res.length, badgeHits, printHits };
    });
    check(lay.badgeHits === 0, `${w}x${h}: ${lay.badges} result badges, none over a card`);
    check(lay.printHits === 0, `${w}x${h}: felt text clear of dealer/seat cards and labels` + (lay.printHits ? ' ' + (await p.evaluate(() => window.__printHit.join('\n'))) : ''));
    if (w === 390) await p.screenshot({ path: OUT + '/table-portrait-after.png' });
    if (w === 412) await p.screenshot({ path: OUT + '/table-412-after.png' });
    const probs = await gallery(p);
    check(probs.length === 0, `${w}x${h}: all ranks A-K red+black legible, no index/pip overlap, fan keeps index visible` + (probs.length ? '\n   ' + probs.slice(0, 12).join('\n   ') : ''));
    if (w === 390) await p.screenshot({ path: OUT + '/cards-after.png' });
    if (w === 844) await p.screenshot({ path: OUT + '/cards-after-landscape.png' });
    check(errs.length === 0, `${w}x${h}: no page errors ${errs.join(' | ')}`);
    await ctx.close();
  }
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
