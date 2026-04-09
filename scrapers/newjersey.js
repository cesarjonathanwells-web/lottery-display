const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { cachedFetch, log } = require('./utils');

const BASE = 'https://www.lottery.net/new-jersey';

const URL_MAP = {
  midday: {
    pick3: `${BASE}/pick-3-midday/results`,
    pick4: `${BASE}/pick-4-midday/results`
  },
  evening: {
    pick3: `${BASE}/pick-3-evening/results`,
    pick4: `${BASE}/pick-4-evening/results`
  }
};

const _cache = new Map();
const CACHE_TTL = 30000;

function parsePage(html) {
  const $ = cheerio.load(html);

  // Get numbers from first result entry
  const balls = [];
  $('ul.results').first().find('li.ball').each((_, el) => {
    balls.push($(el).text().trim());
  });

  // Get date — "Tuesday April 7th 2026" in .dateSmall
  let date = null;
  const dateText = $('div.dateSmall').first().text().trim();
  if (dateText) {
    // Extract from format like "Tuesday April 7th 2026"
    const match = dateText.match(/(\w+)\s+(\d+)\w*\s+(\d{4})/);
    if (match) {
      const monthNames = ['January','February','March','April','May','June',
        'July','August','September','October','November','December'];
      const monthIdx = monthNames.indexOf(match[1]);
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
  const session = drawConfig.session; // "midday" or "evening"
  const urls = URL_MAP[session];
  if (!urls) return null;

  const [p3result, p4result] = await Promise.all([
    fetchResult(urls.pick3, `nj-p3-${session}`),
    fetchResult(urls.pick4, `nj-p4-${session}`)
  ]);

  if (!p3result && !p4result) return null;

  const p3 = p3result?.numbers;
  const p4 = p4result?.numbers;
  if (!p3 || !p4) return null;

  const numbers = [...p3, '-', ...p4];
  const date = p3result?.date || p4result?.date;

  log(`newjersey "${session}" source date: ${date}`);
  return { numbers, parts: [p3, p4], date, closed: false };
}

module.exports = { scrapeDraw };
