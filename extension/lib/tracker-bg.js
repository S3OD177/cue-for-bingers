// Service-worker side of auto-tracking: identifies what's playing on Bingers, sends playback
// scrobbles, keeps "now playing" per tab for the popup, and drives the in-page notices.
import { api } from "./api.js";
import { RESERVED_ORIGINS, originPattern } from "./sites.js";

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
  if (res.episode == null) return res.title;
  return `${res.title} ${code(res.season, res.episode)}`;
}

// ---------- identification ----------
let watchlistLoading = null;
function watchlistItems() {
  if (Date.now() - watchlistCache.at < WATCHLIST_TTL_MS) return Promise.resolve(watchlistCache.items);
  // Share one request between callers (resolve() starts it early, alongside the search).
  watchlistLoading ||= (async () => {
    try {
      const w = await api.watchlist({ kind: "show", limit: 100 });
      const items = Object.values(w?.sections || {}).flatMap((s) => s?.items || []);
      watchlistCache = { at: Date.now(), items };
    } catch {
      watchlistCache = { at: Date.now(), items: [] };
    } finally {
      watchlistLoading = null;
    }
    return watchlistCache.items;
  })();
  return watchlistLoading;
}

async function nextEpisodeFor(titleId) {
  const item = (await watchlistItems()).find((i) => i.id === titleId);
  const n = item?.progress?.next;
  const season = n?.season ?? n?.season_number;
  const episode = n?.number ?? n?.episode ?? n?.episode_number;
  return season != null && episode != null ? { season: Number(season), episode: Number(episode) } : null;
}

const brief = (t) => ({ id: t.id, kind: t.kind, title: t.title, year: t.year ?? null });

// Only suggest a search result that shares a real word with the page title. Site names and
// filler don't count, so "Prime Video: Suits" never suggests "Prime Video Thursday Night Football".
const FILLER = new Set(["prime", "video", "amazon", "netflix", "disney", "plus", "hbo", "max", "apple", "hulu", "shahid", "osn", "watch", "online", "and", "the", "tv", "show", "series", "movie", "season", "episode"]);
// Numbers don't count either: "1. Season" shouldn't suggest "… Season 1, Part 1".
const words = (s) => norm(s).split(" ").filter((w) => !FILLER.has(w) && !/^\d+$/.test(w) && (w.length >= 3 || /\P{ASCII}/u.test(w)));
export function sharesWord(pageTitle, t) {
  const want = new Set(words(pageTitle));
  return [t.title, t.original_title].some((x) => words(x).some((w) => want.has(w)));
}

// Returns { value, suggestions }: value is the confident match (or null); suggestions are the
// top search results to offer as one-click picks when there's no match.
async function cachedSearch(meta) {
  // "rc3": entries now also keep suggestions (rc2 kept only the match).
  const key = `rc3:${meta.kind || "any"}|${norm(meta.title)}|${meta.year || ""}`;
  const store = await chrome.storage.local.get(key);
  const hit = store[key];
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return { value: hit.value, suggestions: hit.suggestions || [] };

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
  const value = best ? { ...brief(best), confidence } : null;
  const suggestions = best ? [] : items.filter((t) => t?.id && t.title && sharesWord(meta.title, t)).slice(0, 2).map(brief);
  await chrome.storage.local.set({ [key]: { at: Date.now(), value, suggestions } });
  return { value, suggestions };
}

