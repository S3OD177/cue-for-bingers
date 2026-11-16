import { send, el, statusLabel, inLibrary, episodeParts, episodeCode, toast, describeResult, t, localizePage, loadLanguage } from "../lib/ui.js";
import { originPattern, ALL_SITES, POPULAR_SITES } from "../lib/sites.js";
import { REPORT_FORM, reportsEnabled } from "../lib/config.js";
import { icon } from "../lib/icons.js";

// One click sends a short report to the developer's Google Form (rows land in their Sheet).
// No sign-in for the user; only what's listed here is sent, and only when they click.
// Asks Cue's tracker on the current page for the title info it reads (title, og:title, heading,
// media-session and episode/movie JSON-LD, path). Null when Cue isn't running on the page.
async function pageInfo() {
  if (!currentTab?.id) return null;
  try {
    const info = await Promise.race([
      chrome.tabs.sendMessage(currentTab.id, { type: "cuePageInfo" }, { frameId: 0 }),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    return info || null;
  } catch {
    return null;
  }
}

async function reportToDeveloper(subject, lines, button) {
  const f = REPORT_FORM.fields;
  if (button) button.disabled = true;
  const info = await pageInfo();
  const details = info ? [...lines, "", "Page info:", JSON.stringify(info).slice(0, 4000)] : lines;
  const body = new URLSearchParams({
    [f.subject]: subject,
    [f.details]: details.join("\n"),
    [f.version]: chrome.runtime.getManifest().version,
  });
  if (button) button.disabled = true;
  try {
    // Google Forms doesn't send CORS headers, so the response can't be read ("no-cors").
    await fetch(REPORT_FORM.action, { method: "POST", mode: "no-cors", body });
    toast(t("report_sent"), "ok");
    if (button) button.textContent = t("report_sentBtn");
    return true;
  } catch {
    toast(t("report_failed"), "err");
    if (button) button.disabled = false;
    return false;
  }
}
// Known = on Cue's streaming-site list (www. or not).
const bareHost = (o) => String(o).replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/^www\./, "");
const isKnownSite = (pattern) => POPULAR_SITES.some((s) => bareHost(s.origin) === bareHost(pattern));

await loadLanguage();
localizePage();
const app = document.getElementById("app");
const who = document.getElementById("who");
const optionsBtn = document.getElementById("open-options");
optionsBtn.replaceChildren(icon("settings", 16));
optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
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
  if (src) {
    const img = el("img", { class: "poster", src, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.replaceWith(poster(null)), { once: true });
    return img;
  }
  return el("div", { class: "poster ph", "aria-hidden": "true" }, icon("film", 16));
}

// A button with a leading icon.
function iconBtn(cls, name, label, attrs = {}) {
  return el("button", { class: cls, ...attrs }, icon(name, 13), el("span", {}, label));
}

// Grey placeholder rows while a list loads.
function skeleton(rows = 3, withPoster = false) {
  return el("div", { class: "skeleton", "aria-busy": "true", "aria-label": t("common_loading") },
    Array.from({ length: rows }, () =>
      el("div", { class: "card sk-card" },
        withPoster ? el("div", { class: "poster sk" }) : null,
        el("div", { class: "meta" }, el("div", { class: "sk sk-line" }), el("div", { class: "sk sk-line short" })),
        el("div", { class: "sk sk-btn" })
      )
    )
  );
}

function emptyState(iconName, text) {
  return el("div", { class: "empty" }, el("div", { class: "empty-ic" }, icon(iconName, 22)), el("div", {}, text));
}

function chip(status) {
  if (!status || status === "unknown") return null;
  const cls = status === "watched" || status === "completed" || status === "caught_up" ? "chip done" : inLibrary(status) ? "chip in" : "chip";
  return el("span", { class: cls }, statusLabel(status));
}

function showError(container, e) {
  container.replaceChildren(el("div", { class: "error-box" }, e?.message || t("err_generic")));
}

async function runAction(button, action, onDone) {
  button.disabled = true;
  button.classList.add("busy");
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
      button.classList.remove("busy");
    }
  }
}

