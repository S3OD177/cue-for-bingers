// UI text lives in _locales/<lang>/messages.json. Messages use $1…$9 for values filled in at
// runtime. By default Chrome picks the bundle from the browser's language (English fallback);
// the Language setting (sync storage `uiLang`) can pick one instead. chrome.i18n can't switch
// language at runtime, so a picked language is loaded here and looked up first.
// Content scripts can't import modules: content.js gets the picked messages from the service
// worker ("uiStrings"), and tracker.js gets its notice text ready-made from the service worker.

export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "ar", name: "العربية" },
];

let picked = null; // messages of the language chosen in Settings, or null to follow Chrome
let pickedCode = "auto";

// Load the Language setting. Extension pages await this before drawing; the service worker
// calls it at start-up and again whenever the setting changes.
export async function loadLanguage() {
  let code = "auto";
  try {
    ({ uiLang: code = "auto" } = await chrome.storage.sync.get({ uiLang: "auto" }));
  } catch {
    /* no storage (unit tests) */
  }
  picked = LANGUAGES.some((l) => l.code === code) ? await fetchMessages(code) : null;
  pickedCode = picked ? code : "auto";
  return pickedCode;
}

async function fetchMessages(code) {
  try {
    const res = await fetch(chrome.runtime.getURL(`_locales/${code}/messages.json`));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// What content scripts need to use the picked language: null when following Chrome.
export const pickedMessages = () => (picked ? { code: pickedCode, messages: picked } : null);

// Fill $1…$9 the way chrome.i18n does.
export const fillMessage = (message, subs) => message.replace(/\$(\d)/g, (_, n) => (subs[n - 1] ?? "")).replace(/\$\$/g, "$");

// The text for `key`, with $1… replaced by `subs`. A missing key shows the key itself, so a
// gap is visible instead of blank.
export function t(key, ...subs) {
  const own = picked?.[key]?.message;
  if (own != null) return fillMessage(own, subs.map(String));
  let m = "";
  try {
    m = chrome.i18n.getMessage(key, subs.map(String));
  } catch {
    /* no chrome.i18n (unit tests without a mock) */
  }
  return m || key;
}

// Text with DOM nodes in it, e.g. t("connectedTo") = "Connected to $1" with $1 a <strong>.
// Returns an array of strings and nodes, ready to pass to el(…children).
export function tNodes(key, ...nodes) {
  const marks = nodes.map((_, i) => `${i}`);
  return t(key, ...marks)
    .split(/(\d)/)
    .map((part, i) => (i % 2 ? nodes[Number(part)] : part))
    .filter((part) => part !== "");
}

// "ltr" or "rtl" for the language in use (each messages.json says which).
export const textDir = () => (t("dir") === "rtl" ? "rtl" : "ltr");

// Fill the static text of an extension page:
//   data-i18n="key"            → textContent   (data-i18n-args="80" for $1…, comma-separated)
//   data-i18n-title / -placeholder / -aria-label="key" → that attribute
// and set <html lang dir> so right-to-left languages lay out correctly.
export function localizePage(root = document) {
  document.documentElement.lang = t("lang");
  document.documentElement.dir = textDir();
  for (const node of root.querySelectorAll("[data-i18n]")) {
    const args = node.dataset.i18nArgs ? node.dataset.i18nArgs.split(",") : [];
    node.textContent = t(node.dataset.i18n, ...args);
  }
  for (const attr of ["title", "placeholder", "aria-label"]) {
    const data = `data-i18n-${attr}`;
    for (const node of root.querySelectorAll(`[${data}]`)) node.setAttribute(attr, t(node.getAttribute(data)));
  }
}
