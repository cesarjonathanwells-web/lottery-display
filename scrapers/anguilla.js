const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday, log } = require('./utils');

const BASE_URL = 'https://enloteria.com/resultados-anguilla-';
const TIME_TO_SLUG = {
  '8:00 AM': '8am', '9:00 AM': '9am', '10:00 AM': '10am', '11:00 AM': '11am',
  '12:00 PM': '12pm', '1:00 PM': '1pm', '2:00 PM': '2pm', '3:00 PM': '3pm',
  '4:00 PM': '4pm', '5:00 PM': '5pm', '6:00 PM': '6pm', '7:00 PM': '7pm',
  '8:00 PM': '8pm', '9:00 PM': '9pm', '10:00 PM': '10pm'
};

async function scrapeDraw(scraperConfig, drawConfig) {
  const slug = TIME_TO_SLUG[drawConfig.time];
  if (!slug) return null;

  const html = await fetchPage(`${BASE_URL}${slug}`);
  const $ = cheerio.load(html);

  const scriptEl = $('script[type="application/ld+json"]').first();
  if (!scriptEl.length) return null;

  let jsonLd;
  try { jsonLd = JSON.parse(scriptEl.html()); } catch { return null; }

  const events = (jsonLd['@graph'] || []).filter(e => e['@type'] === 'Event');
  if (events.length === 0) return null;

  // Find today's event first, fall back to most recent
  const today = getToday();
  const todayEvent = events.find(e => e.startDate && e.startDate.slice(0, 10) === today);
  const latest = todayEvent || events[0];
  const date = latest.startDate.slice(0, 10);

  const numMatch = (latest.description || '').match(/Números ganadores:\s*(.+)\./);
  if (!numMatch) return null;

  const numbers = numMatch[1].split(',').map(n => n.trim().padStart(2, '0'));
  if (numbers.length !== 3) return null;
  log(`anguilla "${drawConfig.time}" source date: ${date}`);
  return { numbers, date, closed: false };
}

module.exports = { scrapeDraw };
