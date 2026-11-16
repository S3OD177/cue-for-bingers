// Mocked tests for auth, API client and parsers. Run: node tests/run.mjs
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "extension", "lib");

// Copy lib with a configured OAuth client id so the OAuth path can be exercised.
const tmp = mkdtempSync(join(tmpdir(), "bingers-test-"));
cpSync(lib, tmp, { recursive: true });
const cfgPath = join(tmp, "config.js");
writeFileSync(cfgPath, readFileSync(cfgPath, "utf8").replace(/export const OAUTH_CLIENT_ID = "[^"]*"/, 'export const OAUTH_CLIENT_ID = "https://example.test/client.json"'));

// ---- chrome mock ----
const store = {};
let authFlowUrl = null;
globalThis.chrome = {
  storage: {
    local: {
      async get(k) { return typeof k === "string" ? (k in store ? { [k]: store[k] } : {}) : { ...store }; },
      async set(o) { Object.assign(store, o); },
      async remove(k) { delete store[k]; },
    },
  },
  identity: {
    getRedirectURL: () => "https://abcdefghijklmnop.chromiumapp.org/",
    async launchWebAuthFlow({ url }) {
      authFlowUrl = new URL(url);
      const state = authFlowUrl.searchParams.get("state");
      return `https://abcdefghijklmnop.chromiumapp.org/?code=CODE123&state=${state}`;
    },
  },
};

// ---- fetch mock ----
const calls = [];
let handler = null;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ url: u, init });
  return handler(u, init);
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const auth = await import(pathToFileURL(join(tmp, "auth.js")));
const { api, encodeRef } = await import(pathToFileURL(join(tmp, "api.js")));
const { normalizeCheck } = await import(pathToFileURL(join(tmp, "normalize.js")));

let passed = 0;
async function test(name, fn) {
  calls.length = 0;
  try {
    await fn();
    passed++;
    console.log("✓", name);
  } catch (e) {
    console.error("✗", name, "\n ", e);
    process.exitCode = 1;
  }
}

await test("encodeRef keeps colons", () => {
  assert.equal(encodeRef("imdb:tt0903747"), "imdb:tt0903747");
  assert.equal(encodeRef("tmdb:show:1396"), "tmdb:show:1396");
});

await test("PAT format is validated", async () => {
  await assert.rejects(auth.signInWithToken("nope"), /bng_pat_/);
  await auth.signInWithToken("  bng_pat_abc123  ");
  assert.deepEqual(store.auth, { mode: "pat", token: "bng_pat_abc123" });
});

await test("PAT request sends bearer + query params", async () => {
  handler = () => json(200, { items: [{ id: "1", title: "Breaking Bad" }] });
  const r = await api.search("breaking", { kind: "show", limit: 5 });
  assert.equal(r.items[0].title, "Breaking Bad");
  const c = calls[0];
  assert.equal(c.url.pathname, "/v1/search");
  assert.equal(c.url.searchParams.get("q"), "breaking");
  assert.equal(c.url.searchParams.get("kind"), "show");
  assert.equal(c.init.headers.Authorization, "Bearer bng_pat_abc123");
});

await test("title path keeps ref readable", async () => {
  handler = () => json(200, { id: "x", kind: "show" });
  await api.title("tmdb:show:1396");
  assert.equal(calls[0].url.pathname, "/v1/titles/tmdb:show:1396");
});

await test("library actions POST body", async () => {
  handler = () => json(200, { results: [{ index: 0, status: "ok", outcome: "watched" }], dry_run: false });
  await api.actions([{ action: "watch", title: "t1", season: 2, episode: 5 }]);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { actions: [{ action: "watch", title: "t1", season: 2, episode: 5 }] });
});

await test("429 surfaces Retry-After", async () => {
  handler = () => json(429, { error: { code: "rate_limited", message: "slow", requestId: "r1" } }, { "Retry-After": "17" });
  await assert.rejects(api.recent(), (e) => e.status === 429 && e.retryAfter === 17 && /17s/.test(e.message));
});

await test("403 insufficient_scope gets a helpful message", async () => {
  handler = () => json(403, { error: { code: "insufficient_scope", message: "x" } });
  await assert.rejects(api.actions([{ action: "follow", title: "t" }]), (e) => e.code === "insufficient_scope" && /read \+ write/.test(e.message));
});

