/* Playwright UI test (iPhone portrait 390x844 and landscape 844x390).
 * Fails on any console error/warning or page error. Also produces the screenshots in shots/.
 * Run: node test/ui.test.cjs   (env: URL=http://127.0.0.1:8768/  API=http://127.0.0.1:8797 for the local worker) */
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://127.0.0.1:8768/';
const API = process.env.API || 'http://127.0.0.1:8797';
const OUT = process.env.OUT || __dirname + '/../shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.log('FAIL', msg); } else console.log('ok  ', msg); };

async function page(b, vw, vh, errs, tag) {
  const ctx = await b.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(`${tag} ${m.type()}: ${m.text()}`); });
  p.on('pageerror', (e) => errs.push(`${tag} pageerror: ${e.message}`));
  return p;
}
const btn = (p, name) => p.getByRole('button', { name, exact: true });
async function clickIf(p, name) {
  const b = btn(p, name);
  try { if (await b.count() && await b.first().isEnabled()) { await b.first().click({ timeout: 2000 }); return true; } } catch (_) { /* re-rendered mid-click; retry next loop */ }
  return false;
}

/** Play rounds, deliberately making an obvious mistake, until the feedback banner shows one. */
async function playUntilMistake(p, wantMistake = true) {
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    if (await clickIf(p, 'Deal')) continue;
    if (await clickIf(p, 'No insurance') || await clickIf(p, 'No, play it')) continue;
    const stand = p.locator('.actions .btn.stand:not([disabled])');
    if (await stand.count()) {
      const info = await p.locator('.actions .hint').first().textContent();
      const m = /Your (soft )?(\d+) vs/.exec(info || ''); if (!m) continue;
      const soft = !!m[1], n = +m[2];
      let a = 'stand';
      if (wantMistake) a = !soft && n >= 17 ? 'hit' : n <= 11 ? 'stand' : 'stand';
      await p.locator(`.actions .btn.${a}`).first().click();
      await sleep(500);
      if (wantMistake && await p.locator('#fb.mistake').count()) return true;
      continue;
    }
    if (await clickIf(p, 'Next round')) continue;
  }
  return false;
}


/** Play n decisions following the on-screen suggestion, with an occasional deliberate deviation. */
async function playDecisions(p, n) {
  let k = 0;
  for (let i = 0; i < n * 12 && k < n; i++) {
    await sleep(450);
    if (await clickIf(p, 'Deal')) continue;
    if (await clickIf(p, 'No insurance') || await clickIf(p, 'No, play it')) continue;
    const sug = p.locator('.actions .btn.suggest:not([disabled])');
    if (await sug.count()) {
      k++;
      if (k % 7 === 0) { const alt = p.locator('.actions .row .btn:not(.suggest):not([disabled])').filter({ hasText: /^(Hit|Stand)$/ }); if (await alt.count()) { await alt.first().click(); continue; } }
      await sug.first().click(); continue;
    }
    if (await clickIf(p, 'Next round')) continue;
  }
  return k;
}