// ---------------- signed-out ----------------
function renderSignedOut(session) {
  who.textContent = "";
  const children = [
    el("h1", {}, t("signin_title")),
    el("p", {}, t("signin_body")),
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
      }, t("signin_oauth"))
    );
    children.push(el("button", { class: "link", onclick: () => chrome.runtime.openOptionsPage() }, t("signin_usePat")));
  } else {
    children.push(el("button", { class: "btn primary big", onclick: () => chrome.runtime.openOptionsPage() }, t("signin_connectToken")));
  }
  children.push(el("p", { class: "muted fine" }, t("signin_planNote")));
  app.replaceChildren(el("div", { class: "signin" }, el("img", { class: "signin-logo", src: "../icons/icon128.png", alt: "", width: "56", height: "56" }), children));
}

// ---------------- signed-in shell ----------------
function renderShell() {
  const tabs = el("div", { class: "tabs", role: "tablist" },
    el("button", { class: "tab", role: "tab", "aria-selected": String(activeTab === "next"), onclick: () => switchTab("next") }, t("tab_next")),
    el("button", { class: "tab", role: "tab", "aria-selected": String(activeTab === "search"), onclick: () => switchTab("search") }, t("tab_search"))
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
// First load shows placeholder rows; a refresh (after an action) keeps the list on screen,
// dimmed, until the new one arrives.
function startLoading(container, rows) {
  const refresh = !!container.querySelector(".card:not(.sk-card)");
  if (refresh) container.classList.add("stale");
  else container.replaceChildren(skeleton(rows, true));
  return refresh;
}

function finishLoading(container, refresh, children) {
  container.classList.remove("stale");
  container.classList.toggle("no-anim", refresh);
  container.replaceChildren(...children);
}

async function renderUpNext(panel) {
  const refresh = startLoading(panel, 4);
  let data;
  try {
    data = await send("watchlist", { limit: 10 });
  } catch (e) {
    panel.classList.remove("stale");
    return showError(panel, e);
  }
  const sections = data?.sections || {};
  const groups = [
    ["watch_next", statusLabel("watch_next")],
    ["to_watch", t("upnext_movies")],
    ["collecting_dust", statusLabel("collecting_dust")],
    ["upcoming", statusLabel("upcoming")],
  ];
  const out = [];
  for (const [key, label] of groups) {
    const s = sections[key];
    if (!s?.items?.length) continue;
    out.push(el("div", { class: "section-title" }, el("span", {}, label), el("span", {}, String(s.count ?? s.items.length))));
    for (const item of s.items) out.push(libraryCard(item, key, () => renderUpNext(panel)));
  }
  if (!out.length) {
    out.push(emptyState("tv", t("upnext_empty")));
  }
  if (data?.truncated) out.push(el("div", { class: "muted fine center-note" }, t("upnext_truncated")));
  finishLoading(panel, refresh, out);
  fillPosters(panel);
}

// The watch list has no posters: show placeholders first, then swap in posters from one
// batched (and cached) lookup in the service worker.
// Posters already looked up while this popup is open, so a refresh draws them straight away.
const knownPosters = new Map();

async function fillPosters(panel) {
  const slots = [...panel.querySelectorAll(".poster.ph[data-id]")];
  if (!slots.length) return;
  let urls = {};
  try {
    urls = await send("posters", { ids: slots.map((s) => s.dataset.id) });
  } catch {
    return;
  }
  for (const slot of slots) {
    const url = urls?.[slot.dataset.id];
    knownPosters.set(slot.dataset.id, url || null);
    if (url && slot.isConnected) slot.replaceWith(poster(url));
  }
}

function libraryCard(item, sectionKey, reload) {
  const next = episodeParts(item.progress?.next);
  const subParts = [];
  if (item.kind === "show" && next) subParts.push(t("upnext_next", `${episodeCode(next)}${next.title ? ` · ${next.title}` : ""}`));
  else if (item.year) subParts.push(String(item.year));
  if (item.kind === "movie" && item.runtime_minutes) subParts.push(t("common_minutes", item.runtime_minutes));
  if (sectionKey === "upcoming" && item.release_date) subParts.push(item.release_date);

  const actions = [];
  if (item.kind === "show" && next && sectionKey !== "upcoming") {
    const b = iconBtn("btn primary", "check", episodeCode(next), { title: t("action_markEp", episodeCode(next)) });
    b.addEventListener("click", () => runAction(b, { action: "watch", title: item.id, season: next.season, episode: next.number }, reload));
    actions.push(b);
  } else if (item.kind === "movie" && item.status !== "watched" && sectionKey !== "upcoming") {
    const b = iconBtn("btn primary", "check", t("action_watched"), { title: t("action_markWatched") });
    b.addEventListener("click", () => runAction(b, { action: "watch", title: item.id }, reload));
    actions.push(b);
  }

  const slot = poster(knownPosters.get(item.id) || null);
  if (item.id && !knownPosters.has(item.id)) slot.dataset.id = item.id;
  return el("div", { class: "card" },
    slot,
    el("div", { class: "meta" },
      el("button", { class: "name", title: item.title, onclick: () => openUrl(item.url) }, item.title),
      el("div", { class: "sub" }, subParts.join(" · ") || statusLabel(item.status))
    ),
    el("div", { class: "actions" }, actions)
  );
}

// ---------------- Search ----------------
function renderSearch(panel, initialQuery = lastQuery) {
  const input = el("input", { type: "search", placeholder: t("search_placeholder"), value: initialQuery, "aria-label": t("tab_search") });
  const field = el("label", { class: "search-field" }, icon("search", 15), input);
  const kind = el("select", { "aria-label": t("search_type") },
    el("option", { value: "" }, t("search_all")),
    el("option", { value: "show" }, t("search_shows")),
    el("option", { value: "movie" }, t("search_movies"))
  );
  const results = el("div", { id: "results" });
  const run = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(input.value.trim(), kind.value, results), 350);
  };
  input.addEventListener("input", run);
  kind.addEventListener("change", run);
  panel.replaceChildren(el("div", { class: "search-row" }, field, kind), results);
  input.focus();
  if (initialQuery) doSearch(initialQuery, "", results);
  else results.replaceChildren(emptyState("search", linkSession ? t("search_pickHint") : t("search_tip")));
}

