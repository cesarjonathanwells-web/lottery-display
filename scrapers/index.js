const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const conectate = require('./conectate');
const ocean = require('./ocean');
const lotterypost = require('./lotterypost');
const anguilla = require('./anguilla');

const DATA_FILE = path.join(__dirname, '..', 'data', 'results.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'scraper-config.json');

// Active polling jobs: key = "lotteryId:drawIndex", value = interval ID
const activePollers = {};

// Verification polling jobs (post-result monitoring)
const verifyPollers = {};

// Status tracking for admin panel
const scraperStatus = {};

// Correction log
const corrections = [];

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
  console.log(`[Scraper ${ts}] ${msg}`);
}

/**
 * Find a lottery in results.json by ID and return its reference + column/lottery indices.
 */
function findLottery(data, lotteryId) {
  for (let ci = 0; ci < data.columns.length; ci++) {
    for (let li = 0; li < data.columns[ci].lotteries.length; li++) {
      if (data.columns[ci].lotteries[li].id === lotteryId) {
        return { lottery: data.columns[ci].lotteries[li], ci, li };
      }
    }
  }
  return null;
}

/**
 * Find the draw index in a lottery that matches the given time string.
 */
function findDrawIndex(lottery, drawTime) {
  return lottery.draws.findIndex(d => d.time === drawTime);
}

/**
 * Update a draw's numbers and status in results.json.
 */
function updateDraw(lotteryId, drawTime, numbers, status) {
  const data = readData();
  const found = findLottery(data, lotteryId);
  if (!found) {
    log(`Lottery ${lotteryId} not found in results.json`);
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  const drawIdx = findDrawIndex(found.lottery, drawTime);
  if (drawIdx === -1) {
    // Draw doesn't exist yet, add it
    found.lottery.draws.push({ time: drawTime, numbers: numbers || [], status: status || null, date: today });
  } else {
    if (numbers) {
      found.lottery.draws[drawIdx].numbers = numbers;
      found.lottery.draws[drawIdx].date = today;
    }
    found.lottery.draws[drawIdx].status = status || null;
  }

  writeData(data);
  return true;
}

/**
 * Set a draw to "pending" status.
 */
function setPending(lotteryId, drawTime) {
  updateDraw(lotteryId, drawTime, null, 'pending');
}

/**
 * Set a draw to "no_result" after timeout.
 */
function setNoResult(lotteryId, drawTime) {
  updateDraw(lotteryId, drawTime, null, 'no_result');
}

// ── Source-specific scrape functions ──

async function scrapeConectate(scraperConfig, drawConfig) {
  const scrapedData = await conectate.scrape();
  const game = conectate.getGame(drawConfig.gameName, scrapedData);

  if (!game) return null;

  // If lottery is closed today, return special signal
  if (game.closed) return { closed: true };

  if (!conectate.isToday(game.date)) return null;

  // Determine format based on lottery type in results.json
  const data = readData();
  const found = findLottery(data, scraperConfig.lotteryId);
  const lotteryFormat = found ? found.lottery.format : 'pick3';

  return conectate.formatNumbers(game.numbers, lotteryFormat);
}

async function scrapeOcean(scraperConfig, drawConfig) {
  const scrapedData = await ocean.scrape();
  const draw = ocean.getDraw(drawConfig.drawLabel, scrapedData);

  if (!draw || !draw.available) return null;
  return ocean.formatNumbers(draw.numbers);
}

async function scrapeLotterypost(scraperConfig, drawConfig) {
  const scrapedData = await lotterypost.scrape(scraperConfig.state);
  const { pick3, pick4 } = lotterypost.getDrawNumbers(
    scraperConfig.state,
    drawConfig.gameNames,
    scrapedData
  );

  if (!pick3 && !pick4) return null;

  // Determine format from the lottery in results.json
  const data = readData();
  const found = findLottery(data, scraperConfig.lotteryId);
  const format = found ? found.lottery.format : 'pick34';

  return lotterypost.formatNumbers(pick3, pick4, format);
}

async function scrapeAnguilla(scraperConfig, drawConfig) {
  const result = await anguilla.scrapeDraw(drawConfig.time);
  if (!result) return null;
  if (result.closed) return { closed: true };

  const today = new Date().toISOString().slice(0, 10);
  if (result.date !== today) return null; // not today's result

  return result.numbers;
}

/**
 * Run a single scrape attempt for a lottery draw.
 * Returns the formatted numbers if new results found, null otherwise.
 */
async function runScrape(scraperConfig, drawConfig) {
  const source = scraperConfig.source;

  try {
    if (source === 'manual') return null;
    if (source === 'anguilla') return await scrapeAnguilla(scraperConfig, drawConfig);
    if (source === 'conectate') return await scrapeConectate(scraperConfig, drawConfig);
    if (source === 'ocean') return await scrapeOcean(scraperConfig, drawConfig);
    if (source === 'lotterypost') return await scrapeLotterypost(scraperConfig, drawConfig);
    log(`Unknown source: ${source}`);
    return null;
  } catch (err) {
    log(`Scrape error for ${scraperConfig.lotteryId} (${source}): ${err.message}`);
    return null;
  }
}

/**
 * Validate scraped numbers match expected format.
 * Returns { valid: true } or { valid: false, reason: "..." }
 */
function validateNumbers(numbers, lotteryId) {
  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return { valid: false, reason: 'empty or not an array' };
  }

  const data = readData();
  const found = findLottery(data, lotteryId);
  if (!found) return { valid: true }; // can't validate without format info

  const format = found.lottery.format;
  const digits = numbers.filter(n => n !== '-');

  // Check no empty strings or undefined
  if (digits.some(d => !d || d.trim() === '' || d === '--')) {
    return { valid: false, reason: 'contains empty or placeholder values' };
  }

  if (format === 'pick3') {
    // Expect 3 numbers, each 1-2 digits, range 00-99
    if (digits.length !== 3) return { valid: false, reason: `pick3 expects 3 numbers, got ${digits.length}` };
    for (const d of digits) {
      const n = parseInt(d, 10);
      if (isNaN(n) || n < 0 || n > 99) return { valid: false, reason: `invalid pick3 number: ${d}` };
    }
  } else if (format === 'pick34') {
    // Expect 7 single digits (3 + separator + 4)
    if (digits.length !== 7) return { valid: false, reason: `pick34 expects 7 digits, got ${digits.length}` };
    for (const d of digits) {
      const n = parseInt(d, 10);
      if (isNaN(n) || n < 0 || n > 9) return { valid: false, reason: `invalid pick34 digit: ${d}` };
    }
  } else if (format === 'florida') {
    // Expect 9-10 single digits (2 + 3 + 4 with separators)
    if (digits.length < 9) return { valid: false, reason: `florida expects 9+ digits, got ${digits.length}` };
    for (const d of digits) {
      const n = parseInt(d, 10);
      if (isNaN(n) || n < 0 || n > 9) return { valid: false, reason: `invalid florida digit: ${d}` };
    }
  }

  return { valid: true };
}