async function rememberedLink(host, rawTitle) {
  if (!rawTitle) return null;
  const key = `link:${host}|${norm(rawTitle)}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

// `out.suggestions` gets the titles to offer when nothing matched.
export async function resolve(meta, host, out = {}) {
  if (!meta?.title) return null;
  // A show without an episode number needs the watchlist (next episode): fetch it while searching.
  if (meta.kind !== "movie" && meta.episode == null) watchlistItems();
  let t = await rememberedLink(host, meta.title);
  if (!t) {
    const found = await cachedSearch(meta);
    t = found.value;
    out.suggestions = found.suggestions;
  }
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
  await showOnIcon(tabId, value).catch(() => {});
}

// Mirror the state on the toolbar icon for that tab, so it's visible without opening the popup.
const ICON_STATES = {
  tracking: { text: "▶", color: "#5fd38d", title: (v) => `Cue: tracking ${v.label}` },
  watched: { text: "✓", color: "#5fd38d", title: (v) => `Cue: marked ${v.label} watched` },
  confirm: { text: "?", color: "#f2c14e", title: (v) => `Cue: finished ${v.label}? Open to confirm` },
  unknown: { text: "?", color: "#f2c14e", title: () => "Cue: couldn't tell what's playing. Open to pick it" },
  error: { text: "!", color: "#ef6461", title: (v) => `Cue: ${v.message || "something went wrong"}` },
};

async function showOnIcon(tabId, value) {
  const st = value && ICON_STATES[value.state];
  if (!st) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    await chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action?.default_title || "Cue for Bingers" });
    return;
  }
  await chrome.action.setBadgeText({ tabId, text: st.text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: st.color });
  await chrome.action.setBadgeTextColor?.({ tabId, color: "#0c0b0b" });
  await chrome.action.setTitle({ tabId, title: st.title(value) });
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
    season: s.res?.season ?? null,
    episode: s.res?.episode ?? null,
    detected: s.meta?.title || s.raw?.title || null,
    suggestions: s.state === "unknown" && !s.res ? (s.suggestions || []).map((t) => label(t)) : [],
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

// The video plays in an embedded player (another host's iframe), whose own title is usually a
// file name or nothing. The episode page around it names what's playing, so ask the top frame.
// Only answers when the tracker runs there too (that site is turned on, or all websites).
async function topPageMeta(tabId) {
  try {
    const r = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "cueReadPage" }, { frameId: 0 }),
      new Promise((res) => setTimeout(() => res(null), 1500)),
    ]);
    return r?.meta?.title ? r.meta : null;
  } catch {
    return null;
  }
}

// Prefer the page's title; keep the frame's season/episode when the page only lacks those.
export function mergeFrameMeta(page, frame) {
  if (!page) return frame;
  if (!frame || frame.kind === "movie" || page.kind === "movie") return page;
  const m = { ...page };
  if (m.episode == null && frame.episode != null) {
    m.kind = "show";
    m.season = frame.season;
    m.episode = frame.episode;
  } else if (m.season == null && frame.season != null && frame.episode === m.episode) {
    m.season = frame.season;
  }
  return m;
}

export async function handleTrack(p, sender) {
  const settings = await getSettings();
  if (!settings.autoTrack || !sender.tab) return { ignored: true };

  let s = sessions.get(p.sessionId);
  if (!s) {
    s = { id: p.sessionId, tabId: sender.tab.id, frameId: sender.frameId ?? 0, host: p.host, meta: p.meta, raw: p.raw, state: "identifying", res: null, progress: 0 };
    sessions.set(s.id, s);
    rememberHost(p.host).catch(() => {});
    s.resolving = (async () => {
      if (s.frameId !== 0) {
        const page = await topPageMeta(s.tabId);
        if (page) {
          s.meta = mergeFrameMeta(page, s.meta);
          s.raw = null;
        }
      }
      const out = {};
      try {
        s.res = await resolve(s.meta, s.host, out);
      } catch (e) {
        s.state = "error";
        s.message = e.message;
        return;
      }
      s.suggestions = out.suggestions || [];
      if (s.res?.needsEpisode) {
        s.state = "unknown";
        const start = { season: s.meta?.season ?? 1, episode: 1 };
        toast(s, `Watching ${s.res.title}?`, [{ id: "firstEpisode", label: `Track ${code(start.season, start.episode)}` }, { id: "ignore", label: "Not this" }], 12000);
      } else if (!s.res) {
        s.state = "unknown";
        const [first, second] = s.suggestions;
        if (first) {
          const actions = [{ id: "pick", index: 0, label: "Track it" }];
          if (second) actions.push({ id: "pick", index: 1, label: label(second) });
          actions.push({ id: "ignore", label: "Not this" });
          toast(s, `Watching ${label(first)}?`, actions, 12000);
        } else {
          const what = s.meta?.title || s.raw?.title;
          toast(s, what ? `Cue couldn't find “${what}” on Bingers` : "Cue couldn't tell what's playing", [], 6000);
        }
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

// The user corrected the season/episode. If the wrong one was already marked watched, move
// the mark to the right one; if they finished before Cue knew the episode, mark it now.
async function setEpisode(s, season, episode) {
  const before = s.res;
  s.res = { ...s.res, season, episode, guessed: false, needsEpisode: false };
  if (s.state === "watched" && before.episode != null && (before.season !== season || before.episode !== episode)) {
    await api.actions([{ action: "unwatch", title: before.id, season: before.season, episode: before.episode }]);
    await markWatched(s);
  } else if (s.state === "unknown") {
    s.state = "tracking";
    if (s.pendingWatched) await markWatched(s);
  }
}

// Link this page's title to a Bingers title (remembered per site) and start tracking it.
async function linkTitle(s, t) {
  const base = { ...t, confidence: "manual" };
  if (s.meta?.title) await chrome.storage.local.set({ [`link:${s.host}|${norm(s.meta.title)}`]: base });
  s.res = base.kind === "movie" ? { ...base, season: null, episode: null } : await (async () => {
    const next = await nextEpisodeFor(base.id);
    return { ...base, season: s.meta?.season ?? next?.season ?? 1, episode: s.meta?.episode ?? next?.episode ?? 1, guessed: !s.meta?.episode };
  })();
  s.state = "tracking";
  s.suggestions = [];
  if (s.pendingWatched) await markWatched(s);
}