async function doSearch(q, kind, results) {
  lastQuery = q;
  if (q.length < 2) {
    results.replaceChildren();
    return;
  }
  const refresh = startLoading(results, 3);
  try {
    const data = await send("search", { q, kind: kind || undefined, limit: 10 });
    if (q !== lastQuery) return; // stale
    const items = data?.items || [];
    if (!items.length) return finishLoading(results, false, [emptyState("search", t("search_noMatches", q))]);
    let statuses = {};
    try {
      statuses = await send("check", { refs: items.map((t) => t.id) });
    } catch {
      /* status is a nice-to-have */
    }
    if (q !== lastQuery) return;
    finishLoading(results, refresh, items.map((t) => searchCard(t, statuses[t.id]?.status, () => doSearch(q, kind, results))));
  } catch (e) {
    if (q !== lastQuery) return;
    results.classList.remove("stale");
    showError(results, e);
  }
}

function searchCard(item, status, reload) {
  const sub = [item.kind === "show" ? t("search_show") : t("search_movie"), item.year, (item.genres || []).slice(0, 2).join(", ")].filter(Boolean).join(" · ");
  const actions = [];
  const add = (iconName, label, action, primary = false) => {
    const b = iconBtn(primary ? "btn primary" : "btn", iconName, label);
    b.addEventListener("click", () => runAction(b, { ...action, title: item.id }, reload));
    actions.push(b);
  };
  if (linkSession) {
    const b = el("button", { class: "btn primary" }, t("search_thisOne"));
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await send("trackerAction", { sessionId: linkSession, action: "link", titleId: item.id });
        linkSession = null;
        toast(t("search_linked"), "ok");
        switchTab("next");
      } catch (e) {
        b.disabled = false;
        toast(e.message, "err");
      }
    });
    actions.push(b);
  } else if (!inLibrary(status)) {
    add("plus", t("action_follow"), { action: "follow" }, true);
    add("clock", t("action_later"), { action: "for_later" });
  } else if (item.kind === "movie" && status !== "watched") {
    add("check", t("action_watched"), { action: "watch" }, true);
  }
  return el("div", { class: "card" },
    poster(item.poster),
    el("div", { class: "meta" },
      el("button", { class: "name", title: item.title, onclick: () => openUrl(item.url) }, item.title),
      el("div", { class: "sub" }, sub, chip(status))
    ),
    el("div", { class: "actions" }, actions)
  );
}


