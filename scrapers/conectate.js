const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday, getNowEST, cachedFetch, padNumbers, log } = require('./utils');

const PAGE_URL = 'https://www.conectate.com.do/loterias/';

const _cache = new Map();
const CACHE_TTL = 30000;

async function fetchGames(url) {
  url = url || PAGE_URL;

  return cachedFetch(_cache, url, CACHE_TTL, async () => {
    const html = await fetchPage(url);
    if (!html) return {};
    const $ = cheerio.load(html);
    const results = {};

    $('.game-block').each((_, block) => {
      const $block = $(block);
      const titleEl = $block.find('.game-title span');
      if (!titleEl.length) return;

      const gameName = titleEl.text().trim();
      const dateRaw = $block.find('.session-date').text().trim();
      const closed = $block.find('.session-badge').first().text().trim() === 'No Sorteo Hoy';

      const numbers = [];
      $block.find('.game-scores span.score').each((_, s) => {
        const num = $(s).text().trim();
        if (num) numbers.push(num);
      });

      // Convert dd-mm or dd-mm-yyyy to YYYY-MM-DD
      let date = null;
      if (dateRaw) {
        const parts = dateRaw.split('-').map(Number);
        if (parts.length === 2 && parts[0] && parts[1]) {
          const year = getNowEST().getFullYear();
          date = `${year}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
        } else if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
          date = `${parts[2]}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
        }
      }

      if (numbers.length > 0 || closed) {
        results[gameName] = { numbers, date, closed };
      }
    });

    return results;
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
  const game = findGame(drawConfig.gameName, allGames);

  if (!game) return null;
  if (game.closed) return { numbers: null, date: game.date || getToday(), closed: true };
  if (!game.numbers || game.numbers.length === 0) return null;

  const format = scraperConfig.format || 'pick3';
  const numbers = formatNumbers(game.numbers, format);
  log(`${scraperConfig.lotteryId} "${drawConfig.gameName || drawConfig.time}" source date: ${game.date}`);
  return { numbers, date: game.date, closed: false };
}

module.exports = { scrapeDraw };
