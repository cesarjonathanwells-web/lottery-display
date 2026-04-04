const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday } = require('./utils');

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
  const today = getToday();
  const hasSinSorteo = html.includes('Sin sorteo');

  const scriptEl = $('script[type="application/ld+json"]').first();
  if (!scriptEl.length) {
    return hasSinSorteo ? { numbers: null, date: today, closed: true } : null;
  }

  let jsonLd;
  try { jsonLd = JSON.parse(scriptEl.html()); } catch {
    return hasSinSorteo ? { numbers: null, date: today, closed: true } : null;
  }

  const events = (jsonLd['@graph'] || []).filter(e => e['@type'] === 'Event');
  if (events.length === 0) {
    return hasSinSorteo ? { numbers: null, date: today, closed: true } : null;
  }

  const latest = events[0];
  const date = latest.startDate.slice(0, 10);

  if (date !== today && hasSinSorteo) {
    return { numbers: null, date: today, closed: true };
  }

  const numMatch = (latest.description || '').match(/Números ganadores:\s*(.+)\./);
  if (!numMatch) return null;

  const numbers = numMatch[1].split(',').map(n => n.trim().padStart(2, '0'));
  return numbers.length === 3 ? { numbers, date, closed: false } : null;
}

module.exports = { scrapeDraw };
