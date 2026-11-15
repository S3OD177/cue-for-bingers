// Service-worker side of auto-tracking: identifies what's playing on Bingers, sends playback
// scrobbles, keeps "now playing" per tab for the popup, and drives the in-page notices.
import { api } from "./api.js";
import { RESERVED_ORIGINS } from "./sites.js";

const DEFAULTS = { autoTrack: true, threshold: 90, minMinutes: 10, confirmBeforeMark: false };
const RESOLVE_TTL_MS = 7 * 24 * 3600 * 1000;
const WATCHLIST_TTL_MS = 5 * 60 * 1000;

// sessionId -> session. Service workers can be stopped, so anything the popup needs is also
// mirrored to chrome.storage.session (nowPlaying), and sessions are rebuilt lazily from events.
const sessions = new Map();
let watchlistCache = { at: 0, items: [] };

export async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^(the|a|an) /, "")
    .trim();

const pad = (n) => String(n).padStart(2, "0");
const code = (s, e) => (s != null ? `S${pad(s)}E${pad(e)}` : `E${pad(e)}`);

function label(res) {
  if (!res) return null;
  if (res.kind === "movie") return res.year ? `${res.title} (${res.year})` : res.title;
  return `${res.title} ${code(res.season, res.episode)}`;
}

// ---------- identification ----------
async function watchlistItems() {
  if (Date.now() - watchlistCache.at < WATCHLIST_TTL_MS) return watchlistCache.items;
  try {
    const w = await api.watchlist({ kind: "show", limit: 100 });
    const items = Object.values(w?.sections || {}).flatMap((s) => s?.items || []);
    watchlistCache = { at: Date.now(), items };
  } catch {
    watchlistCache = { at: Date.now(), items: [] };
  }
  return watchlistCache.items;
}

async function nextEpisodeFor(titleId) {
  const item = (await watchlistItems()).find((i) => i.id === titleId);
  const n = item?.progress?.next;
  const season = n?.season ?? n?.season_number;
  const episode = n?.number ?? n?.episode ?? n?.episode_number;
  return season != null && episode != null ? { season: Number(season), episode: Number(episode) } : null;
}

async function cachedSearch(meta) {
  // "rc2": v1.2.0 cached failed Arabic lookups (searched without lang) for a week; start fresh.
  const key = `rc2:${meta.kind || "any"}|${norm(meta.title)}|${meta.year || ""}`;
  const store = await chrome.storage.local.get(key);
  const hit = store[key];
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.value;

  // Bingers returns English display titles by default, so an Arabic page title (Shahid, OSN+)
  // would never match. Ask for Arabic display titles when the page title is in Arabic.
  const lang = /[؀-ۿ]/.test(meta.title) ? "ar" : undefined;
  const data = await api.search(meta.title, { kind: meta.kind || undefined, limit: 5, lang });
  const items = data?.items || [];
  const target = norm(meta.title);
  let best = null;
  let confidence = "none";
  const exact = items.filter((t) => norm(t.title) === target || norm(t.original_title) === target);
  if (exact.length) {
    best = (meta.year && exact.find((t) => t.year === meta.year)) || exact[0];
    confidence = "high";
  } else {
    const partial = items.find((t) => {
      const n = norm(t.title);
      return n && target && (n.includes(target) || target.includes(n)) && Math.min(n.length, target.length) >= 4;
    });
    if (partial) {
      best = partial;
      confidence = "medium";
    }
  }
  const value = best ? { id: best.id, kind: best.kind, title: best.title, year: best.year ?? null, confidence } : null;
  await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
  return value;
}

