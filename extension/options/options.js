import { send, el, toast } from "../lib/ui.js";
import { INTEGRATIONS_URL } from "../lib/config.js";
import { ALL_SITES, isAllSitesPattern, siteLabel } from "../lib/sites.js";

const saved = () => toast("Saved", "ok");

const body = document.getElementById("account-body");
const badge = document.getElementById("show-badge");

document.getElementById("version").textContent = chrome.runtime.getManifest().version;
send("redirectUrl").then((u) => (document.getElementById("redirect-url").textContent = u)).catch(() => {});

// ---- badge setting (default on) ----
chrome.storage.sync.get({ showBadge: true }).then(({ showBadge }) => (badge.checked = showBadge));
badge.addEventListener("change", () => chrome.storage.sync.set({ showBadge: badge.checked }).then(saved));

function message(text, kind = "") {
  return el("div", { class: `msg ${kind}`, role: "status" }, text);
}

function renderSignedIn(session) {
  const p = session.profile;
  const label = p?.handle ? `@${p.handle}` : p?.name || "your Bingers account";
  const method = session.mode === "pat" ? "personal access token" : "Bingers sign-in";
  body.replaceChildren(
    el("div", { class: "signed-in" },
      el("div", {},
        el("div", {}, el("span", { class: "status-dot" }), "Connected to ", el("strong", {}, label)),
        el("div", { class: "muted small" }, `Using a ${method}.`)
      ),
      el("button", {
        class: "btn",
        onclick: async () => {
          await send("signOut");
          render();

        },
      }, "Sign out")
    )
  );
}

function renderSignedOut(session, note) {
  const out = [];
  if (session.oauthConfigured) {
    const btn = el("button", { class: "btn primary" }, "Sign in with Bingers");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await send("signInOAuth");
        render();
      } catch (e) {
        btn.disabled = false;
        status.replaceChildren(message(e.message, "err"));
      }
    });
    out.push(el("p", { class: "muted small" }, "Recommended. Opens a Bingers window where you approve access. No token to copy."), btn);
    out.push(el("div", { class: "divider" }, "or use a personal access token"));
  }

  const input = el("input", { type: "password", placeholder: "bng_pat_…", autocomplete: "off", spellcheck: "false", "aria-label": "Personal access token" });
  const save = el("button", { class: "btn primary" }, "Connect");
  const connect = async () => {
    save.disabled = true;
    status.replaceChildren(message("Checking token…"));
    try {
      await send("signInToken", { token: input.value });
      render();
    } catch (e) {
      save.disabled = false;
      status.replaceChildren(message(e.message, "err"));
    }
  };
  save.addEventListener("click", connect);
  input.addEventListener("keydown", (e) => e.key === "Enter" && connect());

  const link = el("a", { href: INTEGRATIONS_URL, target: "_blank", rel: "noopener" }, "bingers.app/integrations");
  out.push(
    el("p", { class: "small" }, "Create a token at ", link, ". Pick “read + write” so you can mark things watched. The token is stored only in this browser."),
    el("div", { class: "field" }, input, save)
  );
  const status = el("div");
  if (note) status.append(message(note));
  out.push(status, el("p", { class: "muted small" }, "API access needs the Bingers Legend or Icon plan."));
  body.replaceChildren(...out);
}

async function render(note) {
  try {
    const session = await send("getSession");
    if (session.signedIn) renderSignedIn(session);
    else renderSignedOut(session, note);
  } catch (e) {
    body.replaceChildren(message(e.message, "err"));
  }
}

render();

// ---- auto-tracking ----
const TRACK_DEFAULTS = { autoTrack: true, threshold: 90, minMinutes: 10, confirmBeforeMark: false };
const autoTrack = document.getElementById("auto-track");
const threshold = document.getElementById("threshold");
const minMinutes = document.getElementById("min-minutes");
const confirmMark = document.getElementById("confirm-mark");
const sitesEl = document.getElementById("sites");

