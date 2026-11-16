// Thin client for https://api.bingers.app/v1 (OpenAPI 3.1 contract at /v1/openapi.json).
import { API_BASE } from "./config.js";
import { getAccessToken, getAuth, clearAuth } from "./auth.js";
import { t } from "./i18n.js";
import { logApi } from "./debuglog.js";

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// Title refs look like "imdb:tt0903747" or "tmdb:show:1396". Colons are legal in a path segment.
export function encodeRef(ref) {
  return encodeURIComponent(String(ref)).replace(/%3A/gi, ":");
}

async function request(path, { method = "GET", query, body } = {}, isRetry = false) {
  const url = new URL(API_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const token = await getAccessToken({ forceRefresh: isRetry });
  const started = Date.now();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    logApi({ method, path, query, status: 0, ms: Date.now() - started, data: null });
    throw new ApiError(0, "network", t("err_network"));
  }

  // An OAuth access token can be revoked/expired early: refresh once and retry.
  if (res.status === 401 && !isRetry) {
    const a = await getAuth();
    if (a?.mode === "oauth" && a.refresh_token) return request(path, { method, query, body }, true);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  logApi({ method, path, query, status: res.status, ms: Date.now() - started, data: data ?? (text ? text.slice(0, 300) : null) });

  if (!res.ok) {
    const err = (data && data.error) || {};
    const requestId = err.requestId;
    if (res.status === 401) {
      await clearAuth();
      throw new ApiError(401, err.code || "unauthorized", t("err_signedOut"), { requestId });
    }
    if (res.status === 403) {
      const msg =
        err.code === "insufficient_scope"
          ? t("err_readOnly")
          : err.message || t("err_plan");
      throw new ApiError(403, err.code || "forbidden", msg, { requestId });
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || Number(err.retryAfterSeconds) || 60;
      throw new ApiError(429, "rate_limited", t("err_rateLimited", retryAfter), { retryAfter, requestId });
    }
    if (res.status === 404) {
      throw new ApiError(404, err.code || "not_found", err.message || t("err_notFound"), { requestId });
    }
    throw new ApiError(res.status, err.code || `http_${res.status}`, err.message || t("err_requestFailed", res.status), { requestId });
  }
  return data;
}

export const api = {
  me: () => request("/me"),

  // Library & watch list
  watchlist: ({ kind, limit = 10, lang } = {}) => request("/watchlist", { query: { kind, limit, lang } }),
  library: ({ filter, kind, limit = 25, cursor, lang } = {}) => request("/library", { query: { filter, kind, limit, cursor, lang } }),
  recent: ({ kind, limit = 10, lang } = {}) => request("/recent", { query: { kind, limit, lang } }),
  favorites: ({ kind, limit = 25, lang } = {}) => request("/favorites", { query: { kind, limit, lang } }),
  check: (refs, { lang } = {}) => request("/library/check", { query: { titles: refs.slice(0, 100).join(","), lang } }),

  // Catalog
  search: (q, { kind, limit = 10, lang } = {}) => request("/search", { query: { q, kind, limit, lang } }),
  title: (ref, { lang } = {}) => request(`/titles/${encodeRef(ref)}`, { query: { lang } }),
  titles: (refs, { lang } = {}) => request("/titles", { query: { ids: refs.slice(0, 100).join(","), lang } }),
  episodes: (ref, { season } = {}) => request(`/titles/${encodeRef(ref)}/episodes`, { query: { season } }),
  trending: ({ kind, list, limit = 10, lang } = {}) => request("/trending", { query: { kind, list, limit, lang } }),

  // Writes (library:write)
  actions: (actions, { dryRun = false } = {}) =>
    request("/library/actions", { method: "POST", body: { actions: actions.slice(0, 100), ...(dryRun ? { dry_run: true } : {}) } }),
  // Trakt-style playback: start/pause record nothing (202); stop with progress >= 80 marks watched.
  playback: (phase, body) => request(`/scrobble/${phase}`, { method: "POST", body }),
  scrobble: (items, { dryRun = false } = {}) =>
    request("/scrobble", { method: "POST", body: { items: items.slice(0, 100), ...(dryRun ? { dry_run: true } : {}) } }),
};