async function rememberedLink(host, rawTitle) {
  if (!rawTitle) return null;
  const key = `link:${host}|${norm(rawTitle)}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

export async function resolve(meta, host) {
  if (!meta?.title) return null;
  const linked = await rememberedLink(host, meta.title);
  const t = linked || (await cachedSearch(meta));
  if (!t) return null;

  if (t.kind === "movie") return { ...t, season: null, episode: null, guessed: false };

  let { season, episode } = meta;
  let guessed = false;
  if (episode == null || season == null) {
    const next = await nextEpisodeFor(t.id);
    if (episode == null) {
      if (!next) return { ...t, season: null, episode: null, needsEpisode: true };
      ({ season, episode } = next);
      guessed = true;
    } else if (season == null) {
      season = next?.season ?? 1;
      guessed = true;
    }
  }
  return { ...t, season, episode, guessed };
}

// ---------- now playing (popup) ----------
async function setNowPlaying(tabId, value) {
  const { nowPlaying = {} } = await chrome.storage.session.get("nowPlaying");
  if (value) nowPlaying[tabId] = value;
  else delete nowPlaying[tabId];
  await chrome.storage.session.set({ nowPlaying });
}

function publicState(s) {
  return {
    sessionId: s.id,
    host: s.host,
    state: s.state, // identifying | tracking | watched | unknown | ignored | error
    label: label(s.res),
    kind: s.res?.kind || s.meta?.kind || null,
    guessed: !!s.res?.guessed,
    needsEpisode: !!s.res?.needsEpisode,
    detected: s.meta?.title || s.raw?.title || null,
    progress: s.progress,
    message: s.message || null,
    updatedAt: Date.now(),
  };
}

function toast(s, text, actions = [], ttl = 7000) {
  chrome.tabs.sendMessage(s.tabId, { type: "cueToast", payload: { text, actions, ttl, sessionId: s.id } }, { frameId: s.frameId }).catch?.(() => {});
}

function playbackBody(s, progress) {
  const body = { title: s.res.id, progress: Math.max(0, Math.min(100, Number(progress) || 0)) };
  if (s.res.kind !== "movie") {
    body.season = s.res.season;
    body.episode = s.res.episode;
  }
  return body;
}

async function markWatched(s) {
  try {
    const r = await api.playback("stop", playbackBody(s, Math.max(s.progress, 80)));
    if (r && r.recorded === false) throw new Error(r.message || "Bingers didn't record it.");
    s.state = "watched";
    s.message = null;
    toast(s, `Marked ${label(s.res)} watched`, [{ id: "undo", label: "Undo" }], 10000);
  } catch (e) {
    s.state = "error";
    s.message = e.message;
    toast(s, `Couldn't mark ${label(s.res)}: ${e.message}`, [], 8000);
  }
}

// ---------- events from tracker.js ----------
export async function handleTrack(p, sender) {
  const settings = await getSettings();
  if (!settings.autoTrack || !sender.tab) return { ignored: true };

  let s = sessions.get(p.sessionId);
  if (!s) {
    s = { id: p.sessionId, tabId: sender.tab.id, frameId: sender.frameId ?? 0, host: p.host, meta: p.meta, raw: p.raw, state: "identifying", res: null, progress: 0 };
    sessions.set(s.id, s);
    s.resolving = (async () => {
      try {
        s.res = await resolve(s.meta, s.host);
      } catch (e) {
        s.state = "error";
        s.message = e.message;
        return;
      }
      if (!s.res || s.res.needsEpisode) {
        s.state = "unknown";
        toast(s, s.res?.needsEpisode ? `Watching ${s.res.title}? Open Cue to pick the episode.` : "Cue couldn't tell what's playing. Open Cue to pick it.", [], 8000);
      } else {
        s.state = "tracking";
        const note = s.res.guessed ? " (your next episode)" : "";
        toast(s, `Tracking ${label(s.res)}${note}`, [{ id: "ignore", label: "Not this" }], 6000);
      }
    })();
  }
  await s.resolving;
  s.progress = p.progress;

  if (s.state === "tracking") {
    if (p.event === "play") api.playback("start", playbackBody(s, p.progress)).catch(() => {});
    if (p.event === "pause") api.playback("pause", playbackBody(s, p.progress)).catch(() => {});
    if (p.event === "watched") {
      if (settings.confirmBeforeMark) {
        s.state = "confirm";
        toast(s, `Finished ${label(s.res)}?`, [{ id: "confirm", label: "Mark watched" }, { id: "ignore", label: "Skip" }], 0);
      } else await markWatched(s);
    }
  } else if (s.state === "unknown" && p.event === "watched") {
    s.pendingWatched = true; // if the user picks the title now, we can still mark it
  }
  await setNowPlaying(s.tabId, publicState(s));
  return publicState(s);
}

