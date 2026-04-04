const cheerio = require('cheerio');
const { fetchPage } = require('./http');

const BASE_URL = 'https://lotterycoast.com/lottery-results';

// One page per state, all games + midday/evening on the same page
const STATE_URLS = {
  ny: `${BASE_URL}/new-york/`,
  fl: `${BASE_URL}/florida/`,
  ga: `${BASE_URL}/georgia/`,
  nj: `${BASE_URL}/new-jersey/`,
  ct: `${BASE_URL}/connecticut/`
};

// Game label mapping: what the strong.fs-6 text contains -> our game key
const GAME_MAP = {
  ny: {
    midday: { pick3: 'Numbers Midday', pick4: 'Win 4 Midday' },
    evening: { pick3: 'Numbers Evening', pick4: 'Win 4 Evening' }
  },
  fl: {
    midday: { pick2: 'Pick 2 Midday', pick3: 'Pick 3 Midday', pick4: 'Pick 4 Midday' },
    evening: { pick2: 'Pick 2 Evening', pick3: 'Pick 3 Evening', pick4: 'Pick 4 Evening' }
  },
  ga: {
    midday: { pick3: 'Cash 3 Midday', pick4: 'Cash 4 Midday' },
    evening: { pick3: 'Cash 3 Evening', pick4: 'Cash 4 Evening' },
    night: { pick3: 'Cash 3 Night', pick4: 'Cash 4 Night' }
  },
  nj: {
    midday: { pick3: 'Pick 3 Midday', pick4: 'Pick 4 Midday' },
    evening: { pick3: 'Pick 3 Evening', pick4: 'Pick 4 Evening' }
  },
  ct: {
    day: { pick3: 'Play 3 Day', pick4: 'Play 4 Day' },
    night: { pick3: 'Play 3 Night', pick4: 'Play 4 Night' }
  }
};

// Cache per state page (30s)
const _cache = {};
const CACHE_TTL = 30000;

/**
 * Scrape a state page and return all draw results as a map.
 * Returns: { "Numbers Midday": ["9","5","6"], "Win 4 Evening": ["8","9","2","1"], ... }
 */
async function scrapeState(state) {
  const url = STATE_URLS[state];
  if (!url) return {};

  const now = Date.now();
  if (_cache[state] && (now - _cache[state].time) < CACHE_TTL) return _cache[state].data;

  try {
    const html = await fetchPage(url);
    const $ = cheerio.load(html);
    const results = {};

    // Each draw row is div.row.my-3 containing label + digits
    $('div.row.my-3').each((_, row) => {
      const label = $(row).find('strong.fs-6').text().trim();
      if (!label) return;

      const digits = [];
      $(row).find('span.draw-digit').not('.bg-gradient-warning').each((_, d) => {
        digits.push($(d).text().trim());
      });

      if (digits.length > 0) {
        results[label] = digits;
      }
    });

    // Get the date from the page
    const dateEl = $('time[datetime]').first();
    const dateStr = dateEl.attr('datetime') || '';
    results._date = dateStr; // "2026-04-03"

    _cache[state] = { data: results, time: now };
    return results;
  } catch (err) {
    console.error(`[lotterycoast] Scrape error for ${state}:`, err.message);
    return _cache[state]?.data || {};
  }
}

/**
 * Check if the scraped date matches today (EST).
 */
function isToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // "2026-04-03"
  return dateStr === today;
}

/**
 * Scrape a specific draw for a state, returning combined pick3+pick4 numbers.
 * @param {string} state - "ny", "fl", "ga", "nj", "ct"
 * @param {string} session - "midday", "evening", "night", "day"
 * @param {string} format - "pick34" or "florida"
 */
async function scrapeDraw(state, session, format) {
  const data = await scrapeState(state);
  if (!data._date || !isToday(data._date)) return null;

  const gameMap = GAME_MAP[state]?.[session];
  if (!gameMap) return null;

  if (format === 'florida') {
    const p2 = gameMap.pick2 ? data[gameMap.pick2] : null;
    const p3 = gameMap.pick3 ? data[gameMap.pick3] : null;
    const p4 = gameMap.pick4 ? data[gameMap.pick4] : null;
    if (!p2 && !p3 && !p4) return null;

    const numbers = [];
    if (p2) numbers.push(...p2);
    if (p3) { if (numbers.length) numbers.push('-'); numbers.push(...p3); }
    if (p4) { if (numbers.length) numbers.push('-'); numbers.push(...p4); }
    return { numbers };
  }

  // pick34: pick3 + pick4
  const p3 = gameMap.pick3 ? data[gameMap.pick3] : null;
  const p4 = gameMap.pick4 ? data[gameMap.pick4] : null;
  if (!p3 && !p4) return null;

  const numbers = [];
  if (p3) numbers.push(...p3);
  if (p4) { numbers.push('-'); numbers.push(...p4); }
  return { numbers };
}

module.exports = { scrapeDraw, scrapeState, STATE_URLS };
