// Auto-tracker. Injected only on sites the user turned on (dynamic content script, all frames).
// Finds the main <video>, reads what's playing, and reports start / pause / watched to the
// service worker, which talks to Bingers. Needs lib/parse.js loaded first (CueParse).
(() => {
  // Skip if a working tracker is already here. One left over from before the extension was
  // reloaded can't reach the extension any more (chrome.runtime.id is gone), so replace it.
  // Builds before this one set a plain `true` here; one of those can only be a leftover from
  // before the reload that injected this copy, so it's replaced too.
  const prev = window.__cueTracker;
  if (prev && prev !== true && prev.alive()) return;
  if (typeof prev?.stop === "function") prev.stop();
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  const Parse = globalThis.CueParse;
  if (!Parse) return;

  let settings = { autoTrack: true, threshold: 90, minMinutes: 10, excludedHosts: [], skipVideoPlatforms: true };
  // User-video sites (YouTube and the like): long videos there are rarely a TV episode or movie,
  // so Cue skips them unless the user turns "Skip YouTube and similar sites" off in Settings.
  // Keep in sync with VIDEO_PLATFORMS in lib/sites.js.
  const VIDEO_PLATFORMS = ["youtube.com", "youtu.be", "youtube-nocookie.com", "vimeo.com", "dailymotion.com", "twitch.tv", "kick.com", "tiktok.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "reddit.com", "rumble.com", "odysee.com", "bilibili.com", "bitchute.com", "streamable.com"];
  const isVideoPlatform = (h) => VIDEO_PLATFORMS.some((d) => h === d || h.endsWith(`.${d}`));
  const isTop = window.top === window;
  // The site the user is on. Many sites play the video in an embedded player from another
  // host (often two iframes deep), so a frame names the top page, not itself.
  function pageHost() {
    if (isTop) return location.hostname;
    const anc = location.ancestorOrigins;
    try {
      if (anc && anc.length) return new URL(anc[anc.length - 1]).hostname;
    } catch {
      /* fall through */
    }
    return location.hostname;
  }
  const hostExcluded = () =>
    (settings.excludedHosts || []).includes(pageHost()) ||
    // Also skips a YouTube clip embedded in another page (the frame's own host).
    (settings.skipVideoPlatforms !== false && (isVideoPlatform(pageHost()) || isVideoPlatform(location.hostname)));
  chrome.storage.sync.get(settings).then((s) => (settings = s)).catch(() => {});
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "sync") for (const k of Object.keys(settings)) if (k in c) settings[k] = c[k].newValue;
  });

  // ---------- messaging ----------
  function send(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded: stop quietly */
      stop();
    }
  }

  // ---------- reading the page ----------
  function readJsonLd() {
    const out = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent || "null");
        const list = Array.isArray(data) ? data : data?.["@graph"] ? data["@graph"] : [data];
        for (const it of list) if (it && typeof it === "object") out.push(it);
      } catch {
        /* ignore malformed blocks */
      }
    }
    return out;
  }

  function readInfo() {
    let session = null;
    try {
      const m = navigator.mediaSession?.metadata;
      if (m) session = { title: m.title || "", artist: m.artist || "", album: m.album || "" };
    } catch {
      /* not available in this world */
    }
    const og = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
    const h = document.querySelector("h1")?.textContent || "";
    return { jsonld: readJsonLd(), session, player: readPlayer(), ogTitle: og, docTitle: document.title || "", heading: h.slice(0, 200) };
  }

  // The title and episode line that big players overlay on the video. The page around the
  // player (h1, document.title) often still shows the detail page, e.g. a "1. Season" heading.
  const PLAYER_FIELDS = [
    [".atvwebplayersdk-title-text", ".atvwebplayersdk-subtitle-text"], // Prime Video
    ['[data-uia="video-title"] h4', '[data-uia="video-title"] span'], // Netflix
    [".title-field", ".subtitle-field"], // Disney+
  ];
  function readPlayer() {
    const text = (sel) => (document.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    for (const [t, s] of PLAYER_FIELDS) {
      const title = text(t);
      if (title) return { title, subtitle: text(s) };
    }
    return null;
  }

  // ---------- finding the main video ----------
  function pickVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const d = v.duration;
      if (!Number.isFinite(d) || d < settings.minMinutes * 60) continue; // skips ads, trailers, previews
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area >= bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  // ---------- session per video/episode ----------
  let video = null;
  let session = null;
  let lastUrl = location.href;
  let timer = null;

  const progressOf = (v) => (v && v.duration ? Math.min(100, Math.max(0, (v.currentTime / v.duration) * 100)) : 0);

  function newSession(v) {
    session = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      src: v.currentSrc || "",
      info: null,
      meta: null,
      startedSent: false,
      watchedSent: false,
    };
  }

  function ensureMeta() {
    if (session.meta) return true;
    session.info = readInfo();
    session.meta = Parse.parseMediaInfo(session.info);
    return !!session.meta;
  }

  function report(event) {
    if (!settings.autoTrack || !session || !video) return;
    ensureMeta();
    send("track", {
      event,
      sessionId: session.id,
      progress: Math.round(progressOf(video) * 10) / 10,
      duration: Math.round(video.duration),
      meta: session.meta,
      raw: session.meta ? null : { title: session.info?.docTitle?.slice(0, 120) || "", host: pageHost() },
      host: pageHost(),
      inFrame: !isTop,
    });
  }

  // Good enough to send right away: structured data, or a show with its episode number.
  const solid = (m) => !!m && (m.confidence === "high" || m.episode != null);
  const META_WAIT_MS = 2500;

  const onPlaying = () => {
    if (!session) return;
    if (session.startedSent) return report("play");
    if (session.waiting) return;
    // Send as soon as the page names what's playing; give a slow player up to 2.5 s to publish
    // its metadata before going with what's there.
    const s = session;
    const since = Date.now();
    s.waiting = true;
    const check = () => {
      if (session !== s || s.startedSent) return;
      if (!video || video.paused) {
        s.waiting = false;
        return;
      }
      s.info = readInfo();
      s.meta = Parse.parseMediaInfo(s.info);
      if (solid(s.meta) || Date.now() - since >= META_WAIT_MS) {
        s.startedSent = true;
        report("play");
      } else setTimeout(check, 300);
    };
    check();
  };
  const onPause = () => {
    if (session?.startedSent && !session.watchedSent && !video.ended) report("pause");
  };
  const onTime = () => {
    if (!session) return;
    // Reaching the threshold marks it, however the viewer got there: skipping ahead is fine,
    // e.g. they watched most of it on another device and are just finishing here.
    if (!session.watchedSent && session.startedSent && progressOf(video) >= settings.threshold) {
      session.watchedSent = true;
      report("watched");
    }
  };
  const onEnded = () => onTime();

  function attach(v) {
    detach();
    video = v;
    newSession(v);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("pause", onPause);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("ended", onEnded);
    if (!v.paused) onPlaying();
  }

  function detach() {
    if (!video) return;
    if (session?.startedSent && !session.watchedSent) report("pause");
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("timeupdate", onTime);
    video.removeEventListener("ended", onEnded);
    video = null;
    session = null;
  }

  // Embedded players from other hosts (iframes). The tracker only runs in frames whose host the
  // user turned on, so the popup offers to turn these on too. Ads rarely allow fullscreen.
  let lastEmbeds = null;
  function reportEmbeds() {
    const origins = new Set();
    for (const f of document.querySelectorAll("iframe[src]")) {
      let u;
      try {
        u = new URL(f.src, location.href);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) continue;
      const r = f.getBoundingClientRect();
      const fullscreen = f.allowFullscreen || /fullscreen/.test(f.getAttribute("allow") || "") || f.hasAttribute("webkitallowfullscreen");
      if (fullscreen || (r.width >= 320 && r.height >= 180)) origins.add(u.origin);
    }
    const key = [...origins].sort().join(" ");
    if (key === lastEmbeds) return;
    lastEmbeds = key;
    send("trackerEmbeds", { origins: [...origins].slice(0, 5), reset: isTop, since: isTop ? Math.floor(performance.timeOrigin) : undefined });
  }

  function tick() {
    if (!settings.autoTrack || hostExcluded()) {
      if (video) detach();
      return;
    }
    if (!video) reportEmbeds();
    const v = pickVideo();
    if (v !== video) {
      if (v) attach(v);
      else detach();
      return;
    }
    // Same element, new content (autoplay next episode, client-side navigation).
    if (v && (location.href !== lastUrl || (v.currentSrc && session && v.currentSrc !== session.src && !v.currentSrc.startsWith("blob:")))) {
      attach(v);
    }
    lastUrl = location.href;
  }

  // Media events don't bubble, but they can be caught on the way down: notice a video the moment
  // it knows its length or starts playing, instead of waiting for the next 2-second check.
  const MEDIA_EVENTS = ["loadedmetadata", "durationchange", "playing"];
  let soon = null;
  const tickSoon = (e) => {
    if (e.target?.tagName !== "VIDEO" || (e.target === video && e.type !== "durationchange")) return;
    clearTimeout(soon);
    soon = setTimeout(tick, 50);
  };

  let stopped = false;
  function stop() {
    if (stopped) return; // detach() reports a pause, which calls stop() again if the extension is gone
    stopped = true;
    clearInterval(timer);
    clearTimeout(soon);
    for (const type of MEDIA_EVENTS) document.removeEventListener(type, tickSoon, true);
    try {
      detach();
    } catch {
      /* ignore */
    }
  }
  window.__cueTracker = { alive, stop };

  for (const type of MEDIA_EVENTS) document.addEventListener(type, tickSoon, true);
  timer = setInterval(tick, 2000);
  tick();
  window.addEventListener("pagehide", () => {
    if (session?.startedSent && !session.watchedSent) report("pause");
  });

  // ---------- in-page notices from the service worker ----------
  let host = null;
  let root = null;
  let hideTimer = null;
  const CSS = `
    :host { all: initial; }
    .t { position: fixed; left: 50%; top: 28px; transform: translateX(-50%); z-index: 2147483647;
         display: flex; align-items: center; gap: 10px; padding-block: 8px; padding-inline: 14px 8px; border-radius: 999px;
         background: #0c0b0b; color: #f6f3f0; border: 1px solid #2c2826; box-shadow: 0 10px 30px rgba(0,0,0,.45);
         font: 13px/1.3 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: min(560px, 92vw); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #5fd38d; flex: none; }
    .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { font: inherit; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 6px 12px; cursor: pointer; white-space: nowrap;
             background: transparent; color: #f6f3f0; border: 1px solid #2c2826; }
    button.p { background: #f6f3f0; color: #0c0b0b; border-color: #f6f3f0; }
    button.x { border: 0; color: #9d9691; padding: 4px 8px; }
  `;

  let countTimer = null;
  function showToast({ text, actions = [], ttl = 7000, countdown = 0, sessionId, dir = "ltr", lang = "en", dismiss = "Dismiss" }) {
    clearInterval(countTimer);
    if (window.top !== window && !document.fullscreenElement && !video) return;
    if (!host?.isConnected) {
      host = document.createElement("cue-toast");
      root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = CSS;
      root.append(style);
    }
    // In fullscreen only the fullscreen element is visible, so put the notice inside it.
    const parent = document.fullscreenElement && document.fullscreenElement.tagName !== "VIDEO" ? document.fullscreenElement : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);

    root.querySelector(".t")?.remove();
    const box = document.createElement("div");
    box.className = "t";
    box.setAttribute("role", "status");
    box.dir = dir === "rtl" ? "rtl" : "ltr";
    box.lang = String(lang);
    const dot = document.createElement("span");
    dot.className = "dot";
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.textContent = text;
    box.append(dot, txt);
    actions.forEach((a, i) => {
      const b = document.createElement("button");
      b.className = i === 0 ? "p" : "";
      b.textContent = a.label;
      b.addEventListener("click", () => {
        clearInterval(countTimer);
        send("trackerAction", { sessionId, action: a.id, index: a.index });
        box.remove();
      });
      box.append(b);
      // "Mark watched (10)": counts down to the moment the service worker does it anyway.
      if (i === 0 && countdown > 0) {
        let left = Math.round(countdown);
        b.textContent = `${a.label} (${left})`;
        countTimer = setInterval(() => {
          left -= 1;
          if (left > 0) b.textContent = `${a.label} (${left})`;
          else clearInterval(countTimer);
        }, 1000);
      }
    });
    const x = document.createElement("button");
    x.className = "x";
    x.setAttribute("aria-label", String(dismiss));
    x.textContent = "×";
    x.addEventListener("click", () => box.remove());
    box.append(x);
    root.append(box);
    clearTimeout(hideTimer);
    if (ttl) hideTimer = setTimeout(() => box.remove(), ttl);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "cueToast") showToast(msg.payload || {});
    // The video is in an embedded player: the service worker asks the top page what's playing.
    if (msg?.type === "cueReadPage" && isTop) {
      sendResponse({ meta: Parse.parseMediaInfo(readInfo()), host: location.hostname });
    }
    // The user clicked "Report" / "Suggest it": send the developer only the title info Cue reads,
    // so a parser for this site can be written without visiting it. No cookies, account data,
    // query string, or page content beyond these fields.
    if (msg?.type === "cuePageInfo" && isTop) {
      const info = readInfo();
      const KEEP = ["@type", "name", "episodeNumber", "seasonNumber", "datePublished", "dateCreated"];
      const slim = (o) => (o && typeof o === "object" ? Object.fromEntries(KEEP.filter((k) => k in o).map((k) => [k, o[k]])) : o);
      const jsonld = info.jsonld
        .filter((it) => /Episode|Series|Season|Movie|Video|WebPage/i.test([].concat(it["@type"] || []).join(" ")))
        .slice(0, 5)
        .map((it) => ({ ...slim(it), partOfSeries: slim(it.partOfSeries || it.partOfTVSeries), partOfSeason: slim(it.partOfSeason) }));
      let path = "";
      try {
        path = decodeURIComponent(location.pathname).slice(0, 200);
      } catch {
        path = location.pathname.slice(0, 200);
      }
      sendResponse({ host: location.hostname, path, docTitle: info.docTitle.slice(0, 200), ogTitle: info.ogTitle.slice(0, 200), heading: info.heading, player: info.player, mediaSession: info.session, jsonld, parsed: Parse.parseMediaInfo(info) });
    }
  });
})();
