// loft-twitch: the live Twitch lists for THE LOFT's media tablet (VRChat).
//
// Every 5 minutes (cron) it reads Twitch Helix (Get Streams overall, per language and per category, Get Top Games,
// Get Channel Information for the content labels), drops anything that is not PG, keeps a popularity score per
// channel, and gives every listed live channel that is NOT baked into the world a sticky "slot" (0..299).
// The world bakes https://loft-twitch.theloft.workers.dev/s/<n> for every slot; /s/<n> answers with a 302 to
// https://www.twitch.tv/<login>. A channel keeps its slot while it is live and for GRACE seconds after it went
// offline, so late joiners and other instances open the same stream.
//
//   GET /export        full snapshot for the GitHub Action (which writes the small list files + thumbnail atlases)
//   GET /s/<n>         302 -> https://www.twitch.tv/<login of slot n>   (404 when the slot is free)
//   GET /q?=<words>    Twitch channel search (the world's input field holds ".../q?=") -> compact JSON (< 7 KB)
//   GET /baked?n=500   the most popular PG channels seen so far (for the world's baked top list)
//   GET /health        status
//
// Without TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET (npx wrangler secret put ...) it runs on MOCK data.

import BAKED from '../../baked.json';
import CHARSET from '../../tools/charset.txt';

const SLOTS = 300;
const GRACE = 2 * 3600;
const TITLE_MAX = 48;
const LIST_MAX = 40;            // entries per published list (one file, < 7 KB)
const POOL_MAX = 80;            // entries per language pool (two files)
export const LANGS = ['en', 'ja', 'zh', 'ru', 'ko', 'fr', 'de', 'ar', 'es'];   // + 'other' (index 9)

// Fixed chips (world order): 0 All, 1 Just Chatting, 2 Music, 3 Games, 4 VRChat, 5 Art & Creative, 6 IRL, 7 Sports.
// 8..13 = "Top now": the most-viewed PG categories at the moment (names published with the lists).
const FIXED = {
  1: ['Just Chatting'], 2: ['Music'], 4: ['VRChat'],
  5: ['Art', 'Makers & Crafting', 'Software and Game Development'],
  6: ['IRL', 'Travel & Outdoors', 'Food & Drink'], 7: ['Sports'],
};
const TOP_NOW = 6;
// never shown anywhere (grid, search, baked list, Top-now chips)
const BLOCKED_GAMES = new Set(['Pools, Hot Tubs, and Beaches', 'ASMR', 'Slots', 'Casino', 'Virtual Casino', 'Poker', 'Gambling',
  'Sports Betting', 'Blackjack', 'Roulette', 'Stake', 'Crypto']);
// Helix content classification labels that hide a stream (EXCLUDE_LABELS env var can override, comma separated)
const DEFAULT_LABELS = ['SexualThemes', 'DrugsIntoxication', 'Gambling', 'ProfanityVulgarity', 'ViolentGraphic', 'MatureGame'];
const NON_GAMES = new Set(['Just Chatting', 'Music', 'IRL', 'Art', 'Makers & Crafting', 'Food & Drink', 'Travel & Outdoors', 'Sports',
  'Software and Game Development', 'Talk Shows & Podcasts', 'Special Events', 'Science & Technology', 'Animals, Aquariums, and Zoos',
  'Politics', 'Fitness & Health', 'Beauty & Body Art', 'Writing & Reading', 'VRChat', 'Fashion', 'Retro', ...BLOCKED_GAMES]);
const BAKED_SET = new Set(BAKED.channels.map((c) => c.toLowerCase()));

