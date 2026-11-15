import { send, el, statusLabel, inLibrary, episodeParts, episodeCode, toast, describeResult } from "../lib/ui.js";
import { originPattern, ALL_SITES } from "../lib/sites.js";

const app = document.getElementById("app");
const who = document.getElementById("who");
document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
if (new URLSearchParams(location.search).has("tab")) document.body.classList.add("as-tab");

let activeTab = "next";
let searchTimer = null;
let lastQuery = "";
let currentTab = null; // the browser tab the popup was opened on
let linkSession = null; // when set, Search picks a title for this playback session

// ---------------- helpers ----------------
function openUrl(url) {
  if (url) chrome.tabs.create({ url });
}

function poster(src) {
  if (src) return el("img", { class: "poster", src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
  return el("div", { class: "poster ph", "aria-hidden": "true" }, "🎬");
}

function chip(status) {
  if (!status || status === "unknown") return null;
  const cls = status === "watched" || status === "completed" || status === "caught_up" ? "chip done" : inLibrary(status) ? "chip in" : "chip";
  return el("span", { class: cls }, statusLabel(status));
}

function showError(container, e) {
  container.replaceChildren(el("div", { class: "error-box" }, e?.message || "Something went wrong."));
}

async function runAction(button, action, onDone) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "…";
  try {
    const res = await send("actions", { actions: [action] });
    const d = describeResult(res);
    toast(d.message, d.ok ? "ok" : "err");
    if (d.ok && onDone) await onDone();
  } catch (e) {
    toast(e.message, "err");
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

// ---------------- signed-out ----------------
function renderSignedOut(session) {
  who.textContent = "";
  const children = [
    el("h1", {}, "Connect your Bingers account"),
    el("p", {}, "Track episodes, see your status on IMDb and TMDB, and mark things watched from any tab."),
  ];
  if (session.oauthConfigured) {
    children.push(
      el("button", {
        class: "btn primary big",
        onclick: async (ev) => {
          const b = ev.currentTarget;
          b.disabled = true;
          try {
            await send("signInOAuth");
            init();
          } catch (e) {
            toast(e.message, "err");
            b.disabled = false;
          }
        },
      }, "Sign in with Bingers")
    );
    children.push(el("button", { class: "link", onclick: () => chrome.runtime.openOptionsPage() }, "Use a personal access token instead"));
  } else {
    children.push(el("button", { class: "btn primary big", onclick: () => chrome.runtime.openOptionsPage() }, "Connect with an access token"));
  }
  children.push(el("p", { class: "muted", style: "font-size:11px" }, "API access needs the Bingers Legend or Icon plan."));
  app.replaceChildren(el("div", { class: "signin" }, children));
}

// ---------------- signed-in shell ----------------
function renderShell() {
  const tabs = el("div", { class: "tabs", role: "tablist" },
    el("button", { class: "tab", role: "tab", "aria-selected": String(activeTab === "next"), onclick: () => switchTab("next") }, "Up next"),
    el("button", { class: "tab", role: "tab", "aria-selected": String(activeTab === "search"), onclick: () => switchTab("search") }, "Search")
  );
  const panel = el("div", { class: "panel", id: "panel" });
  const live = el("div", { id: "live" });
  app.replaceChildren(live, tabs, panel);
  renderLive(live);
  if (activeTab === "next") renderUpNext(panel);
  else renderSearch(panel);
}

function switchTab(tab) {
  activeTab = tab;
  renderShell();
}

// ---------------- Up next ----------------
async function renderUpNext(panel) {
  panel.replaceChildren(el("div", { class: "empty" }, "Loading your watch list…"));
  let data;
  try {
    data = await send("watchlist", { limit: 10 });
  } catch (e) {
    return showError(panel, e);
  }
  const sections = data?.sections || {};
  const groups = [
    ["watch_next", "Watch next"],
    ["to_watch", "Movies to watch"],
    ["collecting_dust", "Collecting dust"],
    ["upcoming", "Upcoming"],
  ];
  const out = [];
  for (const [key, label] of groups) {
    const s = sections[key];
    if (!s?.items?.length) continue;
    out.push(el("div", { class: "section-title" }, el("span", {}, label), el("span", {}, String(s.count ?? s.items.length))));
    for (const item of s.items) out.push(libraryCard(item, key, () => renderUpNext(panel)));
  }
  if (!out.length) {
    out.push(el("div", { class: "empty" }, "Nothing queued up. Find something in Search and follow it."));
  }
  if (data?.truncated) out.push(el("div", { class: "empty", style: "font-size:11px" }, "Showing your most recent titles."));
  panel.replaceChildren(...out);
}

function libraryCard(item, sectionKey, reload) {
  const next = episodeParts(item.progress?.next);
  const subParts = [];
  if (item.kind === "show" && next) subParts.push(`Next: ${episodeCode(next)}${next.title ? ` · ${next.title}` : ""}`);
  else if (item.year) subParts.push(String(item.year));
  if (item.kind === "movie" && item.runtime_minutes) subParts.push(`${item.runtime_minutes} min`);
  if (sectionKey === "upcoming" && item.release_date) subParts.push(item.release_date);

  const actions = [];
  if (item.kind === "show" && next && sectionKey !== "upcoming") {
    const b = el("button", { class: "btn primary", title: `Mark ${episodeCode(next)} watched` }, `✓ ${episodeCode(next)}`);
    b.addEventListener("click", () => runAction(b, { action: "watch", title: item.id, season: next.season, episode: next.number }, reload));
    actions.push(b);
  } else if (item.kind === "movie" && item.status !== "watched" && sectionKey !== "upcoming") {
    const b = el("button", { class: "btn primary", title: "Mark watched" }, "✓ Watched");
    b.addEventListener("click", () => runAction(b, { action: "watch", title: item.id }, reload));
    actions.push(b);
  }

  return el("div", { class: "card" },
    el("div", { class: "meta" },
      el("button", { class: "name", title: item.title, onclick: () => openUrl(item.url) }, item.title),
      el("div", { class: "sub" }, subParts.join(" · ") || statusLabel(item.status))
    ),
    el("div", { class: "actions" }, actions)
  );
}

// ---------------- Search ----------------
function renderSearch(panel, initialQuery = lastQuery) {
  const input = el("input", { type: "search", placeholder: "Search shows and movies", value: initialQuery, "aria-label": "Search" });
  const kind = el("select", { "aria-label": "Type" },
    el("option", { value: "" }, "All"),
    el("option", { value: "show" }, "Shows"),
    el("option", { value: "movie" }, "Movies")
  );
  const results = el("div", { id: "results" });
  const run = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(input.value.trim(), kind.value, results), 350);
  };
  input.addEventListener("input", run);
  kind.addEventListener("change", run);
  panel.replaceChildren(el("div", { class: "search-row" }, input, kind), results);
  input.focus();
  if (initialQuery) doSearch(initialQuery, "", results);
  else results.replaceChildren(el("div", { class: "empty" }, linkSession ? "Search for the show or movie that's playing." : "Tip: select text on any page, right-click, and choose “Search Bingers”."));
}

async function doSearch(q, kind, results) {
  lastQuery = q;
  if (q.length < 2) {
    results.replaceChildren();
    return;
  }
  results.replaceChildren(el("div", { class: "empty" }, "Searching…"));
  try {
    const data = await send("search", { q, kind: kind || undefined, limit: 10 });
    if (q !== lastQuery) return; // stale
    const items = data?.items || [];
    if (!items.length) return results.replaceChildren(el("div", { class: "empty" }, `No matches for “${q}”.`));
    let statuses = {};
    try {
      statuses = await send("check", { refs: items.map((t) => t.id) });
    } catch {
      /* status is a nice-to-have */
    }
    if (q !== lastQuery) return;
    results.replaceChildren(...items.map((t) => searchCard(t, statuses[t.id]?.status, () => doSearch(q, kind, results))));
  } catch (e) {
    showError(results, e);
  }
}

function searchCard(t, status, reload) {
  const sub = [t.kind === "show" ? "Show" : "Movie", t.year, (t.genres || []).slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  const actions = [];
  const add = (label, action, primary = false) => {
    const b = el("button", { class: primary ? "btn primary" : "btn" }, label);
    b.addEventListener("click", () => runAction(b, { ...action, title: t.id }, reload));
    actions.push(b);
  };
  if (linkSession) {
    const b = el("button", { class: "btn primary" }, "This one");
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await send("trackerAction", { sessionId: linkSession, action: "link", titleId: t.id });
        linkSession = null;
        toast("Got it. Cue will track this.", "ok");
        switchTab("next");
      } catch (e) {
        b.disabled = false;
        toast(e.message, "err");
      }
    });
    actions.push(b);
  } else if (!inLibrary(status)) {
    add("+ Follow", { action: "follow" }, true);
    add("Later", { action: "for_later" });
  } else if (t.kind === "movie" && status !== "watched") {
    add("✓ Watched", { action: "watch" }, true);
  }
  return el("div", { class: "card" },
    poster(t.poster),
    el("div", { class: "meta" },
      el("button", { class: "name", title: t.title, onclick: () => openUrl(t.url) }, t.title),
      el("div", { class: "sub" }, sub, chip(status))
    ),
    el("div", { class: "actions" }, actions)
  );
}