/**
 * Check if scraped numbers differ from current stored numbers.
 */
function hasNewNumbers(lotteryId, drawTime, newNumbers) {
  if (!newNumbers || newNumbers.length === 0) return false;

  const data = readData();
  const found = findLottery(data, lotteryId);
  if (!found) return true;

  const drawIdx = findDrawIndex(found.lottery, drawTime);
  if (drawIdx === -1) return true;

  const current = found.lottery.draws[drawIdx].numbers;
  if (!current || current.length === 0) return true;

  const currentStr = current.filter(n => n !== '-').join(',');
  const newStr = newNumbers.filter(n => n !== '-').join(',');
  return currentStr !== newStr;
}

/**
 * Check if a draw already has published numbers (not pending/no_result).
 */
function hasPublishedNumbers(lotteryId, drawTime) {
  const data = readData();
  const found = findLottery(data, lotteryId);
  if (!found) return false;
  const drawIdx = findDrawIndex(found.lottery, drawTime);
  if (drawIdx === -1) return false;
  const draw = found.lottery.draws[drawIdx];
  return draw.numbers && draw.numbers.length > 0 && !draw.status;
}

/**
 * Start polling for a specific lottery draw.
 */
function startPolling(scraperConfig, drawConfig, drawIndex) {
  const key = `${scraperConfig.lotteryId}:${drawIndex}`;

  // Don't start if already polling or verifying
  if (activePollers[key] || verifyPollers[key]) {
    log(`Already polling/verifying ${key}`);
    return;
  }

  const config = readConfig();
  const pollInterval = (config.pollIntervalSeconds || 45) * 1000;
  const timeoutMs = (config.defaultTimeoutMinutes || 120) * 60 * 1000;
  const verifyMs = (config.verifyMinutes || 15) * 60 * 1000;
  const startTime = Date.now();

  log(`Starting poll for ${scraperConfig.lotteryId} "${drawConfig.time}"`);
  setPending(scraperConfig.lotteryId, drawConfig.time);

  scraperStatus[key] = {
    lotteryId: scraperConfig.lotteryId,
    drawTime: drawConfig.time,
    source: scraperConfig.source,
    status: 'polling',
    startedAt: new Date().toISOString(),
    lastCheck: null,
    attempts: 0,
    corrected: false
  };

  // Immediate first check
  poll();

  // Then poll every 45 seconds
  activePollers[key] = setInterval(poll, pollInterval);

  async function poll() {
    const elapsed = Date.now() - startTime;
    scraperStatus[key].attempts++;
    scraperStatus[key].lastCheck = new Date().toISOString();

    // Check timeout
    if (elapsed > timeoutMs) {
      log(`Timeout for ${scraperConfig.lotteryId} "${drawConfig.time}" after ${Math.round(elapsed / 60000)}min`);
      stopPolling(key);
      setNoResult(scraperConfig.lotteryId, drawConfig.time);
      scraperStatus[key].status = 'timeout';
      return;
    }

    const result = await runScrape(scraperConfig, drawConfig);
    if (!result) return;

    // Check if lottery is closed today
    if (result.closed) {
      log(`Lottery closed today: ${scraperConfig.lotteryId} "${drawConfig.time}"`);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, null, 'closed');
      stopPolling(key);
      scraperStatus[key].status = 'closed';
      return;
    }

    const numbers = result;

    // Validate before publishing
    const validation = validateNumbers(numbers, scraperConfig.lotteryId);
    if (!validation.valid) {
      log(`Rejected invalid numbers for ${scraperConfig.lotteryId} "${drawConfig.time}": ${validation.reason}`);
      scraperStatus[key].lastRejection = validation.reason;
      return; // keep polling for valid data
    }

    if (hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, numbers)) {
      log(`New result for ${scraperConfig.lotteryId} "${drawConfig.time}": ${numbers.join(',')}`);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, numbers, null);
      scraperStatus[key].result = numbers;

      // Stop initial polling, start verification polling
      stopPolling(key);
      scraperStatus[key].status = 'verifying';
      startVerification(key, scraperConfig, drawConfig, numbers, verifyMs, pollInterval);
    }
  }
}