export async function handleTrackerAction({ sessionId, action, titleId, delta }) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error("That playback session has ended.");

  if (action === "ignore") {
    s.state = "ignored";
  } else if (action === "confirm" && s.res) {
    await markWatched(s);
  } else if (action === "undo" && s.res) {
    const a = { action: "unwatch", title: s.res.id };
    if (s.res.kind !== "movie") Object.assign(a, { season: s.res.season, episode: s.res.episode });
    await api.actions([a]);
    s.state = "ignored";
    toast(s, `Undone: ${label(s.res)} is unwatched again`, [], 5000);
  } else if (action === "episode" && s.res && s.res.kind !== "movie") {
    s.res = { ...s.res, episode: Math.max(1, (s.res.episode || 1) + Number(delta || 0)), guessed: false };
  } else if (action === "season" && s.res && s.res.kind !== "movie") {
    s.res = { ...s.res, season: Math.max(0, (s.res.season ?? 1) + Number(delta || 0)), guessed: false };
  } else if (action === "link" && titleId) {
    const t = await api.title(titleId);
    const base = { id: t.id, kind: t.kind, title: t.title, year: t.year ?? null, confidence: "manual" };
    if (s.meta?.title) await chrome.storage.local.set({ [`link:${s.host}|${norm(s.meta.title)}`]: base });
    s.res = base.kind === "movie" ? { ...base, season: null, episode: null } : await (async () => {
      const next = await nextEpisodeFor(base.id);
      return { ...base, season: s.meta?.season ?? next?.season ?? 1, episode: s.meta?.episode ?? next?.episode ?? 1, guessed: !s.meta?.episode };
    })();
    s.state = "tracking";
    if (s.pendingWatched) await markWatched(s);
  }
  await setNowPlaying(s.tabId, publicState(s));
  return publicState(s);
}

export async function forgetTab(tabId) {
  for (const [id, s] of sessions) if (s.tabId === tabId) sessions.delete(id);
  await setNowPlaying(tabId, null);
}

// ---------- which sites get the tracker ----------
export async function trackedOrigins() {
  const { origins = [] } = await chrome.permissions.getAll();
  // getAll() also lists the extension's own fixed hosts (Bingers API, IMDb/TMDB badge); skip those.
  const m = chrome.runtime.getManifest();
  const fixed = new Set([...RESERVED_ORIGINS, ...(m.host_permissions || []), ...(m.content_scripts || []).flatMap((c) => c.matches || [])]);
  return origins.filter((o) => !fixed.has(o));
}

export async function syncTrackerScripts() {
  const { autoTrack } = await getSettings();
  const origins = autoTrack ? await trackedOrigins() : [];
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["cue-tracker"] });
  } catch {
    /* not registered yet */
  }
  if (!origins.length) return [];
  await chrome.scripting.registerContentScripts([
    {
      id: "cue-tracker",
      matches: origins,
      js: ["lib/parse.js", "content/tracker.js"],
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: true,
    },
  ]);
  return origins;
}

// Inject right away into already-open tabs of a newly approved site (no reload needed).
export async function injectIntoOpenTabs(origins) {
  for (const pattern of origins) {
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: pattern });
    } catch {
      continue;
    }
    for (const t of tabs) {
      chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["lib/parse.js", "content/tracker.js"] }).catch(() => {});
    }
  }
}
