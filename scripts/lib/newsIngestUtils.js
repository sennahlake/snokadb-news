"use strict";

const DEFAULT_CLUB_PATTERNS = [
  /\bifk\s+norrk[oö]ping\b/i,
  /\bnorrk[oö]pings?\s+ifk\b/i,
  /\bpeking\b/i,
  /\bifk-trupp/i,
  /\bifk-spelare/i,
  /\bifk-tr[aä]nare/i,
];

function decodeXml(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(value) {
  return decodeXml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSummary(value, title = "") {
  let summary = stripHtml(value);
  summary = summary
    .replace(/^inlaget\s+.+\s+dok\s+forst\s+upp\s+pa\s+.+$/i, "")
    .replace(/^Inlägget\s+.+\s+dök\s+först\s+upp\s+på\s+.+$/i, "")
    .trim();

  if (!summary || normalize(summary) === normalize(title)) {
    return "";
  }

  return summary.slice(0, 400);
}

function articleIdBase(raw, idPrefix) {
  const url = String(raw.articleUrl || "").trim();
  try {
    const parsed = new URL(url);
    const pathSlug = slugify(parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean).slice(-2).join("-"));
    if (pathSlug) return pathSlug.slice(0, 96);
  } catch (_) {
    // ignore invalid URLs and fall through
  }

  const fromGuid = slugify(raw.guid || "").slice(0, 96);
  if (fromGuid && !fromGuid.startsWith("https-") && !fromGuid.startsWith("http-")) {
    return fromGuid;
  }

  return slugify(raw.title || `${idPrefix}-item`).slice(0, 96);
}

function readTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function readLink(block) {
  const tagged = readTag(block, "link");
  if (tagged) return stripHtml(tagged);

  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atom) return atom[1].trim();

  const bare = block.match(/<link[^>]*>(https?:\/\/[^<\s]+)/i);
  return bare ? bare[1].trim() : "";
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalize(value).replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}

