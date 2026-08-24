const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday, padNumbers, log } = require('./utils');

// Generalized enloteria.com per-game page scraper (same JSON-LD Event
// structure as the per-hour anguilla pages). Each draw in scraper-config
// carries a `pageSlug`, e.g. "resultados-gana-mas". The JSON-LD events are
// date-anchored per draw day, so results only appear once actually drawn —
// verified against official operator sites 2026-08-24.
const BASE_URL = 'https://enloteria.com/';

async function scrapeDraw(scraperConfig, drawConfig) {
  const slug = drawConfig.pageSlug;
  if (!slug) return null;

  const html = await fetchPage(`${BASE_URL}${slug}`);
  if (!html) return null;
  const $ = cheerio.load(html);

  const scriptEl = $('script[type="application/ld+json"]').first();
  if (!scriptEl.length) return null;

  let jsonLd;
  try { jsonLd = JSON.parse(scriptEl.html()); } catch { return null; }

  const events = (jsonLd['@graph'] || []).filter(e => e['@type'] === 'Event');
  if (events.length === 0) return null;

  const today = getToday();
  const todayEvent = events.find(e => e.startDate && e.startDate.slice(0, 10) === today);
  const latest = todayEvent || events[0];

  if (!latest.startDate) return null;
  const date = latest.startDate.slice(0, 10);

  const numMatch = (latest.description || '').match(/Números ganadores:\s*(.+)\./);
  if (!numMatch) return null;

  const numbers = padNumbers(numMatch[1].split(',').map(n => n.trim()));
  if (numbers.length !== 3) return null;
  log(`enloteriaPage ${scraperConfig.lotteryId} "${drawConfig.time}" (${slug}) date: ${date}`);
  return { numbers, date, closed: false };
}

module.exports = { scrapeDraw };
