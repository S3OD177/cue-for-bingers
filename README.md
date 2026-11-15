# Cue for Bingers

An unofficial Chrome extension for the Bingers TV and movie tracker. Not made by or affiliated with Bingers.

A Manifest V3 Chrome extension for the [Bingers](https://bingers.app) TV and movie tracker, built on the Bingers API v1 (`https://api.bingers.app/v1`).

## What it does

| Where | Feature | API used |
|---|---|---|
| Toolbar popup → **Up next** | Next episode of each show you're watching, movies to watch, upcoming. One-click "✓ S02E05" / "✓ Watched". | `GET /watchlist`, `POST /library/actions` (`watch`) |
| Toolbar popup → **Search** | Search the catalog, see your status on each result, Follow / Later / Watched. | `GET /search`, `GET /library/check`, `POST /library/actions` |
| IMDb & TMDB title pages | Floating badge with your status plus Follow, Watch later, Mark watched and 1–5★ rating (movies). Minimisable. | `GET /titles/{ref}`, `GET /library/check`, `POST /library/actions` |
| **Auto-tracking** on sites you approve | Detects the main video, works out what's playing, marks it watched at 90% (configurable), with Undo. Popup shows "Now playing" with Ep −/+ and "Pick title". | `GET /search`, `GET /watchlist`, `POST /scrobble/start\|pause\|stop`, `POST /library/actions` (`unwatch`) |
| Right-click selected text | "Search Bingers for '…'" | `GET /search` |
| Settings page | Sign in (OAuth) or paste a personal access token, toggle the page badge | `GET /me` |

## Project layout

```
extension/            ← the folder you load / zip for the Chrome Web Store
  manifest.json
  background.js       service worker: auth, API calls, message router, context menu
  lib/config.js       ★ set OAUTH_CLIENT_ID here before publishing
  lib/auth.js         OAuth 2.1 + PKCE (chrome.identity), refresh, PAT fallback
  lib/api.js          API client, handles 401 / 403 / 429 (Retry-After)
  lib/normalize.js    tolerant parser for /library/check
  lib/ui.js           shared DOM helpers (no innerHTML)
  lib/theme.css       ★ all colors (Bingers base #0C0B0B); the page badge mirrors it in content.js
  popup/  options/  content/  icons/
hosting/              ← host these at an HTTPS URL you control
  client-metadata.json   OAuth client ID document
  privacy.html           privacy policy (required by the store)
store/                ← listing copy, permission justifications, graphics
tests/                ← mocked unit tests (node tests/run.mjs)
```

## Sign-in: why OAuth, not a baked-in token

Bingers' docs say not to embed personal access tokens in apps other people use. So the published extension uses **OAuth 2.1 with PKCE**, the flow Bingers provides for third-party apps:

- No registration form. **Your `client_id` is the HTTPS URL of a JSON metadata document you host** (`hosting/client-metadata.json`).
- Scopes: `library:read library:write offline_access` (refresh tokens). `resource=https://api.bingers.app/v1`.
- Access tokens last 1 hour. The extension refreshes them automatically.
- Redirect URI is Chrome's built-in `https://<extension-id>.chromiumapp.org/`.

Each user can also paste **their own** personal access token in Settings. Until `OAUTH_CLIENT_ID` is set, that's the only sign-in option shown, which is handy for testing today.

## Try it now (5 minutes, token sign-in)

1. Go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder.
2. The settings page opens. Create a **read + write** token at https://bingers.app/integrations and paste it in.
3. Click the toolbar icon, or open an IMDb title page, e.g. https://www.imdb.com/title/tt0903747/.

## Publish to the Chrome Web Store

1. **Register** as a Chrome Web Store developer (one-time US$5 fee): https://chrome.google.com/webstore/devconsole
2. **Get your permanent extension ID.** Zip the `extension/` folder, upload it as a new item, and save it as a draft (don't submit yet). The dashboard shows the item ID. Your redirect URI is `https://<that-id>.chromiumapp.org/`.
   - Optional, for local testing with the same ID: in the dashboard go to *Package → View public key*, and add `"key": "<that key>"` to `manifest.json` while developing. Remove it before uploading.
3. **Host the `hosting/` folder** on any HTTPS host (GitHub Pages, Vercel, Netlify, Cloudflare Pages). Replace `YOUR-DOMAIN` and `YOUR_EXTENSION_ID` in `client-metadata.json`, and `YOUR-SUPPORT-EMAIL` in `privacy.html`. The `client_id` value inside the JSON must exactly equal the URL it's served from.
4. **Set `OAUTH_CLIENT_ID`** in `extension/lib/config.js` to that same URL.
5. **Test OAuth** with the unpacked extension (with the `key` in place): Settings → *Sign in with Bingers*.
6. **Bump `version`** in `manifest.json` if needed, remove any `key`, then build the zip: `cd extension && zip -r ../cue-for-bingers.zip . -x '.*'`
7. Upload the new zip to the draft, fill in the listing and privacy tabs from `store/STORE_LISTING.md`, and submit for review (usually a few days).

## Limits and things to know

- **Plan:** the Bingers API needs the **Legend or Icon** plan. Other accounts get a 403, and the extension says so.
- **Rate limits:** 60 requests/min and 1,000/hour per user, shared across all of that user's tokens. The extension caches status lookups for 60 s and surfaces `Retry-After` on 429.
- **Unspecified response shapes:** the OpenAPI contract doesn't define the body of `GET /library/check` and `GET /me`, or the inner fields of `progress.next`. The code accepts the likely shapes (`lib/normalize.js`, `episodeParts()` in `lib/ui.js`). If something shows "Not on Bingers" for a title you do have, check the real response in DevTools (service worker → Network) and adjust those two helpers.
## How auto-tracking works

1. **Per-site permission, or all websites.** Nothing is granted at install. Settings also has an "Auto-track on all websites" switch, which requests `https://*/*` and `http://*/*` as optional permissions in one Chrome prompt. With that on, the popup's "Skip this site" adds the host to `excludedHosts` (sync storage) instead of removing a permission. Settings has one-tap buttons for popular sites, and the popup offers "Auto-track <site>" on any site. Each one shows Chrome's approval prompt. `lib/tracker-bg.js` registers `content/tracker.js` (with `lib/parse.js`) on exactly the approved origins, in all frames.
2. **Finding the video.** The largest `<video>` longer than the minimum length (default 10 min, which skips ads and trailers). Reaching the threshold marks it even if you skipped ahead (say you watched most of it on your phone); turn on "Confirm before marking" to be asked first.
3. **Identifying it** (`lib/parse.js`, in priority order): JSON-LD `TVEpisode` / `Movie` → Media Session metadata (what Chrome shows in its media controls) → page `<h1>`, `og:title`, `document.title`. It understands `S02E07`, `2x07`, `Season 2 Episode 7`, `Episode 7`, `الموسم ٢ الحلقة ٧` and `الحلقة ٧`, and strips site names.
4. **Matching on Bingers.** `GET /search` with an exact-title match (then a close match). If only the show is known, it uses that show's next episode from your watch list. Matches are cached for 7 days. Titles you pick by hand are remembered per site.
5. **Scrobbling.** `start` on play and `pause` on pause (both record nothing on Bingers' side). At the threshold it sends `stop`, which marks the episode watched once progress is at least 80%. A notice on the page offers **Undo** (`unwatch`). You can turn on "Ask me before marking" instead.

**Limits.** Sites that publish no title anywhere (some show only "Netflix" as the page title) end up as "Couldn't tell what's playing". You pick the title once in the popup and Cue remembers it for that site. Streaming sites change their pages often, so if one stops being recognised, check what `document.title`, `og:title` and `navigator.mediaSession.metadata` contain on its player page.

## Tests

`node tests/run.mjs` and `node tests/parse.test.cjs` run the auth, API-client and parser logic against a mocked `chrome` and `fetch` (no network or Bingers account needed).
