// Shared helpers for extension pages (popup + options). All DOM is built with
// textContent/createElement — never innerHTML with API data.
import { t, LANGUAGES } from "./i18n.js";

export { t, tNodes, localizePage, loadLanguage, LANGUAGES } from "./i18n.js";

export function send(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message));
      if (!res) return reject(new Error(t("err_noResponse")));
      if (res.ok) resolve(res.data);
      else reject(Object.assign(new Error(res.error?.message || t("err_generic")), res.error || {}));
    });
  });
}

// The Language dropdown (Settings and the welcome page). Language names are shown in their own
// language, so they're readable whatever is selected. Changing it saves and reloads the page.
export function languageSelect(current) {
  const select = el("select", { "aria-label": t("opt_language") },
    el("option", { value: "auto" }, t("opt_languageAuto")),
    LANGUAGES.map((l) => el("option", { value: l.code, lang: l.code }, l.name))
  );
  select.value = current;
  select.addEventListener("change", async () => {
    await chrome.storage.sync.set({ uiLang: select.value });
    location.reload(); // redraw every label in the new language
  });
  return select;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const STATUSES = ["watch_next", "collecting_dust", "not_started", "caught_up", "completed", "upcoming", "watch_later", "stopped", "progress_pending", "to_watch", "started", "watched", "not_in_library", "unknown"];

export function statusLabel(s) {
  if (STATUSES.includes(s)) return t(`status_${s}`);
  return s ? String(s).replace(/_/g, " ") : "";
}

export function inLibrary(status) {
  return !!status && status !== "not_in_library" && status !== "unknown";
}

const pad = (n) => String(n).padStart(2, "0");

// progress.next / progress.furthest shapes aren't pinned down in the contract; accept common field names.
export function episodeParts(ep) {
  if (!ep || typeof ep !== "object") return null;
  const season = ep.season ?? ep.season_number;
  const number = ep.number ?? ep.episode ?? ep.episode_number;
  if (season === undefined || number === undefined || season === null || number === null) return null;
  return { season: Number(season), number: Number(number), title: ep.title || ep.name || null };
}

export function episodeCode(ep) {
  const p = episodeParts(ep);
  return p ? `S${pad(p.season)}E${pad(p.number)}` : null;
}

let toastTimer;
export function toast(message, kind = "info") {
  let t = document.getElementById("toast");
  if (!t) {
    t = el("div", { id: "toast", role: "status", "aria-live": "polite" });
    document.body.append(t);
  }
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = `toast ${kind}`), 2800);
}

export function describeResult(result) {
  const r = result?.results?.[0];
  if (!r) return { ok: true, message: t("result_done") };
  if (r.status === "ok") return { ok: true, message: r.outcome === "rewatched" ? t("result_rewatch") : t("result_saved") };
  if (r.status === "already") return { ok: true, message: t("result_already") };
  if (r.status === "unresolved") return { ok: false, message: r.message || t("result_unresolved") };
  return { ok: false, message: r.message || t("result_failed") };
}
