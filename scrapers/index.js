const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { getToday, parseDrawTime, isToday, isRecent, log, TIMEZONE } = require('./utils');

// Each scraper exports: scrapeDraw(scraperConfig, drawConfig) → { numbers, date, closed } | null
const SCRAPERS = {
  anguilla: require('./anguilla'),
  conectate: require('./conectate'),
  ocean: require('./ocean'),
  lotterycoast: require('./lotterycoast')
};

const DATA_FILE = path.join(__dirname, '..', 'data', 'results.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'scraper-config.json');

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

// ── Draw updates ──────────────────────────────────────────────

function updateDraw(lotteryId, drawTime, numbers, status) {
  const data = readData();
  const lottery = findLottery(data, lotteryId);
  if (!lottery) {
    log(`Lottery ${lotteryId} not found`);
    return false;
  }

  const today = getToday();
  const idx = findDrawIndex(lottery, drawTime);

  if (idx === -1) {
    lottery.draws.push({ time: drawTime, numbers: numbers || [], status: status || null, date: today });
  } else {
    if (numbers) {
      lottery.draws[idx].numbers = numbers;
      lottery.draws[idx].date = today;
    }
    lottery.draws[idx].status = status || null;
  }

  writeData(data);
  return true;
}

// ── Scraping ──────────────────────────────────────────────────

async function runScrape(scraperConfig, drawConfig) {
  const scraper = SCRAPERS[scraperConfig.source];
  if (!scraper) return null;

  try {
    return await scraper.scrapeDraw(scraperConfig, drawConfig);
  } catch (err) {
    log(`Scrape error ${scraperConfig.lotteryId} (${scraperConfig.source}): ${err.message}`);
    return null;
  }
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
  updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'pending');

  scraperStatus[key] = {
    lotteryId: scraperConfig.lotteryId,
    drawTime: drawConfig.time,
    source: scraperConfig.source,
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
      stopPolling(key);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'no_result');
      scraperStatus[key].status = 'timeout';
      return;
    }

    const result = await runScrape(scraperConfig, drawConfig);
    if (!result) return;

    if (result.closed) {
      log(`Closed: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'closed');
      stopPolling(key);
      scraperStatus[key].status = 'closed';
      return;
    }

    // Cron-triggered polling: only accept today's results
    if (result.date && !isToday(result.date)) return;

    const { numbers } = result;
    const validation = validateNumbers(numbers, scraperConfig.lotteryId);
    if (!validation.valid) {
      scraperStatus[key].lastRejection = validation.reason;
      return;
    }

    if (hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, numbers)) {
      log(`Result: ${scraperConfig.lotteryId} "${drawConfig.time}": ${numbers.join(',')}`);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, numbers, null);
      scraperStatus[key].result = numbers;
      stopPolling(key);
      scraperStatus[key].status = 'verifying';
      startVerification(key, scraperConfig, drawConfig, numbers, verifyMs, pollInterval);
    }
  }
}

function startVerification(key, scraperConfig, drawConfig, originalNumbers, verifyMs, pollInterval) {
  const verifyStart = Date.now();
  log(`Verifying: ${scraperConfig.lotteryId} "${drawConfig.time}" (${Math.round(verifyMs / 60000)}min)`);

  verifyPollers[key] = setInterval(async () => {
    if (Date.now() - verifyStart > verifyMs) {
      log(`Verified: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      stopVerification(key);
      scraperStatus[key].status = 'completed';
      return;
    }

    try {
      const result = await runScrape(scraperConfig, drawConfig);
      if (!result || !result.numbers) return;

      const validation = validateNumbers(result.numbers, scraperConfig.lotteryId);
      if (!validation.valid) return;

      if (hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, result.numbers)) {
        const oldNums = scraperStatus[key].result || originalNumbers;
        log(`Correction: ${scraperConfig.lotteryId} "${drawConfig.time}": ${oldNums.join(',')} → ${result.numbers.join(',')}`);

        updateDraw(scraperConfig.lotteryId, drawConfig.time, result.numbers, null);

        const data = readData();
        const lottery = findLottery(data, scraperConfig.lotteryId);
        if (lottery) {
          const drawIdx = findDrawIndex(lottery, drawConfig.time);
          if (drawIdx !== -1) {
            lottery.draws[drawIdx].corrected = true;
            writeData(data);
          }
        }

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

function stopPolling(key) {
  if (activePollers[key]) { clearInterval(activePollers[key]); delete activePollers[key]; }
}

function stopVerification(key) {
  if (verifyPollers[key]) { clearInterval(verifyPollers[key]); delete verifyPollers[key]; }
}

// ── Manual / bulk scraping ────────────────────────────────────

async function manualScrape(lotteryId, { acceptRecent = false } = {}) {
  const config = readConfig();
  const scraperConfig = config.scrapers.find(s => s.lotteryId === lotteryId);
  if (!scraperConfig) return { error: `No scraper config for ${lotteryId}` };

  const results = [];
  for (const drawConfig of scraperConfig.draws) {
    const result = await runScrape(scraperConfig, drawConfig);

    if (result && result.closed) {
      updateDraw(lotteryId, drawConfig.time, null, 'closed');
      results.push({ time: drawConfig.time, closed: true, updated: true });
    } else if (result && result.numbers && result.numbers.length > 0) {
      const dateOk = !result.date || isToday(result.date) || (acceptRecent && isRecent(result.date));

      if (dateOk) {
        const validation = validateNumbers(result.numbers, lotteryId);
        if (validation.valid && hasNewNumbers(lotteryId, drawConfig.time, result.numbers)) {
          updateDraw(lotteryId, drawConfig.time, result.numbers, null);
          results.push({ time: drawConfig.time, numbers: result.numbers, updated: true });
          continue;
        }
      }
      results.push({ time: drawConfig.time, updated: false });
    } else {
      results.push({ time: drawConfig.time, updated: false });
    }
  }
  return { lotteryId, results };
}

async function scrapeAll({ acceptRecent = false } = {}) {
  const config = readConfig();
  const allScrapers = config.scrapers.filter(s => s.source !== 'manual');
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

      cron.schedule(`${parsed.minutes} ${parsed.hours} * * *`, () => {
        startPolling(scraperConfig, drawConfig, di);
      }, { timezone: TIMEZONE });

      log(`  ${scraperConfig.lotteryId} "${drawConfig.time}" → ${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`);
    }
  }

  // Midnight reset
  cron.schedule('0 0 * * *', () => {
    log('Midnight reset');
    Object.keys(activePollers).forEach(stopPolling);
    Object.keys(verifyPollers).forEach(stopVerification);
    Object.keys(scraperStatus).forEach(k => delete scraperStatus[k]);
    corrections.length = 0;
  }, { timezone: TIMEZONE });

  log(`Scheduler ready: ${config.scrapers.length} lotteries`);

  // Startup catch-up: accept today + yesterday's results
  setTimeout(async () => {
    log('Startup catch-up...');
    try {
      const result = await scrapeAll({ acceptRecent: true });
      const updated = result.results.filter(r =>
        r.results && r.results.some(d => d.updated)
      ).length;
      log(`Catch-up done in ${result.elapsed} — ${updated} lotteries updated`);
    } catch (err) {
      log(`Catch-up error: ${err.message}`);
    }
  }, 5000);

  // Periodic re-scrape every 10 minutes (today only)
  cron.schedule('*/10 * * * *', async () => {
    try {
      const result = await scrapeAll({ acceptRecent: false });
      const updated = result.results.filter(r =>
        r.results && r.results.some(d => d.updated)
      ).length;
      if (updated > 0) log(`Periodic scrape: ${updated} updated in ${result.elapsed}`);
    } catch (err) {
      log(`Periodic scrape error: ${err.message}`);
    }
  }, { timezone: TIMEZONE });
}

function getStatus() {
  return {
    activePollers: Object.keys(activePollers),
    verifyPollers: Object.keys(verifyPollers),
    jobs: scraperStatus,
    corrections
  };
}

module.exports = { init, getStatus, manualScrape, scrapeAll };
