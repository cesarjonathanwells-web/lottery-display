const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday, getNowEST, cachedFetch, padNumbers, log } = require('./utils');

const PAGE_URL = 'https://enloteria.com';

const _cache = new Map();
const CACHE_TTL = 30000;

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};

const LOTTERY_NAMES = {
  anguilla: 'Anguilla',
  florida: 'Florida',
  georgia: 'Georgia',
  laprimera: 'La Primera',
  lasuerte: 'La Suerte',
  lotedom: 'Lotedom',
  loteka: 'Loteka',
  nacional: 'Nacional',
  newjersey: 'New Jersey',
  newyork: 'New York',
  quinielapale: 'Leidsa',
  real: 'Real'
};

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function canonicalName(name) {
  return stripAccents(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(loteria|quiniela)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTime(timeRaw) {
  const raw = cleanText(timeRaw).toUpperCase().replace(/\s+/g, '');
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = match[2] || '00';
  if (!hour || hour > 12) return null;

  return `${hour}:${minute.padStart(2, '0')} ${match[3]}`;
}

function timeToMinutes(time) {
  const normalized = normalizeTime(time);
  if (!normalized) return null;

  const match = normalized.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const period = match[3];

  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;

  return hour * 60 + minute;
}

function parseSpanishDate(dateRaw) {
  const raw = stripAccents(cleanText(dateRaw)).toLowerCase();
  const match = raw.match(/(\d{1,2})\s+de\s+([a-z]+)(?:,?\s*(\d{4}))?/i);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = MONTHS[match[2]];
  const year = match[3] || getNowEST().getFullYear();

  if (!day || !month) return null;

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseDateFromNumbersId(id) {
  const match = String(id || '').match(/_(\d{4})_(\d{2})_(\d{2})(?:_|$)/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseGames(html) {
  const $ = cheerio.load(html);
  const results = {};

  $('div.col[data-lottery-name]').each((_, block) => {
    const $block = $(block);
    const gameName = cleanText(
      $block.attr('data-lottery-name') ||
      $block.find('.lottery-name').first().text()
    );
    if (!gameName) return;

    const dateRaw = cleanText($block.find('.result-date').first().text());
    const numbersId = $block.find('.numbers').first().attr('id');
    const date = parseSpanishDate(dateRaw) || parseDateFromNumbersId(numbersId);
    const time = normalizeTime($block.find('.lottery-closing-time').first().text());

    const numbers = [];
    $block.find('.numbers .result-number').each((_, n) => {
      const num = cleanText($(n).text());
      if (num) numbers.push(num);
    });

    const closed = /no sorteo hoy/i.test($block.text());
    results[gameName] = { numbers, date, closed };
    if (time) results[gameName].time = time;
  });

  return results;
}

async function fetchGames(url) {
  url = url || PAGE_URL;

  return cachedFetch(_cache, url, CACHE_TTL, async () => {
    const html = await fetchPage(url);
    if (!html) return {};
    return parseGames(html);
  });
}

function nameMatches(gameName, candidateName) {
  const target = canonicalName(gameName);
  const candidate = canonicalName(candidateName);
  if (!target || !candidate) return false;

  return target === candidate ||
    target.includes(candidate) ||
    candidate.includes(target);
}

function matchesSession(candidateName, session) {
  if (!session) return false;

  const candidate = canonicalName(candidateName);
  if (session === 'midday' || session === 'day') {
    return /\b(dia|tarde)\b/.test(candidate);
  }
  if (session === 'evening' || session === 'night') {
    return /\bnoche\b/.test(candidate);
  }
  return false;
}

function findByTime(entries, targetTime) {
  if (!targetTime) return null;

  const normalizedTarget = normalizeTime(targetTime);
  if (!normalizedTarget) return null;

  const exact = entries.find(([, game]) => game.time === normalizedTarget);
  if (exact) return exact[1];

  const targetMinutes = timeToMinutes(normalizedTarget);
  if (targetMinutes === null) return null;

  const close = entries
    .map(([, game]) => {
      const minutes = timeToMinutes(game.time);
      return minutes === null ? null : { game, diff: Math.abs(minutes - targetMinutes) };
    })
    .filter(Boolean)
    .filter(item => item.diff <= 15)
    .sort((a, b) => a.diff - b.diff);

  return close.length ? close[0].game : null;
}

function findGame(gameName, allGames, drawConfig) {
  if (!gameName) return null;

  const entries = Object.entries(allGames);
  const matches = entries.filter(([key]) => nameMatches(gameName, key));
  const targetTime = drawConfig && drawConfig.time;

  const timed = findByTime(matches, targetTime);
  if (timed) return timed;

  if (drawConfig && drawConfig.session) {
    const sessionMatches = matches.filter(([key]) => matchesSession(key, drawConfig.session));
    const sessionTimed = findByTime(sessionMatches, targetTime);
    if (sessionTimed) return sessionTimed;
    if (sessionMatches.length === 1) return sessionMatches[0][1];
  }

  if (allGames[gameName]) return allGames[gameName];
  if (matches.length === 1) return matches[0][1];

  const exact = matches.find(([key]) => canonicalName(key) === canonicalName(gameName));
  return exact ? exact[1] : null;
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
    // If source provides 3 two-digit numbers, it only has pick3 (quiniela) -- return as-is
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

function getDefaultGameName(scraperConfig) {
  return LOTTERY_NAMES[scraperConfig.lotteryId] || scraperConfig.lotteryId;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const url = scraperConfig.pageUrl
    ? 'https://enloteria.com' + scraperConfig.pageUrl
    : PAGE_URL;
  const allGames = await fetchGames(url);

  // Combined pick3+pick4 mode (e.g. King Lottery)
  if (drawConfig.pick3Name && drawConfig.pick4Name) {
    const p3game = findGame(drawConfig.pick3Name, allGames, drawConfig);
    const p4game = findGame(drawConfig.pick4Name, allGames, drawConfig);

    if (!p3game && !p4game) return null;
    if ((p3game && p3game.closed) || (p4game && p4game.closed)) {
      return { numbers: null, date: (p3game || p4game).date || getToday(), closed: true };
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
  const gameName = drawConfig.gameName || scraperConfig.gameName || getDefaultGameName(scraperConfig);
  const game = findGame(gameName, allGames, drawConfig);

  if (!game) return null;
  if (game.closed) return { numbers: null, date: game.date || getToday(), closed: true };
  if (!game.numbers || game.numbers.length === 0) return null;

  const format = scraperConfig.format || 'pick3';
  const numbers = formatNumbers(game.numbers, format);
  log(`${scraperConfig.lotteryId} "${drawConfig.gameName || drawConfig.time}" source date: ${game.date}`);
  return { numbers, date: game.date, closed: false };
}

module.exports = { scrapeDraw };
Object.defineProperty(module.exports, 'parseGames', { value: parseGames });
