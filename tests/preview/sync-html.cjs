// Re-copy the popup, Settings and welcome HTML into tests/preview with paths that work from here and the
// fake `chrome` loaded first. Run after changing either page's markup:
//   node tests/preview/sync-html.cjs
const fs = require("fs");
const path = require("path");
const ext = path.join(__dirname, "..", "..", "extension");

const pages = {
  "popup.html": {
    src: path.join(ext, "popup", "popup.html"),
    swaps: [
      ['href="popup.css"', 'href="../../extension/popup/popup.css"'],
      ['src="../icons/', 'src="../../extension/icons/'],
      ['<script type="module" src="popup.js"></script>', '<script src="../../tests/preview/mock-chrome.js"></script><script type="module" src="../../extension/popup/popup.js"></script>'],
    ],
  },
  "options.html": {
    src: path.join(ext, "options", "options.html"),
    swaps: [
      ['href="../popup/popup.css"', 'href="../../extension/popup/popup.css"'],
      ['href="options.css"', 'href="../../extension/options/options.css"'],
      ['src="../icons/', 'src="../../extension/icons/'],
      ['<script type="module" src="options.js"></script>', '<script src="../../tests/preview/mock-chrome.js"></script><script type="module" src="../../extension/options/options.js"></script>'],
    ],
  },
  "welcome.html": {
    src: path.join(ext, "welcome", "welcome.html"),
    swaps: [
      ['href="../popup/popup.css"', 'href="../../extension/popup/popup.css"'],
      ['href="../options/options.css"', 'href="../../extension/options/options.css"'],
      ['href="welcome.css"', 'href="../../extension/welcome/welcome.css"'],
      ['src="../icons/', 'src="../../extension/icons/'],
      ['<script type="module" src="welcome.js"></script>', '<script src="../../tests/preview/mock-chrome.js"></script><script type="module" src="../../extension/welcome/welcome.js"></script>'],
    ],
  },
};

for (const [name, { src, swaps }] of Object.entries(pages)) {
  let html = fs.readFileSync(src, "utf8");
  for (const [from, to] of swaps) {
    if (!html.includes(from)) throw new Error(`${name}: expected to find ${from}`);
    html = html.split(from).join(to);
  }
  fs.writeFileSync(path.join(__dirname, name), html);
  console.log(`updated tests/preview/${name}`);
}