function toIsoDate(value) {
  if (value == null || value === "") return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  const asString = String(value).trim();
  const dotNet = asString.match(/\/Date\((-?\d+)(?:[+-]\d+)?\)\//);
  if (dotNet) {
    return new Date(Number(dotNet[1])).toISOString();
  }

  const date = new Date(asString);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString();
}

function seasonIncludes(seasons, year) {
  return String(seasons || "")
    .split(",")
    .map((season) => season.trim())
    .some((season) => season === String(year) || season.startsWith(`${year}/`) || season.startsWith(`${year}-`));
}

function parseRssCategories(block) {
  return [...String(block || "").matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter(Boolean);
}

function parseRssItems(xml) {
  return [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => {
    const block = match[1];
    return {
      title: stripHtml(readTag(block, "title")),
      summary: stripHtml(readTag(block, "description") || readTag(block, "content:encoded")),
      articleUrl: readLink(block),
      guid: stripHtml(readTag(block, "guid")),
      publishedAt: toIsoDate(readTag(block, "pubDate") || readTag(block, "dc:date")),
      categories: parseRssCategories(block),
    };
  });
}

const TEAM_SIDE_TAGS = new Set(["Dam", "Herr"]);

function countPatternHits(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function extractNtPageTeamSide(html) {
  const text = String(html || "");
  if (!text) return null;

  const damHits = (text.match(/(?:organisation|story)\/ifk-norrkoping-dam/gi) || []).length;
  const herrHits = (text.match(/(?:organisation|story)\/ifk-norrkoping-herr/gi) || []).length;
  if (damHits > 0 && herrHits === 0) return "Dam";
  if (herrHits > 0 && damHits === 0) return "Herr";
  if (damHits > herrHits) return "Dam";
  if (herrHits > damHits) return "Herr";

  // Visible section labels on NT article pages, e.g. "IFK Norrköping herr".
  const hasDamLabel = /IFK Norrk[oö]ping\s+Dam\b/i.test(text);
  const hasHerrLabel = /IFK Norrk[oö]ping\s+[Hh]err\b/i.test(text);
  if (hasDamLabel && !hasHerrLabel) return "Dam";
  if (hasHerrLabel && !hasDamLabel) return "Herr";

  return null;
}

function teamSideFromCategoryLabel(category) {
  const value = normalize(category);
  if (!value) return null;
  if (value === "dam" || value === "herr") return value === "dam" ? "Dam" : "Herr";
  if (/\bdamallsvenskan\b/.test(value)) return "Dam";
  if (/\bifk norrkoping dam\b/.test(value) || /\bnorrkoping dam\b/.test(value)) return "Dam";
  if (/\bifk norrkoping herr\b/.test(value) || /\bnorrkoping herr\b/.test(value)) return "Herr";
  return null;
}

function detectTeamSide({ title = "", summary = "", articleUrl = "", categories = [], players = [] } = {}) {
  const categorySides = [...new Set(
    (categories || [])
      .map((category) => teamSideFromCategoryLabel(category))
      .filter(Boolean)
  )];
  if (categorySides.length === 1) return categorySides[0];

  const titleText = String(title || "");
  if (/^\s*dam\b/i.test(titleText) || /\bdam\s*[:\-–]/i.test(titleText)) return "Dam";
  if (/^\s*herr\b/i.test(titleText) || /\bherr\s*[:\-–]/i.test(titleText)) return "Herr";

  const haystack = `${title}\n${summary}\n${articleUrl}\n${(categories || []).join("\n")}`;
  const normalized = ` ${normalize(haystack)} `;

  const damHits = countPatternHits(normalized, [
    /\bdamallsvenskan\b/,
    /\bobos damallsvenskan\b/,
    /\bdamlaget\b/,
    /\bdamlag\b/,
    /\bifk dam\b/,
    /\bnorrkoping dam\b/,
    /\bdam\s*(?:fotboll|trupp|match|spelare|tranare)\b/,
  ]);
  const herrHits = countPatternHits(normalized, [
    /\bsuperettan\b/,
    /\ballsvenskan\b/,
    /\bherrlaget\b/,
    /\bherrlag\b/,
    /\bifk herr\b/,
    /\bnorrkoping herr\b/,
    /\bherr\s*(?:fotboll|trupp|match|spelare|tranare)\b/,
  ]);

  if (damHits > herrHits) return "Dam";
  if (herrHits > damHits) return "Herr";

  // Roster side (Dam/Herr) when text cues are tied or absent.
  const rosterSides = [
    ...new Set(
      (players || [])
        .map((player) => player.side)
        .filter((side) => side === "Dam" || side === "Herr")
    ),
  ];
  if (rosterSides.length === 1) return rosterSides[0];

  // Legacy: mentioned players without side => weak Herr when no dam text cues.
  if (Array.isArray(players) && players.length > 0 && damHits === 0 && rosterSides.length === 0) {
    return "Herr";
  }

  return null;
}

function withTeamSideTag(tags, side) {
  const base = (Array.isArray(tags) ? tags : []).filter((tag) => !TEAM_SIDE_TAGS.has(tag));
  if (side === "Dam" || side === "Herr") base.push(side);
  return base;
}

const OPPONENT_STOPWORDS = new Set([
  "kan", "och", "i", "for", "den", "det", "som", "med", "till", "fran", "mot",
  "matchen", "truppen", "laget", "spelarna", "folj", "direkt", "live", "kring",
  "infor", "efter", "under", "over", "motstandaren", "borta", "hemma",
]);

function cleanOpponentCandidate(raw) {
  const tokens = String(raw || "")
    .replace(/\b(sk|if|ik|fc|bk|ff|united|fotboll)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .filter((token) => !OPPONENT_STOPWORDS.has(token));

  if (tokens.length === 0) return "";
  if (tokens[0] === "ifk" || tokens[0] === "norrkoping") return "";
  // Prefer a single club token; allow a second only when it is not noise.
  const opponent = tokens.slice(0, tokens[1] && tokens[1].length > 2 ? 2 : 1).join(" ");
  // For cross-linking, also expose the primary token (hammarby, ljungskile, ...).
  return opponent;
}

function extractOpponentKeys(...parts) {
  const keys = new Set();
  const patterns = [
    /\bmot\s+([a-z0-9]+(?:\s+[a-z0-9]+)?)/g,
    /\bifk(?:\s+norrkoping)?\s*[-–]\s*([a-z0-9]+(?:\s+[a-z0-9]+)?)/g,
    /\b([a-z0-9]+(?:\s+[a-z0-9]+)?)\s*[-–]\s*ifk(?:\s+norrkoping)?\b/g,
  ];

  for (const part of parts) {
    const normalized = normalize(part);
    if (!normalized) continue;
    for (const pattern of patterns) {
      for (const match of normalized.matchAll(pattern)) {
        const opponent = cleanOpponentCandidate(match[1]);
        if (!opponent || opponent.length < 3) continue;
        keys.add(opponent);
        keys.add(opponent.split(" ")[0]);
      }
    }
  }

  return [...keys];
}

function dayKey(publishedAt) {
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function enrichTeamSideTags(items) {
  const list = Array.isArray(items) ? items : [];
  const firstPass = list.map((item) => {
    const side = detectTeamSide({
      title: item.title,
      summary: item.summary,
      articleUrl: item.articleUrl,
      categories: item.categories,
      players: item.players,
    });
    return {
      ...item,
      tags: withTeamSideTag(item.tags, side),
      _teamSide: side,
    };
  });

  const sideByDayOpponent = new Map();
  for (const item of firstPass) {
    if (!item._teamSide) continue;
    const day = dayKey(item.publishedAt);
    if (!day) continue;
    for (const opponent of extractOpponentKeys(item.title, item.summary)) {
      const key = `${day}|${opponent}`;
      const existing = sideByDayOpponent.get(key);
      if (!existing) sideByDayOpponent.set(key, item._teamSide);
      else if (existing !== item._teamSide) sideByDayOpponent.set(key, "conflict");
    }
  }

  return firstPass.map((item) => {
    let side = item._teamSide;
    if (!side) {
      const day = dayKey(item.publishedAt);
      const opponents = extractOpponentKeys(item.title, item.summary);
      const inferred = [...new Set(
        opponents
          .map((opponent) => sideByDayOpponent.get(`${day}|${opponent}`))
          .filter((value) => value === "Dam" || value === "Herr")
      )];
      if (inferred.length === 1) side = inferred[0];
    }

    const { _teamSide, ...rest } = item;
    return {
      ...rest,
      tags: withTeamSideTag(rest.tags, side),
    };
  });
}

function hasClubSignal(text, patterns = DEFAULT_CLUB_PATTERNS) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return patterns.some((pattern) => pattern.test(value));
}

function hasLooseIfkSignal(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  if (normalized.includes("ifk norrkoping") || normalized.includes("peking")) return true;
  if (/\bifk\b/.test(normalized) && normalized.includes("norrkoping")) return true;
  return /(?:^|\s)ifk-(?:trupp|spelare|tranare|malvakt|back|mittfaltare|forward)/.test(
    ` ${normalized.replace(/\s+/g, " ")} `
  );
}

function mentionsSeasonPlayer(text, players, year) {
  if (!Array.isArray(players) || players.length === 0) return false;
  const normalizedText = ` ${normalize(text)} `;
  return players
    .filter((player) => seasonIncludes(player.seasons, year))
    .some((player) => {
      const name = player.normalizedName || normalize(player.name);
      return name && normalizedText.includes(` ${name} `);
    });
}

function passesSourceFilter(item, filterMode, options = {}) {
  const title = item?.title || "";
  const summary = item?.summary || "";
  const url = item?.articleUrl || "";
  const haystack = `${title}\n${summary}\n${url}`;
  const year = Number(options.year) || new Date().getFullYear();
  const players = options.players || [];

  switch (filterMode) {
    case "all":
      return true;
    case "club":
      return (
        hasClubSignal(haystack) ||
        hasLooseIfkSignal(haystack) ||
        mentionsSeasonPlayer(`${title} ${summary}`, players, year)
      );
    case "nt-sport-ifk": {
      const isFootball = /\/sport\/fotboll\//i.test(url);
      if (!isFootball) return false;
      return (
        hasClubSignal(haystack) ||
        hasLooseIfkSignal(`${title} ${summary}`) ||
        /\bifk\b/i.test(title) ||
        // NT often writes about IFK players without saying "IFK" in title/ingress.
        mentionsSeasonPlayer(`${title} ${summary}`, players, year)
      );
    }
    default:
      return (
        hasClubSignal(haystack) ||
        hasLooseIfkSignal(haystack) ||
        mentionsSeasonPlayer(`${title} ${summary}`, players, year)
      );
  }
}

function findMentionedPlayers(text, players, year) {
  const normalizedText = ` ${normalize(text)} `;
  return players
    .filter((player) => seasonIncludes(player.seasons, year))
    .filter((player) => normalizedText.includes(` ${player.normalizedName} `))
    .slice(0, 8)
    .map((player) => ({
      name: player.name,
      slug: player.slug,
      side: player.side === "Dam" || player.side === "Herr" ? player.side : undefined,
      relation: Number(year) === new Date().getFullYear() ? "current" : "season",
      currentSeason: Number(year) === new Date().getFullYear() ? Number(year) : undefined,
      seasons: [Number(year)],
    }))
    .map((player) => Object.fromEntries(Object.entries(player).filter(([, value]) => value !== undefined)));
}

function buildRelevance({ sourceType, title, summary, articleUrl, players }) {
  const matchedBy = ["Originalkälla"];
  let score = 70;
  let level = "medium";
  const url = articleUrl || "";

  if (sourceType === "official") {
    matchedBy.push("Officiell klubbkälla");
    score = 100;
    level = "high";
  } else if (sourceType === "podcast") {
    matchedBy.push("IFK-podd");
    score = 90;
    level = "high";
  } else if (sourceType === "local") {
    matchedBy.push("Lokal originalkälla");
    score = 88;
    level = "high";
  }

  if (hasClubSignal(title) || hasLooseIfkSignal(title)) {
    matchedBy.push("IFK i rubrik");
    score = Math.max(score, 92);
    level = "high";
  } else if (hasClubSignal(summary) || hasLooseIfkSignal(summary)) {
    matchedBy.push("IFK i ingress");
    score = Math.max(score, 78);
    if (level !== "high") level = "medium";
  } else if (hasClubSignal(url) || hasLooseIfkSignal(url)) {
    matchedBy.push("IFK i artikel-URL");
    score = Math.max(score, 76);
    if (level !== "high") level = "medium";
  }

  if (players.length > 0) {
    matchedBy.push("Kopplad spelare");
    score = Math.min(100, score + 4);
    level = "high";
  }

  return {
    level,
    score,
    matchedBy: [...new Set(matchedBy)],
  };
}

function toNewsItem(raw, sourceConfig, players) {
  const title = stripHtml(raw.title);
  const summary = cleanSummary(raw.summary, title);
  const articleUrl = String(raw.articleUrl || "").trim();
  const publishedAt = toIsoDate(raw.publishedAt);
  if (!title || !articleUrl || !publishedAt) return null;

  const year = new Date(publishedAt).getFullYear();
  if (
    !passesSourceFilter(
      { title, summary, articleUrl },
      sourceConfig.filter || "club",
      { players, year }
    )
  ) {
    return null;
  }

  const mentionedPlayers = findMentionedPlayers(`${title} ${summary}`, players, year);
  const idBase = articleIdBase(raw, sourceConfig.idPrefix);
  const categories = Array.isArray(raw.categories) ? raw.categories : [];
  const teamSide = detectTeamSide({
    title,
    summary,
    articleUrl,
    categories,
    players: mentionedPlayers,
  });

  return {
    id: `${sourceConfig.idPrefix}-${idBase}`,
    title,
    summary: summary || title,
    source: sourceConfig.name,
    sourceUrl: sourceConfig.sourceUrl,
    articleUrl,
    publishedAt,
    category: sourceConfig.category || "Nyhet",
    tags: withTeamSideTag(sourceConfig.tags || ["Extern originalkälla"], teamSide),
    keywords: sourceConfig.keywords || ["IFK Norrköping"],
    access: sourceConfig.access || { type: "free", label: "Fri läsning" },
    relevance: buildRelevance({
      sourceType: sourceConfig.sourceType,
      title,
      summary,
      articleUrl,
      players: mentionedPlayers,
    }),
    players: mentionedPlayers,
    leaders: [],
    matches: [],
    categories,
    fetchedAt: new Date().toISOString(),
    fetchSource: sourceConfig.idPrefix,
  };
}

function dedupeByArticleUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.articleUrl || item.id || "")
      .replace(/\?utm_[^#]+/i, "")
      .replace(/#.*$/, "")
      .toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByPublishedDesc(items) {
  return [...items].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
}

module.exports = {
  DEFAULT_CLUB_PATTERNS,
  decodeXml,
  stripHtml,
  cleanSummary,
  articleIdBase,
  readTag,
  readLink,
  normalize,
  slugify,
  toIsoDate,
  seasonIncludes,
  parseRssCategories,
  parseRssItems,
  hasClubSignal,
  hasLooseIfkSignal,
  mentionsSeasonPlayer,
  passesSourceFilter,
  findMentionedPlayers,
  buildRelevance,
  extractNtPageTeamSide,
  teamSideFromCategoryLabel,
  detectTeamSide,
  withTeamSideTag,
  extractOpponentKeys,
  enrichTeamSideTags,
  toNewsItem,
  dedupeByArticleUrl,
  sortByPublishedDesc,
};
