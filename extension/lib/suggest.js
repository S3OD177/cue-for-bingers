// Suggests auto-tracking on known streaming sites without any host permission: Chrome's
// declarativeContent shows a "Cue can track here" icon (green dot) on those sites until the
// user turns tracking on there. Clicking the icon opens the popup with a one-tap button.
import { POPULAR_SITES, ALL_SITES } from "./sites.js";

const hostOf = (origin) => origin.replace(/^https?:\/\//, "").replace(/\/\*$/, "");

async function dotIcon(size) {
  const res = await fetch(chrome.runtime.getURL(`icons/icon${size}.png`));
  const bmp = await createImageBitmap(await res.blob());
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0, size, size);
  const r = size * 0.22;
  const x = size - r - 0.5;
  const y = r + 0.5;
  g.beginPath();
  g.arc(x, y, r + size * 0.06, 0, Math.PI * 2);
  g.fillStyle = "#0c0b0b"; // ring so the dot reads on any toolbar color
  g.fill();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = "#5fd38d";
  g.fill();
  return g.getImageData(0, 0, size, size);
}

export async function syncSuggestions() {
  if (!chrome.declarativeContent) return;
  await chrome.declarativeContent.onPageChanged.removeRules(undefined);
  const { autoTrack = true } = await chrome.storage.sync.get({ autoTrack: true });
  if (!autoTrack || (await chrome.permissions.contains({ origins: ALL_SITES }))) return;

  const pending = [];
  for (const s of POPULAR_SITES) {
    if (!(await chrome.permissions.contains({ origins: [s.origin] }))) pending.push(hostOf(s.origin));
  }
  if (!pending.length) return;

  const imageData = { 16: await dotIcon(16), 32: await dotIcon(32) };
  await chrome.declarativeContent.onPageChanged.addRules([
    {
      conditions: pending.map((h) => new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: h, schemes: ["https"] } })),
      actions: [new chrome.declarativeContent.SetIcon({ imageData })],
    },
  ]);
}
