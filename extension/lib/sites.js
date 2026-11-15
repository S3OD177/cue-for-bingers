// Streaming sites offered as one-tap "turn on auto-tracking" buttons. Any other site can be
// turned on from the popup ("Auto-track this site"). Each needs the user's approval in Chrome.
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
];

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
  if (isAllSitesPattern(pattern)) return "All websites";
  const known = POPULAR_SITES.find((s) => s.origin === pattern);
  if (known) return known.name;
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
}
