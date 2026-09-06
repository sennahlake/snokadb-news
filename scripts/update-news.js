#!/usr/bin/env node
"use strict";

/**
 * Builds news.json, rss.xml and archive/YYYY.json for SnokaDb.
 *
 * - Player index: https://snokadb.se/data/news-player-index.json (fallback data/player-index.json)
 * - Live RSS/API + podcasts from the same sources as SnokaDb
 * - Historical seed: seed/*.json (optional; used for first bootstrap)
 * - Stable: unchanged archives are not rewritten; "No news changes" when nothing new
 * - KB/Svenska tidningar: archiveRefs metadata only (never full article bodies)
 */

const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const {
  parseRssItems,
  toNewsItem,
  toIsoDate,
  dedupeByArticleUrl,
  sortByPublishedDesc,
  hasClubSignal,
  hasLooseIfkSignal,
  normalize,
  slugify,
  findMentionedPlayers,
  buildRelevance,
  detectTeamSide,
  withTeamSideTag,
  enrichTeamSideTags,
  extractNtPageTeamSide,
  stripHtml,
  decodeXml,
} = require("./lib/newsIngestUtils");

const ROOT = path.join(__dirname, "..");
const NEWS_PATH = path.join(ROOT, "news.json");
const RSS_PATH = path.join(ROOT, "rss.xml");
const ARCHIVE_DIR = path.join(ROOT, "archive");
const ARCHIVE_INDEX_PATH = path.join(ARCHIVE_DIR, "index.json");
const PLAYER_INDEX_PATH = path.join(ROOT, "data", "player-index.json");
const SEED_DIR = path.join(ROOT, "seed");
const REMOTE_PLAYER_INDEX_URL = "https://snokadb.se/data/news-player-index.json";

const RSS_LIMIT = 100;
const LIVE_RSS_PAGES = 3;
const HISTORY_MAX_AGE_DAYS = 365 * 12;

const NEWSPAPER_SOURCES = new Set([
  "Norrköpings Tidningar",
  "Sportbladet",
  "SportExpressen",
]);

const FEED_SOURCES = [
  {
    idPrefix: "ifk",
    name: "IFK Norrköping",
    sourceUrl: "https://ifknorrkoping.se/nyheter/",
    type: "rss",
    feedUrl: "https://ifknorrkoping.se/feed/",
    rssPages: LIVE_RSS_PAGES,
    filter: "all",
    sourceType: "official",
    category: "Officiellt",
    tags: ["Officiellt"],
    keywords: ["IFK Norrköping", "Officiellt"],
    access: { type: "free", label: "Fri läsning" },
  },
  {
    idPrefix: "nt",
    name: "Norrköpings Tidningar",
    sourceUrl: "https://www.nt.se/sport/fotboll",
    type: "rss",
    feedUrl: "https://www.nt.se/rss",
    filter: "nt-sport-ifk",
    sourceType: "local",
    category: "Lokal",
    tags: ["Extern originalkälla", "Lokal"],
    keywords: ["IFK Norrköping", "NT"],
    access: { type: "paywalled", label: "Låst", allowWhenHidingPaywalled: true },
  },
  {
    idPrefix: "fotbolldirekt",
    name: "FotbollDirekt",
    sourceUrl: "https://fotbolldirekt.se/",
    type: "rss",
    feedUrl: "https://fotbolldirekt.se/feed/",
    rssPages: LIVE_RSS_PAGES,
    filter: "club",
    sourceType: "extern",
    category: "Nyhet",
    tags: ["Extern originalkälla"],
    keywords: ["IFK Norrköping", "FotbollDirekt"],
    access: { type: "free", label: "Fri läsning" },
  },
  {
    idPrefix: "svt",
    name: "SVT",
    sourceUrl: "https://www.svt.se/sport/fotboll",
    type: "rss",
    feedUrl: "https://www.svt.se/sport/rss.xml",
    filter: "club",
    sourceType: "public_service",
    category: "Nyhet",
    tags: ["Extern originalkälla", "Public service"],
    keywords: ["IFK Norrköping", "SVT"],
    access: { type: "free", label: "Fri läsning" },
  },
  {
    idPrefix: "sportbladet",
    name: "Sportbladet",
    sourceUrl: "https://www.aftonbladet.se/sportbladet/fotboll",
    type: "rss",
    feedUrl: "https://www.aftonbladet.se/sportbladet/rss.xml",
    filter: "club",
    sourceType: "extern",
    category: "Nyhet",
    tags: ["Extern originalkälla"],
    keywords: ["IFK Norrköping", "Sportbladet"],
    access: { type: "free", label: "Fri läsning" },
  },
  {
    idPrefix: "sportexpressen",
    name: "SportExpressen",
    sourceUrl: "https://www.expressen.se/sport/fotboll/",
    type: "rss",
    feedUrl: "https://www.expressen.se/rss/sport",
    filter: "club",
    sourceType: "extern",
    category: "Nyhet",
    tags: ["Extern originalkälla"],
    keywords: ["IFK Norrköping", "SportExpressen"],
    access: { type: "free", label: "Fri läsning" },
  },
  {
    idPrefix: "tv4",
    name: "TV4",
    sourceUrl: "https://www.tv4.se/sport/fotbollskanalen",
    type: "rss",
    feedUrl: "https://www.tv4.se/rss",
    filter: "club",
    sourceType: "tv",
    category: "Nyhet",
    tags: ["Extern originalkälla", "TV"],
    keywords: ["IFK Norrköping", "TV4"],
    access: { type: "free", label: "Fri läsning" },
  },
  {
    idPrefix: "sr",
    name: "Sveriges Radio",
    sourceUrl: "https://www.sverigesradio.se/sport",
    type: "sr-api",
    query: "IFK Norrköping",
    filter: "club",
    sourceType: "public_service",
    category: "Radio",
    tags: ["Extern originalkälla", "Public service", "Radio"],
    keywords: ["IFK Norrköping", "Sveriges Radio"],
    access: { type: "free", label: "Fri lyssning" },
    maxAgeDays: HISTORY_MAX_AGE_DAYS,
  },
];

