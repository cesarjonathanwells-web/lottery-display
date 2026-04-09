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

function formatDate(timestampMs) {
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const data = await fetchAll();
  if (!data) return null;

  const period = PERIOD_MAP[drawConfig.session];
  if (!period) return null;

  const numbersDraw = findDraw(data.numbers?.draws, period);
  const win4Draw = findDraw(data.win4?.draws, period);

  if (!numbersDraw && !win4Draw) return null;

  const p3 = numbersDraw?.results?.[0]?.primary;
  const p4 = win4Draw?.results?.[0]?.primary;
  if (!p3 || !p4) return null;

  const numbers = [...p3, '-', ...p4];
  const date = formatDate((numbersDraw || win4Draw).drawTime);

  log(`newyork "${drawConfig.session}" source date: ${date}`);
  return { numbers, parts: [p3, p4], date, closed: false };
}

module.exports = { scrapeDraw };