/**
 * Verification polling: keep checking for 15 min after initial result.
 * If the source corrects the numbers, auto-update and flag as corrected.
 */
function startVerification(key, scraperConfig, drawConfig, originalNumbers, verifyMs, pollInterval) {
  const verifyStart = Date.now();

  log(`Starting verification for ${scraperConfig.lotteryId} "${drawConfig.time}" (${Math.round(verifyMs / 60000)}min)`);

  verifyPollers[key] = setInterval(async () => {
    const elapsed = Date.now() - verifyStart;

    // Verification window expired — all good
    if (elapsed > verifyMs) {
      log(`Verification complete for ${scraperConfig.lotteryId} "${drawConfig.time}" — no corrections`);
      stopVerification(key);
      scraperStatus[key].status = 'completed';
      return;
    }

    try {
      const numbers = await runScrape(scraperConfig, drawConfig);
      if (!numbers) return;

      const validation = validateNumbers(numbers, scraperConfig.lotteryId);
      if (!validation.valid) return;

      if (hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, numbers)) {
        // Source corrected the numbers!
        const oldNums = scraperStatus[key].result || originalNumbers;
        log(`CORRECTION for ${scraperConfig.lotteryId} "${drawConfig.time}": ${oldNums.join(',')} → ${numbers.join(',')}`);

        updateDraw(scraperConfig.lotteryId, drawConfig.time, numbers, null);

        // Flag as corrected in the draw data
        const data = readData();
        const found = findLottery(data, scraperConfig.lotteryId);
        if (found) {
          const drawIdx = findDrawIndex(found.lottery, drawConfig.time);
          if (drawIdx !== -1) {
            found.lottery.draws[drawIdx].corrected = true;
            writeData(data);
          }
        }

        // Log the correction
        corrections.push({
          lotteryId: scraperConfig.lotteryId,
          drawTime: drawConfig.time,
          oldNumbers: oldNums,
          newNumbers: numbers,
          correctedAt: new Date().toISOString()
        });

        scraperStatus[key].result = numbers;
        scraperStatus[key].corrected = true;
      }
    } catch (err) {
      log(`Verify error for ${scraperConfig.lotteryId}: ${err.message}`);
    }
  }, pollInterval);
}

