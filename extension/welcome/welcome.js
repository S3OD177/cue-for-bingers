// First-run page, opened once when the extension is installed: sign in, turn on a few sites,
// play something. Every permission is still asked for by Chrome, one click at a time.
import { send, el, toast, t, tNodes, localizePage, loadLanguage, languageSelect } from "../lib/ui.js";
import { POPULAR_SITES, ALL_SITES } from "../lib/sites.js";

const uiLang = await loadLanguage();
localizePage();
document.getElementById("lang-slot").replaceWith(languageSelect(uiLang));
document.getElementById("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---- step 1: account ----
const accountStep = document.getElementById("step-account");
const accountBody = document.getElementById("account-body");

async function renderAccount() {
  let session;
  try {
    session = await send("getSession");
  } catch (e) {
    accountBody.replaceChildren(el("div", { class: "msg err" }, e.message));
    return;
  }
  accountStep.classList.toggle("done", session.signedIn);
  if (session.signedIn) {
    const p = session.profile;
    const label = p?.handle ? `@${p.handle}` : p?.name || t("opt_yourAccount");
    accountBody.replaceChildren(el("div", {}, el("span", { class: "status-dot" }), tNodes("opt_connectedTo", el("strong", { dir: "auto" }, label))));
    return;
  }
  const actions = [];
  if (session.oauthConfigured) {
    const b = el("button", { class: "btn primary" }, t("signin_oauth"));
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await send("signInOAuth");
        renderAccount();
      } catch (e) {
        b.disabled = false;
        toast(e.message, "err");
      }
    });
    actions.push(b, el("button", { class: "link small", onclick: () => chrome.runtime.openOptionsPage() }, t("signin_usePat")));
  } else {
    actions.push(el("button", { class: "btn primary", onclick: () => chrome.runtime.openOptionsPage() }, t("signin_connectToken")));
  }
  accountBody.replaceChildren(
    el("p", { class: "small" }, t("signin_body")),
    el("div", { class: "step-actions" }, actions),
    el("p", { class: "muted small" }, t("signin_planNote"))
  );
}
renderAccount();
// Signing in with a token happens in Settings (another tab): update when it lands.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("auth" in changes || "profile" in changes)) renderAccount();
});

// ---- step 2: sites ----
const sitesStep = document.getElementById("step-sites");
const chips = document.getElementById("site-chips");
const FEATURED = POPULAR_SITES.slice(0, 6);

async function renderSites() {
  const everywhere = await chrome.permissions.contains({ origins: ALL_SITES });
  const on = await Promise.all(FEATURED.map((s) => chrome.permissions.contains({ origins: [s.origin] })));
  sitesStep.classList.toggle("done", everywhere || on.some(Boolean));
  chips.replaceChildren(
    ...FEATURED.map((site, i) => {
      const isOn = everywhere || on[i];
      const b = el("button", { class: isOn ? "btn on" : "btn", "aria-pressed": String(isOn), dir: "auto" }, isOn ? `✓ ${site.name}` : site.name);
      if (isOn) b.disabled = true;
      // permissions.request must run straight from the click.
      else b.addEventListener("click", () => turnOn([site.origin], t("live_nowOn", site.name)));
      return b;
    })
  );
  const all = document.getElementById("all-sites");
  all.hidden = everywhere;
}

async function turnOn(origins, message) {
  const ok = await chrome.permissions.request({ origins }).catch(() => false);
  if (ok) {
    await send("syncTracker").catch(() => {});
    toast(message, "ok");
  }
  renderSites();
}

document.getElementById("all-sites").addEventListener("click", () => turnOn(ALL_SITES, t("live_allOn")));
renderSites();
