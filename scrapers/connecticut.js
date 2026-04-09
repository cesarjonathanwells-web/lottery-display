const { fetchPage } = require('./http');
const cheerio = require('cheerio');
const { cachedFetch, log } = require('./utils');

const RSS_URL = 'https://www.ctlottery.org/Feeds/rssnumbers.xml';

const _cache = new Map();
const CACHE_TTL = 30000;

// Map drawConfig.session to RSS title prefixes
const GAME_LABELS = {
  play3day:   'Play3 Day',
  play3night: 'Play3 Night',
  play4day:   'Play4 Day',
  play4night: 'Play4 Night'
};

async function fetchAll() {
  return cachedFetch(_cache, RSS_URL, CACHE_TTL, async () => {
    const xml = await fetchPage(RSS_URL);
    if (!xml) return null;

    const $ = cheerio.load(xml, { xmlMode: true });
    const results = {};

    $('item').each((_, item) => {
      const title = $(item).find('title').text().trim();
      const desc = $(item).find('description').text().trim();

      for (const [key, label] of Object.entries(GAME_LABELS)) {
        if (!title.startsWith(label)) continue;

        // Title: "Play3 Day for 04/08/2026"
        const dateMatch = title.match(/(\d{2})\/(\d{2})\/(\d{4})$/);
        const date = dateMatch ? `${dateMatch[3]}-${dateMatch[1]}-${dateMatch[2]}` : null;

        // Description: "4-0-2 WB-1" or "2-6-4-6 WB-3"
        const numPart = desc.split(/\s+WB/)[0].trim();
        const numbers = numPart.split('-').map(n => n.trim()).filter(n => n !== '');

        if (!results[key] && numbers.length > 0) {
          results[key] = { numbers, date };
        }
        break;
      }
    });

    return results;
  });
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const results = await fetchAll();
  if (!results) return null;

  const session = drawConfig.session; // "day" or "night"

  const p3key = `play3${session}`;
  const p4key = `play4${session}`;
  const p3 = results[p3key];
  const p4 = results[p4key];

  if (!p3 && !p4) return null;

  const p3nums = p3?.numbers;
  const p4nums = p4?.numbers;
  if (!p3nums || !p4nums) return null;

  const numbers = [...p3nums, '-', ...p4nums];
  const date = p3?.date || p4?.date;

  log(`connecticut "${session}" source date: ${date}`);
  return { numbers, parts: [p3nums, p4nums], date, closed: false };
}

module.exports = { scrapeDraw };
