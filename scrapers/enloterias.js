const { fetchPage } = require('./http');
const { getToday, parseDrawTime, cachedFetch, log } = require('./utils');

// enloterias.com (plural — different site from enloteria.com) King Lottery
// scraper. The root page embeds a JSON payload with the latest result per
// game carrying an explicit ISO `date` and an `updatedAt` epoch — unlike the
// King page's dd-mm datechips, which stamped yesterday's noche numbers with
// today's date pre-draw (2026-08-25 incident). Two acceptance gates:
//   1. a result claiming today's date must have been updated after today's
//      draw time (rejects premature/stale "today" labels);
//   2. when the payload's quiniela carries the same date, it must derive
//      exactly from pick3/pick4 (quiniela = [p3last2, p4first2, p4last2]),
//      rejecting internally inconsistent junk (conectate 08-24/08-26 mode).
const PAGE_URL = 'https://enloterias.com/';

const GAME_SLUGS = {
  dia:   { pick3: 'pick-3-dia',   pick4: 'pick-4-dia',   quiniela: 'quiniela-dia' },
  noche: { pick3: 'pick-3-noche', pick4: 'pick-4-noche', quiniela: 'quiniela-noche' }
};

// Grace window: results can be published a few minutes before the nominal
// draw time settles in the payload's clock.
const DRAW_SLACK_MINUTES = 20;

const _cache = new Map();
const CACHE_TTL = 30000;

// The payload sits inside an escaped Next.js flight string; unescape \" and
// bracket-match the array that follows `"king-lottery":`.
function extractKingArray(html) {
  const unescaped = html.replace(/\\"/g, '"');
  const key = '"king-lottery":[';
  const start = unescaped.indexOf(key);
  if (start === -1) return null;
  const open = start + key.length - 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < unescaped.length; i++) {
    const ch = unescaped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(unescaped.slice(open, i + 1));
        } catch (err) {
          return null;
        }
      }
    }
  }
  return null;
}

async function fetchGames() {
  return cachedFetch(_cache, PAGE_URL, CACHE_TTL, async () => {
    const html = await fetchPage(PAGE_URL);
    if (!html) return null;
    const items = extractKingArray(html);
    if (!Array.isArray(items)) return null;
    const games = {};
    for (const item of items) {
      if (!item || !item.gameSlug || games[item.gameSlug]) continue;
      games[item.gameSlug] = {
        date: typeof item.date === 'string' ? item.date : null,
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
        nums: Array.isArray(item.numbers) ? item.numbers : null
      };
    }
    return games;
  });
}

// A result dated today is only trustworthy once it was updated after today's
// draw actually happened (ET). Anything earlier is a stale value re-stamped.
function updatedAfterDraw(updatedAt, drawTimeStr) {
  if (!updatedAt) return false;
  const parsed = parseDrawTime(drawTimeStr);
  if (!parsed) return false;
  const updatedDay = new Date(updatedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (updatedDay !== getToday()) return false;
  const updated = new Date(new Date(updatedAt).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const updatedMinutes = updated.getHours() * 60 + updated.getMinutes();
  return updatedMinutes >= (parsed.hours * 60 + parsed.minutes - DRAW_SLACK_MINUTES);
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const slugs = GAME_SLUGS[drawConfig.session];
  if (!slugs) return null;

  const games = await fetchGames();
  if (!games) return null;

  const p3raw = games[slugs.pick3];
  const p4raw = games[slugs.pick4];
  if (!p3raw || !p4raw || !p3raw.nums || !p4raw.nums) return null;
  if (!p3raw.date || p3raw.date !== p4raw.date) return null;

  const digits = raw => raw.nums.map(n => String(parseInt(n, 10)));
  const p3 = digits(p3raw);
  const p4 = digits(p4raw);
  if (p3.length !== 3 || p4.length !== 4) return null;
  if ([...p3, ...p4].some(d => !/^\d$/.test(d))) return null;

  if (p3raw.date === getToday()) {
    if (!updatedAfterDraw(p3raw.updatedAt, drawConfig.time) || !updatedAfterDraw(p4raw.updatedAt, drawConfig.time)) {
      log(`enloterias kinglottery "${drawConfig.session}" rejected: dated today but updated before today's ${drawConfig.time} draw`);
      return null;
    }
  }

  const quiraw = games[slugs.quiniela];
  if (quiraw && quiraw.nums && quiraw.date === p3raw.date) {
    const derived = [p3.slice(1).join(''), p4.slice(0, 2).join(''), p4.slice(2).join('')].map(Number);
    const published = quiraw.nums.map(Number);
    if (derived.join(',') !== published.join(',')) {
      log(`enloterias kinglottery "${drawConfig.session}" rejected: quiniela ${published.join('-')} does not derive from pick3/pick4 ${p3.join('')}/${p4.join('')}`);
      return null;
    }
  }

  const numbers = [...p3, '-', ...p4];
  log(`enloterias kinglottery "${drawConfig.session}" source date: ${p3raw.date}`);
  return { numbers, parts: [p3, p4], date: p3raw.date, closed: false };
}

module.exports = { scrapeDraw, _test: { extractKingArray, updatedAfterDraw } };
