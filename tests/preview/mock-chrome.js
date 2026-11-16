// Fake `chrome` API so the popup and Settings pages can be opened in a normal browser tab
// for UI work: serve the repo root (python -m http.server 8765) and open
// http://localhost:8765/tests/preview/popup.html?state=tracking
// ?allsites=1 (all-websites mode, youtube skipped)
// ?state= tracking | watched | unknown | identifying | none   ?signedout=1   ?empty=1
// ?lang=ar (Chrome's language: any folder in extension/_locales; default en)
// ?uiLang=ar (the Language setting; default auto = same as Chrome)
const q = new URLSearchParams(location.search);
const state = q.get("state") || "tracking";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const watchlist = q.has("empty") ? { sections: {} } : {
  sections: {
    watch_next: { count: 3, items: [
      { id: "1", kind: "show", title: "Severance", url: "#", progress: { next: { season: 2, number: 7, title: "Chikhai Bardo" } } },
      { id: "2", kind: "show", title: "The Bear", url: "#", progress: { next: { season: 3, number: 2, title: "Next" } } },
      { id: "3", kind: "show", title: "Shōgun", url: "#", progress: { next: { season: 1, number: 5, title: "Broken to the Fist" } } },
    ] },
    to_watch: { count: 1, items: [{ id: "4", kind: "movie", title: "Dune: Part Two", year: 2024, runtime_minutes: 166, url: "#" }] },
  },
};
const search = { items: [
  { id: "5", kind: "show", title: "Breaking Bad", year: 2008, genres: ["Drama", "Crime"], poster: null },
  { id: "6", kind: "show", title: "Better Call Saul", year: 2015, genres: ["Drama"], poster: null },
  { id: "7", kind: "movie", title: "El Camino: A Breaking Bad Movie", year: 2019, genres: ["Crime", "Thriller"], poster: null },
] };

// Solid-colour stand-in posters.
const fakePoster = (hue) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="36" height="54"><defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 40%)"/><stop offset="1" stop-color="hsl(${hue} 45% 18%)"/></linearGradient></defs><rect width="36" height="54" fill="url(#g)"/></svg>`);
search.items.forEach((t, i) => (t.poster = fakePoster(120 + i * 70)));

const handlers = {
  posters: async ({ ids }) => (await wait(300), Object.fromEntries(ids.map((id, i) => [id, i === 2 ? null : fakePoster(i * 55)]))),
  getSession: () => (q.has("signedout") ? { signedIn: false, oauthConfigured: true } : { signedIn: true, mode: "pat", profile: { handle: "viewer" } }),
  watchlist: async () => (await wait(700), watchlist),
  search: async () => (await wait(600), search),
  check: () => ({ 5: { status: "completed" } }),
  actions: async () => (await wait(900), { results: [{ status: "ok" }] }),
  trackerAction: () => ({}),
  syncTracker: () => ({}),
  debugInfo: () => ({ extension: "preview", log: [] }),
  trackedSites: () => ["https://www.netflix.com/*", "https://shahid.mbc.net/*", "https://www.streamrecorder.io/*", "https://a-really-long-streaming-site-name.example.com/*"],
  redirectUrl: () => "https://abcdefghijklmnop.chromiumapp.org/",
};

const nowPlaying = state === "none" ? {} : { 1: {
  sessionId: "s1", host: "www.netflix.com", state, kind: "show",
  label: state === "unknown" || state === "identifying" ? null : "Severance",
  detected: "Severance", season: 2, episode: 7, progress: 41, suggestions: state === "unknown" ? ["Severance"] : [],
} };

const store = (initial) => ({
  get: async (k) => (k && typeof k === "object" && !Array.isArray(k) ? { ...k, ...initial } : { ...initial }),
  set: async () => {}, remove: async () => {},
});

// UI text from extension/_locales, loaded synchronously so the pages can translate on load.
// Fills in $1… the way Chrome does; a missing key falls back to English.
function loadMessages(lang) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", `../../extension/_locales/${lang}/messages.json`, false);
  xhr.send();
  return xhr.status === 200 ? JSON.parse(xhr.responseText) : {};
}
const messagesEn = loadMessages("en");
const messages = q.get("lang") && q.get("lang") !== "en" ? { ...messagesEn, ...loadMessages(q.get("lang")) } : messagesEn;

window.chrome = {
  i18n: {
    getMessage: (key, subs = []) => (messages[key]?.message ?? "").replace(/\$(\d)/g, (_, n) => [].concat(subs)[n - 1] ?? ""),
    getUILanguage: () => q.get("lang") || "en",
  },
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) {
      Promise.resolve(handlers[msg.type]?.(msg.payload)).then((data) => cb({ ok: true, data: data ?? {} }));
    },
    getManifest: () => ({ version: "preview" }),
    getURL: (path) => `../../extension/${path}`,
    openOptionsPage: () => {},
  },
  tabs: { query: async () => [{ id: 1, url: "https://www.netflix.com/watch/1" }], create: () => {}, sendMessage: async () => null },
  storage: { session: store({ nowPlaying }), sync: store({ ...(q.has("allsites") ? { excludedHosts: ["www.youtube.com"] } : {}), ...(q.get("uiLang") ? { uiLang: q.get("uiLang") } : {}) }), local: store({}), onChanged: { addListener() {} } },
  permissions: { contains: async ({ origins }) => q.has("allsites") || origins.some((o) => o.includes("netflix")), request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
  scripting: { executeScript: async () => [] },
};
