// Authentication: OAuth 2.1 + PKCE through chrome.identity, with a personal-access-token fallback.
import { AUTH_ISSUER, OAUTH_CLIENT_ID, OAUTH_SCOPES, OAUTH_RESOURCE } from "./config.js";
import { t } from "./i18n.js";

const STORE_KEY = "auth";
const EXPIRY_SKEW_MS = 60_000;

let discoveryCache = null;
let refreshPromise = null;

export class AuthError extends Error {
  constructor(message, code = "not_signed_in") {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = 401;
  }
}

export function isOAuthConfigured() {
  return typeof OAUTH_CLIENT_ID === "string" && OAUTH_CLIENT_ID.startsWith("https://") && !OAUTH_CLIENT_ID.includes("YOUR-DOMAIN");
}

export async function getDiscovery() {
  if (discoveryCache) return discoveryCache;
  const fallback = {
    authorization_endpoint: `${AUTH_ISSUER}/auth/oauth2/authorize`,
    token_endpoint: `${AUTH_ISSUER}/auth/oauth2/token`,
  };
  try {
    const res = await fetch(`${AUTH_ISSUER}/.well-known/oauth-authorization-server`, { headers: { Accept: "application/json" } });
    if (res.ok) {
      discoveryCache = { ...fallback, ...(await res.json()) };
      return discoveryCache;
    }
  } catch {
    /* fall back to documented endpoints */
  }
  return fallback;
}

// ---------- storage ----------
export async function getAuth() {
  const o = await chrome.storage.local.get(STORE_KEY);
  return o[STORE_KEY] || null;
}
async function setAuth(value) {
  await chrome.storage.local.set({ [STORE_KEY]: value });
}
export async function clearAuth() {
  await chrome.storage.local.remove(STORE_KEY);
}

// ---------- PKCE helpers ----------
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomString(byteLength = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}
async function s256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

async function tokenRequest(endpoint, params) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    throw new AuthError(t("err_authNetwork"), "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new AuthError(data.error_description || data.error?.message || data.error || `Sign-in failed (${res.status}).`, "oauth_error");
    err.oauthError = typeof data.error === "string" ? data.error : data.error?.code;
    throw err;
  }
  return data;
}

async function saveTokens(tokens, previous = null) {
  await setAuth({
    mode: "oauth",
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || previous?.refresh_token || null,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    scope: tokens.scope || previous?.scope || OAUTH_SCOPES,
  });
}

// ---------- sign-in flows ----------
export async function signInWithOAuth() {
  if (!isOAuthConfigured()) {
    throw new AuthError(t("err_oauthNotSetup"), "oauth_not_configured");
  }
  const d = await getDiscovery();
  const redirectUri = chrome.identity.getRedirectURL(); // https://<extension-id>.chromiumapp.org/
  const verifier = randomString(48);
  const state = randomString(16);

  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    resource: OAUTH_RESOURCE,
  }).toString();

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
  } catch (e) {
    throw new AuthError(/did not approve|cancel/i.test(e?.message || "") ? t("err_cancelled") : `Sign-in failed: ${e?.message || e}`, "cancelled");
  }
  if (!responseUrl) throw new AuthError(t("err_cancelled"), "cancelled");

  const params = new URL(responseUrl).searchParams;
  if (params.get("error")) throw new AuthError(params.get("error_description") || params.get("error"), "oauth_error");
  if (params.get("state") !== state) throw new AuthError(t("err_stateMismatch"), "state_mismatch");
  const code = params.get("code");
  if (!code) throw new AuthError(t("err_noCode"), "oauth_error");

  const tokens = await tokenRequest(d.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: verifier,
    resource: OAUTH_RESOURCE,
  });
  await saveTokens(tokens);
}

export async function signInWithToken(token) {
  const tok = String(token || "").trim();
  if (!/^bng_pat_[A-Za-z0-9_\-]+$/.test(tok)) {
    throw new AuthError(t("err_tokenFormat"), "invalid_token_format");
  }
  await setAuth({ mode: "pat", token: tok });
}

export async function signOut() {
  const a = await getAuth();
  if (a?.mode === "oauth" && a.refresh_token) {
    try {
      const d = await getDiscovery();
      if (d.revocation_endpoint) {
        await fetch(d.revocation_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: a.refresh_token, token_type_hint: "refresh_token", client_id: OAUTH_CLIENT_ID }).toString(),
        });
      }
    } catch {
      /* best effort */
    }
  }
  await clearAuth();
}

// ---------- access token for API calls ----------
export async function getAccessToken({ forceRefresh = false } = {}) {
  const a = await getAuth();
  if (!a) throw new AuthError(t("err_notSignedIn"));
  if (a.mode === "pat") return a.token;

  if (!forceRefresh && a.access_token && a.expires_at - EXPIRY_SKEW_MS > Date.now()) return a.access_token;
  if (!a.refresh_token) {
    await clearAuth();
    throw new AuthError(t("err_expired"), "expired");
  }
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const d = await getDiscovery();
        const tokens = await tokenRequest(d.token_endpoint, {
          grant_type: "refresh_token",
          refresh_token: a.refresh_token,
          client_id: OAUTH_CLIENT_ID,
          resource: OAUTH_RESOURCE,
        });
        await saveTokens(tokens, a);
        return tokens.access_token;
      } catch (e) {
        if (e.oauthError === "invalid_grant") {
          await clearAuth();
          throw new AuthError(t("err_expired"), "expired");
        }
        throw e;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}
