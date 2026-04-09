const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { cachedFetch, log } = require('./utils');

const BASE = 'https://www.lottery.net/georgia';

const URL_MAP = {
  midday: {
    cash3: `${BASE}/cash-3-midday/numbers`,
    cash4: `${BASE}/cash-4-midday/numbers`
  },
  evening: {
    cash3: `${BASE}/cash-3-evening/numbers`,
    cash4: `${BASE}/cash-4-evening/numbers`
  },
  night: {
    cash3: `${BASE}/cash-3-night/numbers`,
    cash4: `${BASE}/cash-4-night/numbers`
  }
};

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

const _cache = new Map();
const CACHE_TTL = 30000;

function parsePage(html) {
  const $ = cheerio.load(html);

  const balls = [];
  $('ul.results').first().find('li.ball').each((_, el) => {
    balls.push($(el).text().trim());
  });

  let date = null;
  const dateText = $('div.dateSmall').first().text().trim();
  if (dateText) {
    const match = dateText.match(/(\w+)\s+(\d+)\w*\s+(\d{4})/);
    if (match) {
      const monthIdx = MONTH_NAMES.indexOf(match[1]);
      if (monthIdx !== -1) {
        date = `${match[3]}-${String(monthIdx + 1).padStart(2, '0')}-${String(match[2]).padStart(2, '0')}`;
      }
    }
  }

  return balls.length > 0 ? { numbers: balls, date } : null;
}

async function fetchResult(url, cacheKey) {
  return cachedFetch(_cache, cacheKey, CACHE_TTL, async () => {
    const html = await fetchPage(url);
    if (!html) return null;
    return parsePage(html);
  });
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const session = drawConfig.session; // "midday", "evening", "night"
  const urls = URL_MAP[session];
  if (!urls) return null;

  const [c3result, c4result] = await Promise.all([
    fetchResult(urls.cash3, `ga-c3-${session}`),
    fetchResult(urls.cash4, `ga-c4-${session}`)
  ]);

  if (!c3result && !c4result) return null;

  const p3 = c3result?.numbers;
  const p4 = c4result?.numbers;
  if (!p3 || !p4) return null;

  const numbers = [...p3, '-', ...p4];
  const date = c3result?.date || c4result?.date;

  log(`georgia "${session}" source date: ${date}`);
  return { numbers, parts: [p3, p4], date, closed: false };
}

module.exports = { scrapeDraw };