// ---------------------------------------------------------------- text the world's fonts can draw
const ALLOWED = new Set(Array.from(CHARSET.replace(/[\r\n]/g, '')));
for (let c = 32; c < 127; c++) ALLOWED.add(String.fromCharCode(c));
function isArabic(ch) { const c = ch.codePointAt(0); return (c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f); }
// Arabic contextual shaping (presentation forms B) + right-to-left order for a left-to-right text box (like "ar_display")
const AR = {
  'ء': [0xFE80], 'آ': [0xFE81, 0xFE82], 'أ': [0xFE83, 0xFE84], 'ؤ': [0xFE85, 0xFE86], 'إ': [0xFE87, 0xFE88],
  'ئ': [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C], 'ا': [0xFE8D, 0xFE8E], 'ب': [0xFE8F, 0xFE90, 0xFE91, 0xFE92], 'ة': [0xFE93, 0xFE94],
  'ت': [0xFE95, 0xFE96, 0xFE97, 0xFE98], 'ث': [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C], 'ج': [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],
  'ح': [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4], 'خ': [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8], 'د': [0xFEA9, 0xFEAA], 'ذ': [0xFEAB, 0xFEAC],
  'ر': [0xFEAD, 0xFEAE], 'ز': [0xFEAF, 0xFEB0], 'س': [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4], 'ش': [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],
  'ص': [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC], 'ض': [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0], 'ط': [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4],
  'ظ': [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8], 'ع': [0xFEC9, 0xFECA, 0xFECB, 0xFECC], 'غ': [0xFECD, 0xFECE, 0xFECF, 0xFED0],
  'ف': [0xFED1, 0xFED2, 0xFED3, 0xFED4], 'ق': [0xFED5, 0xFED6, 0xFED7, 0xFED8], 'ك': [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC],
  'ل': [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0], 'م': [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4], 'ن': [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
  'ه': [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC], 'و': [0xFEED, 0xFEEE], 'ى': [0xFEEF, 0xFEF0], 'ي': [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],
};
const LAM_ALEF = { 'آ': [0xFEF5, 0xFEF6], 'أ': [0xFEF7, 0xFEF8], 'إ': [0xFEF9, 0xFEFA], 'ا': [0xFEFB, 0xFEFC] };
function shapeArabicRun(s) {
  const a = Array.from(s).filter((ch) => !(ch >= '\u064B' && ch <= '\u065F'));
  const out = [];
  const joinsLeft = (ch) => AR[ch] && AR[ch].length === 4;
  for (let i = 0; i < a.length; i++) {
    const ch = a[i];
    if (!AR[ch]) { out.push(ch); continue; }
    const fromRight = i > 0 && joinsLeft(a[i - 1]);
    if (ch === 'ل' && LAM_ALEF[a[i + 1]]) { out.push(String.fromCharCode(LAM_ALEF[a[i + 1]][fromRight ? 1 : 0])); i++; continue; }
    const toLeft = joinsLeft(ch) && a[i + 1] && AR[a[i + 1]];
    const f = AR[ch];
    out.push(String.fromCharCode(f.length === 1 ? f[0] : f.length === 2 ? (fromRight ? f[1] : f[0]) : fromRight ? (toLeft ? f[3] : f[1]) : (toLeft ? f[2] : f[0])));
  }
  return out;
}
export function displayArabic(s) {
  if (!Array.from(s).some(isArabic)) return s;
  const runs = []; let cur = null;
  for (const ch of s) {
    const k = isArabic(ch) ? 'a' : (ch === ' ' && cur && cur.k === 'a') ? 'a' : 'l';
    if (!cur || cur.k !== k) { cur = { k, t: '' }; runs.push(cur); }
    cur.t += ch;
  }
  return runs.reverse().map((r) => r.k === 'a' ? shapeArabicRun(r.t).reverse().join('') : r.t).join('');
}
function clean(s, max) {
  s = (s || '').replace(/[\u0000-\u001f\u007f"\\<>{}]/g, ' ').replace(/\s+/g, ' ').trim();
  s = displayArabic(s);
  let out = '', dropped = 0, n = 0;
  for (const ch of s) {
    if (n >= max) { out = out.trimEnd() + '…'; break; }
    if (ALLOWED.has(ch)) { out += ch; n++; } else dropped++;
  }
  return { text: out.replace(/\s+/g, ' ').trim(), dropped };
}
function cleanTitle(title, game) {
  const c = clean(title, TITLE_MAX);
  if (c.text.length < 4 || c.dropped > c.text.length) return clean(game || '', TITLE_MAX).text;   // mostly unsupported letters: show the category
  return c.text;
}
function langIndex(l) { const i = LANGS.indexOf((l || '').toLowerCase().slice(0, 2)); return i < 0 ? 9 : i; }

// ---------------------------------------------------------------- storage (D1, a few JSON blobs: few queries per run)
async function kvGet(env, k) { const r = await env.DB.prepare('SELECT v FROM kv WHERE k=?').bind(k).first(); return r ? r.v : null; }
async function kvJson(env, k, dflt) { const v = await kvGet(env, k); try { return v ? JSON.parse(v) : dflt; } catch { return dflt; } }
function kvStmt(env, k, v) { return env.DB.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, typeof v === 'string' ? v : JSON.stringify(v)); }
async function kvSet(env, k, v) { await kvStmt(env, k, v).run(); }

// Sticky slots: blob = array[SLOTS] of [login, seenUnix] or null.
//   need      = [{login}] listed live channels that want a slot now
//   stillLive = logins known to be live (their slot's grace clock restarts)
export function assignInto(slots, need, stillLive, now) {
  const byLogin = new Map();
  slots.forEach((r, s) => { if (r && r[0]) byLogin.set(r[0], s); });
  const touched = new Set();
  for (const l of stillLive) { const s = byLogin.get(l); if (s !== undefined) { slots[s][1] = now; touched.add(s); } }
  const result = new Map();
  for (const { login } of need) {
    if (byLogin.has(login)) { const s = byLogin.get(login); slots[s][1] = now; touched.add(s); result.set(login, s); continue; }
    let pick = -1, oldest = Infinity;
    for (let s = 0; s < SLOTS; s++) {
      const r = slots[s];
      if (!r || !r[0]) { pick = s; break; }
      if (!touched.has(s) && r[1] < now - GRACE && r[1] < oldest) { oldest = r[1]; pick = s; }
    }
    if (pick < 0) { result.set(login, -1); continue; }
    if (slots[pick] && slots[pick][0]) byLogin.delete(slots[pick][0]);
    slots[pick] = [login, now]; byLogin.set(login, pick); touched.add(pick); result.set(login, pick);
  }
  return result;
}
async function loadSlots(env) { const s = await kvJson(env, 'slots', []); while (s.length < SLOTS) s.push(null); return s.slice(0, SLOTS); }

// ---------------------------------------------------------------- Twitch Helix
function hasCreds(env) { return !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET); }
async function token(env, now) {
  const t = await kvJson(env, 'token', null);
  if (t && t.exp > now + 600) return t.tok;
  const r = await fetch('https://id.twitch.tv/oauth2/token?client_id=' + encodeURIComponent(env.TWITCH_CLIENT_ID) +
    '&client_secret=' + encodeURIComponent(env.TWITCH_CLIENT_SECRET) + '&grant_type=client_credentials', { method: 'POST' });
  if (!r.ok) throw new Error('twitch token ' + r.status);
  const j = await r.json();
  await kvSet(env, 'token', { tok: j.access_token, exp: now + (j.expires_in || 3600) });
  return j.access_token;
}
async function helix(env, path, tok) {
  const r = await fetch('https://api.twitch.tv/helix/' + path, { headers: { 'Client-Id': env.TWITCH_CLIENT_ID, Authorization: 'Bearer ' + tok } });
  if (r.status === 401) { await kvSet(env, 'token', { exp: 0 }); throw new Error('helix 401'); }
  if (!r.ok) throw new Error('helix ' + path.split('?')[0] + ' ' + r.status);
  return r.json();
}
async function streams(env, tok, query, pages) {
  const out = []; let after = '';
  for (let p = 0; p < pages; p++) {
    const j = await helix(env, 'streams?first=100' + query + (after ? '&after=' + after : ''), tok);
    for (const s of j.data || []) out.push(fromHelix(s));
    after = j.pagination && j.pagination.cursor; if (!after) break;
  }
  return out;
}
function fromHelix(s) {
  return { id: s.user_id, l: s.user_login.toLowerCase(), d: s.user_name || s.user_login, t: s.title || '', g: s.game_name || '', gid: s.game_id || '',
    v: s.viewer_count || 0, u: Math.floor(Date.parse(s.started_at) / 1000) || 0, n: langIndex(s.language), mature: !!s.is_mature,
    th: (s.thumbnail_url || '').replace('{width}', '192').replace('{height}', '108') };
}
async function gameIds(env, tok) {
  const g = await kvJson(env, 'games', null);
  if (g && g.t > Date.now() / 1000 - 86400 * 7) return g.ids;
  const names = [...new Set(Object.values(FIXED).flat())];
  const j = await helix(env, 'games?' + names.map((n) => 'name=' + encodeURIComponent(n)).join('&'), tok);
  const ids = {}; for (const x of j.data || []) ids[x.name] = x.id;
  await kvSet(env, 'games', { t: Date.now() / 1000, ids });
  return ids;
}
// content classification labels per broadcaster id, cached 30 min (Get Channel Information, 100 ids per call)
async function labels(env, tok, ids, now, budget) {
  const cache = await kvJson(env, 'ccl', {});
  const want = [...new Set(ids)].filter((id) => !cache[id] || cache[id][1] < now - 1800);
  for (let i = 0; i < want.length && budget > 0; i += 100, budget--) {
    const part = want.slice(i, i + 100);
    const j = await helix(env, 'channels?' + part.map((id) => 'broadcaster_id=' + id).join('&'), tok);
    for (const c of j.data || []) cache[c.broadcaster_id] = [(c.content_classification_labels || []).join(','), now];
  }
  for (const k of Object.keys(cache)) if (cache[k][1] < now - 7200) delete cache[k];
  return cache;
}

// ---------------------------------------------------------------- MOCK data (until the owner adds the Twitch app)
const MOCK_EXTRA = Array.from({ length: 120 }, (_, i) => 'loftmock_' + String(i + 1).padStart(3, '0'));
const MOCK_GAMES = ['Just Chatting', 'Music', 'VRChat', 'Fortnite', 'League of Legends', 'Minecraft', 'Art', 'IRL', 'Grand Theft Auto V',
  'Valorant', 'Sports', 'Food & Drink', 'Counter-Strike', 'Makers & Crafting', 'Slots', 'ASMR'];
const MOCK_TITLES = ['Chill stream with chat', 'Late night music session', 'Ranked grind to the top', 'Exploring new VRChat worlds',
  'Drawing your ideas live', 'Cooking something new', 'Road trip IRL', '24/7 lofi beats', 'Speedrun attempts', 'Q&A and hangout',
  'بث مباشر مع الشباب', 'まったり雑談配信', 'Стрим с чатом', 'Directo de charla', 'Live mit Chat', '방송 켰어요', '一起聊天吧', 'Live avec le chat'];
const MOCK_LANG = { 10: 7, 11: 1, 12: 3, 13: 8, 14: 6, 15: 4, 16: 2, 17: 5 };
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function mockStreams(now) {
  const win = Math.floor(now / 1800);
  const out = [];
  for (const login of [...BAKED.channels.slice(0, 90), ...MOCK_EXTRA]) {
    const h = hash(login + ':' + win);
    if (h % 10 < 3) continue;
    const ti = hash(login + 't') % MOCK_TITLES.length;
    out.push({ id: String(hash(login)), l: login.toLowerCase(), d: login, t: MOCK_TITLES[ti], g: MOCK_GAMES[hash(login) % MOCK_GAMES.length], gid: '',
      v: 3 + (hash(login + 'v') % 40000) + (h % 900), u: now - 600 - (hash(login + 'u:' + win) % 30000), n: MOCK_LANG[ti] ?? (hash(login + 'n') % 3 ? 0 : 9),
      mature: hash(login + 'm') % 17 === 0, th: 'mock:' + login });
  }
  return out.sort((a, b) => b.v - a.v);
}

// ---------------------------------------------------------------- lists
// a published list holds a mix so all four sorts work locally: top viewers, newest, longest, smallest
function mixList(list, max) {
  const pick = new Map();
  const add = (arr, n) => { for (const s of arr) { if (pick.size >= max || n <= 0) break; if (!pick.has(s.l)) { pick.set(s.l, s); n--; } } };
  const byV = [...list].sort((a, b) => b.v - a.v);
  add(byV, Math.ceil(max * 0.55));
  add([...list].sort((a, b) => b.u - a.u), Math.ceil(max * 0.15));
  add([...list].sort((a, b) => a.u - b.u), Math.ceil(max * 0.15));
  add([...list].sort((a, b) => a.v - b.v), max);
  return [...pick.values()].sort((a, b) => b.v - a.v);
}

async function poll(env, now) {
  const mock = !hasCreds(env);
  const excl = new Set((env.EXCLUDE_LABELS || DEFAULT_LABELS.join(',')).split(',').map((x) => x.trim()).filter(Boolean));
  let overall, perLang = {}, perFixed = {}, top = [], tok = null, cclStats = { checked: 0, hidden: 0 };
  if (mock) {
    overall = mockStreams(now);
    for (let i = 0; i < LANGS.length; i++) perLang[i] = overall.filter((s) => s.n === i);
    for (const k of Object.keys(FIXED)) perFixed[k] = overall.filter((s) => FIXED[k].includes(s.g));
    const counts = {}; for (const s of overall) counts[s.g] = (counts[s.g] || 0) + s.v;
    top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name]) => ({ name, id: '' }));
  } else {
    tok = await token(env, now);
    overall = await streams(env, tok, '', 3);
    for (let i = 0; i < LANGS.length; i++) perLang[i] = await streams(env, tok, '&language=' + LANGS[i], 1);
    const ids = await gameIds(env, tok);
    for (const k of Object.keys(FIXED)) {
      const q = FIXED[k].map((n) => ids[n]).filter(Boolean);
      perFixed[k] = q.length ? await streams(env, tok, q.map((id) => '&game_id=' + id).join(''), 1) : [];
    }
    const tg = await helix(env, 'games/top?first=30', tok);
    top = (tg.data || []).map((g) => ({ name: g.name, id: g.id }));
  }
  // Top now: the most-viewed PG categories that are not already a fixed chip
  const fixedNames = new Set(Object.values(FIXED).flat());
  const chips = top.filter((g) => !BLOCKED_GAMES.has(g.name) && !fixedNames.has(g.name) && clean(g.name, 22).dropped === 0).slice(0, TOP_NOW);
  const perTop = {};
  for (let i = 0; i < chips.length; i++)
    perTop[8 + i] = mock ? overall.filter((s) => s.g === chips[i].name) : await streams(env, tok, '&game_id=' + chips[i].id, 1);

  // every candidate once; PG filter (category, mature flag, content labels)
  const all = new Map();
  const put = (arr) => { for (const s of arr) if (!all.has(s.l)) all.set(s.l, s); };
  put(overall); Object.values(perLang).forEach(put); Object.values(perFixed).forEach(put); Object.values(perTop).forEach(put);
  let ccl = {};
  if (!mock) { ccl = await labels(env, tok, [...all.values()].map((s) => s.id), now, 12); }
  const bad = new Set();
  for (const s of all.values()) {
    const lab = mock ? (s.mature ? 'MatureGame' : '') : (ccl[s.id] ? ccl[s.id][0] : null);
    const hidden = BLOCKED_GAMES.has(s.g) || s.mature || lab === null || lab.split(',').some((x) => excl.has(x));
    if (lab !== null) cclStats.checked++;
    if (hidden) { bad.add(s.l); cclStats.hidden++; }
  }
  const pg = (arr) => (arr || []).filter((s) => !bad.has(s.l));

  // chip membership bit mask per channel (lets the world filter a language pool by chip)
  const chipOf = (s) => {
    let m = 1;
    for (const k of Object.keys(FIXED)) if (FIXED[k].includes(s.g)) m |= 1 << Number(k);
    if (!NON_GAMES.has(s.g)) m |= 1 << 3;
    chips.forEach((c, i) => { if (c.name === s.g) m |= 1 << (8 + i); });
    return m;
  };
  const lists = {};                                          // "c<chip>" all languages, "l<lang>" language pools
  const good = pg([...all.values()]);
  lists.c0 = mixList(pg(overall), LIST_MAX);
  for (const k of Object.keys(FIXED)) lists['c' + k] = mixList(pg(perFixed[k]), LIST_MAX);
  lists.c3 = mixList(good.filter((s) => !NON_GAMES.has(s.g)), LIST_MAX);
  for (let i = 0; i < chips.length; i++) lists['c' + (8 + i)] = mixList(pg(perTop[8 + i]), LIST_MAX);
  for (let i = 0; i < LANGS.length; i++) lists['l' + i] = mixList(good.filter((s) => s.n === i), POOL_MAX);
  lists.l9 = mixList(good.filter((s) => s.n === 9), POOL_MAX);

  // popularity: viewer-hours since the last run (the baked top list is picked from this; PG only)
  const last = Number(await kvGet(env, 'lastPoll')) || now - 300;
  const hrs = Math.min(Math.max(now - last, 60), 1800) / 3600;
  const pop = await kvJson(env, 'pop', {});
  if (!mock) {
    for (const s of all.values()) {
      const p = pop[s.l] || [0, s.d, 1];
      pop[s.l] = [p[0] + s.v * hrs, s.d, bad.has(s.l) ? 0 : 1];
    }
    const keep = Object.entries(pop).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3000);
    for (const k of Object.keys(pop)) delete pop[k];
    for (const [k, v] of keep) pop[k] = v;
  }

  // slots: every listed channel outside the baked set; holders still live anywhere keep their grace clock
  const need = []; const needSet = new Set();
  for (const arr of Object.values(lists)) for (const s of arr) if (!BAKED_SET.has(s.l) && !needSet.has(s.l)) { needSet.add(s.l); need.push({ login: s.l }); }
  const stillLive = [...all.keys()];
  const slots = await loadSlots(env);
  if (!mock) {
    const holders = slots.filter((r) => r && r[0] && r[1] >= now - GRACE && !all.has(r[0])).map((r) => r[0]);
    for (let i = 0; i < holders.length && i < 300; i += 100) {
      const j = await helix(env, 'streams?first=100&' + holders.slice(i, i + 100).map((l) => 'user_login=' + encodeURIComponent(l)).join('&'), tok);
      for (const s of j.data || []) stillLive.push(s.user_login.toLowerCase());
    }
  }
  const fresh = await loadSlots(env);      // a search may have assigned slots meanwhile: start from the newest copy
  const got = assignInto(fresh, need, stillLive, now);
  const out = {};
  for (const [k, arr] of Object.entries(lists)) out[k] = arr.map((s) => ({
    l: s.l, d: clean(s.d, 25).text || s.l, t: cleanTitle(s.t, s.g), g: clean(s.g, 28).text, v: s.v, u: s.u, n: s.n, m: chipOf(s), th: s.th,
    s: BAKED_SET.has(s.l) ? -1 : (got.get(s.l) ?? -1),
  }));
  const snap = { v: 2, t: now, mock, baked: BAKED.version, chips: chips.map((c) => clean(c.name, 22).text), lists: out, pg: cclStats, excluded: [...excl] };
  await env.DB.batch([kvStmt(env, 'slots', fresh), kvStmt(env, 'snapshot', snap), kvStmt(env, 'lastPoll', String(now)), kvStmt(env, 'pop', pop)]);
  return snap;
}

