// Sticky slots (pure logic, unit-tested in worker/test/slots.test.mjs).
//
// The world bakes https://loft-twitch.theloft.workers.dev/s/<n> for n = 0..SLOTS-1; /s/<n> redirects to the channel that
// holds slot n. The published list files say "channel X = slot n". Those files reach players minutes later (GitHub Pages,
// VRChat's string cache) and a player may tap a tile long after that, so a slot must NOT change hands while any list
// that names it can still be on screen.
//
// r37 (owner: 21 % of the slot links in the published lists opened another channel): with 300 slots for ~660 listed
// non-baked channels, every run took slots from channels that were still on players' screens. Now:
//   * SLOTS = 1000 (the world bakes 1000 slot links);
//   * a slot remembers when it was last PUBLISHED (row[2]); it is never given to another channel within
//     REUSE_COOLDOWN (30 min) of that, nor while its channel is listed in this run. If no slot is free, the channel
//     gets -1 (the world opens the typed twitch.tv box) - a wrong channel is never possible.
//
// Row = [login, seenUnix, listedUnix] (older two-field rows count as listed when last seen).

export const SLOTS = 1000;
export const GRACE = 2 * 3600;          // a holder that went offline keeps its slot this long
export const REUSE_COOLDOWN = 30 * 60;  // a slot stays with its channel this long after it was last published

export function normalizeSlots(arr, n = SLOTS) {
  const s = Array.isArray(arr) ? arr.slice(0, n) : [];
  while (s.length < n) s.push(null);
  for (let i = 0; i < s.length; i++) {
    const r = s[i];
    if (!Array.isArray(r) || !r[0]) { s[i] = null; continue; }
    if (r.length < 3 || typeof r[2] !== 'number') s[i] = [r[0], Number(r[1]) || 0, Number(r[1]) || 0];
  }
  return s;
}

function listedAt(r) { return r.length > 2 && typeof r[2] === 'number' ? r[2] : r[1]; }
export function reusable(r, now) { return !r || !r[0] || now - listedAt(r) >= REUSE_COOLDOWN; }

//   need      = [{login}] listed live channels that want a slot now (they are protected for this run)
//   stillLive = logins known to be live (their slot's grace clock restarts)
export function assignInto(slots, need, stillLive, now) {
  const n = slots.length;
  const byLogin = new Map();
  slots.forEach((r, s) => { if (r && r[0]) byLogin.set(r[0], s); });
  const touched = new Set();
  for (const l of stillLive) { const s = byLogin.get(l); if (s !== undefined) slots[s][1] = now; }
  // every channel that is listed this run keeps its slot (protected before any new channel is placed)
  for (const { login } of need) { const s = byLogin.get(login); if (s !== undefined) { slots[s][1] = now; touched.add(s); } }
  const result = new Map();
  for (const { login } of need) {
    if (byLogin.has(login)) { result.set(login, byLogin.get(login)); continue; }
    let pick = -1, best = Infinity;
    // 1. a free slot; 2. a holder offline for GRACE whose cooldown has passed (seen longest ago)
    for (let s = 0; s < n; s++) {
      const r = slots[s];
      if (!r || !r[0]) { pick = s; break; }
      if (!touched.has(s) && r[1] < now - GRACE && reusable(r, now) && r[1] < best) { best = r[1]; pick = s; }
    }
    // 3. all held: the holder not listed now whose last publication is oldest, only after the cooldown
    if (pick < 0) {
      for (let s = 0; s < n; s++) { const r = slots[s]; if (!touched.has(s) && reusable(r, now) && listedAt(r) < best) { best = listedAt(r); pick = s; } }
    }
    if (pick < 0) { result.set(login, -1); continue; }
    if (slots[pick] && slots[pick][0]) byLogin.delete(slots[pick][0]);
    slots[pick] = [login, now, now]; byLogin.set(login, pick); touched.add(pick); result.set(login, pick);
  }
  return result;
}

// the slots that went out in a published list (or a search answer) now: their cooldown restarts
export function markListed(slots, got, now) {
  for (const s of got.values()) if (s >= 0 && s < slots.length && slots[s]) slots[s][2] = now;
}
