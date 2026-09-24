const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { hasTimePassed, isToday, cachedFetch, log } = require('./utils');

// lotteryusa.com state pages: one card per game with an explicit title, draw
// date and balls. Replaces lotterycoast.com (now behind a Cloudflare challenge).
const BASE_URL = 'https://www.lotteryusa.com';

const STATE_URLS = {
  ga: `${BASE_URL}/georgia/`,
  nj: `${BASE_URL}/new-jersey/`,
  ct: `${BASE_URL}/connecticut/`,
  ny: `${BASE_URL}/new-york/`
};

const GAME_MAP = {
  ga: {
    midday:  { pick3: 'Cash 3 Midday',  pick4: 'Cash 4 Midday' },
    evening: { pick3: 'Cash 3 Evening', pick4: 'Cash 4 Evening' },
    night:   { pick3: 'Cash 3 Night',   pick4: 'Cash 4 Night' }
  },
  nj: {
    midday:  { pick3: 'Pick-3 Midday',  pick4: 'Pick-4 Midday' },
    evening: { pick3: 'Pick-3 Evening', pick4: 'Pick-4 Evening' }
  },
  ct: {
    day:   { pick3: 'Play3 Day',   pick4: 'Play4 Day' },
    night: { pick3: 'Play3 Night', pick4: 'Play4 Night' }
  },
  ny: {
    midday:  { pick3: 'Numbers Midday',  pick4: 'Win 4 Midday' },
    evening: { pick3: 'Numbers Evening', pick4: 'Win 4 Evening' }
  }
};

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

const _cache = new Map();
const CACHE_TTL = 30000;

// "Wednesday, Sep 23, 2026" → "2026-09-23"
function parseDate(text) {
  const m = (text || '').match(/([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  if (mi === -1) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function parsePage(html) {
  const $ = cheerio.load(html);
  const results = {};

  $('.c-game-result-card').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.c-game-result-card__title').first().text().replace(/\s+/g, ' ').trim();
    if (!title || results[title]) return;

    // Main balls only — bonus balls (NJ Fireball, CT Wild Ball) carry c-result__bonus.
    const digits = $el.find('.c-result li.c-ball')
      .not('.c-result__bonus')
      .map((_, b) => $(b).text().trim())
      .get();

    results[title] = { digits, date: parseDate($el.find('time').first().text()) };
  });

  return results;
}

async function scrapeState(state) {
  const url = STATE_URLS[state];
  if (!url) return {};

  return cachedFetch(_cache, state, CACHE_TTL, async () => {
    const html = await fetchPage(url);
    return html ? parsePage(html) : {};
  });
}

function getPart(data, name, length) {
  const game = data[name];
  if (!game || !game.date) return null;
  if (game.digits.length !== length || !game.digits.every(d => /^\d$/.test(d))) return null;
  return game;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const gameMap = GAME_MAP[scraperConfig.state]?.[drawConfig.session];
  if (!gameMap) return null;

  const data = await scrapeState(scraperConfig.state);
  const p3 = getPart(data, gameMap.pick3, 3);
  const p4 = getPart(data, gameMap.pick4, 4);
  if (!p3 || !p4) return null;

  // Both halves must be the same draw — never publish a fresh pick3 beside a stale pick4.
  if (p3.date !== p4.date) return null;

  const date = p3.date;
  if (isToday(date) && drawConfig.time && !hasTimePassed(drawConfig.time)) return null;

  log(`${scraperConfig.lotteryId} "${drawConfig.time}" lotteryusa date: ${date}`);
  return {
    numbers: [...p3.digits, '-', ...p4.digits],
    parts: [p3.digits, p4.digits],
    date,
    closed: false
  };
}

module.exports = { scrapeDraw, _test: { parsePage, parseDate } };