(async () => {
  const b = await chromium.launch();
  const errs = [];
  // ---------- portrait: table, feedback, drill, stats ----------
  const p = await page(b, 390, 844, errs, '[portrait]');
  await p.goto(URL + (process.env.LOCALAPI ? '?api=' + encodeURIComponent(API) : ''));
  await sleep(1500);
  check(await p.locator('.seat').count() >= 3, 'table renders seats');
  // Tap targets >= 44px
  const small = await p.$$eval('nav.tabs button, .actions .btn', (bs) => bs.filter((x) => x.offsetParent && (x.getBoundingClientRect().height < 44 || x.getBoundingClientRect().width < 44)).map((x) => x.textContent.trim()));
  check(small.length === 0, 'touch targets >= 44px ' + small.join(','));
  await clickIf(p, 'Deal'); await sleep(2600);
  await p.screenshot({ path: OUT + '/bj-1-table.png' });
  check(await p.locator('.card').count() >= 4, 'cards dealt');
  const mistake = await playUntilMistake(p);
  check(mistake, 'mistake feedback shown');
  if (mistake) {
    const t = await p.locator('#fb').textContent();
    check(/Mistake/.test(t) && /because/i.test(t), 'feedback explains why: ' + t.slice(0, 120));
    await p.screenshot({ path: OUT + '/bj-2-feedback.png' });
  }
  // Build up some history for the stats screen: follow hints (alwaysHint on) with a few deviations.
  await p.evaluate(() => { const k = 'bjt.settings.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.alwaysHint = true; localStorage.setItem(k, JSON.stringify(s)); });
  await p.reload(); await sleep(1200);
  const played = await playDecisions(p, 30);
  check(played >= 15, 'played ' + played + ' decisions following the suggestion');
  // Count drill
  await p.locator('nav.tabs [data-go="drills"]').click(); await sleep(300);
  await p.getByText('True count + bet', { exact: true }).click(); await sleep(1200);
  await p.screenshot({ path: OUT + '/bj-3-count-drill.png' });
  check(await p.locator('#screen-drills input, section[data-screen="drills"] input, section[data-screen="drills"] button').count() > 0, 'drill renders controls');
  // Stats
  await p.locator('nav.tabs [data-go="stats"]').click(); await sleep(500);
  check(/%/.test(await p.locator('section[data-screen="stats"]').textContent()), 'stats show percentages');
  await p.screenshot({ path: OUT + '/bj-6-stats.png' });
  // Learn + settings render
  await p.locator('nav.tabs [data-go="learn"]').click(); await sleep(300);
  check((await p.locator('section[data-screen="learn"]').textContent()).includes('Hi-Lo'), 'learn renders');
  await p.locator('nav.tabs [data-go="settings"]').click(); await sleep(300);
  check(await p.locator('section[data-screen="settings"] select, section[data-screen="settings"] input').count() > 3, 'settings render');
  // Reload: stats persisted
  const before = await p.evaluate(() => window.__bj.stats.decisions?.total ?? JSON.stringify(window.__bj.stats).length);
  await p.reload(); await sleep(1200);
  const after = await p.evaluate(() => window.__bj.stats.decisions?.total ?? JSON.stringify(window.__bj.stats).length);
  check(before === after, 'stats persist across reload');

  // ---------- landscape ----------
  const l = await page(b, 844, 390, errs, '[landscape]');
  await l.goto(URL); await sleep(1500);
  await clickIf(l, 'Deal'); await sleep(2800);
  await clickIf(l, 'No insurance');
  await sleep(600);
  await l.screenshot({ path: OUT + '/bj-5-landscape.png' });
  const overflow = await l.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check(!overflow, 'no horizontal overflow in landscape');
  const actVisible = await l.evaluate(() => { const a = document.querySelector('.actions'); const r = a.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.height > 0; });
  check(actVisible, 'action bar visible in landscape');

  // ---------- multiplayer (needs the worker) ----------
  if (process.env.MULTI !== '0') {
    const q = '?api=' + encodeURIComponent(API);
    const a = await page(b, 390, 844, errs, '[host]'), c = await page(b, 390, 844, errs, '[guest]');
    await a.goto(URL + (process.env.LOCALAPI ? q : '')); await c.goto(URL + (process.env.LOCALAPI ? q : ''));
    await sleep(1000);
    await a.locator('nav.tabs [data-go="online"]').click();
    await a.locator('section[data-screen="online"] input').first().fill('Richard');
    await a.locator('section[data-screen="online"] input').nth(2).fill('4821');
    await clickIf(a, 'Create table');
    await a.waitForFunction(() => window.__bj.driver?.online && window.__bj.driver.status === 'online', null, { timeout: 10000 });
    const code = await a.evaluate(() => window.__bj.driver.code);
    check(/^[A-Z0-9]{6}$/.test(code), 'table created ' + code);
    await c.locator('nav.tabs [data-go="online"]').click();
    await c.locator('section[data-screen="online"] input').first().fill('Sam');
    const inputs = c.locator('section[data-screen="online"] input');
    const n = await inputs.count();
    await inputs.nth(n - 2).fill(code); await inputs.nth(n - 1).fill('4821');
    await clickIf(c, 'Join');
    await c.waitForFunction(() => window.__bj.driver?.status === 'online', null, { timeout: 10000 });
    await a.waitForFunction(() => window.__bj.driver.view.seats.filter(Boolean).length === 2, null, { timeout: 10000 });
    check(true, 'both players seated');
    // bets + deal
    for (const x of [a, c]) { await clickIf(x, 'Deal'); }
    await sleep(3500);
    // chat (with an HTML payload that must render as text)
    await c.locator('#chatFab').click();
    await c.locator('.sheet .chat input').fill('gl all <b>bold?</b>');
    await c.locator('.sheet .chat input').press('Enter');
    await sleep(800);
    await c.locator('#sheet').getByRole('button', { name: 'Close', exact: true }).click();
    await a.locator('#chatFab').click(); await sleep(300);
    await a.locator('.sheet .chat input').fill('Hi Sam, good luck');
    await a.locator('.sheet .chat input').press('Enter'); await sleep(900);
    const txt = await a.locator('.sheet .chat .msgs').textContent();
    check(txt.includes('gl all') && txt.includes('Hi Sam'), 'chat delivered both ways');
    check((await a.locator('.sheet .chat .msgs b').count()) === 0, 'chat HTML not rendered');
    await a.screenshot({ path: OUT + '/bj-4-multiplayer-chat.png' });
    // Inline chat on the table screen as well
    await a.locator('#sheet').getByRole('button', { name: 'Close', exact: true }).click();
    await sleep(300);
    await a.screenshot({ path: OUT + '/bj-4b-multiplayer-table.png' });
    // Clean up: both leave -> server deletes the table
    for (const x of [c, a]) await x.evaluate(() => window.__bj.driver.leave());
    await sleep(800);
  }
  check(errs.length === 0, 'no console errors\n' + errs.join('\n'));
  await b.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