await test("401 on PAT clears auth", async () => {
  handler = () => json(401, { error: { code: "unauthorized", message: "bad" } });
  await assert.rejects(api.me(), (e) => e.status === 401);
  assert.equal(store.auth, undefined);
});

await test("OAuth PKCE sign-in exchanges code for tokens", async () => {
  handler = (u, init) => {
    if (u.pathname === "/.well-known/oauth-authorization-server") return json(404, {});
    if (u.pathname === "/auth/oauth2/token") {
      const p = new URLSearchParams(init.body);
      assert.equal(p.get("grant_type"), "authorization_code");
      assert.equal(p.get("code"), "CODE123");
      assert.equal(p.get("client_id"), "https://example.test/client.json");
      assert.equal(p.get("redirect_uri"), "https://abcdefghijklmnop.chromiumapp.org/");
      assert.equal(p.get("resource"), "https://api.bingers.app/v1");
      assert.ok(p.get("code_verifier").length >= 43);
      return json(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600, token_type: "Bearer" });
    }
    return json(500, {});
  };
  await auth.signInWithOAuth();
  const q = authFlowUrl.searchParams;
  assert.equal(authFlowUrl.origin + authFlowUrl.pathname, "https://api.bingers.app/auth/oauth2/authorize");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("scope"), "library:read library:write offline_access");
  assert.equal(q.get("resource"), "https://api.bingers.app/v1");
  assert.equal(store.auth.mode, "oauth");
  assert.equal(store.auth.access_token, "AT1");
});

await test("expired OAuth token refreshes once, concurrent calls share it", async () => {
  store.auth.expires_at = Date.now() - 1000;
  let refreshes = 0;
  handler = (u, init) => {
    if (u.pathname === "/.well-known/oauth-authorization-server") return json(404, {});
    if (u.pathname === "/auth/oauth2/token") {
      refreshes++;
      assert.equal(new URLSearchParams(init.body).get("grant_type"), "refresh_token");
      return json(200, { access_token: "AT2", expires_in: 3600 }); // no new refresh token returned
    }
    assert.equal(init.headers.Authorization, "Bearer AT2");
    return json(200, { items: [] });
  };
  await Promise.all([api.recent(), api.favorites(), api.recent()]);
  assert.equal(refreshes, 1);
  assert.equal(store.auth.refresh_token, "RT1"); // kept the old refresh token
});

await test("401 with OAuth triggers refresh + retry", async () => {
  let n = 0;
  handler = (u) => {
    if (u.pathname === "/auth/oauth2/token") return json(200, { access_token: "AT3", refresh_token: "RT3", expires_in: 3600 });
    if (u.pathname.startsWith("/.well-known")) return json(404, {});
    n++;
    return n === 1 ? json(401, { error: { code: "unauthorized" } }) : json(200, { ok: 1 });
  };
  const r = await api.me();
  assert.deepEqual(r, { ok: 1 });
  assert.equal(store.auth.access_token, "AT3");
});

await test("invalid_grant on refresh signs the user out", async () => {
  store.auth.expires_at = 0;
  handler = (u) => (u.pathname === "/auth/oauth2/token" ? json(400, { error: "invalid_grant" }) : json(404, {}));
  await assert.rejects(api.me(), (e) => e.code === "expired");
  assert.equal(store.auth, undefined);
});

await test("normalizeCheck handles plausible shapes", () => {
  const refs = ["imdb:tt1", "imdb:tt2"];
  assert.deepEqual(normalizeCheck({ items: [{ ref: "imdb:tt2", status: "watched" }, { ref: "imdb:tt1", status: "not_in_library" }] }, refs), {
    "imdb:tt1": { ref: "imdb:tt1", status: "not_in_library" },
    "imdb:tt2": { ref: "imdb:tt2", status: "watched" },
  });
  assert.equal(normalizeCheck({ items: ["caught_up", "unknown"] }, refs)["imdb:tt1"].status, "caught_up");
  assert.equal(normalizeCheck({ "imdb:tt2": "to_watch" }, refs)["imdb:tt2"].status, "to_watch");
  assert.equal(normalizeCheck({ items: { "imdb:tt1": { status: "stopped" } } }, refs)["imdb:tt1"].status, "stopped");
  assert.equal(normalizeCheck({ results: [{ title: { id: "x" }, my_status: "started" }] }, refs)["imdb:tt1"].status, "started");
  assert.equal(normalizeCheck(null, refs)["imdb:tt2"].status, "unknown");
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
