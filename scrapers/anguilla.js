const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://enloteria.com/resultados-anguilla-';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
};

// Map our draw times to enloteria URL slugs
const TIME_TO_SLUG = {
  '8:00 AM':  '8am',
  '9:00 AM':  '9am',
  '10:00 AM': '10am',
  '11:00 AM': '11am',
  '12:00 PM': '12pm',
  '1:00 PM':  '1pm',
  '2:00 PM':  '2pm',
  '3:00 PM':  '3pm',
  '4:00 PM':  '4pm',
  '5:00 PM':  '5pm',
  '6:00 PM':  '6pm',
  '7:00 PM':  '7pm',
  '8:00 PM':  '8pm',
  '9:00 PM':  '9pm',
  '10:00 PM': '10pm'
};

/**
 * Scrape a single Anguilla draw time from enloteria.com.
 * Uses JSON-LD structured data embedded in the page.
 *
 * @param {string} drawTime - e.g. "8:00 AM"
 * @returns {{ numbers: string[], date: string, closed: boolean } | null}
 */
async function scrapeDraw(drawTime) {
  const slug = TIME_TO_SLUG[drawTime];
  if (!slug) return null;

  const url = `${BASE_URL}${slug}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);

  const today = new Date().toISOString().slice(0, 10);

  // First check: does the page show "Sin sorteo" for today?
  // The page renders today's card first — if it says "Sin sorteo", the lottery is closed
  const pageHtml = $.html();
  const hasSinSorteo = pageHtml.includes('Sin sorteo');

  // Parse JSON-LD structured data for actual numbers
  const scriptEl = $('script[type="application/ld+json"]').first();
  if (!scriptEl.length) {
    return hasSinSorteo ? { numbers: null, date: today, closed: true } : null;
  }

  let jsonLd;
  try {
    jsonLd = JSON.parse(scriptEl.html());
  } catch (e) {
    return hasSinSorteo ? { numbers: null, date: today, closed: true } : null;
  }

  const graph = jsonLd['@graph'];
  if (!graph) return null;

  // Find the most recent Event with numbers
  const events = graph.filter(e => e['@type'] === 'Event');
  if (events.length === 0) {
    return hasSinSorteo ? { numbers: null, date: today, closed: true } : null;
  }

  // Check if the latest event is from today
  const latest = events[0];
  const eventDate = latest.startDate;
  const dateStr = eventDate.slice(0, 10);

  // If latest event is NOT today and page shows "Sin sorteo" → closed
  if (dateStr !== today && hasSinSorteo) {
    return { numbers: null, date: today, closed: true };
  }

  // If latest event is not today and no "Sin sorteo" → no result yet
  if (dateStr !== today) return null;

  // Extract numbers from today's event
  const desc = latest.description || '';
  const numMatch = desc.match(/Números ganadores:\s*(.+)\./);

  if (!numMatch) return null;

  const numbers = numMatch[1].split(',').map(n => n.trim().padStart(2, '0'));
  if (numbers.length !== 3) return null;

  return { numbers, date: dateStr, closed: false };
}

/**
 * Scrape all 15 Anguilla draws at once, fully parallel.
 * Returns a map: { "8:00 AM": { numbers, date, closed }, ... }
 */
async function scrapeAll() {
  const results = {};
  const times = Object.keys(TIME_TO_SLUG);

  const promises = times.map(async (time) => {
    try {
      const result = await scrapeDraw(time);
      if (result) results[time] = result;
      } catch (err) {
        // Skip failed draws
      }
    });
  await Promise.all(promises);

  return results;
}

module.exports = { scrapeDraw, scrapeAll, TIME_TO_SLUG };