export async function handleTrackerAction(p) {
  const { sessionId, action, titleId, delta } = p;
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
    await setEpisode(s, s.res.season ?? 1, Math.max(1, (s.res.episode || 0) + Number(delta || 0)));
  } else if (action === "season" && s.res && s.res.kind !== "movie") {
    await setEpisode(s, Math.max(0, (s.res.season ?? 1) + Number(delta || 0)), s.res.episode || 1);
  } else if (action === "setEpisode" && s.res && s.res.kind !== "movie") {
    const season = Math.trunc(Number(p.season));
    const episode = Math.trunc(Number(p.episode));
    if (!(season >= 0 && season < 1000 && episode >= 1 && episode < 10000)) throw new Error("Enter a season (0 or more) and an episode (1 or more).");
    await setEpisode(s, season, episode);
  } else if (action === "link" && titleId) {
    await linkTitle(s, brief(await api.title(titleId)));
  } else if (action === "pick") {
    // In-page button: only one of the titles Cue itself suggested for this session.
    const t = (s.suggestions || [])[Number(p.index)];
    if (!t || s.state !== "unknown" || s.res) throw new Error("That suggestion is no longer available.");
    await linkTitle(s, t);
    toast(s, `Tracking ${label(s.res)}`, [{ id: "ignore", label: "Not this" }], 5000);
  } else if (action === "firstEpisode" && s.res?.needsEpisode) {
    await setEpisode(s, s.meta?.season ?? 1, 1);
    toast(s, `Tracking ${label(s.res)}`, [{ id: "ignore", label: "Not this" }], 5000);
  }
  await setNowPlaying(s.tabId, publicState(s));
  return publicState(s);
}

export async function forgetTab(tabId) {
  for (const [id, s] of sessions) if (s.tabId === tabId) sessions.delete(id);
  await setNowPlaying(tabId, null);
  await setEmbeds(tabId, null);
  const { embedSeen = {} } = await chrome.storage.session.get("embedSeen");
  if (embedSeen[tabId]) {
    delete embedSeen[tabId];
    await chrome.storage.session.set({ embedSeen });
  }
}

// ---------- embedded players ----------
// tabId -> origin patterns of the embedded players seen in that tab ("https://host/*").
async function setEmbeds(tabId, list) {
  const { embeds = {} } = await chrome.storage.session.get("embeds");
  if (list && list.length) embeds[tabId] = list;
  else delete embeds[tabId];
  await chrome.storage.session.set({ embeds });
}

// Frames report in any order: an inner player can report before the top page does. So each
// entry keeps when it was seen, and the top page's report (with its load time) drops only
// entries from earlier pages. Updates run one at a time so two frames can't overwrite each other.
let embedQueue = Promise.resolve();

export function handleEmbeds(p, sender) {
  const run = embedQueue.then(() => updateEmbeds(p, sender));
  embedQueue = run.catch(() => {});
  return run;
}

async function updateEmbeds({ origins, reset, since }, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return null;
  const found = [];
  for (const o of [].concat(origins || []).slice(0, 5)) {
    const pattern = originPattern(String(o));
    if (pattern && !RESERVED_ORIGINS.includes(pattern)) found.push(pattern);
  }
  const now = Date.now();
  const { embedSeen = {} } = await chrome.storage.session.get("embedSeen");
  let seen = embedSeen[tabId] || {}; // pattern -> { at, top }
  if (reset && sender.frameId === 0) {
    const pageStart = Number(since) || now;
    seen = Object.fromEntries(Object.entries(seen).filter(([, v]) => !v.top && v.at >= pageStart));
    for (const o of found) seen[o] = { at: now, top: true };
  } else {
    for (const o of found) seen[o] = { at: now, top: !!seen[o]?.top };
  }
  const list = Object.keys(seen).slice(-10);
  seen = Object.fromEntries(list.map((o) => [o, seen[o]]));
  if (list.length) embedSeen[tabId] = seen;
  else delete embedSeen[tabId];
  await chrome.storage.session.set({ embedSeen });
  await setEmbeds(tabId, list);
  return list;
}

// ---------- which sites get the tracker ----------
// Sites where Cue has tracked something, newest first, so Settings can list them even in
// "all websites" mode (where there's no per-site permission to list).
async function rememberHost(host) {
  if (!host) return;
  const { seenHosts = [] } = await chrome.storage.local.get("seenHosts");
  if (seenHosts[0] === host) return;
  await chrome.storage.local.set({ seenHosts: [host, ...seenHosts.filter((h) => h !== host)].slice(0, 30) });
}

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
// Also covers tabs where the site only appears as an embedded player (tabs.query matches the
// top URL only). Frames that already have the tracker skip the second copy.
export async function injectIntoOpenTabs(origins) {
  const tabIds = new Set();
  for (const pattern of origins) {
    try {
      for (const t of await chrome.tabs.query({ url: pattern })) tabIds.add(t.id);
    } catch {
      /* invalid pattern */
    }
  }
  const { embeds = {} } = await chrome.storage.session.get("embeds");
  const all = origins.some((o) => o === "https://*/*" || o === "http://*/*");
  for (const [tabId, list] of Object.entries(embeds)) {
    if (all || list.some((o) => origins.includes(o))) tabIds.add(Number(tabId));
  }
  for (const tabId of tabIds) {
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["lib/parse.js", "content/tracker.js"] }).catch(() => {});
  }
}