// ---------------------------------------------------------------- search (players with "Allow Untrusted URLs" on)
async function search(env, words, now) {
  words = words.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!words) return { v: 2, q: '', r: [] };
  const excl = new Set((env.EXCLUDE_LABELS || DEFAULT_LABELS.join(',')).split(',').map((x) => x.trim()).filter(Boolean));
  let found;
  if (!hasCreds(env)) {
    const w = words.toLowerCase();
    const live = new Map(mockStreams(now).map((s) => [s.l, s]));
    found = [...BAKED.channels, ...MOCK_EXTRA].filter((l) => l.toLowerCase().includes(w)).slice(0, 16).map((l) => {
      const s = live.get(l.toLowerCase());
      return s ? { ...s, o: 1, bad: s.mature || BLOCKED_GAMES.has(s.g) } : { l: l.toLowerCase(), d: l, t: '', g: '', v: 0, u: 0, n: 9, o: 0 };
    });
  } else {
    const tok = await token(env, now);
    const j = await helix(env, 'search/channels?first=20&query=' + encodeURIComponent(words), tok);
    found = (j.data || []).map((c) => ({ id: c.id, l: c.broadcaster_login.toLowerCase(), d: c.display_name || c.broadcaster_login, t: c.title || '',
      g: c.game_name || '', v: 0, u: Math.floor(Date.parse(c.started_at) / 1000) || 0, n: langIndex(c.broadcaster_language), o: c.is_live ? 1 : 0 }));
    const ccl = await labels(env, tok, found.map((c) => c.id), now, 1);
    for (const c of found) { const lab = ccl[c.id] ? ccl[c.id][0] : ''; c.bad = BLOCKED_GAMES.has(c.g) || lab.split(',').some((x) => excl.has(x)); }
    const liveLogins = found.filter((c) => c.o && !c.bad).map((c) => c.l);
    if (liveLogins.length) {
      const s = await helix(env, 'streams?first=100&' + liveLogins.map((l) => 'user_login=' + encodeURIComponent(l)).join('&'), tok);
      const v = new Map((s.data || []).map((x) => [x.user_login.toLowerCase(), x]));
      for (const c of found) if (v.has(c.l)) { c.v = v.get(c.l).viewer_count; if (v.get(c.l).is_mature) c.bad = true; }
    }
  }
  found = found.filter((c) => !c.bad).sort((a, b) => (b.o - a.o) || (b.v - a.v)).slice(0, 16);
  const need = found.filter((c) => c.o && !BAKED_SET.has(c.l)).map((c) => ({ login: c.l }));
  let got = new Map();
  if (need.length) { const slots = await loadSlots(env); got = assignInto(slots, need, [], now); await kvSet(env, 'slots', slots); }
  const r = found.map((c) => ({ l: c.l, d: clean(c.d, 25).text || c.l, t: c.o ? cleanTitle(c.t, c.g) : '', g: clean(c.g, 28).text, v: c.v, u: c.o ? c.u : 0, n: c.n, o: c.o,
    s: BAKED_SET.has(c.l) ? -1 : (got.get(c.l) ?? -1) }));
  return { v: 2, t: now, q: clean(words, 40).text, r };
}