chrome.storage.sync.get(TRACK_DEFAULTS).then((s) => {
  autoTrack.checked = s.autoTrack;
  threshold.value = String(s.threshold);
  minMinutes.value = String(s.minMinutes);
  confirmMark.checked = s.confirmBeforeMark;
});
autoTrack.addEventListener("change", () => chrome.storage.sync.set({ autoTrack: autoTrack.checked }).then(saved));
threshold.addEventListener("change", () => chrome.storage.sync.set({ threshold: Number(threshold.value) }).then(saved));
minMinutes.addEventListener("change", () => chrome.storage.sync.set({ minMinutes: Number(minMinutes.value) }).then(saved));
confirmMark.addEventListener("change", () => chrome.storage.sync.set({ confirmBeforeMark: confirmMark.checked }).then(saved));

const allSites = document.getElementById("all-sites");
const excludedEl = document.getElementById("excluded");
allSites.addEventListener("change", async () => {
  // permissions.request must run directly from this user action.
  const ok = allSites.checked
    ? await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false)
    : await chrome.permissions.remove({ origins: ALL_SITES }).catch(() => false);
  if (ok) await send("syncTracker").catch(() => {});
  renderSites();
});

async function renderSites() {
  let granted = [];
  try {
    granted = await send("trackedSites");
  } catch {
    /* ignore */
  }
  const everywhere = await chrome.permissions.contains({ origins: ALL_SITES });
  allSites.checked = everywhere;
  granted = granted.filter((o) => !isAllSitesPattern(o));

  const { excludedHosts = [] } = await chrome.storage.sync.get({ excludedHosts: [] });
  const { seenHosts = [] } = await chrome.storage.local.get("seenHosts");
  excludedEl.replaceChildren();

  // Listed: only the user's own sites: turned on, tracked something, or skipped. The verified
  // streaming sites aren't listed here; the popup marks them "Verified" when the user is on one.
  const hostOf = (o) => o.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
  const all = [];
  const add = (o) => {
    if (!all.some((x) => hostOf(x) === hostOf(o))) all.push(o);
  };
  granted.forEach(add);
  [...seenHosts, ...excludedHosts].forEach((h) => add(`https://${h}/*`));

  const rows = [];
  for (const origin of all) {
    const host = hostOf(origin);
    if (everywhere) {
      // With "all websites" on, every site is on unless it was skipped.
      const skipped = excludedHosts.includes(host);
      const btn = el("button", { class: skipped ? "btn primary" : "btn" }, skipped ? "Track again" : "Skip");
      btn.addEventListener("click", async () => {
        const next = skipped ? excludedHosts.filter((h) => h !== host) : [...new Set([...excludedHosts, host])];
        await chrome.storage.sync.set({ excludedHosts: next });
        renderSites();
      });
      rows.push(el("div", { class: "site" }, el("span", {}, siteLabel(origin), skipped ? el("span", { class: "muted" }, " skipped") : el("span", { class: "on" }, " \u25cf on")), btn));
      continue;
    }
    const on = granted.includes(origin);
    const btn = el("button", { class: on ? "btn" : "btn primary" }, on ? "Turn off" : "Turn on");
    btn.addEventListener("click", async () => {
      // permissions.request must run directly from this click.
      const done = on ? await chrome.permissions.remove({ origins: [origin] }) : await chrome.permissions.request({ origins: [origin] });
      if (done) await send("syncTracker").catch(() => {});
      renderSites();
    });
    rows.push(el("div", { class: "site" }, el("span", {}, siteLabel(origin), on ? el("span", { class: "on" }, " \u25cf on") : null), btn));
  }
  if (!rows.length) rows.push(el("p", { class: "muted small" }, "No sites yet. Open a site you watch on, click the Cue icon, then turn it on."));
  sitesEl.replaceChildren(...rows);
}
renderSites();
chrome.permissions.onAdded.addListener(renderSites);
chrome.permissions.onRemoved.addListener(renderSites);
chrome.storage.onChanged.addListener((c, area) => {
  if ((area === "local" && c.seenHosts) || (area === "sync" && c.excludedHosts)) renderSites();
});
