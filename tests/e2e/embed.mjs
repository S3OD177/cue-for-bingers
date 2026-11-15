// E2E: auto-tracking when the video plays inside nested cross-origin iframes (Shoof Live style:
// episode page -> player iframe -> embed iframe with the <video>). Runs on Windows/macOS/Linux
// with the installed Google Chrome; no Playwright needed. Chrome 137+ ignores --load-extension,
// so the extension is loaded over the DevTools pipe (Extensions.loadUnpacked).
//
//   node tests/e2e/embed.mjs            (CHROME=path/to/chrome to override)
//
// Needs Python (for mockapi.py). Hosts are *.localhost, which Chrome resolves to 127.0.0.1.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CHROME =
  process.env.CHROME ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((p) => fs.existsSync(p));
const SITE_PORT = 8767;
const TOP = `http://shoof.localhost:${SITE_PORT}`;
const PLAYER = `http://player.localhost:${SITE_PORT}`;
const EMBED = `http://embed.localhost:${SITE_PORT}`;

let failures = 0;
const check = (ok, msg, extra) => {
  console.log(`${ok ? "✓" : "✗"} ${msg}${!ok && extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- test video: 40 s of silent WAV (a <video> plays audio-only files fine) ----------
function wav(seconds = 40, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write("data", 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const WAV = wav();

// ---------- the three sites ----------
const PAGES = {
  shoof: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
    <title>مسلسل الفريق الأول الحلقة 1 مترجمة - شوف لايف</title>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"مسلسل الفريق الأول الحلقة 1 مترجمة"}</script></head>
    <body style="margin:0;background:#111;color:#eee"><h1>مسلسل الفريق الأول الحلقة 1 مترجمة</h1>
    <div class="watch"><iframe src="${PLAYER}/albaplayer/ekip-1-nizama-adanms-ruhlar-2012-s01e01" width="800" height="450" frameborder="0" allowfullscreen></iframe></div></body></html>`,
  player: `<!doctype html><html><head><meta charset="utf-8"><title>ekip-1-nizama-adanms-ruhlar-2012-s01e01</title></head>
    <body style="margin:0"><iframe src="${EMBED}/embed-ked0tb8mvz25.html" style="width:100%;height:440px;border:0" allowfullscreen></iframe></body></html>`,
  embed: `<!doctype html><html><head><meta charset="utf-8"><title>Watch ekip-1-nizama-adanms-ruhlar-2012-s01e01.mp4</title></head>
    <body style="margin:0;background:#000"><video id="v" src="/tone.wav" muted playsinline style="width:100%;height:420px"></video>
    <script>const v=document.getElementById('v');v.addEventListener('canplay',()=>{v.playbackRate=4;v.play()},{once:true})</script></body></html>`,
};

const site = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  if (req.url === "/tone.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": WAV.length, "Accept-Ranges": "bytes" });
    return res.end(WAV);
  }
  const page = host.startsWith("shoof.") ? PAGES.shoof : host.startsWith("player.") ? PAGES.player : host.startsWith("embed.") ? PAGES.embed : null;
  if (!page) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
});

// ---------- a test build of the extension ----------
function buildExtension(grantHosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cue-e2e-ext-"));
  fs.cpSync(path.join(ROOT, "extension"), dir, { recursive: true });
  const cfgPath = path.join(dir, "lib/config.js");
  fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, "utf8").replace('export const API_BASE = "https://api.bingers.app/v1"', 'export const API_BASE = "http://127.0.0.1:8768/v1"'));
  const mPath = path.join(dir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
  // Test sites are pre-granted (Chrome's approval prompt can't be clicked in a test).
  m.host_permissions.push("http://127.0.0.1:8768/*", ...grantHosts.map((h) => `${h.replace(/:\d+$/, "")}/*`));
  fs.writeFileSync(mPath, JSON.stringify(m));
  return dir;
}

// ---------- Chrome over the DevTools pipe ----------
async function launch(extDir) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cue-e2e-profile-"));
  const proc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required", "--window-size=1100,700", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const out = proc.stdio[3];
  const inp = proc.stdio[4];
  let id = 0;
  const pending = new Map();
  let buf = "";
  inp.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message}`)) : resolve(msg.result);
      }
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      out.write(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  const { id: extId } = await send("Extensions.loadUnpacked", { path: extDir });

  async function attach(match) {
    for (let i = 0; i < 40; i++) {
      const { targetInfos } = await send("Target.getTargets");
      const t = targetInfos.find(match);
      if (t) return (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
      await sleep(250);
    }
    throw new Error("target not found");
  }
  const sw = await attach((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`));
  const evalIn = async (sessionId, expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    extId,
    sw: (expr) => evalIn(sw, expr),
    open: async (url) => (await send("Target.createTarget", { url })).targetId,
    // An extension page to send messages from (like the popup does).
    extPage: async () => {
      const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
      const sid = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      await sleep(800);
      return (expr) => evalIn(sid, expr);
    },
    close: () => {
      try {
        out.write(JSON.stringify({ id: ++id, method: "Browser.close" }) + "\0");
      } catch {
        /* already gone */
      }
      setTimeout(() => proc.kill(), 1000);
    },
  };
}

