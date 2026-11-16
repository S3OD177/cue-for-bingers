// Content script for IMDb and TMDB title pages: shows a small Bingers badge with the
// user's status and quick actions. UI lives in a closed shadow root so page CSS can't touch it.
(() => {
  if (window.__bingersBadge) return;
  window.__bingersBadge = true;

  // UI text from _locales (same keys as lib/i18n.js). `picked` holds the language chosen in
  // Settings (from the service worker); without one, Chrome's own language is used.
  let picked = null;
  const t = (key, ...subs) => {
    const own = picked?.[key]?.message;
    const rtl = (picked ? picked.dir?.message : safeMessage("dir")) === "rtl";
    // Isolate inserted values in right-to-left text (see lib/i18n.js).
    const vals = subs.map((s) => (rtl ? `\u2068${s}\u2069` : String(s)));
    if (own != null) return own.replace(/\$(\d)/g, (_, n) => vals[n - 1] ?? "");
    try {
      return chrome.i18n.getMessage(key, vals) || key;
    } catch {
      return key; // extension reloaded
    }
  };
  function safeMessage(key) {
    try {
      return chrome.i18n.getMessage(key);
    } catch {
      return "";
    }
  }
  const dir = () => (t("dir") === "rtl" ? "rtl" : "ltr");
  let stringsLoaded = null;
  const loadStrings = () =>
    (stringsLoaded ||= send("uiStrings")
      .then((r) => (picked = r?.messages || null))
      .catch(() => (picked = null)));
  const STATUSES = ["watch_next", "collecting_dust", "not_started", "caught_up", "completed", "upcoming", "watch_later", "stopped", "progress_pending", "to_watch", "started", "watched", "not_in_library", "unknown"];
  const statusLabel = (s) => (STATUSES.includes(s) ? t(`status_${s}`) : String(s).replace(/_/g, " "));
  const inLibrary = (s) => !!s && s !== "not_in_library" && s !== "unknown";

  // ---------- page \u2192 title reference ----------
  function refFromLocation() {
    const { hostname, pathname } = location;
    if (/(^|\.)imdb\.com$/.test(hostname)) {
      const m = pathname.match(/\/title\/(tt\d{5,})/);
      return m ? `imdb:${m[1]}` : null;
    }
    if (/(^|\.)themoviedb\.org$/.test(hostname)) {
      const m = pathname.match(/^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?(movie|tv)\/(\d+)/);
      return m ? `tmdb:${m[1] === "tv" ? "show" : "movie"}:${m[2]}` : null;
    }
    return null;
  }

  // ---------- messaging ----------
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error(t("err_noResponse")));
          res.ok ? resolve(res.data) : reject(Object.assign(new Error(res.error?.message || t("err_generic")), res.error || {}));
        });
      } catch (e) {
        reject(e); // "Extension context invalidated" after an update/reload
      }
    });
  }

  // ---------- shadow DOM UI ----------
  let host = null;
  let root = null;

  // THEME mirrors lib/theme.css (Bingers' brand base #0C0B0B). Content scripts can't load extension CSS into a closed shadow root without web_accessible_resources, so the tokens live here too.
  const THEME = `--bg:#0c0b0b;--panel:#161414;--panel-2:#1f1c1b;--line:#2c2826;--text:#f6f3f0;--muted:#9d9691;--accent:#f6f3f0;--accent-ink:#0c0b0b;--ok:#5fd38d;--err:#ff8a80;--star:#ffc94d;`;
  const CSS = `
    :host { all: initial; }
    .wrap { ${THEME} position: fixed; inset-inline-end: 18px; bottom: 18px; z-index: 2147483646; font: 13px/1.35 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
    .pill { display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding-block: 6px; padding-inline: 6px 8px; box-shadow: 0 10px 30px rgba(0,0,0,.4); max-width: 440px; animation: in .22s ease-out both; }
    @keyframes in { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
    .logo { width: 30px; height: 30px; border-radius: 999px; background: var(--panel-2); color: var(--text); flex: none; display: grid; place-items: center; cursor: pointer; border: 0; padding: 0; position: relative; transition: background .15s; }
    .logo:hover { background: var(--line); }
    .logo svg { width: 13px; height: 13px; margin-left: 2px; }
    .logo::before { content: ""; position: absolute; right: 1px; bottom: 1px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--bg); }
    .logo.mini { width: 40px; height: 40px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 8px 24px rgba(0,0,0,.4); animation: in .22s ease-out both; }
    .logo.mini svg { width: 15px; height: 15px; }
    .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--text); animation: spin .7s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .msg.loading { display: flex; align-items: center; gap: 8px; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.b.busy { color: transparent; position: relative; }
    button.b.busy::after { content: ""; position: absolute; inset: 0; margin: auto; width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--muted); border-top-color: transparent; animation: spin .7s linear infinite; }
    button.b.p.busy::after { border-color: var(--accent-ink); border-top-color: transparent; }
    @media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }
    .info { min-width: 0; }
    .label { font-size: 11px; color: var(--muted); font-weight: 700; letter-spacing: -0.02em; text-transform: lowercase; }
    .status { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status.done { color: var(--ok); }
    .status.in { color: var(--text); }
    .actions { display: flex; gap: 5px; margin-inline-start: 2px; align-items: center; }
    button.b { font: inherit; font-size: 12px; font-weight: 600; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; cursor: pointer; white-space: nowrap; transition: background .15s, filter .15s; }
    button.b:hover:not(:disabled) { background: var(--panel-2); }
    button.b.p { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
    button.b.p:hover:not(:disabled) { background: var(--accent); filter: brightness(.9); }
    button.b:disabled { opacity: .5; cursor: default; }
    .stars { display: flex; }
    .stars button { background: none; border: 0; padding: 0 1px; font-size: 16px; color: var(--line); cursor: pointer; }
    .stars:hover button { color: var(--star); }
    .stars button:hover ~ button { color: var(--line); }
    .x { background: none; border: 0; color: var(--muted); font-size: 15px; cursor: pointer; padding: 0 6px; }
    .x:hover { color: var(--text); }
    .msg { font-size: 12px; color: var(--muted); padding-inline-end: 6px; }
    .msg.err { color: var(--err); }
  `;

  function h(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  function mount() {
    if (host?.isConnected) return;
    host = document.createElement("bingers-badge");
    root = host.attachShadow({ mode: "closed" });
    root.append(h("style", {}, CSS));
    document.documentElement.append(host);
  }

  function unmount() {
    host?.remove();
    host = root = null;
  }

  function paint(...content) {
    mount();
    root.querySelector(".wrap")?.remove();
    root.append(h("div", { class: "wrap", dir: dir(), lang: t("lang") }, ...content));
  }

  async function isCollapsed() {
    const { badgeCollapsed } = await chrome.storage.local.get({ badgeCollapsed: false });
    return badgeCollapsed;
  }
  async function setCollapsed(v) {
    await chrome.storage.local.set({ badgeCollapsed: v });
  }

  // ---------- rendering ----------
  let renderToken = 0;

  async function load(ref) {
    const myToken = ++renderToken;
    const { showBadge } = await chrome.storage.sync.get({ showBadge: true });
    if (!showBadge || !ref) return unmount();

    let session;
    try {
      session = await send("getSession");
    } catch {
      return unmount();
    }
    if (!session.signedIn) return unmount(); // don't nag signed-out users on every page
    await loadStrings();

    if (await isCollapsed()) return paintCollapsed(ref);

    paint(h("div", { class: "pill" }, logoButton(ref), h("div", { class: "msg loading" }, h("span", { class: "spin", "aria-hidden": "true" }), t("badge_checking"))));

    let title = null;
    let status = "unknown";
    try {
      const [t, check] = await Promise.all([
        send("title", { ref }).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
        send("check", { refs: [ref] }),
      ]);
      title = t;
      status = check?.[ref]?.status || "unknown";
    } catch (e) {
      if (myToken !== renderToken) return;
      return paint(h("div", { class: "pill" }, logoButton(ref), h("div", { class: "msg err" }, e.message), closeButton(ref)));
    }
    if (myToken !== renderToken) return;
    if (!title) return paint(h("div", { class: "pill" }, logoButton(ref), h("div", { class: "msg" }, t("badge_notOnBingers")), closeButton(ref)));

    renderFull(ref, title, status);
  }

  // Play mark (same shape as the toolbar icon), drawn with createElementNS.
  function playMark() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M6 3.5v17l15-8.5z");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linejoin", "round");
    svg.append(p);
    return svg;
  }

  function logoButton(ref) {
    return h("button", { class: "logo", title: t("badge_minimiseHint"), "aria-label": t("badge_minimiseLabel"), onclick: async () => { await setCollapsed(true); paintCollapsed(ref); } }, playMark());
  }
  function closeButton(ref) {
    return h("button", { class: "x", title: t("badge_minimise"), "aria-label": t("badge_minimise"), onclick: async () => { await setCollapsed(true); paintCollapsed(ref); } }, "\u00d7");
  }
  function paintCollapsed(ref) {
    paint(h("button", { class: "logo mini", title: t("badge_showHint"), "aria-label": t("badge_showLabel"), onclick: async () => { await setCollapsed(false); load(ref); } }, playMark()));
  }

  async function act(button, action, ref) {
    button.disabled = true;
    button.classList.add("busy");
    try {
      const res = await send("actions", { actions: [action] });
      const r = res?.results?.[0];
      if (r && (r.status === "unresolved" || r.status === "error")) throw new Error(r.message || t("result_failed"));
      load(ref);
    } catch (e) {
      button.disabled = false;
      button.classList.remove("busy");
      const pill = root?.querySelector(".pill");
      pill?.querySelector(".msg.err")?.remove();
      pill?.append(h("div", { class: "msg err" }, e.message));
    }
  }

  function renderFull(ref, title, status) {
    const cls = ["watched", "completed", "caught_up"].includes(status) ? "status done" : inLibrary(status) ? "status in" : "status";
    const actions = [];
    const id = title.id || ref;
    const btn = (label, action, primary) => {
      const b = h("button", { class: primary ? "b p" : "b" }, label);
      b.addEventListener("click", () => act(b, { ...action, title: id }, ref));
      return b;
    };

    if (!inLibrary(status)) {
      actions.push(btn(`+ ${t("action_follow")}`, { action: "follow" }, true));
      actions.push(btn(t("action_later"), { action: "for_later" }));
      if (title.kind === "movie") actions.push(btn(`\u2713 ${t("action_watched")}`, { action: "watch" }));
    } else if (title.kind === "movie" && status !== "watched") {
      actions.push(btn(`\u2713 ${t("action_watched")}`, { action: "watch" }, true));
    } else if (title.kind === "movie" && status === "watched") {
      const stars = h("div", { class: "stars", title: t("badge_rate"), dir: "ltr" });
      for (let i = 1; i <= 5; i++) {
        const s = h("button", { "aria-label": t("badge_rateN", i) }, "\u2605");
        s.addEventListener("click", () => act(s, { action: "rate", title: id, rating: i }, ref));
        stars.append(s);
      }
      actions.push(stars);
    }
    if (title.url) {
      actions.push(h("button", { class: "b", onclick: () => window.open(title.url, "_blank", "noopener") }, t("badge_open")));
    }

    paint(
      h("div", { class: "pill", role: "region", "aria-label": "Cue for Bingers" },
        logoButton(ref),
        h("div", { class: "info" },
          h("div", { class: "label" }, "cue \u00b7 bingers"),
          h("div", { class: cls, title: title.title || "" }, statusLabel(status))
        ),
        h("div", { class: "actions" }, actions),
        closeButton(ref)
      )
    );
  }

  // ---------- SPA navigation (IMDb and TMDB both route client-side) ----------
  let lastRef;
  function tick() {
    const ref = refFromLocation();
    if (ref === lastRef) return;
    lastRef = ref;
    load(ref).catch(() => {});
  }
  tick();
  setInterval(tick, 1000);
  window.addEventListener("popstate", tick);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && "showBadge" in changes) load(refFromLocation()).catch(() => {});
    if (area === "local" && "auth" in changes) load(refFromLocation()).catch(() => {});
    if (area === "sync" && "uiLang" in changes) {
      stringsLoaded = null; // the service worker reloads the language too; ask again
      setTimeout(() => load(refFromLocation()).catch(() => {}), 300);
    }
  });
})();