// ---------------- Now playing + auto-track toggle for the current site ----------------
const STATE_TEXT = {
  identifying: "Identifying…",
  tracking: "Tracking",
  confirm: "Waiting for you to confirm on the page",
  watched: "Marked watched ✓",
  unknown: "Couldn't tell what's playing",
  ignored: "Not tracking this one",
  error: "Something went wrong",
};

async function renderLive(container) {
  const tab = currentTab;
  const pattern = tab?.url ? originPattern(tab.url) : null;
  if (!pattern || pattern.startsWith("https://api.bingers.app")) return container.replaceChildren();
  const host = new URL(tab.url).hostname.replace(/^www\./, "");
  const parts = [];

  const { nowPlaying = {} } = await chrome.storage.session.get("nowPlaying");
  const np = nowPlaying[tab.id];
  if (np) parts.push(nowPlayingCard(np, container));

  const hostname = new URL(tab.url).hostname;
  const everywhere = await chrome.permissions.contains({ origins: ALL_SITES });
  const { excludedHosts = [] } = await chrome.storage.sync.get({ excludedHosts: [] });
  const skipped = everywhere && excludedHosts.includes(hostname);
  const granted = !skipped && (everywhere || (await chrome.permissions.contains({ origins: [pattern] })));
  if (granted) {
    const turnOff = async () => {
      // With "all websites" on, a single site can't be un-granted, so it's skipped instead.
      if (everywhere) await chrome.storage.sync.set({ excludedHosts: [...new Set([...excludedHosts, hostname])] });
      else await chrome.permissions.remove({ origins: [pattern] });
      renderLive(container);
    };
    parts.push(el("div", { class: "site-row" },
      el("span", {}, el("span", { class: "live-dot" }), `Auto-tracking on ${host}`),
      el("button", { class: "link small", onclick: turnOff }, everywhere ? "Skip this site" : "Turn off")
    ));
  } else if (skipped) {
    const b = el("button", { class: "btn" }, `▶ Track ${host} again`);
    b.addEventListener("click", async () => {
      await chrome.storage.sync.set({ excludedHosts: excludedHosts.filter((h) => h !== hostname) });
      toast(`Auto-tracking on ${host} again`, "ok");
      renderLive(container);
    });
    parts.push(el("div", { class: "site-row" }, el("span", { class: "muted" }, `Skipped on ${host}`), b));
  } else {
    const b = el("button", { class: "btn" }, `▶ Auto-track ${host}`);
    b.addEventListener("click", async () => {
      // Chrome shows its own approval prompt. The popup may close while it's open; the
      // service worker finishes the setup either way.
      const ok = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
      if (ok) {
        await send("syncTracker").catch(() => {});
        toast(`Auto-tracking on ${host}. Play something!`, "ok");
      }
      renderLive(container);
    });
    parts.push(el("div", { class: "site-row" }, el("span", { class: "muted" }, "Mark episodes watched automatically here?"), b));
  }
  container.replaceChildren(...parts);
}

