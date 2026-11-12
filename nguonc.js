/*
 * NguonC Provider for Nuvio v1.2.0
 * Uses Nuvio-injected TMDB_API_KEY; no key is stored in this repository.
 * Resolves NguonC episode embeds through the public NguonC Resolver endpoint.
 */

const NGUONC_API = "https://phim.nguonc.com/api";
const RESOLVER = "https://nguonc-resolver.onrender.com";
const PROVIDER_ID = "nguonc";
const PROVIDER_NAME = "NguonC";

// Small in-memory TTL cache. It speeds up episode changes while the Nuvio
// provider runtime stays alive. Nothing is persisted and expiring media URLs
// are deliberately NOT cached.
const CACHE = new Map();
const IN_FLIGHT = new Map();
const CACHE_LIMIT = 80;

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    CACHE.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  if (CACHE.size >= CACHE_LIMIT) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey !== undefined) CACHE.delete(firstKey);
  }
  CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function cached(key, ttlMs, loader) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key);

  const task = (async () => {
    try {
      const value = await loader();
      if (value !== undefined && value !== null) cacheSet(key, value, ttlMs);
      return value;
    } finally {
      IN_FLIGHT.delete(key);
    }
  })();

  IN_FLIGHT.set(key, task);
  return task;
}

const TTL = {
  tmdb: 6 * 60 * 60 * 1000,
  search: 15 * 60 * 1000,
  detail: 15 * 60 * 1000,
  mapping: 60 * 60 * 1000
};

