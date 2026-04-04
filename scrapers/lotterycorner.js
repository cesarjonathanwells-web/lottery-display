const cheerio = require('cheerio');
const { fetchPage } = require('./http');

const BASE_URL = 'https://www.lotterycorner.com';

const GAME_URLS = {
  'ny:pick3:midday': '/ny/numbers-midday', 'ny:pick3:evening': '/ny/numbers-evening',
  'ny:pick4:midday': '/ny/win-4-midday', 'ny:pick4:evening': '/ny/win-4-evening',
  'fl:pick2:midday': '/fl/pick-2-midday', 'fl:pick2:evening': '/fl/pick-2-evening',
  'fl:pick3:midday': '/fl/pick-3-midday', 'fl:pick3:evening': '/fl/pick-3-evening',
  'fl:pick4:midday': '/fl/pick-4-midday', 'fl:pick4:evening': '/fl/pick-4-evening',
  'ga:pick3:midday': '/ga/cash-3-midday', 'ga:pick3:evening': '/ga/cash-3-evening', 'ga:pick3:night': '/ga/cash-3-night',
  'ga:pick4:midday': '/ga/cash-4-midday', 'ga:pick4:evening': '/ga/cash-4-evening', 'ga:pick4:night': '/ga/cash-4-night',
  'nj:pick3:midday': '/nj/pick-3-midday', 'nj:pick3:evening': '/nj/pick-3-evening',
  'nj:pick4:midday': '/nj/pick-4-midday', 'nj:pick4:evening': '/nj/pick-4-evening',
  'ct:pick3:day': '/ct/play3-day', 'ct:pick3:night': '/ct/play3-night',
  'ct:pick4:day': '/ct/play4-day', 'ct:pick4:night': '/ct/play4-night',
};

const DIGIT_COUNT = { pick2: 2, pick3: 3, pick4: 4 };

// Cache fetched pages for 30s
const _cache = {};
const CACHE_TTL = 30000;

/** Fetch latest result for a single game. */
async function fetchGame(gameKey) {
  const path = GAME_URLS[gameKey];
  if (!path) return null;

  const url = BASE_URL + path;
  const now = Date.now();
  if (_cache[url] && (now - _cache[url].time) < CACHE_TTL) return _cache[url].data;

  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const card = $('.c-lottery-card').first();
    if (!card.length) return null;

    const allNums = [];
    card.find('.c-lottery-numbers .number').each((_, el) => {
      if (!$(el).hasClass('highlighted')) allNums.push($(el).text().trim());
    });

    const count = DIGIT_COUNT[gameKey.split(':')[1]] || 3;
    const digits = allNums.slice(0, count);
    const dateText = card.find('.card-body p').first().text().trim();

    if (digits.length < count) return null;

    const result = { digits, date: dateText };
    _cache[url] = { data: result, time: now };
    return result;
  } catch (err) {
    console.error(`[lotterycorner] Fetch error for ${gameKey}:`, err.message);
    return null;
  }
}

/** Check if result date matches today in Eastern time. */
function isToday(dateText) {
  if (!dateText) return false;
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: '2-digit', year: 'numeric'
  });
  return dateText.includes(today);
}

/** Scrape Pick 3 + Pick 4 for a draw session, return combined numbers. */
async function scrapeDraw(state, session, format) {
  if (format === 'florida') {
    const [p2, p3, p4] = await Promise.all([
      fetchGame(`${state}:pick2:${session}`),
      fetchGame(`${state}:pick3:${session}`),
      fetchGame(`${state}:pick4:${session}`)
    ]);
    if (!p2 && !p3 && !p4) return null;
    if (![p2, p3, p4].some(r => r && isToday(r.date))) return null;

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
  if (![p3, p4].some(r => r && isToday(r.date))) return null;

  const numbers = [];
  if (p3) numbers.push(...p3.digits);
  if (p4) { numbers.push('-'); numbers.push(...p4.digits); }
  return { numbers };
}

module.exports = { scrapeDraw, fetchGame, GAME_URLS };