function nowPlayingCard(np, container) {
  const act = async (payload, okMsg) => {
    try {
      await send("trackerAction", { sessionId: np.sessionId, ...payload });
      if (okMsg) toast(okMsg, "ok");
    } catch (e) {
      toast(e.message, "err");
    }
    renderLive(container);
  };
  const title = np.label || np.detected || `Something on ${np.host}`;
  let status = STATE_TEXT[np.state] || np.state;
  if (np.state === "tracking" && np.progress) status += ` · ${Math.round(np.progress)}%`;
  if (np.state === "tracking" && np.guessed) status += " · guessed your next episode";
  if (np.state === "error" && np.message) status = np.message;

  const buttons = [];
  const isShow = np.kind !== "movie";
  if (np.label && isShow && ["tracking", "confirm", "unknown"].includes(np.state)) {
    buttons.push(
      el("button", { class: "btn", title: "Previous episode", onclick: () => act({ action: "episode", delta: -1 }) }, "Ep −"),
      el("button", { class: "btn", title: "Next episode", onclick: () => act({ action: "episode", delta: 1 }) }, "Ep +")
    );
  }
  if (["unknown", "tracking", "error"].includes(np.state) || np.needsEpisode) {
    buttons.push(el("button", {
      class: np.state === "unknown" ? "btn primary" : "btn",
      onclick: () => {
        linkSession = np.sessionId;
        lastQuery = np.detected || "";
        switchTab("search");
      },
    }, np.state === "unknown" ? "Pick title" : "Wrong title?"));
  }
  if (np.state === "tracking") buttons.push(el("button", { class: "btn", onclick: () => act({ action: "ignore" }, "Won't track this one") }, "Stop"));
  if (np.state === "watched") buttons.push(el("button", { class: "btn", onclick: () => act({ action: "undo" }, "Undone") }, "Undo"));

  return el("div", { class: "now" },
    el("div", { class: "now-top" }, el("span", { class: "eyebrow" }, `Now playing · ${np.host.replace(/^www\./, "")}`)),
    el("div", { class: "now-title", title }, title),
    el("div", { class: "now-sub" }, status),
    buttons.length ? el("div", { class: "now-actions" }, buttons) : null
  );
}

// ---------------- boot ----------------
async function init() {
  let session;
  try {
    session = await send("getSession");
  } catch (e) {
    return showError(app, e);
  }
  if (!session.signedIn) return renderSignedOut(session);

  try {
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    currentTab = null;
  }
  const p = session.profile;
  who.textContent = p?.handle ? `@${p.handle}` : p?.name || "Signed in";

  const { pendingSearch } = await chrome.storage.session.get("pendingSearch");
  if (pendingSearch) {
    await chrome.storage.session.remove("pendingSearch");
    activeTab = "search";
    lastQuery = pendingSearch;
  } else if (new URLSearchParams(location.search).get("tab") === "search") {
    activeTab = "search";
  }
  renderShell();
}

init();
