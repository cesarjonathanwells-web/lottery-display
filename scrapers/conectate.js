const { fetchPage } = require('./http');
const { cachedFetch, padNumbers, log } = require('./utils');

const PAGE_URL = 'https://www.conectate.com.do/loterias/';
const API_BASE = 'https://api.conectate.com.do/conectate';
const SITE_URL = `${API_BASE}/sites/env`;
const SESSIONS_URL = `${API_BASE}/sessions`;
const DOMINICAN_TIMEZONE = 'America/Santo_Domingo';

const _cache = new Map();
const CACHE_TTL = 30000;

function getDominicanToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: DOMINICAN_TIMEZONE });
}

function toDominicanMidnightIso(dateStr) {
  return `${dateStr}T04:00:00.000Z`;
}

function normalizeApiDate(dateRaw) {
  if (!dateRaw) return null;
  const date = new Date(dateRaw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-CA', { timeZone: DOMINICAN_TIMEZONE });
}

function flattenScore(score) {
  const numbers = [];

  function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (value === null || value === undefined) return;
    const number = String(value).trim().replace(/^\+/, '');
    if (number) numbers.push(number);
  }

  walk(score);
  return numbers;
}

function findSessionForDate(sessionRecord, dateStr) {
  if (!sessionRecord) return null;

  const sessions = Array.isArray(sessionRecord.sessions) ? sessionRecord.sessions : [];
  const found = sessions.find(session => normalizeApiDate(session.date) === dateStr);
  if (found) return found;

  const lastSession = sessionRecord.lastSession;
  if (lastSession && normalizeApiDate(lastSession.date) === dateStr) return lastSession;

  return null;
}

function hasClosedMarker(siteGame, dateStr) {
  const skips = siteGame && siteGame.game && Array.isArray(siteGame.game.skips)
    ? siteGame.game.skips
    : [];
  return skips.some(skip => normalizeApiDate(skip.date) === dateStr);
}

function addGameResult(results, siteGame, sessionRecord, dateStr) {
  if (!siteGame || !siteGame.title) return;

  const session = findSessionForDate(sessionRecord, dateStr);
  const closed = hasClosedMarker(siteGame, dateStr) || Boolean(session && session.reason);
  const numbers = session ? flattenScore(session.score) : [];
  const date = session ? normalizeApiDate(session.date) : dateStr;

  if (numbers.length > 0 || closed) {
    results[siteGame.title] = { numbers, date, closed };
  }
}

function collectApiResults(site, sessionRows, dateStr) {
  const results = {};
  const sessionsByGameId = new Map();

  if (Array.isArray(sessionRows)) {
    sessionRows.forEach(row => {
      if (row && row.game_id) sessionsByGameId.set(row.game_id, row);
    });
  }

  for (const company of site && Array.isArray(site.siteCompanies) ? site.siteCompanies : []) {
    for (const siteGame of Array.isArray(company.siteGames) ? company.siteGames : []) {
      addGameResult(results, siteGame, sessionsByGameId.get(siteGame.game_id), dateStr);
    }
  }

  return results;
}

async function fetchGames(url) {
  url = url || PAGE_URL;
  const dateStr = getDominicanToday();
  const sessionsUrl = `${SESSIONS_URL}?date=${encodeURIComponent(toDominicanMidnightIso(dateStr))}`;
  const cacheKey = `${url}|${dateStr}`;

  return cachedFetch(_cache, cacheKey, CACHE_TTL, async () => {
    const [site, sessionRows] = await Promise.all([
      fetchPage(SITE_URL),
      fetchPage(sessionsUrl)
    ]);

    return collectApiResults(site, sessionRows, dateStr);
  });
}

function findGame(gameName, allGames) {
  if (allGames[gameName]) return allGames[gameName];
  const key = Object.keys(allGames).find(k =>
    k.toLowerCase().includes(gameName.toLowerCase()) ||
    gameName.toLowerCase().includes(k.toLowerCase())
  );
  return key ? allGames[key] : null;
}

function splitDigits(numbers, pick3Count, pick4Count) {
  const allSingleDigit = numbers.every(n => n.length === 1);
  if (allSingleDigit && numbers.length >= pick3Count + pick4Count) {
    return [...numbers.slice(0, pick3Count), '-', ...numbers.slice(pick3Count, pick3Count + pick4Count)];
  }
  const digits = numbers.join('').split('');
  if (digits.length >= pick3Count + pick4Count - 1) {
    return [...digits.slice(0, pick3Count), '-', ...digits.slice(pick3Count, pick3Count + pick4Count)];
  }
  return numbers;
}

function formatNumbers(numbers, format) {
  if (format === 'pick3') {
    return padNumbers(numbers.slice(0, 3));
  }
  if (format === 'pick34') {
    // If source provides 3 two-digit numbers, it only has pick3 (quiniela) — return as-is
    const allTwoDigit = numbers.every(n => n.length === 2);
    if (allTwoDigit && numbers.length === 3) {
      return numbers;
    }
    return splitDigits(numbers, 3, 4);
  }
  if (format === 'florida') {
    const digits = numbers.join('').split('');
    if (digits.length >= 6) {
      return [
        digits[0], digits[1], '-',
        digits[2], digits[3], digits[4], '-',
        digits[5], digits[6] || '0', digits[7] || '0', digits[8] || '0'
      ];
    }
    return numbers;
  }
  return numbers;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const url = scraperConfig.pageUrl
    ? 'https://www.conectate.com.do' + scraperConfig.pageUrl
    : PAGE_URL;
  const allGames = await fetchGames(url);

  // Combined pick3+pick4 mode (e.g. King Lottery)
  if (drawConfig.pick3Name && drawConfig.pick4Name) {
    const p3game = findGame(drawConfig.pick3Name, allGames);
    const p4game = findGame(drawConfig.pick4Name, allGames);

    if (!p3game && !p4game) return null;
    if ((p3game && p3game.closed) || (p4game && p4game.closed)) {
      return { numbers: null, date: (p3game || p4game).date || getDominicanToday(), closed: true };
    }

    const p3 = p3game && p3game.numbers.length > 0 ? p3game.numbers : null;
    const p4 = p4game && p4game.numbers.length > 0 ? p4game.numbers : null;
    if (!p3 && !p4) return null;

    const numbers = [];
    if (p3) numbers.push(...p3);
    if (p4) { numbers.push('-'); numbers.push(...p4); }

    const date = (p3game && p3game.date) || (p4game && p4game.date) || null;
    log(`${scraperConfig.lotteryId} "${drawConfig.time}" source date: ${date}`);
    return { numbers, date, closed: false };
  }

  // Single game mode
  const game = findGame(drawConfig.gameName, allGames);

  if (!game) return null;
  if (game.closed) return { numbers: null, date: game.date || getDominicanToday(), closed: true };
  if (!game.numbers || game.numbers.length === 0) return null;

  const format = scraperConfig.format || 'pick3';
  const numbers = formatNumbers(game.numbers, format);
  log(`${scraperConfig.lotteryId} "${drawConfig.gameName || drawConfig.time}" source date: ${game.date}`);
  return { numbers, date: game.date, closed: false };
}

module.exports = { scrapeDraw };