/**
 * Stop initial polling for a specific key.
 */
function stopPolling(key) {
  if (activePollers[key]) {
    clearInterval(activePollers[key]);
    delete activePollers[key];
  }
}

/**
 * Stop verification polling for a specific key.
 */
function stopVerification(key) {
  if (verifyPollers[key]) {
    clearInterval(verifyPollers[key]);
    delete verifyPollers[key];
  }
}

/**
 * Manually trigger a scrape for a lottery (all its draws).
 */
async function manualScrape(lotteryId) {
  const config = readConfig();
  const scraperConfig = config.scrapers.find(s => s.lotteryId === lotteryId);
  if (!scraperConfig) return { error: `No scraper config for ${lotteryId}` };

  const results = [];
  for (let i = 0; i < scraperConfig.draws.length; i++) {
    const drawConfig = scraperConfig.draws[i];
    const result = await runScrape(scraperConfig, drawConfig);

    if (result && result.closed) {
      updateDraw(lotteryId, drawConfig.time, null, 'closed');
      results.push({ time: drawConfig.time, numbers: null, closed: true, updated: true });
    } else if (result && Array.isArray(result) && result.length > 0) {
      updateDraw(lotteryId, drawConfig.time, result, null);
      results.push({ time: drawConfig.time, numbers: result, updated: true });
    } else {
      results.push({ time: drawConfig.time, numbers: null, updated: false });
    }
  }
  return { lotteryId, results };
}

/**
 * Scrape ALL lotteries in parallel. One call updates everything.
 */
async function scrapeAll() {
  const config = readConfig();
  const allScrapers = config.scrapers.filter(s => s.source !== 'manual');

  const startMs = Date.now();
  log('Scrape-all started');

  const results = await Promise.all(allScrapers.map(async (sc) => {
    try {
      return { lotteryId: sc.lotteryId, ...(await manualScrape(sc.lotteryId)) };
    } catch (err) {
      return { lotteryId: sc.lotteryId, error: err.message };
    }
  }));

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  log(`Scrape-all finished in ${elapsed}s`);

  return { elapsed: `${elapsed}s`, results };
}

/**
 * Parse a draw time like "2:30 PM" or "10:00 AM" into { hours, minutes } in 24h format.
 */
function parseDrawTime(timeStr) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours !== 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return { hours, minutes };
}

/**
 * Initialize the scheduler. Sets up cron jobs for each lottery draw.
 * Polling starts AT the draw time (not before).
 */
function init() {
  const config = readConfig();
  log('Initializing scraper scheduler...');

  for (const scraperConfig of config.scrapers) {
    for (let di = 0; di < scraperConfig.draws.length; di++) {
      const drawConfig = scraperConfig.draws[di];
      const parsed = parseDrawTime(drawConfig.time);
      if (!parsed) {
        log(`  Skipping ${scraperConfig.lotteryId} "${drawConfig.time}" — could not parse time`);
        continue;
      }

      const cronExpr = `${parsed.minutes} ${parsed.hours} * * *`;

      cron.schedule(cronExpr, () => {
        startPolling(scraperConfig, drawConfig, di);
      }, { timezone: config.timezone || 'America/New_York' });

      log(`  Scheduled ${scraperConfig.lotteryId} "${drawConfig.time}" → poll at ${String(parsed.hours).padStart(2,'0')}:${String(parsed.minutes).padStart(2,'0')}`);
    }
  }

  // Daily reset at midnight: clear all statuses and correction log
  cron.schedule('0 0 * * *', () => {
    log('Midnight reset: clearing all scraper statuses');
    for (const key of Object.keys(activePollers)) {
      stopPolling(key);
    }
    for (const key of Object.keys(verifyPollers)) {
      stopVerification(key);
    }
    for (const key of Object.keys(scraperStatus)) {
      delete scraperStatus[key];
    }
    corrections.length = 0;
  }, { timezone: config.timezone || 'America/New_York' });

  log(`Scheduler initialized with ${config.scrapers.length} lottery configs`);
}

/**
 * Get current scraper status for all jobs.
 */
function getStatus() {
  return {
    activePollers: Object.keys(activePollers),
    verifyPollers: Object.keys(verifyPollers),
    jobs: scraperStatus,
    corrections
  };
}

module.exports = { init, getStatus, manualScrape, scrapeAll };
