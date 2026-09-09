"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeXml,
  parseRssItems,
  passesSourceFilter,
  toIsoDate,
  toNewsItem,
  dedupeByArticleUrl,
  detectTeamSide,
  enrichTeamSideTags,
  extractNtPageTeamSide,
  teamSideFromCategoryLabel,
} = require("./newsIngestUtils");

test("decodeXml handles numeric entities", () => {
  assert.equal(decodeXml("Parken &#8211; hoppas"), "Parken – hoppas");
});

test("parseRssItems extracts basic fields", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[IFK-truppen mot Ljungskile]]></title>
      <link>https://ifknorrkoping.se/ifk-truppen-mot-ljungskile-sk/</link>
      <pubDate>Wed, 03 Sep 2026 12:00:00 +0000</pubDate>
      <description><![CDATA[Truppen är spikad.]]></description>
    </item>
  </channel></rss>`;

  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "IFK-truppen mot Ljungskile");
  assert.match(items[0].articleUrl, /ifk-truppen/);
  assert.ok(items[0].publishedAt);
});

test("nt-sport-ifk filter keeps football IFK stories only", () => {
  assert.equal(
    passesSourceFilter(
      {
        title: "Nyman historisk",
        summary: "IFK Norrköping vann",
        articleUrl: "https://www.nt.se/sport/fotboll/artikel/nyman/1",
      },
      "nt-sport-ifk"
    ),
    true
  );

  assert.equal(
    passesSourceFilter(
      {
        title: "Villa såld i Norrköping",
        summary: "Ny ägare",
        articleUrl: "https://www.nt.se/bostad/artikel/villa/1",
      },
      "nt-sport-ifk"
    ),
    false
  );
});

test("nt-sport-ifk accepts current IFK player without saying IFK", () => {
  const players = [
    {
      name: "Axel Brönner",
      slug: "axel-bronner",
      normalizedName: "axel bronner",
      seasons: "2024, 2025, 2026",
    },
  ];

  assert.equal(
    passesSourceFilter(
      {
        title: "Efter väntan och längtan – Brönner fick chansen från start",
        summary:
          "Axel Brönner har fått vänta på sin chans. Mot Ljungskile kom den till slut.",
        articleUrl:
          "https://www.nt.se/sport/fotboll/artikel/efter-vantan-och-langtan-bronner-fick-chansen-fran-start/jo5k618l",
      },
      "nt-sport-ifk",
      { players, year: 2026 }
    ),
    true
  );
});

test("nt-sport-ifk accepts NT story-sport football URLs", () => {
  assert.equal(
    passesSourceFilter(
      {
        title: 'Viggo Fälths väg till Parken: "Du behöver det inre drivet"',
        summary: "IFK Norrköping-talangen berättar.",
        articleUrl:
          "https://www.nt.se/story-sport/fotboll/artikel/viggo-falth-om-vagen-fran-vanga-if-till-ifk-norrkoping/jo5kp07l",
      },
      "nt-sport-ifk"
    ),
    true
  );
});

test("club filter requires IFK context", () => {
  assert.equal(
    passesSourceFilter(
      {
        title: "Vilmer Tyrén med mål mot IFK Norrköping",
        summary: "Superettan",
        articleUrl: "https://www.expressen.se/sport/fotboll/x",
      },
      "club"
    ),
    true
  );

  assert.equal(
    passesSourceFilter(
      {
        title: "Mbappé missade straff",
        summary: "Real Madrid",
        articleUrl: "https://www.aftonbladet.se/sportbladet/a/x",
      },
      "club"
    ),
    false
  );
});

test("toNewsItem builds official IFK item", () => {
  const item = toNewsItem(
    {
      title: "Fredagsmys med match på Parken",
      summary: "Inlägget Fredagsmys med match på Parken dök först upp på IFK Norrköping .",
      articleUrl: "https://ifknorrkoping.se/fredagsmys-med-match-pa-parken/",
      publishedAt: "2026-09-03T16:00:00+02:00",
      guid: "https://ifknorrkoping.se/?p=123",
    },
    {
      idPrefix: "ifk",
      name: "IFK Norrköping",
      sourceUrl: "https://ifknorrkoping.se/nyheter/",
      filter: "all",
      sourceType: "official",
      category: "Officiellt",
      tags: ["Officiellt"],
      keywords: ["IFK Norrköping"],
      access: { type: "free", label: "Fri läsning" },
    },
    []
  );

  assert.ok(item);
  assert.equal(item.source, "IFK Norrköping");
  assert.equal(item.id, "ifk-fredagsmys-med-match-pa-parken");
  assert.equal(item.summary, "Fredagsmys med match på Parken");
  assert.equal(item.relevance.level, "high");
});

test("toIsoDate supports .NET dates", () => {
  assert.equal(toIsoDate("/Date(1742821500000)/"), new Date(1742821500000).toISOString());
});

test("dedupeByArticleUrl drops utm variants", () => {
  const items = dedupeByArticleUrl([
    { id: "a", articleUrl: "https://example.com/x?utm_medium=rss" },
    { id: "b", articleUrl: "https://example.com/x" },
  ]);
  assert.equal(items.length, 1);
});

test("detectTeamSide uses RSS category and league cues", () => {
  assert.equal(
    detectTeamSide({ title: "Truppen mot Hammarby", categories: ["Dam"] }),
    "Dam"
  );
  assert.equal(
    detectTeamSide({
      title: "Från akademin till debutanter i OBOS Damallsvenskan",
      summary: "",
    }),
    "Dam"
  );
  assert.equal(
    detectTeamSide({
      title: "Efter väntan och längtan – Brönner fick chansen från start",
      summary: "Axel Brönner har fått vänta. Mot Ljungskile kom den.",
      players: [{ name: "Axel Brönner" }],
    }),
    "Herr"
  );
  assert.equal(
    detectTeamSide({
      title: "Se Superettan och stötta IFK Norrköping",
      summary: "",
    }),
    "Herr"
  );
  assert.equal(
    detectTeamSide({
      title: "Malva efter förlusten",
      summary: "Vi ska fortsätta jobba för varandra",
      players: [{ name: "Malva Larsson", side: "Dam" }],
    }),
    "Dam"
  );
  assert.equal(
    detectTeamSide({
      title: "Brönner från start",
      summary: "Chansen kom mot Ljungskile",
      players: [{ name: "Axel Brönner", side: "Herr" }],
    }),
    "Herr"
  );
});

test("enrichTeamSideTags cross-links same-day opponent articles", () => {
  const items = enrichTeamSideTags([
    {
      id: "ifk-1",
      title: "Truppen mot Hammarby",
      summary: "Truppen mot Hammarby",
      publishedAt: "2026-09-05T08:00:00Z",
      tags: ["Officiellt", "Herr"],
      categories: ["Dam"],
    },
    {
      id: "nt-ham",
      title: "Svår uppgift för IFK – följ matchen mot Hammarby",
      summary: "Kan formsvaga IFK knäcka guldjagande Hammarby?",
      publishedAt: "2026-09-05T10:15:00Z",
      tags: ["Extern originalkälla", "Lokal", "Herr"],
      players: [],
    },
    {
      id: "nt-bron",
      title: "Efter väntan och längtan – Brönner fick chansen från start",
      summary: "Axel Brönner har fått vänta. Mot Ljungskile kom den.",
      publishedAt: "2026-09-05T10:00:00Z",
      tags: ["Extern originalkälla", "Lokal", "Herr"],
      players: [{ name: "Axel Brönner" }],
    },
  ]);

  assert.deepEqual(
    items.find((item) => item.id === "nt-ham").tags,
    ["Extern originalkälla", "Lokal", "Dam"]
  );
  assert.deepEqual(
    items.find((item) => item.id === "nt-bron").tags,
    ["Extern originalkälla", "Lokal", "Herr"]
  );
  assert.deepEqual(
    items.find((item) => item.id === "ifk-1").tags,
    ["Officiellt", "Dam"]
  );
});

test("parseRssItems reads Dam/Herr categories", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title><![CDATA[Truppen mot Hammarby]]></title>
      <link>https://ifknorrkoping.se/truppen-mot-hammarby-9/</link>
      <pubDate>Fri, 05 Sep 2026 08:00:00 +0000</pubDate>
      <category><![CDATA[Dam]]></category>
      <description><![CDATA[Truppen är spikad.]]></description>
    </item>
  </channel></rss>`;

  const items = parseRssItems(xml);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].categories, ["Dam"]);
});

test("extractNtPageTeamSide reads IFK Dam/Herr tags from NT HTML", () => {
  const damHtml = `
    <script>{"name":"IFK Norrköping Dam","slug":"organisation/ifk-norrkoping-dam"}</script>
    <h1>IFK Norrköping Dam</h1>
  `;
  const herrHtml = `
    <script>{"name":"IFK Norrköping Herr","slug":"organisation/ifk-norrkoping-herr"}</script>
    <h1>IFK Norrköping herr</h1>
  `;
  assert.equal(extractNtPageTeamSide(damHtml), "Dam");
  assert.equal(extractNtPageTeamSide(herrHtml), "Herr");
  assert.equal(extractNtPageTeamSide("<p>Ingen lag-tagg</p>"), null);
});

test("teamSideFromCategoryLabel understands NT labels", () => {
  assert.equal(teamSideFromCategoryLabel("IFK Norrköping Dam"), "Dam");
  assert.equal(teamSideFromCategoryLabel("IFK Norrköping herr"), "Herr");
  assert.equal(teamSideFromCategoryLabel("Damallsvenskan"), "Dam");
  assert.equal(teamSideFromCategoryLabel("Fotboll"), null);
});
