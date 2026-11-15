// Turns whatever a streaming page exposes (JSON-LD, Media Session metadata, og:title,
// document.title) into { kind, title, season, episode, year }.
// Classic script (no import/export) so it can run as a content script; also loadable in Node tests.
(function (root) {
  "use strict";

  const toAsciiDigits = (s) => String(s || "").replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));
  const squash = (s) => String(s || "").replace(/[\s ]+/g, " ").trim();

  const BRANDS =
    "netflix|prime video|amazon prime video|amazon|disney\\+|disney plus|hbo max|max|apple tv\\+?|hulu|crunchyroll|shahid|شاهد|osn\\+?|osnplus|plex|jellyfin|emby|youtube|paramount\\+|peacock|stc tv|starzplay|tod";
  const SUFFIX_RE = new RegExp(`\\s*(?:[|\\-–—•:]\\s*)(?:watch\\s+)?(?:${BRANDS})(?:\\s+(?:online|tv))?\\s*$`, "i");
  const PREFIX_RE = /^(?:watch(?:ing)?|now playing|مشاهدة|شاهد)\s*[:\-]?\s+/i;
  const GENERIC_RE = new RegExp(`^(?:${BRANDS}|home|player|video|watch|loading\\W*)$`, "i");

  function cleanTitle(s) {
    let t = squash(s);
    for (let i = 0; i < 3; i++) t = t.replace(SUFFIX_RE, "");
    t = t.replace(PREFIX_RE, "");
    t = t.replace(/^[\s|\-–—:•"'“”]+|[\s|\-–—:•"'“”,]+$/g, "");
    return squash(t);
  }

  // [regex, hasSeason]
  const EP_PATTERNS = [
    [/\bS(\d{1,3})\s*[:.\-]?\s*E(\d{1,4})\b/i, true],
    [/\b(\d{1,2})x(\d{1,3})\b/, true],
    [/\bSeason\s*(\d{1,3})\b[^\d]{0,15}?\b(?:Episode|Ep\.?|E)\s*(\d{1,4})\b/i, true],
    [/الموسم\s*(\d{1,3})[\s\S]{0,20}?الحلقة\s*(\d{1,4})/, true], // الموسم N ... الحلقة N
    [/\b(?:Episode|Ep\.?)\s*(\d{1,4})\b/i, false],
    [/الحلقة\s*(\d{1,4})/, false], // الحلقة N
  ];

  function parseText(raw) {
    const text = toAsciiDigits(squash(raw));
    if (!text) return null;
    for (const [re, hasSeason] of EP_PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      const season = hasSeason ? Number(m[1]) : null;
      const episode = Number(hasSeason ? m[2] : m[1]);
      let title = cleanTitle(text.slice(0, m.index));
      if (!title) title = cleanTitle(text.slice(m.index + m[0].length).split(/[|–—]| - /)[0]);
      return { kind: "show", title, season, episode, year: null };
    }
    const ym = text.match(/\((19\d{2}|20\d{2})\)/);
    const title = cleanTitle(ym ? text.slice(0, ym.index) : text);
    return { kind: null, title, season: null, episode: null, year: ym ? Number(ym[1]) : null };
  }

  function fromJsonLd(items) {
    for (const it of items || []) {
      const types = [].concat(it?.["@type"] || []).map(String);
      if (types.includes("TVEpisode") || types.includes("Episode")) {
        const series = it.partOfSeries?.name || it.partOfTVSeries?.name;
        const season = it.partOfSeason?.seasonNumber ?? it.seasonNumber;
        const episode = it.episodeNumber;
        if (series && episode != null) {
          return { kind: "show", title: cleanTitle(series), season: season != null ? Number(season) : null, episode: Number(episode), year: null, source: "jsonld", confidence: "high" };
        }
      }
      if (types.includes("Movie") && it.name) {
        const y = String(it.datePublished || it.dateCreated || "").slice(0, 4);
        return { kind: "movie", title: cleanTitle(it.name), season: null, episode: null, year: /^\d{4}$/.test(y) ? Number(y) : null, source: "jsonld", confidence: "high" };
      }
    }
    return null;
  }

  const usable = (r) => r && r.title && r.title.length >= 2 && !GENERIC_RE.test(r.title);

  /**
   * info = { jsonld: [...], session: {title, artist, album}, ogTitle, docTitle, heading }
   */
  function parseMediaInfo(info = {}) {
    const ld = fromJsonLd(info.jsonld);
    if (usable(ld)) return ld;

    const s = info.session || {};
    if (s.title) {
      const joined = [s.album, s.artist, s.title].filter(Boolean).join(" - ");
      const fromJoined = parseText(joined);
      if (fromJoined && fromJoined.kind === "show" && fromJoined.episode != null) {
        const showName = cleanTitle(s.album || s.artist || "") || fromJoined.title;
        const r = { ...fromJoined, title: usable({ title: showName }) ? showName : fromJoined.title, source: "mediaSession", confidence: "high" };
        if (usable(r)) return r;
      }
      const t = parseText(s.title);
      if (t && t.kind === "show" && usable(t)) return { ...t, source: "mediaSession", confidence: "high" };
      // Title is usually the episode name and artist/album the show name.
      const show = cleanTitle(s.album || s.artist || "");
      if (usable({ title: show })) return { kind: null, title: show, season: null, episode: null, year: null, source: "mediaSession", confidence: "medium" };
      if (t && usable(t)) return { ...t, source: "mediaSession", confidence: "medium" };
    }

    for (const [field, source] of [["heading", "heading"], ["ogTitle", "og:title"], ["docTitle", "title"]]) {
      const t = parseText(info[field]);
      if (t && t.kind === "show" && usable(t)) return { ...t, source, confidence: "medium" };
    }
    for (const [field, source] of [["ogTitle", "og:title"], ["docTitle", "title"], ["heading", "heading"]]) {
      const t = parseText(info[field]);
      if (usable(t)) return { ...t, source, confidence: "low" };
    }
    return null;
  }

  const api = { parseMediaInfo, parseText, cleanTitle, toAsciiDigits };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CueParse = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
