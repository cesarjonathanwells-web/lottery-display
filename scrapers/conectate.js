const axios = require('axios');
const cheerio = require('cheerio');

const URL = 'https://www.conectate.com.do/loterias/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
};

// Cache: one fetch serves all Dominican lotteries
let _cache = null;
let _cacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

/**
 * Scrapes conectate.com.do and returns all lottery results found on the page.
 * Cached for 30s so multiple lotteries share one fetch.
 * Returns: { "Game Name": { numbers: ["27", "72", "16"], date: "03-04" }, ... }
 */
async function scrape() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) return _cache;

  const { data: html } = await axios.get(URL, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const results = {};

  $('.game-block').each((_, block) => {
    const $block = $(block);
    const titleEl = $block.find('.game-title span');
    if (!titleEl.length) return;

    const gameName = titleEl.text().trim();
    const dateEl = $block.find('.session-date');
    const date = dateEl.text().trim();

    // Check for "No Sorteo Hoy" badge
    const sessionBadge = $block.find('.session-badge').first().text().trim();
    const closed = sessionBadge === 'No Sorteo Hoy';

    // Get numbers from span.score elements (direct children of .game-scores)
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
}

/**
 * Extract results for a specific game from scraped data.
 * @param {string} gameName - The game name as shown on conectate (e.g. "Gana Más")
 * @param {object} scrapedData - Result from scrape()
 * @returns {{ numbers: string[], date: string } | null}
 */
function getGame(gameName, scrapedData) {
  // Try exact match first
  if (scrapedData[gameName]) return scrapedData[gameName];

  // Try partial match (case-insensitive)
  const key = Object.keys(scrapedData).find(k =>
    k.toLowerCase().includes(gameName.toLowerCase()) ||
    gameName.toLowerCase().includes(k.toLowerCase())
  );
  return key ? scrapedData[key] : null;
}

/**
 * Format conectate numbers into our data model format.
 * Pick3 lotteries (Nacional, La Primera, etc.): 3 two-digit numbers -> ["27", "72", "16"]
 * King Lottery (pick34): individual digits -> ["3", "2", "3", "-", "6", "8", "0", "1"]
 * NY/NJ/CT/GA (pick34 from conectate): 3 two-digit numbers -> split into digits + separator
 * Florida: 3 two-digit numbers -> split into florida format
 */
function formatNumbers(numbers, lotteryFormat) {
  if (lotteryFormat === 'pick3') {
    return numbers.slice(0, 3).map(n => n.padStart(2, '0'));
  }
  if (lotteryFormat === 'pick34') {
    // Check if numbers are already individual digits (King Lottery from conectate)
    const allSingleDigit = numbers.every(n => n.length === 1);
    if (allSingleDigit && numbers.length >= 7) {
      return [
        numbers[0], numbers[1], numbers[2],
        '-',
        numbers[3], numbers[4], numbers[5], numbers[6]
      ];
    }
    // Conectate quiniela: 3 two-digit numbers -> split first into 3 digits, rest into 4 digits
    // e.g. ["56", "56", "24"] for NY -> first number digits + separator + second/third number digits
    const allDigits = numbers.join('').split('');
    if (allDigits.length >= 6) {
      return [allDigits[0], allDigits[1], allDigits[2], '-', allDigits[3], allDigits[4], allDigits[5], allDigits[6] || '0'];
    }
    return numbers;
  }
  if (lotteryFormat === 'florida') {
    // Conectate gives 3 two-digit numbers -> split into florida format: 2-3-4 digits
    const allDigits = numbers.join('').split('');
    if (allDigits.length >= 6) {
      return [
        allDigits[0], allDigits[1], '-',
        allDigits[2], allDigits[3], allDigits[4], '-',
        allDigits[5], allDigits[6] || '0', allDigits[7] || '0', allDigits[8] || '0'
      ];
    }
    return numbers;
  }
  return numbers;
}

/**
 * Check if the scraped date matches today.
 * Conectate dates are in dd-mm format.
 */
function isToday(dateStr) {
  if (!dateStr) return false;
  const now = new Date();
  const [day, month] = dateStr.split('-').map(Number);
  return day === now.getDate() && month === (now.getMonth() + 1);
}

module.exports = { scrape, getGame, formatNumbers, isToday };
