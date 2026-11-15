# Cue for Bingers: project brief for Claude Code

Chrome extension (Manifest V3, plain JS, no build step) for the **Bingers** TV and movie tracker,
built on the Bingers API v1 (`https://api.bingers.app/v1`). It's an **unofficial** add-on by Saud
Albin Zaid, meant for publishing on the Chrome Web Store.

API docs: https://bingers.app/llms-full.txt · OpenAPI: https://api.bingers.app/v1/openapi.json

## Current state (v1.2.0)
Built and tested so far:
- **Sign-in:** OAuth 2.1 + PKCE via `chrome.identity.launchWebAuthFlow` (client_id = URL of a hosted
  client-metadata JSON), with fallback to the user's own personal access token (`bng_pat_…`).
  `OAUTH_CLIENT_ID` in `extension/lib/config.js` is still a placeholder (`YOUR-DOMAIN`). Until it's
  set, only token sign-in is shown.
- **Popup:** Up next (watch list + one-click mark watched), Search (follow / later / watched),
  Now playing card (auto-tracking state, Ep −/+, Pick title, Undo).
- **IMDb/TMDB badge:** content script with the user's status and quick actions.
- **Auto-tracking:** `content/tracker.js` + `lib/parse.js` read the main `<video>` and the page's title
  info (JSON-LD → Media Session → h1/og:title/document.title, incl. Arabic "الموسم/الحلقة").
  `lib/tracker-bg.js` matches titles via `/search` (+ next episode from `/watchlist`) and sends
  `/scrobble/start|pause|stop`; stop at ≥80% marks watched. Undo = `unwatch` action.
- **Site permissions:** nothing is granted at install. Sites are turned on one at a time (optional host
  permissions, dynamic `chrome.scripting.registerContentScripts`), or all at once with the
  "Auto-track on all websites" switch (`https://*/*`, `http://*/*`). In all-sites mode,
  "Skip this site" uses `excludedHosts` in sync storage.
- **Settings page:** account, auto-tracking (threshold 80–95%, minimum video length, confirm before
  marking, sites), badge toggle.

## Decisions already made (keep them)
- **Name: "Cue for Bingers".** Keep "for Bingers" after the name, never "Bingers …" first. The icon
  is original (play + green check on #0C0B0B). Do NOT use the official Bingers logo unless Bingers
  approves in writing (legal@bingers.app). Say "unofficial / not affiliated" in the listing.
- **Look:** Bingers' brand base color is `#0C0B0B` (dark theme). All colors are tokens in
  `extension/lib/theme.css`, mirrored in the THEME block of `content/content.js`.
- **Least privilege:** no broad host permissions at install. Broad access stays optional and only
  follows a user action.
- **Security:** no innerHTML with API data. Content scripts may call only the allow-listed message
  types in `background.js` (`CONTENT_SCRIPT_ALLOWED`, `CONTENT_TRACKER_ACTIONS`).
- **API access** needs the Bingers Legend or Icon plan (403 otherwise). Rate limits: 60/min and
  1,000/hour per user. The `/library/check` status lookup is cached for 60 s.

## Known gaps / next steps
1. **Not yet tested on real streaming sites** (Netflix, Shahid, OSN+, …) or against the live API with
   a real account. If a site isn't recognised, check `document.title`, `og:title` and
   `navigator.mediaSession.metadata` on its player page and extend `lib/parse.js`.
2. The OpenAPI contract doesn't define the response bodies of `/library/check` and `/me`, or the inner
   fields of `progress.next`. They're parsed defensively in `lib/normalize.js` and
   `episodeParts()` in `lib/ui.js`. Confirm against real responses.
3. **Before publishing:** register as a Chrome Web Store developer, upload a draft to get the
   extension ID, host `hosting/` (client-metadata.json + privacy.html) over HTTPS, fill in
   `YOUR-DOMAIN`, `YOUR_EXTENSION_ID` and `YOUR-SUPPORT-EMAIL`, set `OAUTH_CLIENT_ID`, re-zip.
   Listing copy and permission justifications are in `store/STORE_LISTING.md`.
4. Replace the mock-data store screenshot with real screenshots.

## Layout
```
extension/          load this folder unpacked in chrome://extensions; zip it for the store
  manifest.json  background.js
  lib/  config.js auth.js api.js normalize.js ui.js theme.css sites.js parse.js tracker-bg.js
  popup/  options/  content/ (content.js = IMDb/TMDB badge, tracker.js = auto-tracking)  icons/
hosting/            client-metadata.json, privacy.html, icon128.png (host over HTTPS)
store/              STORE_LISTING.md, screenshots, promo tile, store icon, logo-cue.svg
tests/              run.mjs (auth/API, mocked), parse.test.cjs (title parser), e2e/ (headless Chrome)
```

## Commands
- Unit tests: `node tests/run.mjs` and `node tests/parse.test.cjs`
- E2E (needs Python + Playwright + Chrome; paths inside are from the original Linux workspace and need
  adjusting): `tests/e2e/run.py` (single site), `tests/e2e/run_all.py` (all-sites mode). Each starts
  a mock Bingers API (`mockapi.py`) and a test video site. The test video `ep.mp4` isn't included;
  make any 20–30 s mp4 and put it in `tests/e2e/site/`.
- Package for the store (PowerShell): `Compress-Archive -Path extension\* -DestinationPath cue-for-bingers.zip -Force`
- Bump `version` in `extension/manifest.json` for every store upload.