// The real tracker registration only covers sites approved at runtime; the test grants them in
// the manifest instead, so register the tracker for them here.
async function setup(b, hosts) {
  await sleep(800); // let onInstalled's own sync finish first
  await b.sw(`(async () => {
    await chrome.storage.local.set({ auth: { mode: "pat", token: "bng_pat_test" } });
    await chrome.storage.sync.set({ minMinutes: 0.1, threshold: 90 });
    await chrome.scripting.registerContentScripts([{ id: "cue-tracker-test", matches: ${JSON.stringify(hosts.map((h) => `${h.replace(/:\d+$/, "")}/*`))},
      js: ["lib/parse.js", "content/tracker.js"], allFrames: true, runAt: "document_idle" }]);
  })()`);
}

const nowPlaying = (b) => b.sw(`chrome.storage.session.get("nowPlaying").then((r) => Object.values(r.nowPlaying || {}))`);
// ---------- mock Bingers API (same answers as mockapi.py, no Python needed) ----------
const calls = []; // { m, p, b }
const apiLog = () => calls;
const api = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ m: req.method, p: req.url, b: body });
    const send = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    const p = req.url;
    if (req.method === "GET") {
      if (p.startsWith("/v1/me")) return send(200, { handle: "tester" });
      if (p.startsWith("/v1/search") && /[؀-ۿ]/.test(decodeURIComponent(p)))
        return send(200, { items: [{ id: "team1", kind: "show", title: "الفريق الأول", original_title: "Ekip 1", year: 2012 }] });
      if (p.startsWith("/v1/search")) return send(200, { items: [] });
      if (p.startsWith("/v1/watchlist")) return send(200, { sections: {} });
      if (p.startsWith("/v1/library/check")) return send(200, { items: [] });
      return send(404, { error: { code: "not_found", message: "nope" } });
    }
    if (p === "/v1/scrobble/start" || p === "/v1/scrobble/pause") return send(202);
    if (p === "/v1/scrobble/stop") return send(200, { recorded: (body?.progress || 0) >= 80 });
    if (p === "/v1/library/actions") return send(200, { results: [{ index: 0, status: "ok" }], dry_run: false });
    return send(404, { error: { code: "not_found", message: "nope" } });
  });
});

async function main() {
  if (!CHROME) throw new Error("Chrome not found; set CHROME=path");
  await new Promise((r) => api.listen(8768, "127.0.0.1", r));
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));

  try {
    // ---- 1. Only the episode site and its first player are on: the video is out of reach ----
    console.log("\n1) Site on, embedded player's host not on yet");
    {
      const b = await launch(buildExtension([TOP, PLAYER]));
      try {
        await setup(b, [TOP, PLAYER]);
        await b.open(`${TOP}/episode/team-1-ep-1/servers/`);
        await sleep(6000);
        const embeds = await b.sw(`chrome.storage.session.get("embeds").then((r) => Object.values(r.embeds || {}).flat())`);
        check(embeds.includes("http://embed.localhost/*"), "the player frame reports the embed host the popup should offer", embeds);
        check((await nowPlaying(b)).length === 0, "nothing is tracked while the video's host is off", await nowPlaying(b));
      } finally {
        b.close();
      }
    }
    await sleep(1500);

    // ---- 2. All three hosts on: tracks with the episode page's title ----
    console.log("\n2) Site and both players on");
    {
      const b = await launch(buildExtension([TOP, PLAYER, EMBED]));
      try {
        await setup(b, [TOP, PLAYER, EMBED]);
        await b.open(`${TOP}/episode/team-1-ep-1/servers/`);
        let np = [];
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          np = await nowPlaying(b);
          if (np[0]?.state === "watched") break;
        }
        const s = np[0] || {};
        check(s.label === "الفريق الأول S01E01", "title comes from the episode page, season from the embed's file name", s.label);
        check(s.host === "shoof.localhost", "the session is named after the site, not the embed host", s.host);
        check(s.state === "watched", "marked watched at the threshold", s.state);
        const calls = apiLog();
        const search = calls.find((c) => c.p.startsWith("/v1/search"));
        const q = search && new URL(search.p, "http://x").searchParams;
        check(q?.get("q") === "الفريق الأول" && q?.get("lang") === "ar", "searched Bingers for the Arabic name with lang=ar", search?.p);
        const start = calls.find((c) => c.p === "/v1/scrobble/start");
        check(start?.b?.title === "team1" && start.b.season === 1 && start.b.episode === 1, "scrobble start for team1 S1E1", start?.b);
        const stop = calls.find((c) => c.p === "/v1/scrobble/stop");
        check(stop?.b?.title === "team1" && stop.b.progress >= 80, "scrobble stop (watched) sent", stop?.b);

        // ---- 3. The user fixes the episode from the popup: the watched mark moves ----
        console.log("\n3) Choose episode: fix S01E01 -> S01E02");
        const before = apiLog().length;
        const ext = await b.extPage();
        const action = (season, episode) => ext(`(async () => {
          const { nowPlaying } = await chrome.storage.session.get("nowPlaying");
          const sid = Object.values(nowPlaying)[0].sessionId;
          return new Promise((r) => chrome.runtime.sendMessage({ type: "trackerAction", payload: { sessionId: sid, action: "setEpisode", season: ${season}, episode: ${episode} } }, r));
        })()`);
        const state = (await action(1, 2))?.data;
        check(state?.label === "الفريق الأول S01E02" && state?.state === "watched", "now shows S01E02, still watched", state);
        const after = apiLog().slice(before);
        const unwatch = after.find((c) => c.p === "/v1/library/actions");
        check(unwatch?.b?.actions?.[0]?.action === "unwatch" && unwatch.b.actions[0].episode === 1, "unwatched the wrong episode (E1)", unwatch?.b);
        const restop = after.find((c) => c.p === "/v1/scrobble/stop");
        check(restop?.b?.episode === 2, "marked the right episode (E2) watched", restop?.b);

        const bad = await action(1, 0);
        check(bad?.ok === false && /episode/i.test(bad.error?.message), "rejects episode 0", bad);
      } finally {
        b.close();
      }
    }
  } finally {
    api.close();
    site.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll embedded-player checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
