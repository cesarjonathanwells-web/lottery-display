const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { hasTimePassed, isToday, log } = require('./utils');

const BASE_URL = 'https://lotterycoast.com/lottery-results';

const STATE_URLS = {
  ny: `${BASE_URL}/new-york/`,
  fl: `${BASE_URL}/florida/`,
  ga: `${BASE_URL}/georgia/`,
  nj: `${BASE_URL}/new-jersey/`,
  ct: `${BASE_URL}/connecticut/`
};

const GAME_MAP = {
  ny: {
    midday:  { pick3: 'Numbers Midday',  pick4: 'Win 4 Midday' },
    evening: { pick3: 'Numbers Evening', pick4: 'Win 4 Evening' }
  },
  fl: {
    midday:  { pick2: 'Pick 2 Midday',  pick3: 'Pick 3 Midday',  pick4: 'Pick 4 Midday' },
    evening: { pick2: 'Pick 2 Evening', pick3: 'Pick 3 Evening', pick4: 'Pick 4 Evening' }
  },
  ga: {
    midday:  { pick3: 'Cash 3 Midday',  pick4: 'Cash 4 Midday' },
    evening: { pick3: 'Cash 3 Evening', pick4: 'Cash 4 Evening' },
    night:   { pick3: 'Cash 3 Night',   pick4: 'Cash 4 Night' }
  },
  nj: {
    midday:  { pick3: 'Pick 3 Midday',  pick4: 'Pick 4 Midday' },
    evening: { pick3: 'Pick 3 Evening', pick4: 'Pick 4 Evening' }
  },
  ct: {
    day:   { pick3: 'Play 3 Day',   pick4: 'Play 4 Day' },
    night: { pick3: 'Play 3 Night', pick4: 'Play 4 Night' }
  }
};

const _cache = {};
const CACHE_TTL = 30000;

async function scrapeState(state) {
  const url = STATE_URLS[state];
  if (!url) return {};

  const now = Date.now();
  if (_cache[state] && (now - _cache[state].time) < CACHE_TTL) return _cache[state].data;

  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const results = {};
  let currentDate = '';

  // Walk DOM in order — date headers precede their result rows
  $('time[datetime], div.row.my-3').each((_, el) => {
    const $el = $(el);
    if ($el.is('time[datetime]')) {
      currentDate = $el.attr('datetime') || '';
    } else {
      const label = $el.find('strong.fs-6').text().trim();
      if (!label) return;
      const digits = [];
      $el.find('span.draw-digit').not('.bg-gradient-warning').each((_, d) => {
        digits.push($(d).text().trim());
      });
      if (digits.length > 0) {
        results[label] = { digits, date: currentDate };
      }
    }
  });

  _cache[state] = { data: results, time: now };
  return results;
}

function getDigits(data, name) {
  return data[name] ? data[name].digits : null;
}

function getResultDate(data, gameMap) {
  for (const name of Object.values(gameMap)) {
    if (data[name]) return data[name].date;
  }
  return null;
}

function combineNumbers(gameMap, data, format) {
  if (format === 'florida') {
    const p2 = gameMap.pick2 ? getDigits(data, gameMap.pick2) : null;
    const p3 = gameMap.pick3 ? getDigits(data, gameMap.pick3) : null;
    const p4 = gameMap.pick4 ? getDigits(data, gameMap.pick4) : null;
    if (!p2 && !p3 && !p4) return null;
    const numbers = [];
    if (p2) numbers.push(...p2);
    if (p3) { if (numbers.length) numbers.push('-'); numbers.push(...p3); }
    if (p4) { if (numbers.length) numbers.push('-'); numbers.push(...p4); }
    return numbers;
  }

  const p3 = gameMap.pick3 ? getDigits(data, gameMap.pick3) : null;
  const p4 = gameMap.pick4 ? getDigits(data, gameMap.pick4) : null;
  if (!p3 && !p4) return null;
  const numbers = [];
  if (p3) numbers.push(...p3);
  if (p4) { numbers.push('-'); numbers.push(...p4); }
  return numbers;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const { state } = scraperConfig;
  const format = scraperConfig.format || 'pick34';
  const data = await scrapeState(state);

  const gameMap = GAME_MAP[state]?.[drawConfig.session];
  if (!gameMap) return null;

  const date = getResultDate(data, gameMap);
  if (isToday(date) && drawConfig.time && !hasTimePassed(drawConfig.time)) return null;

  const numbers = combineNumbers(gameMap, data, format);
  if (!numbers) return null;

  log(`${scraperConfig.lotteryId} "${drawConfig.time}" source date: ${date}`);
  return { numbers, date, closed: false };
}

module.exports = { scrapeDraw };
