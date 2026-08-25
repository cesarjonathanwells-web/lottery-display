const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday, getNowEST, cachedFetch, log } = require('./utils');

// enloterias.com (plural — different site from enloteria.com) King Lottery
// scraper. The main per-lottery page renders every game as a .drawline with
// a dd-mm datechip; the per-game subpages cache stale data, so only the main
// page is used. Values cross-verified 2026-08-24 against loteriasdominicanas,
// enloteria.com's derived quiniela, and the official-derived día numbers.
const PAGE_URL = 'https://enloterias.com/resultados/king-lottery';

const GAME_LABELS = {
  dia:   { pick3: 'Pick 3 Día',   pick4: 'Pick 4 Día' },
  noche: { pick3: 'Pick 3 Noche', pick4: 'Pick 4 Noche' }
};

const _cache = new Map();
const CACHE_TTL = 30000;

// "24-08" -> "2026-08-24" (year inferred; tolerant of the Dec/Jan boundary)
function chipToIso(chip) {
  const m = chip.match(/^(\d{2})-(\d{2})$/);
  if (!m) return null;
  const now = new Date(getNowEST());
  let year = now.getFullYear();
  const iso = y => `${y}-${m[2]}-${m[1]}`;
  const asDate = new Date(`${iso(year)}T12:00:00`);
  if (asDate - now > 3 * 86400000) year -= 1; // chip far in the future => last year
  return iso(year);
}

async function fetchGames() {
  return cachedFetch(_cache, PAGE_URL, CACHE_TTL, async () => {
    const html = await fetchPage(PAGE_URL);
    if (!html) return null;
    const $ = cheerio.load(html);
    const games = {};
    $('.drawline').each((_, el) => {
      const name = $(el).find('.drawname').first().text().trim();
      const chip = $(el).find('.datechip').first().text().trim();
      const nums = [];
      $(el).find('.drawnums .disc > span').each((_, n) => {
        nums.push($(n).text().trim());
      });
      if (name && chip && nums.length && !games[name]) {
        games[name] = { date: chipToIso(chip), nums };
      }
    });
    return games;
  });
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const labels = GAME_LABELS[drawConfig.session];
  if (!labels) return null;

  const games = await fetchGames();
  if (!games) return null;

  const p3raw = games[labels.pick3];
  const p4raw = games[labels.pick4];
  if (!p3raw || !p4raw) return null;
  if (!p3raw.date || p3raw.date !== p4raw.date) return null;

  // discs are single digits zero-padded to two chars ("05" -> "5")
  const digits = raw => raw.nums.map(n => String(parseInt(n, 10)));
  const p3 = digits(p3raw);
  const p4 = digits(p4raw);
  if (p3.length !== 3 || p4.length !== 4) return null;
  if ([...p3, ...p4].some(d => !/^\d$/.test(d))) return null;

  const numbers = [...p3, '-', ...p4];
  log(`enloterias kinglottery "${drawConfig.session}" source date: ${p3raw.date}`);
  return { numbers, parts: [p3, p4], date: p3raw.date, closed: false };
}

module.exports = { scrapeDraw };