const PODCAST_SOURCES = [
  {
    idPrefix: "genom-ljuva-livet",
    name: "Genom Ljuva Livet",
    sourceUrl: "https://poddtoppen.se/podcast/1728458754/genom-ljuva-livet",
    feedUrl: "https://feed.pod.space/genomljuvalivet",
    keywords: ["IFK Norrköping", "Genom Ljuva Livet", "Podd", "Supporter"],
  },
  {
    idPrefix: "snokasnack",
    name: "Snokasnack",
    sourceUrl: "https://poddtoppen.se/podcast/1223781523/snokasnack",
    feedUrl: "https://feeds.soundcloud.com/users/soundcloud:users:298997865/sounds.rss",
    keywords: ["IFK Norrköping", "Snokasnack", "Podd", "Supporter"],
  },
  {
    idPrefix: "studio-peking",
    name: "Studio Peking",
    sourceUrl: "https://poddtoppen.se/podcast/1738623973/studio-peking",
    feedUrl: "https://feed.pod.space/studiopeking",
    keywords: ["IFK Norrköping", "Studio Peking", "Podd", "Supporter"],
  },
  {
    idPrefix: "gate-upp-gate-ner",
    name: "Gate Upp och Gate Ner",
    sourceUrl: "https://poddtoppen.se/podcast/1619327870/gate-upp-gate-ner",
    feedUrl: "https://anchor.fm/s/8e246614/podcast/rss",
    keywords: ["IFK Norrköping", "Gate Upp och Gate Ner", "GUGN", "Podd", "Supporter"],
  },
];

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("http://") ? http : https;
    const request = lib.get(
      url,
      {
        headers: {
          "User-Agent": "SnokaDbNewsBot/1.0 (+https://snokadb.se)",
          Accept: "application/rss+xml, application/xml, application/json, text/xml, */*",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects for " + url));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          fetchText(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error("HTTP " + res.statusCode + " for " + url));
          res.resume();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      }
    );
    request.setTimeout(45000, () => {
      request.destroy(new Error("Timeout for " + url));
    });
    request.on("error", reject);
  });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonIfChanged(filePath, value) {
  const next = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(filePath)) {
    const prev = fs.readFileSync(filePath, "utf8");
    if (prev === next) return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function writeTextIfChanged(filePath, text) {
  const next = String(text);
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === next) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function itemKey(item) {
  return String(item.articleUrl || item.id || "")
    .replace(/\?utm_[^#]+/i, "")
    .replace(/#.*$/, "")
    .toLowerCase();
}

function yearOf(item) {
  const date = new Date(item.publishedAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.getUTCFullYear();
}

function buildArchiveRefs(item) {
  if (!NEWSPAPER_SOURCES.has(item.source)) return undefined;
  const date = String(item.publishedAt || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return [
    {
      provider: "KB/Svenska tidningar",
      publication: item.source,
      date,
      status: "expected",
      note: "Metadata sparad för framtida sökning i KB/Svenska tidningar.",
    },
  ];
}

function stabilizeItem(item) {
  if (!item || typeof item !== "object") return null;
  const out = { ...item };
  delete out.fetchedAt;
  delete out.categories;

  const refs = buildArchiveRefs(out);
  if (refs) out.archiveRefs = refs;
  else delete out.archiveRefs;

  // Drop undefined-ish noise for stable JSON.
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function loadPlayersFromPayload(payload) {
  const players = Array.isArray(payload?.players) ? payload.players : [];
  return players
    .map((row) => ({
      name: row.name || row.player,
      slug: row.slug || row.url_player,
      normalizedName: normalize(row.name || row.player),
      seasons: Array.isArray(row.seasons) ? row.seasons.join(",") : row.seasons,
    }))
    .filter((row) => row.name && row.slug);
}

async function loadPlayerIndex() {
  try {
    const remote = JSON.parse(await fetchText(REMOTE_PLAYER_INDEX_URL));
    const players = loadPlayersFromPayload(remote);
    if (players.length > 0) {
      const cachePayload = {
        schemaVersion: 1,
        itemCount: players.length,
        players: players.map((p) => ({
          name: p.name,
          slug: p.slug,
          seasons: String(p.seasons || "")
            .split(",")
            .map((s) => Number(String(s).trim().match(/^\d{4}/)?.[0]))
            .filter((n) => Number.isInteger(n)),
        })),
      };
      writeJsonIfChanged(PLAYER_INDEX_PATH, cachePayload);
      console.log("Player index: remote (" + players.length + ")");
      return players;
    }
  } catch (error) {
    console.warn("Player index remote failed: " + error.message);
  }

  const local = readJson(PLAYER_INDEX_PATH, { players: [] });
  const players = loadPlayersFromPayload(local);
  console.log("Player index: local fallback (" + players.length + ")");
  return players;
}

function loadArchiveItems() {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  const items = [];
  for (const name of fs.readdirSync(ARCHIVE_DIR)) {
    if (!/^\d{4}\.json$/.test(name)) continue;
    const payload = readJson(path.join(ARCHIVE_DIR, name), { items: [] });
    if (Array.isArray(payload.items)) items.push(...payload.items);
  }
  return items;
}

function loadSeedItems() {
  if (!fs.existsSync(SEED_DIR)) return [];
  const items = [];
  for (const name of fs.readdirSync(SEED_DIR)) {
    if (!name.endsWith(".json")) continue;
    const payload = readJson(path.join(SEED_DIR, name), null);
    if (!payload) continue;
    if (Array.isArray(payload)) items.push(...payload);
    else if (Array.isArray(payload.items)) items.push(...payload.items);
  }
  return items;
}

function mergePreferExisting(existingItems, incomingItems) {
  const map = new Map();
  for (const raw of existingItems) {
    const item = stabilizeItem(raw);
    const key = itemKey(item);
    if (!item || !key) continue;
    map.set(key, item);
  }

  let added = 0;
  for (const raw of incomingItems) {
    const item = stabilizeItem(raw);
    const key = itemKey(item);
    if (!item || !key) continue;
    if (map.has(key)) continue;
    map.set(key, item);
    added += 1;
  }

  return {
    items: enrichTeamSideTags(sortByPublishedDesc([...map.values()])),
    added,
  };
}

function pagedFeedUrl(feedUrl, page) {
  if (page <= 1) return feedUrl;
  return feedUrl + (feedUrl.includes("?") ? "&" : "?") + "paged=" + page;
}

async function enrichNtItemsFromArticlePages(items) {
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const articleUrl = String(item.articleUrl || "").trim();
    if (!articleUrl || !/nt\.se\//i.test(articleUrl)) continue;
    try {
      const html = await fetchText(articleUrl);
      const side = extractNtPageTeamSide(html);
      if (!side) continue;
      item.categories = [...new Set([].concat(item.categories || [], [side]))];
      item.tags = withTeamSideTag(item.tags, side);
    } catch (error) {
      console.warn("NT page tags failed for " + articleUrl + ": " + error.message);
    }
  }
  return list;
}

async function fetchRssSource(source, players) {
  const pages = Math.max(1, Number(source.rssPages) || 1);
  const collected = [];
  let emptyPages = 0;

  for (let page = 1; page <= pages; page += 1) {
    const url = pagedFeedUrl(source.feedUrl, page);
    let xml;
    try {
      xml = await fetchText(url);
    } catch (error) {
      if (page > 1) break;
      throw error;
    }

    const rawItems = parseRssItems(xml);
    if (rawItems.length === 0) {
      emptyPages += 1;
      if (emptyPages >= 2) break;
      continue;
    }
    emptyPages = 0;
    collected.push(...rawItems.map((raw) => toNewsItem(raw, source, players)).filter(Boolean));
  }

  const items = dedupeByArticleUrl(collected);
  if (source.idPrefix === "nt") {
    await enrichNtItemsFromArticlePages(items);
  }
  return items;
}

async function fetchSrApiSource(source, players) {
  const query = encodeURIComponent(source.query || "IFK Norrköping");
  const url =
    "https://api.sr.se/api/v2/episodes/search?query=" + query + "&format=json&size=100";
  const payload = JSON.parse(await fetchText(url));
  const episodes = Array.isArray(payload.episodes) ? payload.episodes : [];

  return episodes
    .map((episode) => {
      const title = String(episode.title || "").trim();
      const summary = String(episode.description || "").trim();
      const articleUrl = String(episode.url || "").trim();
      const publishedAt = toIsoDate(episode.publishdateutc);
      const programName = episode.program && episode.program.name ? episode.program.name : "";
      const haystack = title + "\n" + summary + "\n" + programName;

      if (!title || !articleUrl || !publishedAt) return null;
      if (!hasClubSignal(haystack) && !hasLooseIfkSignal(haystack)) return null;

      const program = normalize(programName);
      if (program.includes("barn") || program.includes("karlavagnen")) return null;

      const year = new Date(publishedAt).getFullYear();
      const mentionedPlayers = findMentionedPlayers(title + " " + summary, players, year);
      const idBase = slugify("sr-" + (episode.id || articleUrl)).slice(0, 96);
      const teamSide = detectTeamSide({
        title,
        summary,
        articleUrl,
        players: mentionedPlayers,
      });

      return {
        id: source.idPrefix + "-" + idBase,
        title,
        summary: summary.slice(0, 400),
        source: source.name,
        sourceUrl: source.sourceUrl,
        articleUrl,
        publishedAt,
        category: source.category || "Radio",
        tags: withTeamSideTag(source.tags || ["Extern originalkälla", "Public service"], teamSide),
        keywords: [].concat(source.keywords || [], [programName]).filter(Boolean),
        access: source.access || { type: "free", label: "Fri lyssning" },
        relevance: buildRelevance({
          sourceType: source.sourceType,
          title,
          summary,
          articleUrl,
          players: mentionedPlayers,
        }),
        players: mentionedPlayers,
        leaders: [],
        matches: [],
        fetchSource: source.idPrefix,
      };
    })
    .filter(Boolean);
}

function readTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

async function fetchPodcastSource(source, players) {
  const xml = await fetchText(source.feedUrl);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .map((match) => {
      const block = match[1];
      const title = stripHtml(readTag(block, "title"));
      const link = stripHtml(readTag(block, "link"));
      const guid = stripHtml(readTag(block, "guid"));
      const rawSummary = stripHtml(
        readTag(block, "description") ||
          readTag(block, "content:encoded") ||
          readTag(block, "itunes:summary")
      );
      const summary = rawSummary && rawSummary !== "." ? rawSummary.slice(0, 400) : title;
      const publishedAt = toIsoDate(readTag(block, "pubDate"));
      if (!title || !publishedAt) return null;

      const year = new Date(publishedAt).getFullYear();
      const mentionedPlayers = findMentionedPlayers(`${title} ${summary}`, players, year);
      const episodeSlug = slugify(title || guid || link).slice(0, 96);

      return {
        id: `${source.idPrefix}-${episodeSlug}`,
        title,
        summary,
        source: source.name,
        sourceUrl: source.sourceUrl,
        articleUrl: link || source.sourceUrl,
        publishedAt,
        category: "Podd",
        tags: ["Extern originalkälla", "Podd", "Supporter"],
        keywords: source.keywords,
        access: { type: "free", label: "Fri lyssning" },
        relevance: buildRelevance({
          sourceType: "podcast",
          title,
          summary,
          articleUrl: link || source.sourceUrl,
          players: mentionedPlayers,
        }),
        players: mentionedPlayers,
        leaders: [],
        matches: [],
        fetchSource: source.idPrefix,
      };
    })
    .filter(Boolean);
}

async function fetchSource(source, players) {
  if (source.type === "rss") return fetchRssSource(source, players);
  if (source.type === "sr-api") return fetchSrApiSource(source, players);
  throw new Error("Unknown source type: " + source.type);
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildRss(items) {
  const latest = sortByPublishedDesc(items).slice(0, RSS_LIMIT);
  const lastBuild = latest[0]?.publishedAt || new Date().toISOString();
  const entries = latest
    .map((item) => {
      const title = escapeXml(item.title);
      const link = escapeXml(item.articleUrl);
      const description = escapeXml(item.summary || item.title);
      const pubDate = new Date(item.publishedAt).toUTCString();
      const guid = escapeXml(item.id || item.articleUrl);
      return [
        "    <item>",
        `      <title>${title}</title>`,
        `      <link>${link}</link>`,
        `      <guid isPermaLink="false">${guid}</guid>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <description>${description}</description>`,
        `      <category>${escapeXml(item.source)}</category>`,
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    "    <title>SnokaDb – Nyheter om IFK Norrköping</title>",
    "    <link>https://snokadb.se/nyheter</link>",
    "    <description>Samlat nyhetsflöde för IFK Norrköping (metadata/länkar, inte fulltext).</description>",
    "    <language>sv-se</language>",
    `    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>`,
    entries,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

function writeArchives(items) {
  const byYear = new Map();
  for (const item of items) {
    const year = yearOf(item);
    if (!year) continue;
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(item);
  }

  const years = [...byYear.keys()].sort((a, b) => b - a);
  let changedYears = 0;

  for (const year of years) {
    const yearItems = sortByPublishedDesc(byYear.get(year));
    const payload = {
      year,
      itemCount: yearItems.length,
      items: yearItems,
    };
    const filePath = path.join(ARCHIVE_DIR, `${year}.json`);
    if (writeJsonIfChanged(filePath, payload)) changedYears += 1;
  }

  // Never delete older year files just because a run had no seed for them.
  const index = {
    schemaVersion: 1,
    yearCount: years.length,
    years: years.map((year) => ({
      year,
      itemCount: byYear.get(year).length,
      path: `archive/${year}.json`,
    })),
  };
  const indexChanged = writeJsonIfChanged(ARCHIVE_INDEX_PATH, index);
  return { changedYears, indexChanged, years };
}

async function main() {
  const players = await loadPlayerIndex();
  const existing = loadArchiveItems();
  const seedItems = loadSeedItems();
  if (seedItems.length) {
    console.log("Seed items: " + seedItems.length);
  }

  const fresh = [];
  const summary = [];

  for (const source of FEED_SOURCES) {
    try {
      const items = await fetchSource(source, players);
      fresh.push(...items);
      summary.push({ source: source.name, count: items.length, ok: true });
      console.log("✓ " + source.name + ": " + items.length);
    } catch (error) {
      summary.push({ source: source.name, count: 0, ok: false, error: error.message });
      console.error("✗ " + source.name + ": " + error.message);
    }
  }

  for (const source of PODCAST_SOURCES) {
    try {
      const items = await fetchPodcastSource(source, players);
      fresh.push(...items);
      summary.push({ source: source.name, count: items.length, ok: true });
      console.log("✓ " + source.name + ": " + items.length);
    } catch (error) {
      summary.push({ source: source.name, count: 0, ok: false, error: error.message });
      console.error("✗ " + source.name + ": " + error.message);
    }
  }

  const merged = mergePreferExisting(existing, [].concat(seedItems, fresh));
  const items = merged.items;

  const archiveResult = writeArchives(items);

  const previousNews = readJson(NEWS_PATH, { items: [] });
  const previousKeys = new Set((previousNews.items || []).map(itemKey));
  const nextKeys = new Set(items.map(itemKey));
  const itemsChanged =
    previousKeys.size !== nextKeys.size ||
    [...nextKeys].some((key) => !previousKeys.has(key)) ||
    JSON.stringify(sortByPublishedDesc(previousNews.items || []).map(stabilizeItem)) !==
      JSON.stringify(items.map(stabilizeItem));

  let newsChanged = false;
  let rssChanged = false;

  if (itemsChanged || !fs.existsSync(NEWS_PATH)) {
    newsChanged = writeJsonIfChanged(NEWS_PATH, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      itemCount: items.length,
      sourceSummary: summary,
      items,
    });
  }

  if (itemsChanged || !fs.existsSync(RSS_PATH)) {
    rssChanged = writeTextIfChanged(RSS_PATH, buildRss(items));
  }

  const anyChange =
    newsChanged || rssChanged || archiveResult.changedYears > 0 || archiveResult.indexChanged;

  if (!anyChange) {
    console.log("No news changes");
    return;
  }

  console.log(
    "Updated news: items=" +
      items.length +
      " added=" +
      merged.added +
      " archiveYearsChanged=" +
      archiveResult.changedYears +
      " news=" +
      newsChanged +
      " rss=" +
      rssChanged
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
