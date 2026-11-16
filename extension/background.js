// Service worker: owns auth + all network calls. Popup, options and content scripts talk to it by message.
import { api } from "./lib/api.js";
import * as auth from "./lib/auth.js";
import { normalizeCheck } from "./lib/normalize.js";
import * as tracker from "./lib/tracker-bg.js";
import { syncSuggestions } from "./lib/suggest.js";
import { posters, rememberPosters } from "./lib/posters.js";
import { t, loadLanguage, pickedMessages } from "./lib/i18n.js";

// The Language setting (Settings page). Messages wait for it, so replies use the right language.
let languageReady = loadLanguage();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !("uiLang" in changes)) return;
  languageReady = loadLanguage().then(() => {
    chrome.contextMenus.update("bingers-search", { title: t("menu_search") }, () => void chrome.runtime.lastError);
  });
});

const CHECK_TTL_MS = 60_000;
const checkCache = new Map(); // ref -> { at, value }

async function refreshProfile() {
  let profile = null;
  try {
    profile = await api.me();
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw e; // bad token / no plan: surface it
  }
  await chrome.storage.local.set({ profile });
  return { signedIn: true, profile };
}

async function cachedCheck(refs) {
  const now = Date.now();
  const result = {};
  const missing = [];
  for (const r of refs) {
    const hit = checkCache.get(r);
    if (hit && now - hit.at < CHECK_TTL_MS) result[r] = hit.value;
    else missing.push(r);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const normalized = normalizeCheck(await api.check(batch), batch);
    for (const r of batch) {
      checkCache.set(r, { at: now, value: normalized[r] });
      result[r] = normalized[r];
    }
  }
  return result;
}

const handlers = {
  async getSession() {
    const a = await auth.getAuth();
    const oauthConfigured = auth.isOAuthConfigured();
    if (!a) return { signedIn: false, oauthConfigured };
    const { profile } = await chrome.storage.local.get("profile");
    return { signedIn: true, mode: a.mode, profile: profile ?? null, oauthConfigured };
  },
  async signInOAuth() {
    await auth.signInWithOAuth();
    checkCache.clear();
    return refreshProfile();
  },
  async signInToken({ token }) {
    await auth.signInWithToken(token);
    checkCache.clear();
    try {
      return await refreshProfile();
    } catch (e) {
      await auth.clearAuth();
      if (e.status === 401) throw new Error(t("err_tokenRejected"));
      throw e;
    }
  },
  async signOut() {
    await auth.signOut();
    await chrome.storage.local.remove("profile");
    checkCache.clear();
    return { signedIn: false };
  },
  redirectUrl: () => chrome.identity.getRedirectURL(),

  watchlist: (p) => api.watchlist(p),
  recent: (p) => api.recent(p),
  async search({ q, kind, limit }) {
    const res = await api.search(q, { kind, limit });
    rememberPosters(res?.items).catch(() => {});
    return res;
  },
  posters: ({ ids }) => posters(ids),
  title: ({ ref }) => api.title(ref),
  check: ({ refs }) => cachedCheck(Array.isArray(refs) ? refs.slice(0, 200) : []),
  async actions({ actions }) {
    const res = await api.actions(actions);
    checkCache.clear();
    return res;
  },
  openOptions: () => chrome.runtime.openOptionsPage(),
  // The language picked in Settings, for the IMDb/TMDB badge (null = same as Chrome).
  uiStrings: () => pickedMessages(),

  // ---- auto-tracking ----
  track: (p, sender) => tracker.handleTrack(p, sender),
  trackerAction: (p) => tracker.handleTrackerAction(p),
  trackerEmbeds: (p, sender) => tracker.handleEmbeds(p, sender),
  trackedSites: () => tracker.trackedOrigins(),
  async syncTracker() {
    const origins = await tracker.syncTrackerScripts();
    await tracker.injectIntoOpenTabs(origins);
    return origins;
  },
};

// Content scripts run on third-party pages, so they only get a narrow set of operations.
const CONTENT_SCRIPT_ALLOWED = new Set(["getSession", "check", "title", "actions", "openOptions", "track", "trackerAction", "trackerEmbeds", "uiStrings"]);
// In-page notice buttons may only do these. "pick" can only choose among the titles Cue itself
// suggested for that session (by index); free linking/episode edits stay in the popup.
const CONTENT_TRACKER_ACTIONS = new Set(["ignore", "confirm", "undo", "pick", "firstEpisode"]);

function serializeError(e) {
  return {
    message: e?.message || String(e),
    code: e?.code || "error",
    status: e?.status ?? null,
    retryAfter: e?.retryAfter ?? null,
    requestId: e?.requestId ?? null,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;

  const fromExtensionPage = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  const blocked =
    !fromExtensionPage &&
    (!CONTENT_SCRIPT_ALLOWED.has(msg.type) || (msg.type === "trackerAction" && !CONTENT_TRACKER_ACTIONS.has(msg.payload?.action)));
  if (blocked) {
    sendResponse({ ok: false, error: { message: "Not allowed", code: "forbidden" } });
    return false;
  }

  languageReady
    .catch(() => {})
    .then(() => handler(msg.payload || {}, sender))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (e) => sendResponse({ ok: false, error: serializeError(e) })
    );
  return true; // async response
});

// ---------- context menu: search selected text ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  await languageReady.catch(() => {});
  chrome.contextMenus.create({
    id: "bingers-search",
    title: t("menu_search"),
    contexts: ["selection"],
  });
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  // After an update or reload, the trackers in open tabs are cut off from the extension and
  // new ones only arrive on the next page load. Put fresh ones into the open tabs now, so a
  // video that's already playing is picked up without reloading the page.
  tracker
    .syncTrackerScripts()
    .then((origins) => origins.length && tracker.injectIntoOpenTabs(origins))
    .catch(() => {});
  syncSuggestions().catch(() => {});
});

// ---------- auto-tracking: keep the tracker registered on exactly the approved sites ----------
chrome.runtime.onStartup.addListener(() => {
  tracker.syncTrackerScripts().catch(() => {});
  syncSuggestions().catch(() => {});
});
chrome.permissions.onAdded.addListener(async (p) => {
  await tracker.syncTrackerScripts().catch(() => {});
  if (p.origins?.length) await tracker.injectIntoOpenTabs(p.origins);
  syncSuggestions().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => {
  tracker.syncTrackerScripts().catch(() => {});
  syncSuggestions().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "autoTrack" in changes) {
    tracker.syncTrackerScripts().catch(() => {});
    syncSuggestions().catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => tracker.forgetTab(tabId).catch(() => {}));

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "bingers-search" || !info.selectionText) return;
  await chrome.storage.session.set({ pendingSearch: info.selectionText.trim().slice(0, 100) });
  try {
    await chrome.action.openPopup();
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html?tab=search") });
  }
});
