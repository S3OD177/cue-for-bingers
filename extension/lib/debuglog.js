// A short local log of recent API calls and what auto-tracking saw, so a user can copy it from
// Settings ("Copy debug info") and send it to the developer. Kept in session storage (cleared
// when the browser closes), never sent anywhere by the extension itself. Tokens are never logged;
// fields that look like personal or secret data are blanked.

const KEY = "debugLog";
const MAX_ENTRIES = 40;
const MAX_BODY = 3000; // characters of each response kept

const SECRET = /token|secret|password|email|authorization|cookie/i;

// Blank secret-looking fields, deeply, and cut long bodies down.
export function redact(value, depth = 0) {
  if (depth > 8) return "…";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? "[hidden]" : redact(v, depth + 1)]));
  }
  return value;
}

function clip(value) {
  try {
    const s = JSON.stringify(redact(value));
    return s && s.length > MAX_BODY ? `${s.slice(0, MAX_BODY)}…` : s ?? null;
  } catch {
    return null;
  }
}

let buffer = null; // loads once per service worker life; writes go through it
let loading = null;

async function entries() {
  if (buffer) return buffer;
  loading ||= chrome.storage.session
    .get(KEY)
    .then((r) => (buffer = Array.isArray(r?.[KEY]) ? r[KEY] : []))
    .catch(() => (buffer = []));
  return loading;
}

// Never throws and never blocks the caller (unit tests run without chrome.storage).
export function logEvent(kind, data) {
  (async () => {
    const list = await entries();
    list.push({ at: new Date().toISOString(), kind, ...data });
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    await chrome.storage.session.set({ [KEY]: list });
  })().catch(() => {});
}

export function logApi({ method, path, query, status, ms, data }) {
  // Search terms are what the user typed or what Cue read from a page: kept, they're the point.
  const q = query ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")) : undefined;
  logEvent("api", { method, path, query: q, status, ms, body: clip(data) });
}

export const readLog = async () => [...(await entries())];
