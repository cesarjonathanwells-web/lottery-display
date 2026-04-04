const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.lotterycorner.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

/**
 * Game URL slugs per state. Each entry maps to a page on lotterycorner.com.
 * The key format is "{state}:{game}:{session}" matching our scraper config.
 */
const GAME_URLS = {
  // New York
  'ny:pick3:midday':   '/ny/numbers-midday',
  'ny:pick3:evening':  '/ny/numbers-evening',
  'ny:pick4:midday':   '/ny/win-4-midday',
  'ny:pick4:evening':  '/ny/win-4-evening',
  // Florida
  'fl:pick2:midday':   '/fl/pick-2-midday',
  'fl:pick2:evening':  '/fl/pick-2-evening',
  'fl:pick3:midday':   '/fl/pick-3-midday',
  'fl:pick3:evening':  '/fl/pick-3-evening',
  'fl:pick4:midday':   '/fl/pick-4-midday',
  'fl:pick4:evening':  '/fl/pick-4-evening',
  // Georgia
  'ga:pick3:midday':   '/ga/cash-3-midday',
  'ga:pick3:evening':  '/ga/cash-3-evening',
  'ga:pick3:night':    '/ga/cash-3-night',
  'ga:pick4:midday':   '/ga/cash-4-midday',
  'ga:pick4:evening':  '/ga/cash-4-evening',
  'ga:pick4:night':    '/ga/cash-4-night',
  // New Jersey
  'nj:pick3:midday':   '/nj/pick-3-midday',
  'nj:pick3:evening':  '/nj/pick-3-evening',
  'nj:pick4:midday':   '/nj/pick-4-midday',
  'nj:pick4:evening':  '/nj/pick-4-evening',
  // Connecticut
  'ct:pick3:day':      '/ct/play3-day',
  'ct:pick3:night':    '/ct/play3-night',
  'ct:pick4:day':      '/ct/play4-day',
  'ct:pick4:night':    '/ct/play4-night',
};

// Expected digit counts per game type
const DIGIT_COUNT = { pick2: 2, pick3: 3, pick4: 4 };

// Cache: store fetched pages for 30s to share across multiple games in same state
const _cache = {};
const CACHE_TTL = 30000;

/**
 * Fetch a lotterycorner page, returning the latest result's digits.
 * @param {string} gameKey - e.g. "ny:pick3:midday"
 * @returns {{ digits: string[], date: string } | null}
 */
async function fetchGame(gameKey) {
  const path = GAME_URLS[gameKey];
  if (!path) return null;

  const url = BASE_URL + path;
  const now = Date.now();

  // Check cache
  if (_cache[url] && (now - _cache[url].time) < CACHE_TTL) {
    return _cache[url].data;
  }

  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);

  // Get the FIRST .c-lottery-card (latest/hero result)
  const card = $('.c-lottery-card').first();
  if (!card.length) return null;

  // Extract all non-bonus number digits
  const allNums = [];
  card.find('.c-lottery-numbers .number').each((_, el) => {
    if (!$(el).hasClass('highlighted')) {
      allNums.push($(el).text().trim());
    }
  });

  // Extract the expected count based on game type
  const gameType = gameKey.split(':')[1]; // pick2, pick3, pick4
  const count = DIGIT_COUNT[gameType] || 3;
  const digits = allNums.slice(0, count);

  // Get date text
  const dateText = card.find('.card-body p').first().text().trim();

  if (digits.length < count) return null;

  const result = { digits, date: dateText };
  _cache[url] = { data: result, time: now };
  return result;
}

/**
 * Check if the result date matches today in US Eastern time.
 * lotterycorner dates look like: "...Fri, Apr 03, 2026"
 */
function isToday(dateText) {
  if (!dateText) return false;
  // Use Eastern timezone since all US lottery draws are EST/EDT
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: '2-digit', year: 'numeric'
  }); // "Apr 03, 2026"
  return dateText.includes(today);
}

/**
 * Scrape Pick 3 + Pick 4 for a draw session (e.g. NY midday).
 * Returns combined numbers in our format.
 *
 * @param {string} state - "ny", "fl", "ga", "nj", "ct"
 * @param {string} session - "midday", "evening", "night", "day"
 * @param {string} format - "pick34" or "florida"
 * @returns {{ numbers: string[] } | null}
 */
async function scrapeDraw(state, session, format) {
  if (format === 'florida') {
    // Florida: Pick 2 + Pick 3 + Pick 4
    const [p2, p3, p4] = await Promise.all([
      fetchGame(`${state}:pick2:${session}`),
      fetchGame(`${state}:pick3:${session}`),
      fetchGame(`${state}:pick4:${session}`)
    ]);

    if (!p2 && !p3 && !p4) return null;

    // Check if any result is from today
    const hasToday = [p2, p3, p4].some(r => r && isToday(r.date));
    if (!hasToday) return null;

    const numbers = [];
    if (p2) numbers.push(...p2.digits);
    if (p3) { if (numbers.length) numbers.push('-'); numbers.push(...p3.digits); }
    if (p4) { if (numbers.length) numbers.push('-'); numbers.push(...p4.digits); }
    return { numbers };
  }

  // pick34: Pick 3 + Pick 4
  const [p3, p4] = await Promise.all([
    fetchGame(`${state}:pick3:${session}`),
    fetchGame(`${state}:pick4:${session}`)
  ]);

  if (!p3 && !p4) return null;

  const hasToday = [p3, p4].some(r => r && isToday(r.date));
  if (!hasToday) return null;

  const numbers = [];
  if (p3) numbers.push(...p3.digits);
  if (p4) { numbers.push('-'); numbers.push(...p4.digits); }
  return { numbers };
}

module.exports = { scrapeDraw, fetchGame, GAME_URLS };
