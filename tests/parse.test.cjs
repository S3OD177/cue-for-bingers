// node tests/parse.test.cjs
const assert = require("node:assert/strict");
const { parseMediaInfo, parseText } = require("../extension/lib/parse.js");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("✓", name); };

t("S01E02 in page title", () => {
  assert.deepEqual(parseText("Severance S02E07 - Chikhai Bardo | Apple TV+"), { kind: "show", title: "Severance", season: 2, episode: 7, year: null });
});
t("1x07 format", () => assert.equal(parseText("The Bear 3x02 Next").episode, 2));
t("Season/Episode words", () => {
  const r = parseText("Shōgun: Season 1, Episode 5 – Broken to the Fist");
  assert.equal(r.title, "Shōgun"); assert.equal(r.season, 1); assert.equal(r.episode, 5);
});
t("Arabic season + episode with Arabic-Indic digits", () => {
  const r = parseText("مسلسل الحشاشين الموسم ١ الحلقة ٧ | شاهد");
  assert.equal(r.season, 1); assert.equal(r.episode, 7); assert.equal(r.title, "الحشاشين");
});
t("Arabic episode only", () => {
  const r = parseText("الحشاشين - الحلقة 12 - شاهد");
  assert.equal(r.season, null); assert.equal(r.episode, 12); assert.equal(r.title, "الحشاشين");
});
t("Movie with year", () => {
  const r = parseText("Watch Dune: Part Two (2024) | Prime Video");
  assert.deepEqual(r, { kind: null, title: "Dune: Part Two", season: null, episode: null, year: 2024 });
});
t("JSON-LD TVEpisode wins", () => {
  const r = parseMediaInfo({
    jsonld: [{ "@type": "TVEpisode", episodeNumber: 3, partOfSeason: { seasonNumber: 2 }, partOfSeries: { name: "Andor" } }],
    docTitle: "Netflix",
  });
  assert.equal(r.title, "Andor"); assert.equal(r.season, 2); assert.equal(r.episode, 3); assert.equal(r.confidence, "high");
});
t("JSON-LD Movie", () => {
  const r = parseMediaInfo({ jsonld: [{ "@type": ["Movie"], name: "Past Lives", datePublished: "2023-06-02" }] });
  assert.equal(r.kind, "movie"); assert.equal(r.year, 2023);
});
t("Media Session: album = show, title = episode name with S/E in artist", () => {
  const r = parseMediaInfo({ session: { title: "Chikhai Bardo", artist: "S2:E7", album: "Severance" }, docTitle: "Apple TV+" });
  assert.equal(r.title, "Severance"); assert.equal(r.season, 2); assert.equal(r.episode, 7);
});
t("Media Session: only show name known → kind null (use next episode)", () => {
  const r = parseMediaInfo({ session: { title: "Some Episode Name", artist: "Slow Horses" }, docTitle: "Apple TV+" });
  assert.equal(r.title, "Slow Horses"); assert.equal(r.kind, null); assert.equal(r.confidence, "medium");
});
t("Generic site title is ignored", () => {
  assert.equal(parseMediaInfo({ docTitle: "Netflix", ogTitle: "Netflix" }), null);
});
t("og:title fallback with episode", () => {
  const r = parseMediaInfo({ docTitle: "Player", ogTitle: "Slow Horses S04E01 | Apple TV+" });
  assert.equal(r.title, "Slow Horses"); assert.equal(r.episode, 1);
});
t("Shahid player page: season comes from document.title, not og:title", () => {
  const r = parseMediaInfo({
    jsonld: [{ "@type": "WebPage", name: "المدينة البعيدة" }],
    ogTitle: "المدينة البعيدة, الحلقة 316",
    docTitle: "شاهد المدينة البعيدة - الموسم 3 / الحلقة 316 - MBC شاهد",
    heading: "شاهد المدينة البعيدة, م3 ح316 - MBC شاهد",
  });
  assert.equal(r.title, "المدينة البعيدة"); assert.equal(r.season, 3); assert.equal(r.episode, 316);
});
t("Shahid short form م3 ح316", () => {
  const r = parseText("شاهد المدينة البعيدة, م3 ح316 - MBC شاهد");
  assert.equal(r.title, "المدينة البعيدة"); assert.equal(r.season, 3); assert.equal(r.episode, 316);
});
t("Shahid episode-only og:title still works alone", () => {
  const r = parseMediaInfo({ ogTitle: "المدينة البعيدة, الحلقة 316", docTitle: "MBC شاهد" });
  assert.equal(r.title, "المدينة البعيدة"); assert.equal(r.season, null); assert.equal(r.episode, 316);
});
t("MBC Shahid brand suffix is stripped", () => {
  assert.equal(parseText("Watch Detective Knight - MBC Shahid").title, "Detective Knight");
  assert.equal(parseText("شاهد فيلم راعي الأجرب - MBC شاهد").title, "راعي الأجرب");
});
t("Shoof Live episode page (player is an embedded iframe)", () => {
  const r = parseMediaInfo({
    heading: "مسلسل الفريق الأول الحلقة 1 مترجمة",
    docTitle: "مسلسل الفريق الأول الحلقة 1 مترجمة - شوف لايف",
    jsonld: [{ "@type": "VideoObject", name: "مسلسل الفريق الأول الحلقة 1 مترجمة" }],
  });
  assert.equal(r.title, "الفريق الأول"); assert.equal(r.season, null); assert.equal(r.episode, 1);
});
t("Arabic ordinal words for season and episode", () => {
  let r = parseText("مسلسل الفريق الأول الموسم الثاني الحلقة 5 مترجمة");
  assert.equal(r.title, "الفريق الأول"); assert.equal(r.season, 2); assert.equal(r.episode, 5);
  r = parseText("مسلسل وادي الذئاب الموسم الاول الحلقة الثالثة");
  assert.equal(r.title, "وادي الذئاب"); assert.equal(r.season, 1); assert.equal(r.episode, 3);
  r = parseText("مسلسل باب الحارة الجزء الثاني عشر الحلقة 7");
  assert.equal(r.title, "باب الحارة"); assert.equal(r.season, 12); assert.equal(r.episode, 7);
  r = parseText("مسلسل الهيبة الجزء 3 الحلقة الحادية عشرة");
  assert.equal(r.title, "الهيبة"); assert.equal(r.season, 3); assert.equal(r.episode, 11);
  // A show whose name contains an ordinal keeps it: "الفريق الأول" isn't "season 1".
  r = parseText("مسلسل الفريق الأول الحلقة 1 مترجمة");
  assert.equal(r.title, "الفريق الأول"); assert.equal(r.season, null); assert.equal(r.episode, 1);
});
t("Season without an episode", () => {
  let r = parseText("مسلسل الفريق الأول الموسم الثاني - شوف لايف");
  assert.equal(r.kind, "show"); assert.equal(r.title, "الفريق الأول"); assert.equal(r.season, 2); assert.equal(r.episode, null);
  r = parseText("Watch The Bear Season 3 | Hulu");
  assert.equal(r.title, "The Bear"); assert.equal(r.season, 3); assert.equal(r.episode, null);
});
t("Site name in front of the title (Prime Video)", () => {
  assert.equal(parseText("Prime Video: Suits").title, "Suits");
  assert.equal(parseText("Amazon.com: Watch Suits | Prime Video").title, "Suits");
  const r = parseText("Prime Video: Suits - Season 2");
  assert.equal(r.title, "Suits"); assert.equal(r.season, 2);
  assert.equal(parseText("Netflix - Dark").title, "Dark");
  // No separator: a title that starts with a brand word stays whole.
  assert.equal(parseText("Max Payne (2008)").title, "Max Payne");
});
t("Player overlay beats a season heading (Prime Video)", () => {
  const r = parseMediaInfo({ player: { title: "Meryem", subtitle: "S1 E1 قسمت 1" }, heading: "1. Season", docTitle: "Prime Video: Meryem" });
  assert.equal(r.title, "Meryem"); assert.equal(r.season, 1); assert.equal(r.episode, 1); assert.equal(r.source, "player");
  const r2 = parseMediaInfo({ player: { title: "Suits", subtitle: "Season 2, Ep. 3 Meet the New Boss" } });
  assert.equal(r2.title, "Suits"); assert.equal(r2.season, 2); assert.equal(r2.episode, 3);
});
t("A season label alone is not a title", () => {
  assert.equal(parseMediaInfo({ heading: "1. Season", docTitle: "Prime Video" }), null);
  const r = parseMediaInfo({ heading: "1. Season", docTitle: "Prime Video: Meryem" });
  assert.equal(r.title, "Meryem");
});
t("Season label in the page title adds the season (Prime Video detail page, user report)", () => {
  const r = parseMediaInfo({ jsonld: [], session: null, ogTitle: "", docTitle: "Prime Video: 1. Season", heading: "Meryem" });
  assert.equal(r.title, "Meryem"); assert.equal(r.kind, "show"); assert.equal(r.season, 1); assert.equal(r.episode, null);
  const de = parseMediaInfo({ docTitle: "Prime Video: Staffel 2", heading: "Dark" });
  assert.equal(de.title, "Dark"); assert.equal(de.season, 2);
  const movie = parseMediaInfo({ docTitle: "Prime Video: Dune: Part Two", heading: "Dune: Part Two" });
  assert.equal(movie.season, null);
});
console.log(`\n${n} parser tests passed`);
