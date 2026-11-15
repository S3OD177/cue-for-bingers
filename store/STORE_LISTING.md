# Chrome Web Store listing: copy and form answers

Paste these into the Developer Dashboard (https://chrome.google.com/webstore/devconsole).

## Store listing tab

**Name:** Cue for Bingers

**Summary (≤132 chars):**
Unofficial Bingers companion: your next episode in the toolbar, your status on IMDb and TMDB, one-click mark as watched.

**Category:** Entertainment  **Language:** English

**Description:**

Cue brings your Bingers TV and movie tracker into your browser, with your next episode cued up and ready.

• Up next, one click away. Open the toolbar popup to see the next episode of every show you're watching and tick it off without leaving the page.
• Your status on IMDb and TMDB. Open any title page and a small badge shows whether it's in your library, whether you've watched it, and gives you one-click Follow, Watch later, Mark watched and Rate buttons.
• Auto-tracking. Turn on the sites you watch on (Netflix, Shahid, OSN+, Prime Video, Disney+ and more, any other site, or all websites at once) and Cue marks episodes and movies watched in Bingers when you finish them, with one-tap Undo.
• Search from anywhere. Search the Bingers catalog from the popup, or highlight a title on any page, right-click, and choose "Search Bingers".
• Private by design. The extension talks only to the Bingers API. No analytics, no ads, no tracking.

Requires a Bingers account on the Legend or Icon plan (needed for Bingers API access).

Cue is an independent extension built on the public Bingers API. It is not made by, endorsed by, or affiliated with Bingers, IMDb or TMDB.

**Graphics you need to upload:**
- Store icon 128×128: `store/store-icon-128.png`
- At least 1 screenshot, 1280×800 or 640×400: use `store/screenshot-popup-1280x800.png` and add a real one of the IMDb badge once you've signed in
- Small promo tile 440×280: `store/promo-440x280.png`

## Privacy tab

**Single purpose:**
Lets users of the Bingers TV and movie tracker view and update their Bingers library (watch status, next episodes, ratings) from the browser, including on IMDb and TMDB title pages.

**Permission justifications:**
- `storage`: Saves the user's Bingers sign-in and their extension settings locally.
- `identity`: Runs the OAuth sign-in window (chrome.identity.launchWebAuthFlow) so users can connect their Bingers account without copying a token.
- `contextMenus`: Adds a "Search Bingers for '…'" item when the user right-clicks selected text.
- `scripting`: Registers the auto-tracking script only on the streaming sites the user has approved, and injects it into already-open tabs of a site right after the user approves it.
- `activeTab`: Lets the popup see which site is open when the user clicks the toolbar icon, so it can offer "Auto-track this site".
- Optional host permissions (`https://*/*`, `http://*/*`): Never granted at install. Requested only after a user action: one site at a time when the user clicks "Turn on" for a streaming site or "Auto-track this site", or for all sites at once if the user turns on "Auto-track on all websites" in settings. Even then the script only acts on videos longer than the user's minimum length (default 10 minutes), and the user can skip any site. The script on those sites reads the playing video's progress and title to mark episodes watched in Bingers. `http://` covers self-hosted media servers (Plex, Jellyfin) on a home network.
- Host permission `https://api.bingers.app/*`: The Bingers API, the only server the extension sends requests to.
- Content script on `www.imdb.com`, `m.imdb.com` and `www.themoviedb.org`: Reads the title ID from the page URL to show the user's Bingers status badge on title pages. Both sites change pages client-side, so the script is registered for the whole site and only acts on `/title/` (IMDb) and `/movie/` or `/tv/` (TMDB) paths.

**Remote code:** No, I am not using remote code. (All JavaScript ships in the package.)

**Data usage (check these):**
- ☑ Authentication information (OAuth / access tokens)
- ☑ Web history: the IMDb/TMDB title ID of the current page (badge), and, on sites the user approves for auto-tracking, the title of the show or movie being played and how much of it was watched. Sent only to Bingers.
- Leave everything else unchecked.

Certify all three: not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

**Privacy policy URL:** `https://YOUR-DOMAIN/bingers-extension/privacy.html`

## Brand note
The name uses "for Bingers" only to say which service it works with, and the icon is original. Don't add the Bingers logo unless Bingers approves it in writing (ask at legal@bingers.app).
