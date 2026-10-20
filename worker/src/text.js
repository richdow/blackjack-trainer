/* Text hygiene for nicknames and chat (no Cloudflare imports so it can be unit-tested in Node). */
/* ---------- text hygiene (nicknames + chat) ---------- */
export const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
// Short, deliberately mild list; words are masked, not rejected. Clients render with textContent.
const BAD = ['fuck', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'dick', 'pussy', 'slut', 'whore', 'fag', 'nigger', 'nigga', 'retard', 'motherfucker'];
const BAD_RE = new RegExp('\\b(' + BAD.map((w) => w.split('').join('[\\W_]*')).join('|') + ')(s|es|ing|ed|er|ers)?\\b', 'gi');
export function cleanChat(t) {
  t = String(t ?? '').replace(CTRL, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.slice(0, 200);
  t = t.replace(BAD_RE, (m) => m[0] + '*'.repeat(Math.max(1, m.length - 1)));
  // Defence in depth: neutralise HTML metacharacters even though clients never use innerHTML.
  return t.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}
export function cleanNick(n) {
  n = String(n ?? '').replace(CTRL, '').replace(/[<>"'`&\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n.replace(BAD_RE, (m) => m[0] + '*'.repeat(m.length - 1));
}

