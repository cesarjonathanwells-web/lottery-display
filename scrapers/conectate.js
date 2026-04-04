const cheerio = require('cheerio');
const { fetchPage } = require('./http');

const URL = 'https://www.conectate.com.do/loterias/';

// Cache: one fetch serves all Dominican lotteries
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 30000;

/**
 * Scrapes conectate.com.do. Cached for 30s so multiple lotteries share one fetch.
 */
async function scrape() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;

  try {
    const html = await fetchPage(URL);
    const $ = cheerio.load(html);
    const results = {};

    $('.game-block').each((_, block) => {
      const $block = $(block);
      const titleEl = $block.find('.game-title span');
      if (!titleEl.length) return;

      const gameName = titleEl.text().trim();
      const date = $block.find('.session-date').text().trim();
      const closed = $block.find('.session-badge').first().text().trim() === 'No Sorteo Hoy';

      const numbers = [];
      $block.find('.game-scores span.score').each((_, s) => {
        const num = $(s).text().trim();
        if (num) numbers.push(num);
      });

      if (numbers.length > 0 || closed) {
        results[gameName] = { numbers, date, closed };
      }
    });

    _cache = results;
    _cacheTime = Date.now();
    return results;
  } catch (err) {
    console.error('[conectate] Scrape error:', err.message);
    return _cache || {};
  }
}

/** Find a game by name (exact or partial match). */
function getGame(gameName, scrapedData) {
  if (scrapedData[gameName]) return scrapedData[gameName];
  const key = Object.keys(scrapedData).find(k =>
    k.toLowerCase().includes(gameName.toLowerCase()) ||
    gameName.toLowerCase().includes(k.toLowerCase())
  );
  return key ? scrapedData[key] : null;
}

/** Format numbers into our data model based on lottery format. */
function formatNumbers(numbers, lotteryFormat) {
  if (lotteryFormat === 'pick3') {
    return numbers.slice(0, 3).map(n => n.padStart(2, '0'));
  }
  if (lotteryFormat === 'pick34') {
    const allSingleDigit = numbers.every(n => n.length === 1);
    if (allSingleDigit && numbers.length >= 7) {
      return [numbers[0], numbers[1], numbers[2], '-', numbers[3], numbers[4], numbers[5], numbers[6]];
    }
    const allDigits = numbers.join('').split('');
    if (allDigits.length >= 6) {
      return [allDigits[0], allDigits[1], allDigits[2], '-', allDigits[3], allDigits[4], allDigits[5], allDigits[6] || '0'];
    }
    return numbers;
  }
  if (lotteryFormat === 'florida') {
    const allDigits = numbers.join('').split('');
    if (allDigits.length >= 6) {
      return [allDigits[0], allDigits[1], '-', allDigits[2], allDigits[3], allDigits[4], '-', allDigits[5], allDigits[6] || '0', allDigits[7] || '0', allDigits[8] || '0'];
    }
    return numbers;
  }
  return numbers;
}

/** Check if dd-mm date matches today (EST). */
function isToday(dateStr) {
  if (!dateStr) return false;
  const now = new Date();
  const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const [day, month] = dateStr.split('-').map(Number);
  return day === estNow.getDate() && month === (estNow.getMonth() + 1);
}

module.exports = { scrape, getGame, formatNumbers, isToday };