function getTmdbKey() {
  try {
    if (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) return String(TMDB_API_KEY);
  } catch (_) {}
  try {
    if (typeof globalThis !== "undefined" && globalThis.TMDB_API_KEY) {
      return String(globalThis.TMDB_API_KEY);
    }
  } catch (_) {}
  return "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractYear(value) {
  const m = String(value || "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : 0;
}

async function getJson(url, headers, ttlMs) {
  const load = async () => {
    const response = await fetch(url, {
      method: "GET",
      headers: Object.assign({ "Accept": "application/json" }, headers || {})
    });
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
    return response.json();
  };

  // Only cache metadata GETs. Resolver/media URLs are never passed here.
  if (!ttlMs) return load();
  return cached("json:" + url, ttlMs, load);
}

function cleanContentId(contentId) {
  return String(contentId || "")
    .replace(/^tmdb:/i, "")
    .replace(/^movie:/i, "")
    .replace(/^tv:/i, "")
    .replace(/^series:/i, "")
    .trim();
}

async function getTmdbInfo(contentId, mediaType, apiKey) {
  const raw = cleanContentId(contentId);
  const type = mediaType === "movie" ? "movie" : "tv";

  if (/^tt\d+$/i.test(raw)) {
    const found = await getJson(
      "https://api.themoviedb.org/3/find/" + encodeURIComponent(raw) +
      "?external_source=imdb_id&api_key=" + encodeURIComponent(apiKey),
      null,
      TTL.tmdb
    );
    const list = type === "movie" ? (found.movie_results || []) : (found.tv_results || []);
    const first = list[0];
    if (!first) return null;
    return {
      id: first.id,
      type,
      title: first.title || first.name || "",
      originalTitle: first.original_title || first.original_name || "",
      year: extractYear(first.release_date || first.first_air_date),
      imdbId: raw
    };
  }

  if (!/^\d+$/.test(raw)) return null;

  const details = await getJson(
    "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(raw) +
    "?api_key=" + encodeURIComponent(apiKey)
  );
  let imdbId = "";
  try {
    const ext = await getJson(
      "https://api.themoviedb.org/3/" + type + "/" + encodeURIComponent(raw) +
      "/external_ids?api_key=" + encodeURIComponent(apiKey),
      null,
      TTL.tmdb
    );
    imdbId = ext.imdb_id || "";
  } catch (_) {}

  return {
    id: Number(raw),
    type,
    title: details.title || details.name || "",
    originalTitle: details.original_title || details.original_name || "",
    year: extractYear(details.release_date || details.first_air_date),
    imdbId
  };
}

async function searchNguonC(keyword) {
  if (!keyword) return [];
  const data = await getJson(
    NGUONC_API + "/films/search?keyword=" + encodeURIComponent(keyword) + "&page=1",
    null,
    TTL.search
  );
  return Array.isArray(data.items) ? data.items : [];
}

function candidateSlug(item) {
  return item && item.slug ? String(item.slug) : "";
}

async function getNguonCDetail(slug) {
  const data = await getJson(
    NGUONC_API + "/film/" + encodeURIComponent(slug),
    null,
    TTL.detail
  );
  return data && data.movie ? data.movie : null;
}

function scoreTitle(a, b) {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const xs = new Set(x.split(" "));
  const ys = new Set(y.split(" "));
  let overlap = 0;
  xs.forEach(word => { if (ys.has(word)) overlap++; });
  return overlap / Math.max(xs.size, ys.size);
}

async function findNguonCMovie(tmdbInfo) {
  const mappingKey = "mapping:" + tmdbInfo.type + ":" + tmdbInfo.id + ":" +
    (tmdbInfo.imdbId || "");
  return cached(mappingKey, TTL.mapping, async () => {
  const queries = [];
  [tmdbInfo.originalTitle, tmdbInfo.title].forEach(q => {
    if (q && !queries.includes(q)) queries.push(q);
  });

  const found = [];
  const seen = new Set();
  for (const query of queries) {
    try {
      const items = await searchNguonC(query);
      for (const item of items.slice(0, 12)) {
        const slug = candidateSlug(item);
        if (slug && !seen.has(slug)) {
          seen.add(slug);
          found.push(item);
        }
      }
    } catch (_) {}
    if (found.length >= 12) break;
  }

  if (!found.length) return null;

  let best = null;
  let bestScore = 0;
  for (const item of found.slice(0, 12)) {
    const slug = candidateSlug(item);
    if (!slug) continue;
    let movie;
    try { movie = await getNguonCDetail(slug); } catch (_) { continue; }
    if (!movie) continue;

    const tmdbMatch = tmdbInfo.id && movie.tmdb && Number(movie.tmdb.id) === Number(tmdbInfo.id);
    const imdbMatch = tmdbInfo.imdbId && movie.imdb && movie.imdb.id === tmdbInfo.imdbId;
    if (tmdbMatch || imdbMatch) return movie;

    const names = [
      movie.name,
      movie.original_name,
      item.name,
      item.origin_name,
      item.original_name
    ];
    let titleScore = 0;
    names.forEach(name => {
      titleScore = Math.max(
        titleScore,
        scoreTitle(name, tmdbInfo.title),
        scoreTitle(name, tmdbInfo.originalTitle)
      );
    });

    const movieYear = Number(movie.year || item.year || 0);
    if (tmdbInfo.year && movieYear) {
      if (tmdbInfo.year === movieYear) titleScore += 0.12;
      else if (Math.abs(tmdbInfo.year - movieYear) > 1) titleScore -= 0.2;
    }

    if (titleScore > bestScore) {
      bestScore = titleScore;
      best = movie;
    }
  }

  // Avoid returning a wrong title from a loose keyword match.
  return bestScore >= 0.82 ? best : null;
  });
}

function getEpisodeItems(movie, mediaType, episode) {
  const servers = [];
  const targetEpisode = Number(episode || 1);

  for (const server of (movie.episodes || [])) {
    for (const item of (server.items || [])) {
      if (!item.embed) continue;

      if (mediaType === "movie") {
        if (/full|movie|complete/i.test(String(item.name || "")) || (server.items || []).length === 1) {
          servers.push({ server: server.server_name || "NguonC", item });
        }
      } else {
        const itemNumber = Number((String(item.name || "").match(/\d+/) || [])[0] || 0);
        if (itemNumber === targetEpisode) {
          servers.push({ server: server.server_name || "NguonC", item });
        }
      }
    }
  }
  return servers;
}

async function getStreams(contentId, mediaType, season, episode) {
  try {
    const apiKey = getTmdbKey();
    if (!apiKey) {
      console.log("[NguonC] TMDB_API_KEY is not available in Nuvio runtime.");
      return [];
    }

    const normalizedType = mediaType === "movie" ? "movie" : "tv";
    const tmdbInfo = await getTmdbInfo(contentId, normalizedType, apiKey);
    if (!tmdbInfo) {
      console.log("[NguonC] Could not resolve TMDB metadata for", contentId);
      return [];
    }

    const movie = await findNguonCMovie(tmdbInfo);
    if (!movie || !movie.slug) {
      console.log("[NguonC] No confident NguonC match for", tmdbInfo.title);
      return [];
    }

    // NguonC currently exposes a flat episode list. Do not guess multi-season numbering.
    if (normalizedType === "tv" && Number(season || 1) !== 1) return [];

    const entries = getEpisodeItems(movie, normalizedType, episode);
    if (!entries.length) return [];

    const movieUrl = "https://phim.nguonc.com/phim/" + movie.slug;
    const output = [];

    for (const entry of entries.slice(0, 6)) {
      const resolverUrl = RESOLVER + "/resolve?embed=" +
        encodeURIComponent(entry.item.embed) +
        "&movie=" + encodeURIComponent(movieUrl);

      const serverLabel = entry.server || "NguonC";
      const episodeLabel = normalizedType === "tv"
        ? "Tập " + (episode || 1)
        : (entry.item.name || "Full");
      const qualityLabel = movie.quality || "HD";

      output.push({
        // Compact source heading, similar to Nuvio's source cards.
        name: "NguonC [" + serverLabel + "]",
title: [
  "🎬 " + (movie.name || tmdbInfo.title),
  "📺 " + episodeLabel + " · " + serverLabel,
  "💎 " + qualityLabel
].join("\n"),
url: resolverUrl,
quality: qualityLabel,
type: "hls",
language: "vi",
provider: PROVIDER_ID,
headers: {
  "Referer": movieUrl
}
      });
    }

    return output;
  } catch (error) {
    console.log("[NguonC] Provider error:", error && error.message ? error.message : String(error));
    return [];
  }
}

module.exports = { getStreams };
