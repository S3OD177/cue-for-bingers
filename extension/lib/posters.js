// Poster URLs for library titles. /watchlist doesn't include posters, so they come from one
// batched GET /titles?ids=… call and are cached in local storage, so most popup opens make no
// extra request. Search results carry posters already and are added to the cache for free.
import { api } from "./api.js";

const KEY = "posterCache";
const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX = 400; // entries kept

async function load() {
  const { [KEY]: cache = {} } = await chrome.storage.local.get(KEY);
  return cache;
}

async function save(cache) {
  const keys = Object.keys(cache);
  if (keys.length > MAX) {
    keys.sort((a, b) => cache[b].t - cache[a].t).slice(MAX).forEach((k) => delete cache[k]);
  }
  await chrome.storage.local.set({ [KEY]: cache });
}

const isUrl = (u) => typeof u === "string" && /^https:\/\//.test(u);

// Returns { [id]: url | null }. Never throws: posters are a nice-to-have.
export async function posters(ids) {
  const wanted = [...new Set((ids || []).filter((id) => typeof id === "string" && id))].slice(0, 100);
  const out = {};
  if (!wanted.length) return out;
  const cache = await load();
  const now = Date.now();
  const missing = [];
  for (const id of wanted) {
    const e = cache[id];
    if (e && now - e.t < TTL) out[id] = e.u;
    else missing.push(id);
  }
  if (!missing.length) return out;
  try {
    const data = await api.titles(missing);
    const found = new Map((data?.items || []).map((t) => [t.id, isUrl(t.poster) ? t.poster : null]));
    for (const id of missing) {
      const u = found.get(id) ?? null;
      cache[id] = { u, t: now };
      out[id] = u;
    }
    await save(cache);
  } catch {
    /* leave the placeholders */
  }
  return out;
}

export async function rememberPosters(items) {
  const list = (items || []).filter((t) => t?.id && "poster" in t);
  if (!list.length) return;
  const cache = await load();
  const now = Date.now();
  for (const t of list) cache[t.id] = { u: isUrl(t.poster) ? t.poster : null, t: now };
  await save(cache);
}
