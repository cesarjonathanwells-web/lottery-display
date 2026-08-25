const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { getToday, getNowEST, parseDrawTime, isToday, isRecent, log, TIMEZONE } = require('./utils');

// Each scraper exports: scrapeDraw(scraperConfig, drawConfig) → { numbers, date, closed } | null
const SCRAPERS = {
  anguilla: require('./anguilla'),
  conectate: require('./conectate'),
  enloteria: require('./enloteria'),
  enloteriaPage: require('./enloteriaPage'),
  enloterias: require('./enloterias'),
  ocean: require('./ocean'),
  lotterycoast: require('./lotterycoast'),
  newyork: require('./newyork'),
  florida: require('./florida'),
  georgia: require('./georgia'),
  newjersey: require('./newjersey'),
  connecticut: require('./connecticut')
};

const DATA_FILE = path.join(__dirname, '..', 'data', 'results.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'scraper-config.json');

const activePollers = {};
const verifyPollers = {};
const scraperStatus = {};
const corrections = [];

// ── Data helpers ──────────────────────────────────────────────

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function findLottery(data, lotteryId) {
  for (const col of data.columns) {
    for (const lottery of col.lotteries) {
      if (lottery.id === lotteryId) return lottery;
    }
  }
  return null;
}

function findDrawIndex(lottery, drawTime) {
  return lottery.draws.findIndex(d => d.time === drawTime);
}

// ── Timer helper ─────────────────────────────────────────────

function stopTimer(map, key) {
  if (map[key]) { clearInterval(map[key]); delete map[key]; }
}

// ── Per-component change detection ──────────────────────────
// Split a combined numbers array (e.g. ["0","9","0","-","4","0","7","3"])
// into its component segments: [["0","9","0"], ["4","0","7","3"]]
function splitParts(numbers) {
  if (!numbers || numbers.length === 0) return [];
  const parts = [];
  let current = [];
  for (const n of numbers) {
    if (n === '-') {
      if (current.length) parts.push(current);
      current = [];
    } else {
      current.push(n);
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

// Check that every component in newParts differs from storedParts.
// Returns true if ALL parts have changed (safe to accept).
function allPartsChanged(storedParts, newParts) {
  if (storedParts.length !== newParts.length) return true; // structure changed, accept
  for (let i = 0; i < storedParts.length; i++) {
    if (storedParts[i].join(',') === newParts[i].join(',')) return false;
  }
  return true;
}

// ── Scrape result helpers ────────────────────────────────────

function countUpdatedResults(results) {
  return results.filter(r =>
    r.results && r.results.some(d => d.updated)
  ).length;
}

// ── Draw updates ──────────────────────────────────────────────

function updateDraw(lotteryId, drawTime, numbers, status, date, extra) {
  const data = readData();
  const lottery = findLottery(data, lotteryId);
  if (!lottery) {
    log(`Lottery ${lotteryId} not found`);
    return false;
  }

  const drawDate = date || getToday();
  const idx = findDrawIndex(lottery, drawTime);

  // A listener-locked draw is authoritative for the day — don't let a scraper
  // overwrite it. The nightly reset clears `locked`. (Unlock manually via DELETE.)
  if (idx !== -1 && lottery.draws[idx].locked === true) {
    log(`Skip update (locked): ${lotteryId} "${drawTime}"`);
    return false;
  }

  if (idx === -1) {
    lottery.draws.push({ time: drawTime, numbers: numbers || [], status: status || null, date: drawDate });
  } else {
    if (numbers) {
      lottery.draws[idx].numbers = numbers;
      lottery.draws[idx].date = drawDate;
    }
    lottery.draws[idx].status = status || null;
  }

  if (extra && idx !== -1) {
    Object.assign(lottery.draws[idx], extra);
  }

  writeData(data);
  return true;
}

function updateDrawTime(lotteryId, oldTime, newTime) {
  const data = readData();
  const lottery = findLottery(data, lotteryId);
  if (!lottery) return;
  const idx = lottery.draws.findIndex(d => d.time === oldTime);
  if (idx !== -1) {
    lottery.draws[idx].time = newTime;
    writeData(data);
    log(`Time swap: ${lotteryId} "${oldTime}" → "${newTime}"`);
  }
}

// ── Scraping ──────────────────────────────────────────────────

function resolveSources(scraperConfig) {
  const sources = scraperConfig.sources || [scraperConfig.source];
  return sources.filter(Boolean);
}

function isManualScraper(scraperConfig) {
  const sources = resolveSources(scraperConfig);
  return sources.length > 0 && sources.every(src => src === 'manual');
}

async function selectSourceResult(scraperConfig, drawConfig, options = {}) {
  const sourceMap = options.sourceMap || SCRAPERS;
  const validateResult = options.validateResult || ((numbers, lotteryId) => validateNumbers(numbers, lotteryId));
  const dateOk = options.dateOk || (date => isToday(date));
  const logFn = options.logFn || log;

  for (const src of resolveSources(scraperConfig)) {
    const scraper = sourceMap[src];
    if (!scraper || typeof scraper.scrapeDraw !== 'function') {
      logFn(`Scrape error ${scraperConfig.lotteryId} (${src}): source not configured`);
      continue;
    }

    let result;
    try {
      result = await scraper.scrapeDraw(scraperConfig, drawConfig);
    } catch (err) {
      logFn(`Scrape error ${scraperConfig.lotteryId} (${src}): ${err.message}`);
      continue;
    }

    if (!result) continue;
    if (!result.date || !dateOk(result.date)) continue;

    if (!result.closed) {
      const validation = validateResult(result.numbers, scraperConfig.lotteryId, result);
      if (!validation.valid) {
        logFn(`Rejected source ${src}: ${scraperConfig.lotteryId} "${drawConfig.time}": ${validation.reason}`);
        continue;
      }
    }

    logFn(`Source ${src} provided ${scraperConfig.lotteryId} "${drawConfig.time}"`);
    return { source: src, result };
  }

  return null;
}

async function runScrape(scraperConfig, drawConfig, options = {}) {
  const dateOk = options.dateOk || (date =>
    options.acceptRecent
      ? isToday(date) || isRecent(date)
      : isToday(date)
  );
  const selected = await selectSourceResult(scraperConfig, drawConfig, { ...options, dateOk });
  return selected ? selected.result : null;
}

// ── Validation ────────────────────────────────────────────────

function validateNumbers(numbers, lotteryId) {
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return { valid: false, reason: 'empty or not an array' };
  }

  const data = readData();
  const lottery = findLottery(data, lotteryId);
  if (!lottery) return { valid: true };

  const format = lottery.format;
  const digits = numbers.filter(n => n !== '-');

  if (digits.some(d => !d || d.trim() === '' || d === '--')) {
    return { valid: false, reason: 'contains empty or placeholder values' };
  }

  if (format === 'pick3') {
    if (digits.length !== 3) return { valid: false, reason: `pick3 expects 3, got ${digits.length}` };
    for (const d of digits) {
      const n = parseInt(d, 10);
      if (isNaN(n) || n < 0 || n > 99) return { valid: false, reason: `invalid pick3: ${d}` };
    }
  } else if (format === 'pick34') {
    if (digits.length !== 7) return { valid: false, reason: `pick34 expects 7, got ${digits.length}` };
    for (const d of digits) {
      const n = parseInt(d, 10);
      if (isNaN(n) || n < 0 || n > 9) return { valid: false, reason: `invalid pick34: ${d}` };
    }
  } else if (format === 'florida') {
    if (digits.length < 9) return { valid: false, reason: `florida expects 9+, got ${digits.length}` };
    for (const d of digits) {
      const n = parseInt(d, 10);
      if (isNaN(n) || n < 0 || n > 9) return { valid: false, reason: `invalid florida: ${d}` };
    }
  }

  return { valid: true };
}

function hasNewNumbers(lotteryId, drawTime, newNumbers) {
  if (!newNumbers || newNumbers.length === 0) return false;

  const data = readData();
  const lottery = findLottery(data, lotteryId);
  if (!lottery) return true;

  const idx = findDrawIndex(lottery, drawTime);
  if (idx === -1) return true;

  const current = lottery.draws[idx].numbers;
  if (!current || current.length === 0) return true;

  return current.filter(n => n !== '-').join(',') !== newNumbers.filter(n => n !== '-').join(',');
}

// ── Polling ───────────────────────────────────────────────────

function startPolling(scraperConfig, drawConfig, drawIndex) {
  const key = `${scraperConfig.lotteryId}:${drawIndex}`;
  if (activePollers[key] || verifyPollers[key]) return;

  const config = readConfig();
  const pollInterval = (config.pollIntervalSeconds || 45) * 1000;
  const timeoutMs = (config.defaultTimeoutMinutes || 120) * 60 * 1000;
  const verifyMs = (config.verifyMinutes || 15) * 60 * 1000;
  const startTime = Date.now();

  log(`Polling: ${scraperConfig.lotteryId} "${drawConfig.time}"`);

  // Snapshot the stored numbers BEFORE setting pending — these are yesterday's values.
  // Used to detect per-component staleness (e.g. pick3 updated but pick4 still stale).
  const preData = readData();
  const preLottery = findLottery(preData, scraperConfig.lotteryId);
  const preIdx = preLottery ? findDrawIndex(preLottery, drawConfig.time) : -1;
  const storedParts = (preIdx !== -1 && preLottery.draws[preIdx].numbers)
    ? splitParts(preLottery.draws[preIdx].numbers)
    : [];

  updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'pending');

  let candidate = null; // numbers must appear on 2 consecutive scrapes before accepting

  scraperStatus[key] = {
    lotteryId: scraperConfig.lotteryId,
    drawTime: drawConfig.time,
    source: resolveSources(scraperConfig).join(','),
    status: 'polling',
    startedAt: new Date().toISOString(),
    lastCheck: null,
    attempts: 0
  };

  poll();
  activePollers[key] = setInterval(poll, pollInterval);

  async function poll() {
    scraperStatus[key].attempts++;
    scraperStatus[key].lastCheck = new Date().toISOString();

    if (Date.now() - startTime > timeoutMs) {
      log(`Timeout: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      stopTimer(activePollers, key);

      // Don't set no_result if numbers were already found (e.g. by periodic scrape)
      const currentData = readData();
      const currentLottery = findLottery(currentData, scraperConfig.lotteryId);
      const currentIdx = currentLottery ? findDrawIndex(currentLottery, drawConfig.time) : -1;
      const draw = currentIdx !== -1 ? currentLottery.draws[currentIdx] : null;
      const alreadyHasNumbers = draw && draw.numbers && draw.numbers.length > 0 && isToday(draw.date);

      if (alreadyHasNumbers) {
        log(`Timeout but numbers exist: ${scraperConfig.lotteryId} "${drawConfig.time}" — keeping results`);
        scraperStatus[key].status = 'completed';
      } else {
        updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'no_result');
        scraperStatus[key].status = 'timeout';
      }
      return;
    }

    const result = await runScrape(scraperConfig, drawConfig);
    if (!result) return;

    if (result.closed) {
      log(`Closed: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'closed');
      stopTimer(activePollers, key);
      scraperStatus[key].status = 'closed';
      return;
    }

    // Cron-triggered polling: only accept today's results
    if (result.date && !isToday(result.date)) return;

    const { numbers } = result;
    const validation = validateNumbers(numbers, scraperConfig.lotteryId);
    if (!validation.valid) {
      log(`Rejected: ${scraperConfig.lotteryId} "${drawConfig.time}": ${validation.reason}`);
      scraperStatus[key].lastRejection = validation.reason;
      candidate = null;
      return;
    }

    if (!hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, numbers)) {
      // Numbers already match what's in the data (e.g. periodic scrape got them first)
      log(`Already up-to-date: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      stopTimer(activePollers, key);
      scraperStatus[key].status = 'completed';
      scraperStatus[key].result = numbers;
      return;
    }

    // Per-component staleness check: when the result combines multiple games
    // (pick3 + pick4), require EVERY component to have changed from the stored
    // values. This prevents publishing a mix of fresh + stale numbers when the
    // source updates games at different times.
    if (storedParts.length > 1) {
      const newParts = result.parts || splitParts(numbers);
      if (!allPartsChanged(storedParts, newParts)) {
        log(`Partial: ${scraperConfig.lotteryId} "${drawConfig.time}": not all components updated yet`);
        candidate = null; // reset candidate — partial results are not trustworthy
        return;
      }
    }

    const numKey = numbers.filter(n => n !== '-').join(',');

    // Require same numbers on 2 consecutive scrapes before accepting
    if (!candidate || candidate.key !== numKey) {
      candidate = { key: numKey, numbers, date: result.date };
      log(`Candidate: ${scraperConfig.lotteryId} "${drawConfig.time}": ${numKey} — waiting for confirmation`);
      return;
    }

    // Confirmed — same numbers seen twice in a row
    log(`Confirmed: ${scraperConfig.lotteryId} "${drawConfig.time}": ${numbers.join(',')} (date: ${result.date})`);
    updateDraw(scraperConfig.lotteryId, drawConfig.time, candidate.numbers, null, candidate.date);
    scraperStatus[key].result = candidate.numbers;
    stopTimer(activePollers, key);
    scraperStatus[key].status = 'verifying';
    startVerification(key, scraperConfig, drawConfig, candidate.numbers, verifyMs, pollInterval);
  }
}

function startVerification(key, scraperConfig, drawConfig, originalNumbers, verifyMs, pollInterval) {
  const verifyStart = Date.now();
  log(`Verifying: ${scraperConfig.lotteryId} "${drawConfig.time}" (${Math.round(verifyMs / 60000)}min)`);

  verifyPollers[key] = setInterval(async () => {
    if (Date.now() - verifyStart > verifyMs) {
      log(`Verified: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      stopTimer(verifyPollers, key);
      scraperStatus[key].status = 'completed';
      // Clear corrected flag once verification period ends — the number is now stable
      const vData = readData();
      const vLottery = findLottery(vData, scraperConfig.lotteryId);
      if (vLottery) {
        const vIdx = findDrawIndex(vLottery, drawConfig.time);
        if (vIdx !== -1 && vLottery.draws[vIdx].corrected) {
          delete vLottery.draws[vIdx].corrected;
          writeData(vData);
          log(`Cleared corrected flag: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
        }
      }
      return;
    }

    try {
      const result = await runScrape(scraperConfig, drawConfig);
      if (!result || !result.numbers) return;

      const validation = validateNumbers(result.numbers, scraperConfig.lotteryId);
      if (!validation.valid) return;

      if (hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, result.numbers)) {
        const oldNums = scraperStatus[key].result || originalNumbers;
        log(`Correction: ${scraperConfig.lotteryId} "${drawConfig.time}": ${oldNums.join(',')} → ${result.numbers.join(',')} (date: ${result.date})`);

        updateDraw(scraperConfig.lotteryId, drawConfig.time, result.numbers, null, result.date, { corrected: true });

        corrections.push({
          lotteryId: scraperConfig.lotteryId,
          drawTime: drawConfig.time,
          oldNumbers: oldNums,
          newNumbers: result.numbers,
          correctedAt: new Date().toISOString()
        });

        scraperStatus[key].result = result.numbers;
        scraperStatus[key].corrected = true;
      }
    } catch (err) {
      log(`Verify error ${scraperConfig.lotteryId}: ${err.message}`);
    }
  }, pollInterval);
}

// ── Manual / bulk scraping ────────────────────────────────────

async function manualScrape(lotteryId, { acceptRecent = false } = {}) {
  const config = readConfig();
  const scraperConfig = config.scrapers.find(s => s.lotteryId === lotteryId);
  if (!scraperConfig) return { error: `No scraper config for ${lotteryId}` };

  const isSunday = getNowEST().getDay() === 0;
  const results = [];
  for (const drawConfig of scraperConfig.draws) {
    if (drawConfig.skipSunday && isSunday) {
      results.push({ time: drawConfig.time, skipped: true, updated: false });
      continue;
    }

    // Use Sunday time for lookups/updates when applicable
    const effectiveTime = (isSunday && drawConfig.sundayTime) ? drawConfig.sundayTime : drawConfig.time;

    const result = await runScrape(scraperConfig, drawConfig, { acceptRecent });

    if (result && result.closed) {
      results.push({ time: effectiveTime, closed: true, updated: false });
    } else if (result && result.numbers && result.numbers.length > 0) {
      const dateOk = !result.date || isToday(result.date) || (acceptRecent && isRecent(result.date));

      if (dateOk) {
        const validation = validateNumbers(result.numbers, lotteryId);
        if (!validation.valid) {
          log(`Rejected: ${lotteryId} "${effectiveTime}": ${validation.reason}`);
        } else if (hasNewNumbers(lotteryId, effectiveTime, result.numbers)) {
          log(`Update: ${lotteryId} "${effectiveTime}": ${result.numbers.join(',')} (date: ${result.date})`);
          updateDraw(lotteryId, effectiveTime, result.numbers, null, result.date);
          results.push({ time: effectiveTime, numbers: result.numbers, date: result.date, updated: true });
          continue;
        } else {
          // Numbers unchanged — clear any stale pending/no_result status
          updateDraw(lotteryId, effectiveTime, result.numbers, null, result.date);
        }
      }
      results.push({ time: effectiveTime, updated: false });
    } else {
      results.push({ time: effectiveTime, updated: false });
    }
  }
  return { lotteryId, results };
}

async function scrapeAll({ acceptRecent = false } = {}) {
  const config = readConfig();
  const allScrapers = config.scrapers.filter(s => !isManualScraper(s));
  const startMs = Date.now();

  log('Scrape-all started');
  const results = await Promise.all(allScrapers.map(async (sc) => {
    try {
      return await manualScrape(sc.lotteryId, { acceptRecent });
    } catch (err) {
      return { lotteryId: sc.lotteryId, error: err.message };
    }
  }));

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  log(`Scrape-all done in ${elapsed}s`);
  return { elapsed: `${elapsed}s`, results };
}

// ── Initialization ────────────────────────────────────────────

function scheduleMidnightReset() {
  cron.schedule('0 0 * * *', () => {
    log('Midnight reset');
    Object.keys(activePollers).forEach(k => stopTimer(activePollers, k));
    Object.keys(verifyPollers).forEach(k => stopTimer(verifyPollers, k));
    Object.keys(scraperStatus).forEach(k => delete scraperStatus[k]);
    corrections.length = 0;

    // Clear statuses in data file so the new day starts fresh
    const data = readData();
    for (const col of data.columns) {
      for (const lottery of col.lotteries) {
        for (const draw of lottery.draws) {
          delete draw.status;
          delete draw.corrected;
          delete draw.locked;
        }
      }
    }
    writeData(data);
    log('Cleared all draw statuses for new day');

    // Swap draw times for day-specific schedules
    const config = readConfig();
    const isSunday = getNowEST().getDay() === 0;
    for (const sc of config.scrapers) {
      for (const dc of sc.draws) {
        if (dc.sundayTime) {
          if (isSunday) {
            updateDrawTime(sc.lotteryId, dc.time, dc.sundayTime);
          } else {
            updateDrawTime(sc.lotteryId, dc.sundayTime, dc.time);
          }
        }
      }
    }
  }, { timezone: TIMEZONE });
}

function startupCatchUp() {
  setTimeout(async () => {
    log('Startup catch-up...');
    try {
      const result = await scrapeAll({ acceptRecent: true });
      const updated = countUpdatedResults(result.results);
      log(`Catch-up done in ${result.elapsed} — ${updated} lotteries updated`);
    } catch (err) {
      log(`Catch-up error: ${err.message}`);
    }
  }, 5000);
}

function schedulePeriodicScrape() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await scrapeAll({ acceptRecent: false });
      const updated = countUpdatedResults(result.results);
      if (updated > 0) log(`Periodic scrape: ${updated} updated in ${result.elapsed}`);
    } catch (err) {
      log(`Periodic scrape error: ${err.message}`);
    }
  }, { timezone: TIMEZONE });
}

function init() {
  const config = readConfig();
  log('Initializing scheduler...');

  for (const scraperConfig of config.scrapers) {
    for (let di = 0; di < scraperConfig.draws.length; di++) {
      const drawConfig = scraperConfig.draws[di];
      const parsed = parseDrawTime(drawConfig.time);
      if (!parsed) {
        log(`  Skip: ${scraperConfig.lotteryId} "${drawConfig.time}" — invalid time`);
        continue;
      }

      if (drawConfig.sundayTime) {
        const sundayParsed = parseDrawTime(drawConfig.sundayTime);
        if (sundayParsed) {
          // Mon-Sat: normal time
          cron.schedule(`${parsed.minutes} ${parsed.hours} * * 1-6`, () => {
            updateDrawTime(scraperConfig.lotteryId, drawConfig.sundayTime, drawConfig.time);
            startPolling(scraperConfig, { ...drawConfig, time: drawConfig.time }, di);
          }, { timezone: TIMEZONE });
          // Sunday: alternate time
          cron.schedule(`${sundayParsed.minutes} ${sundayParsed.hours} * * 0`, () => {
            updateDrawTime(scraperConfig.lotteryId, drawConfig.time, drawConfig.sundayTime);
            startPolling(scraperConfig, { ...drawConfig, time: drawConfig.sundayTime }, di);
          }, { timezone: TIMEZONE });
          log(`  ${scraperConfig.lotteryId} "${drawConfig.time}" → Mon-Sat ${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}, Sun ${String(sundayParsed.hours).padStart(2, '0')}:${String(sundayParsed.minutes).padStart(2, '0')}`);
          continue;
        }
      }

      const cronDays = drawConfig.skipSunday ? '1-6' : '*';
      cron.schedule(`${parsed.minutes} ${parsed.hours} * * ${cronDays}`, () => {
        startPolling(scraperConfig, drawConfig, di);
      }, { timezone: TIMEZONE });

      const skipLabel = drawConfig.skipSunday ? ' (Mon-Sat)' : '';
      log(`  ${scraperConfig.lotteryId} "${drawConfig.time}" → ${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}${skipLabel}`);
    }
  }

  scheduleMidnightReset();

  // Swap draw times on startup if today is Sunday
  const isSunday = getNowEST().getDay() === 0;
  if (isSunday) {
    for (const sc of config.scrapers) {
      for (const dc of sc.draws) {
        if (dc.sundayTime) {
          updateDrawTime(sc.lotteryId, dc.time, dc.sundayTime);
        }
      }
    }
    log('Sunday detected — swapped draw times');
  }

  log(`Scheduler ready: ${config.scrapers.length} lotteries`);

  // Startup catch-up: accept today + yesterday's results
  startupCatchUp();

  // Periodic re-scrape every 10 minutes (today only)
  schedulePeriodicScrape();
}

function getStatus() {
  return {
    activePollers: Object.keys(activePollers),
    verifyPollers: Object.keys(verifyPollers),
    jobs: scraperStatus,
    corrections
  };
}

module.exports = {
  init,
  getStatus,
  manualScrape,
  scrapeAll,
  _test: { resolveSources, isManualScraper, selectSourceResult }
};
