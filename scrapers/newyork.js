const { fetchPage } = require('./http');
const { cachedFetch, log } = require('./utils');

const API_URL = 'https://edit.nylottery.ny.gov/api/all/draw_games_fallback?_format=json';

const _cache = new Map();
const CACHE_TTL = 30000;

const PERIOD_MAP = { midday: 1, evening: 2 };

async function fetchAll() {
  return cachedFetch(_cache, API_URL, CACHE_TTL, async () => {
    const raw = await fetchPage(API_URL);
    if (!raw || !raw.data) return null;
    return raw.data;
  });
}

function findDraw(draws, period) {
  if (!draws) return null;
  // Status 22 = completed with results
  return draws.find(d => d.drawPeriod === period && d.status === 22) || null;
}

// drawTime is midnight Eastern on the draw date. Read it on that clock so the
// date doesn't depend on the server's time zone.
function formatDate(timestampMs) {
  return new Date(timestampMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Numbers (Pick 3) and Win 4 post separately, sometimes 20 minutes apart. The
// latest finished draw of each can then be from different days, so both halves
// must share a date or today's Pick 3 goes out beside yesterday's Win 4.
function buildResult(data, session) {
  const period = PERIOD_MAP[session];
  if (!data || !period) return null;

  const numbersDraw = findDraw(data.numbers?.draws, period);
  const win4Draw = findDraw(data.win4?.draws, period);

  const p3 = numbersDraw?.results?.[0]?.primary;
  const p4 = win4Draw?.results?.[0]?.primary;
  if (!p3 || !p4) return null;

  const date = formatDate(numbersDraw.drawTime);
  const win4Date = formatDate(win4Draw.drawTime);
  if (date !== win4Date) {
    log(`newyork "${session}" date mismatch: numbers=${date} win4=${win4Date} — skipping`);
    return null;
  }

  log(`newyork "${session}" source date: ${date}`);
  return { numbers: [...p3, '-', ...p4], parts: [p3, p4], date, closed: false };
}

async function scrapeDraw(scraperConfig, drawConfig) {
  return buildResult(await fetchAll(), drawConfig.session);
}

module.exports = { scrapeDraw, _test: { buildResult } };
