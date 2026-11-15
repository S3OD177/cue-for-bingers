// Auto-tracker. Injected only on sites the user turned on (dynamic content script, all frames).
// Finds the main <video>, reads what's playing, and reports start / pause / watched to the
// service worker, which talks to Bingers. Needs lib/parse.js loaded first (CueParse).
(() => {
  if (window.__cueTracker) return;
  window.__cueTracker = true;
  const Parse = globalThis.CueParse;
  if (!Parse) return;

  let settings = { autoTrack: true, threshold: 90, minMinutes: 10, excludedHosts: [] };
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
  const hostExcluded = () => (settings.excludedHosts || []).includes(pageHost());
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
    return { jsonld: readJsonLd(), session, ogTitle: og, docTitle: document.title || "", heading: h.slice(0, 200) };
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

  const onPlaying = () => {
    if (!session) return;
    if (!session.startedSent) {
      // Give the player a moment to publish its metadata.
      setTimeout(() => {
        if (session && !session.startedSent && !video.paused) {
          session.startedSent = true;
          report("play");
        }
      }, 2500);
    } else report("play");
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

  function tick() {
    if (!settings.autoTrack || hostExcluded()) {
      if (video) detach();
      return;
    }
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

  function stop() {
    clearInterval(timer);
    try {
      detach();
    } catch {
      /* ignore */
    }
  }

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
         display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 999px;
         background: #0c0b0b; color: #f6f3f0; border: 1px solid #2c2826; box-shadow: 0 10px 30px rgba(0,0,0,.45);
         font: 13px/1.3 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; max-width: min(560px, 92vw); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #5fd38d; flex: none; }
    .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { font: inherit; font-size: 12px; font-weight: 600; border-radius: 999px; padding: 6px 12px; cursor: pointer; white-space: nowrap;
             background: transparent; color: #f6f3f0; border: 1px solid #2c2826; }
    button.p { background: #f6f3f0; color: #0c0b0b; border-color: #f6f3f0; }
    button.x { border: 0; color: #9d9691; padding: 4px 8px; }
  `;

  function showToast({ text, actions = [], ttl = 7000, sessionId }) {
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
        send("trackerAction", { sessionId, action: a.id });
        box.remove();
      });
      box.append(b);
    });
    const x = document.createElement("button");
    x.className = "x";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    x.addEventListener("click", () => box.remove());
    box.append(x);
    root.append(box);
    clearTimeout(hideTimer);
    if (ttl) hideTimer = setTimeout(() => box.remove(), ttl);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "cueToast") showToast(msg.payload || {});
  });
})();