// ---------------- Now playing + auto-track toggle for the current site ----------------
const STATES = ["identifying", "tracking", "confirm", "watched", "unknown", "ignored", "error"];
const stateText = (state) => (STATES.includes(state) ? t(`state_${state}`) : state);

// Embedded player hosts the tracker found in this tab that aren't turned on yet.
async function missingEmbeds(tabId) {
  const { embeds = {} } = await chrome.storage.session.get("embeds");
  const out = [];
  for (const o of embeds[tabId] || []) {
    if (!(await chrome.permissions.contains({ origins: [o] }).catch(() => true))) out.push(o);
  }
  return out;
}

// Before the site is on, the popup can still look at the top page (activeTab) and list the
// iframes that look like video players.
async function pagePlayerOrigins(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () =>
        [...document.querySelectorAll("iframe[src]")]
          .filter((f) => {
            const r = f.getBoundingClientRect();
            return f.allowFullscreen || /fullscreen/.test(f.getAttribute("allow") || "") || f.hasAttribute("webkitallowfullscreen") || (r.width >= 320 && r.height >= 180);
          })
          .map((f) => f.src),
    });
    const set = new Set();
    for (const src of r?.result || []) {
      const p = originPattern(String(src));
      if (p && !p.startsWith("https://api.bingers.app")) set.add(p);
    }
    return [...set].slice(0, 4);
  } catch {
    return [];
  }
}

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
      el("span", {}, el("span", { class: "live-dot" }), t("live_on", host)),
      el("button", { class: "link small", onclick: turnOff }, everywhere ? t("live_skipSite") : t("live_turnOff"))
    ));
    // The video may play in an embedded player from another host, which needs its own approval.
    const missing = everywhere ? [] : await missingEmbeds(tab.id);
    if (missing.length && !np) {
      const names = missing.map((o) => o.replace(/^https?:\/\//, "").replace(/\/\*$/, "")).join(", ");
      const b = iconBtn("btn primary", "play", t("live_trackPlayer"));
      b.addEventListener("click", async () => {
        const ok = await chrome.permissions.request({ origins: missing }).catch(() => false);
        if (ok) {
          await send("syncTracker").catch(() => {});
          toast(t("live_playerOn"), "ok");
        }
        renderLive(container);
      });
      parts.push(el("div", { class: "site-row" }, el("span", { class: "muted" }, t("live_playsFrom", names)), b));
    }
    // A site we don't list yet: let the user tell the developer about it.
    if (reportsEnabled() && !isKnownSite(pattern)) {
      // Remember sites this browser already suggested, so the same site isn't sent twice.
      const { suggestedHosts = [] } = await chrome.storage.local.get("suggestedHosts");
      const already = suggestedHosts.includes(host);
      const suggest = el("button", {
        class: "link small",
        onclick: async (e) => {
          const b = e.currentTarget;
          if (await reportToDeveloper(`Add ${host} to Cue`, [`Please add this streaming site: ${host}`], b)) {
            const { suggestedHosts: list = [] } = await chrome.storage.local.get("suggestedHosts");
            await chrome.storage.local.set({ suggestedHosts: [...new Set([...list, host])].slice(-100) });
          }
        },
      }, already ? t("live_suggested") : t("live_suggest"));
      if (already) suggest.disabled = true;
      parts.push(el("div", { class: "site-row" },
        el("span", { class: "muted small" }, already ? t("live_suggestedNote", host) : t("live_notListed", host)),
        suggest
      ));
    }
  } else if (skipped) {
    const b = iconBtn("btn", "play", t("live_trackAgain", host));
    b.addEventListener("click", async () => {
      await chrome.storage.sync.set({ excludedHosts: excludedHosts.filter((h) => h !== hostname) });
      toast(t("live_onAgain", host), "ok");
      renderLive(container);
    });
    parts.push(el("div", { class: "site-row" }, el("span", { class: "muted" }, t("live_skipped", host)), b));
  } else {
    // Chrome shows its own approval prompt. The popup may close while it's open; the
    // service worker finishes the setup either way.
    const turnOn = (origins, msg) => async () => {
      const ok = await chrome.permissions.request({ origins }).catch(() => false);
      if (ok) {
        await send("syncTracker").catch(() => {});
        toast(msg, "ok");
      }
      renderLive(container);
    };
    // Ask for the page's embedded player hosts in the same prompt (one click instead of two).
    const players = await pagePlayerOrigins(tab.id);
    const b = iconBtn("btn primary", "play", t("action_track", host), { onclick: turnOn([pattern, ...players.filter((o) => o !== pattern)], t("live_nowOn", host)) });
    const all = el("button", { class: "link small", onclick: turnOn(ALL_SITES, t("live_allOn")) }, t("live_everySite"));
    parts.push(el("div", { class: "site-row offer" }, el("span", { class: "muted" }, t("live_offer")), el("span", { class: "offer-actions" }, b, all)));
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
  const title = np.label || np.detected || t("np_something", np.host);
  let status = stateText(np.state);
  const pct = np.state === "tracking" && np.progress ? Math.max(0, Math.min(100, Math.round(np.progress))) : null;
  if (pct != null) status += ` · ${pct}%`;
  if (np.state === "tracking" && np.guessed) status += ` · ${t("np_guessed")}`;
  if (np.state === "error" && np.message) status = np.message;

  const buttons = [];
  const isShow = np.kind !== "movie";
  let picker = null;
  // A show is identified (np.label), so its season and episode can be set by hand.
  if (np.label && isShow && ["tracking", "confirm", "unknown", "watched"].includes(np.state)) {
    const known = np.episode != null;
    const current = known ? `S${String(np.season ?? 1).padStart(2, "0")} · E${String(np.episode).padStart(2, "0")}` : null;
    const choose = el("button", {
      class: known && !np.guessed ? "btn ep-btn" : "btn primary ep-btn",
      title: known ? t("np_changeEp") : t("np_setEp"),
      "aria-expanded": "false",
    }, known ? [current, icon("pencil", 12)] : t("np_chooseEp"));
    const toggle = (open) => {
      picker.hidden = !open;
      choose.setAttribute("aria-expanded", String(open));
      if (open) {
        const input = picker.querySelector("input[name=episode]");
        input?.focus();
        input?.select();
      }
    };
    picker = episodePicker(np, act, () => toggle(false));
    choose.addEventListener("click", () => toggle(picker.hidden));
    buttons.push(choose);
    toggle(!known);
  }
  // Same guesses as the in-page notice: one click tracks it.
  const guesses = np.state === "unknown" ? (np.suggestions || []) : [];
  guesses.forEach((name, index) => {
    buttons.push(el("button", {
      class: index === 0 ? "btn primary" : "btn",
      title: t("action_track", name),
      onclick: () => act({ action: "pick", index }, t("action_tracking", name)),
    }, t("action_track", name)));
  });
  if (["unknown", "tracking", "error"].includes(np.state) || np.needsEpisode) {
    buttons.push(el("button", {
      class: np.state === "unknown" && !guesses.length ? "btn primary" : "btn",
      onclick: () => {
        linkSession = np.sessionId;
        lastQuery = np.detected || "";
        switchTab("search");
      },
    }, np.state === "unknown" ? t("np_pickTitle") : t("np_wrongTitle")));
  }
  if (reportsEnabled() && ["unknown", "error"].includes(np.state)) {
    buttons.push(el("button", {
      class: "btn",
      title: t("np_reportHint"),
      onclick: (e) => reportToDeveloper(`Cue couldn't read ${np.host}`, [
        `Site: ${np.host}`,
        `What Cue saw: ${np.detected || "(nothing)"}`,
        `Status: ${np.state}${np.message ? ` (${np.message})` : ""}`,
      ], e.currentTarget),
    }, t("np_report")));
  }
  if (np.state === "tracking") buttons.push(el("button", { class: "btn", onclick: () => act({ action: "ignore" }, t("np_stopped")) }, t("np_stop")));
  if (np.state === "watched") buttons.push(iconBtn("btn", "undo", t("action_undo"), { onclick: () => act({ action: "undo" }, t("action_undone")) }));

  // Progress toward the end of the video; full once marked watched.
  const fill = np.state === "watched" ? 100 : pct;
  const bar = fill != null
    ? el("div", { class: "now-bar", role: "progressbar", "aria-label": t("np_progress"), "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(fill) },
      el("span", { style: `width:${fill}%` }))
    : null;

  return el("div", { class: `now state-${np.state}`, dataset: { session: np.sessionId, state: np.state } },
    el("div", { class: "now-top" }, el("span", { class: "eyebrow" }, el("span", { class: "state-dot" }), t("np_eyebrow", np.host.replace(/^www\./, "")))),
    el("div", { class: "now-title", title }, title),
    el("div", { class: "now-sub" }, status),
    bar,
    buttons.length ? el("div", { class: "now-actions" }, buttons) : null,
    picker
  );
}

// Season + episode number fields. Saving re-targets tracking; if the wrong episode was already
// marked watched, the service worker moves the mark.
function episodePicker(np, act, close) {
  const num = (name, label, value, min) =>
    el("label", { class: "ep-field" }, label,
      el("input", { type: "number", name, min: String(min), max: "9999", step: "1", inputmode: "numeric", value: value != null ? String(value) : "", placeholder: "#", required: "" }));
  const save = el("button", { class: "btn primary", type: "submit" }, np.state === "watched" ? t("ep_fix") : t("ep_save"));
  const cancel = np.episode != null ? el("button", { class: "link small", type: "button", onclick: close }, t("ep_cancel")) : null;
  const form = el("form", { class: "ep-picker" },
    num("season", t("ep_season"), np.season ?? 1, 0),
    num("episode", t("ep_episode"), np.episode, 1),
    save,
    cancel
  );
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cancel) {
      e.preventDefault();
      close();
    }
  });
  const hint = np.state === "watched" ? t("ep_hintMove") : np.guessed ? t("ep_hintGuessed") : null;
  if (hint) form.append(el("div", { class: "ep-hint" }, hint));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const season = Number(form.elements.season.value);
    const episode = Number(form.elements.episode.value);
    if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1) {
      toast(t("ep_invalid"), "err");
      return;
    }
    save.disabled = true;
    const code = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    act({ action: "setEpisode", season, episode }, np.state === "watched" ? t("ep_moved", code) : t("action_tracking", code));
  });
  return form;
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
  who.textContent = p?.handle ? `@${p.handle}` : p?.name || t("signin_signedIn");

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

// Keep Now playing current while the popup is open. Progress ticks only patch the status
// line and bar; a new state redraws the row, unless the viewer is typing in the episode picker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.nowPlaying || !currentTab?.id) return;
  const live = document.getElementById("live");
  if (!live) return;
  if (live.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const np = changes.nowPlaying.newValue?.[currentTab.id];
  const card = live.querySelector(".now");
  if (np && card && card.dataset.session === np.sessionId && card.dataset.state === np.state) {
    const fresh = nowPlayingCard(np, live);
    for (const sel of [".now-sub", ".now-bar"]) {
      const a = card.querySelector(sel), b = fresh.querySelector(sel);
      if (a && b) a.replaceWith(b);
    }
    return;
  }
  live.classList.add("no-anim");
  renderLive(live);
});
