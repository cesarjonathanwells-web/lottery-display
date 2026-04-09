const axios = require('axios');
const { cachedFetch, log } = require('./utils');

const API_URL = 'https://apim-website-prod-eastus.azure-api.net/drawgamesapp/getLatestDrawGames';
const HEADERS = {
  'x-partner': 'web',
  'Accept': 'application/json'
};

const GAME_IDS = { pick2: 127, pick3: 104, pick4: 108 };

const _cache = new Map();
const CACHE_TTL = 30000;

async function fetchAll() {
  return cachedFetch(_cache, API_URL, CACHE_TTL, async () => {
    const { data } = await axios.get(API_URL, { headers: HEADERS, timeout: 15000 });
    if (!Array.isArray(data)) return null;
    return data;
  });
}

function getWinningNumbers(draw) {
  if (!draw || !draw.DrawNumbers) return null;
  return draw.DrawNumbers
    .filter(d => d.NumberType && d.NumberType.startsWith('wn'))
    .sort((a, b) => a.NumberType.localeCompare(b.NumberType))
    .map(d => String(d.NumberPick));
}

function parseDate(drawDate) {
  if (!drawDate) return null;
  // Format: "04/08/2026 12:00:00 AM"
  const match = drawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

function findLatestDraw(allGames, gameId, drawType) {
  const matches = allGames.filter(g =>
    g.Id === gameId &&
    g.DrawType && g.DrawType.toUpperCase() === drawType.toUpperCase() &&
    g.DrawNumbers && g.DrawNumbers.some(d => d.NumberType && d.NumberType.startsWith('wn'))
  );
  if (matches.length === 0) return null;
  // Sort by date descending, take the newest
  matches.sort((a, b) => {
    const da = parseDate(a.DrawDate) || '';
    const db = parseDate(b.DrawDate) || '';
    return db.localeCompare(da);
  });
  return matches[0];
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const allGames = await fetchAll();
  if (!allGames) return null;

  const drawType = drawConfig.session === 'midday' ? 'MIDDAY' : 'EVENING';

  const p2draw = findLatestDraw(allGames, GAME_IDS.pick2, drawType);
  const p3draw = findLatestDraw(allGames, GAME_IDS.pick3, drawType);
  const p4draw = findLatestDraw(allGames, GAME_IDS.pick4, drawType);

  const p2 = getWinningNumbers(p2draw);
  const p3 = getWinningNumbers(p3draw);
  const p4 = getWinningNumbers(p4draw);

  // Require all three parts
  if (!p2 || !p3 || !p4) return null;

  // All three games must share the same date to avoid mixing stale + fresh numbers
  const d2 = parseDate(p2draw.DrawDate);
  const d3 = parseDate(p3draw.DrawDate);
  const d4 = parseDate(p4draw.DrawDate);
  if (d2 !== d3 || d2 !== d4) {
    log(`florida "${drawConfig.session}" date mismatch: p2=${d2} p3=${d3} p4=${d4} — skipping`);
    return null;
  }

  const numbers = [...p2, '-', ...p3, '-', ...p4];
  const date = d2;

  log(`florida "${drawConfig.session}" source date: ${date}`);
  return { numbers, parts: [p2, p3, p4], date, closed: false };
}

module.exports = { scrapeDraw };
