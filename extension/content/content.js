// Content script for IMDb and TMDB title pages: shows a small Bingers badge with the
// user's status and quick actions. UI lives in a closed shadow root so page CSS can't touch it.
(() => {
  if (window.__bingersBadge) return;
  window.__bingersBadge = true;

  const LABELS = {
    watch_next: "Watch next", collecting_dust: "Collecting dust", not_started: "Not started",
    caught_up: "Caught up", completed: "Completed", upcoming: "Upcoming", watch_later: "Watch later",
    stopped: "Stopped", progress_pending: "Updating\u2026", to_watch: "To watch", started: "Watching",
    watched: "Watched", not_in_library: "Not in your library", unknown: "Not on Bingers",
  };
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
          if (!res) return reject(new Error("No response"));
          res.ok ? resolve(res.data) : reject(Object.assign(new Error(res.error?.message || "Error"), res.error || {}));
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
    .wrap { ${THEME} position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; font: 13px/1.35 "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
    .pill { display: flex; align-items: center; gap: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 6px 8px 6px 6px; box-shadow: 0 10px 30px rgba(0,0,0,.4); max-width: 420px; }
    .logo { width: 30px; height: 30px; border-radius: 999px; background: var(--panel-2); flex: none; display: grid; place-items: center; cursor: pointer; border: 0; padding: 0; }
    .logo::after { content: ""; border-left: 9px solid var(--text); border-top: 6px solid transparent; border-bottom: 6px solid transparent; margin-left: 3px; }
    .logo { position: relative; }
    .logo::before { content: ""; position: absolute; right: 1px; bottom: 1px; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); border: 2px solid var(--bg); }
    .info { min-width: 0; }
    .label { font-size: 11px; color: var(--muted); font-weight: 700; letter-spacing: -0.02em; text-transform: lowercase; }
    .status { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status.done { color: var(--ok); }
    .status.in { color: var(--text); }
    .actions { display: flex; gap: 5px; margin-left: 2px; align-items: center; }
    button.b { font: inherit; font-size: 12px; font-weight: 600; color: var(--text); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; cursor: pointer; white-space: nowrap; }
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
    .msg { font-size: 12px; color: var(--muted); padding-right: 6px; }
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
    root.append(h("div", { class: "wrap" }, ...content));
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

    if (await isCollapsed()) return paintCollapsed(ref);

    paint(h("div", { class: "pill" }, logoButton(ref), h("div", { class: "msg" }, "Checking Bingers\u2026")));

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
    if (!title) return paint(h("div", { class: "pill" }, logoButton(ref), h("div", { class: "msg" }, "Not on Bingers yet"), closeButton(ref)));

    renderFull(ref, title, status);
  }

  function logoButton(ref) {
    return h("button", { class: "logo", title: "Cue for Bingers \u2014 click to minimise", "aria-label": "Minimise Bingers badge", onclick: async () => { await setCollapsed(true); paintCollapsed(ref); } });
  }
  function closeButton(ref) {
    return h("button", { class: "x", title: "Minimise", "aria-label": "Minimise", onclick: async () => { await setCollapsed(true); paintCollapsed(ref); } }, "\u00d7");
  }
  function paintCollapsed(ref) {
    paint(h("button", { class: "logo", style: "width:38px;height:38px;background:#0c0b0b;border:1px solid #2c2826;box-shadow:0 8px 24px rgba(0,0,0,.4)", title: "Show Cue for Bingers", "aria-label": "Show Bingers badge", onclick: async () => { await setCollapsed(false); load(ref); } }));
  }

  async function act(button, action, ref) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "\u2026";
    try {
      const res = await send("actions", { actions: [action] });
      const r = res?.results?.[0];
      if (r && (r.status === "unresolved" || r.status === "error")) throw new Error(r.message || "Bingers couldn't save that.");
      load(ref);
    } catch (e) {
      button.disabled = false;
      button.textContent = original;
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
      actions.push(btn("+ Follow", { action: "follow" }, true));
      actions.push(btn("Later", { action: "for_later" }));
      if (title.kind === "movie") actions.push(btn("\u2713 Watched", { action: "watch" }));
    } else if (title.kind === "movie" && status !== "watched") {
      actions.push(btn("\u2713 Watched", { action: "watch" }, true));
    } else if (title.kind === "movie" && status === "watched") {
      const stars = h("div", { class: "stars", title: "Rate on Bingers" });
      for (let i = 1; i <= 5; i++) {
        const s = h("button", { "aria-label": `Rate ${i} of 5` }, "\u2605");
        s.addEventListener("click", () => act(s, { action: "rate", title: id, rating: i }, ref));
        stars.append(s);
      }
      actions.push(stars);
    }
    if (title.url) {
      actions.push(h("button", { class: "b", onclick: () => window.open(title.url, "_blank", "noopener") }, "Open"));
    }

    paint(
      h("div", { class: "pill", role: "region", "aria-label": "Cue for Bingers" },
        logoButton(ref),
        h("div", { class: "info" },
          h("div", { class: "label" }, "cue \u00b7 bingers"),
          h("div", { class: cls, title: title.title || "" }, LABELS[status] || status.replace(/_/g, " "))
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
  });
})();