// ---------------------------------------------------------------- HTTP
const JSONH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
function json(o, status = 200) { return new Response(JSON.stringify(o), { status, headers: JSONH }); }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const now = Math.floor(Date.now() / 1000);
    const p = url.pathname;
    try {
      const m = p.match(/^\/s\/(\d{1,3})\/?$/);
      if (m) {
        const n = Number(m[1]);
        const slots = n < SLOTS ? await loadSlots(env) : [];
        const row = slots[n];
        if (!row || !row[0]) return new Response('This slot is free right now.', { status: 404, headers: { 'cache-control': 'no-store' } });
        return new Response(null, { status: 302, headers: { location: 'https://www.twitch.tv/' + row[0], 'cache-control': 'no-store' } });
      }
      if (p === '/q' || p === '/q/') {
        let raw = url.search.replace(/^\?/, '');
        raw = raw.startsWith('q=') ? raw.slice(2) : raw.startsWith('=') ? raw.slice(1) : raw;
        let words; try { words = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { words = raw; }
        return json(await search(env, words, now));
      }
      if (p === '/export') {
        const s = await kvGet(env, 'snapshot');
        if (s && JSON.parse(s).v === 2 && url.searchParams.get('fresh') !== '1') return new Response(s, { headers: JSONH });
        return json(await poll(env, now));
      }
      if (p === '/baked') {
        const n = Math.min(Number(url.searchParams.get('n')) || 500, 1000);
        const pop = await kvJson(env, 'pop', {});
        const rows = Object.entries(pop).filter(([, v]) => v[2] === 1).sort((a, b) => b[1][0] - a[1][0]).slice(0, n);
        return json({ v: 1, t: now, mock: !hasCreds(env), n: rows.length, channels: rows.map(([k]) => k), names: rows.map(([, v]) => v[1]) });
      }
      if (p === '/health' || p === '/') {
        const slots = await loadSlots(env);
        return json({ ok: true, mock: !hasCreds(env), lastPoll: Number(await kvGet(env, 'lastPoll')) || 0, now, slotsUsed: slots.filter((r) => r && r[0]).length,
          slots: SLOTS, graceSeconds: GRACE, baked: BAKED.channels.length, bakedVersion: BAKED.version });
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(poll(env, Math.floor(Date.now() / 1000)));
  },
};
