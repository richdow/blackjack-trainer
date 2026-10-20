/* ==========================================================================
 * PERSISTENCE (localStorage): settings, long-term stats, drill progress.
 * Keys are versioned ("bjt.*.v1"); corrupt data falls back to defaults
 * instead of throwing, so a bad write can never brick the app.
 * ======================================================================== */
import { DEFAULT_RULES, sanitizeRules } from './engine.js';

const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : def; } catch (_) { return def; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* quota: ignore */ } };

export const DEFAULT_SETTINGS = {
  rules: { ...DEFAULT_RULES },
  aiCount: 2, mySeat: 3, bankroll: 1000,
  mode: 'coach',           // coach | casino | strategy | count
  showCount: false,        // HUD visibility (count practice keeps it hidden)
  alwaysHint: false,       // highlight the correct button before you act
  useIndices: false,       // grade with Hi-Lo index plays (I18 + Fab 4)
  largeText: false, contrast: false, fourColor: false,
  speed: 1, sound: false, nick: '',
};
export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...load('bjt.settings.v1', {}) };
  s.rules = sanitizeRules({ ...DEFAULT_RULES, ...(s.rules || {}) });
  return s;
}
export const saveSettings = (s) => save('bjt.settings.v1', s);

export function emptyStats() {
  return {
    since: Date.now(), decisions: 0, correct: 0, slight: 0, mistake: 0, evLoss: 0, evLossMoney: 0,
    cat: {}, cells: {}, early: { n: 0, loss: 0 }, recent: [],
    hands: 0, wagered: 0, net: 0, expected: 0, curve: [],
    countChecks: { n: 0, exact: 0, absErr: 0 }, betChecks: { n: 0, ok: 0 },
    sessions: [], drills: {}, lessons: {},
  };
}
export function loadStats() { const s = { ...emptyStats(), ...load('bjt.stats.v1', {}) }; if (!Array.isArray(s.recent)) s.recent = []; return s; }
export const saveStats = (s) => save('bjt.stats.v1', s);

/** Category of a decision for the breakdown table. */
export function categoryOf(info) {
  if (info.insurance) return 'Insurance';
  if (info.correct === 'surrender' || info.chosen === 'surrender') return 'Surrender';
  if (info.pair) return 'Pairs';
  if (info.soft) return 'Soft totals';
  if (info.correct === 'double' || info.chosen === 'double') return 'Doubles';
  return 'Hard totals';
}

export function recordDecision(stats, d) {
  stats.decisions++; stats[d.grade]++;
  stats.evLoss += d.loss; stats.evLossMoney += d.loss * (d.bet || 0);
  const c = (stats.cat[d.cat] ||= { n: 0, ok: 0, loss: 0 }); c.n++; if (d.grade === 'correct') c.ok++; c.loss += d.loss;
  const cell = (stats.cells[d.cell] ||= { n: 0, wrong: 0, loss: 0, correct: d.correct, last: '' });
  cell.n++; if (d.grade !== 'correct') { cell.wrong++; cell.loss += d.loss; cell.last = d.chosen; } cell.correct = d.correct;
  if (stats.early.n < 200) { stats.early.n++; stats.early.loss += d.loss; }
  stats.recent.push(+d.loss.toFixed(5)); if (stats.recent.length > 200) stats.recent.shift();
}
export function recordHand(stats, { wagered, net, expected }) {
  stats.hands++; stats.wagered += wagered; stats.net += net; stats.expected += expected;
  stats.curve.push([+stats.net.toFixed(2), +stats.expected.toFixed(2)]);
  if (stats.curve.length > 1500) stats.curve = stats.curve.filter((_, i) => i % 2 === 0);
}
