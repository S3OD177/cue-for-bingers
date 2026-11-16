// Streaming sites offered as one-tap "turn on auto-tracking" buttons. Any other site can be
// turned on from the popup ("Auto-track this site"). Each needs the user's approval in Chrome.
import { t } from "./i18n.js";

export const POPULAR_SITES = [
  { name: "Netflix", origin: "https://www.netflix.com/*" },
  { name: "Shahid", origin: "https://shahid.mbc.net/*" },
  { name: "OSN+", origin: "https://www.osnplus.com/*" },
  { name: "Prime Video", origin: "https://www.primevideo.com/*" },
  { name: "Disney+", origin: "https://www.disneyplus.com/*" },
  { name: "Max", origin: "https://play.max.com/*" },
  { name: "Apple TV+", origin: "https://tv.apple.com/*" },
  { name: "Crunchyroll", origin: "https://www.crunchyroll.com/*" },
  { name: "Hulu", origin: "https://www.hulu.com/*" },
  { name: "Plex", origin: "https://app.plex.tv/*" },
  { name: "Shooflive", origin: "https://p4.shooflive.sbs/*" }, // added at the owner's request (user report)
];

// User-video sites skipped by default ("Skip YouTube and similar sites" in Settings).
// Keep in sync with the copy in content/tracker.js.
export const VIDEO_PLATFORMS = ["youtube.com", "youtu.be", "youtube-nocookie.com", "vimeo.com", "dailymotion.com", "twitch.tv", "kick.com", "tiktok.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "reddit.com", "rumble.com", "odysee.com", "bilibili.com", "bitchute.com", "streamable.com"];
export const isVideoPlatform = (host) => VIDEO_PLATFORMS.some((d) => host === d || host.endsWith(`.${d}`));

// Origins the extension holds for its own reasons; never treated as "tracked sites".
// "Auto-track on all websites": optional, requested only when the user flips the switch.
export const ALL_SITES = ["https://*/*", "http://*/*"];
export const isAllSitesPattern = (o) => ALL_SITES.includes(o);

export const RESERVED_ORIGINS = ["https://api.bingers.app/*"];

export function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export function siteLabel(pattern) {
  if (isAllSitesPattern(pattern)) return t("opt_allWebsites");
  const known = POPULAR_SITES.find((s) => s.origin === pattern);
  if (known) return known.name;
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
}
