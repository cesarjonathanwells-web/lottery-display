const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const conectate = require('./conectate');
const ocean = require('./ocean');
const lotterypost = require('./lotterypost');

const DATA_FILE = path.join(__dirname, '..', 'data', 'results.json');
const CONFIG_FILE = path.join(__dirname, '..', 'data', 'scraper-config.json');

// Active polling jobs: key = "lotteryId:drawIndex", value = interval ID
const activePollers = {};

// Status tracking for admin panel
const scraperStatus = {};

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

  const drawIdx = findDrawIndex(found.lottery, drawTime);
  if (drawIdx === -1) {
    // Draw doesn't exist yet, add it
    found.lottery.draws.push({ time: drawTime, numbers: numbers || [], status: status || null });
  } else {
    if (numbers) found.lottery.draws[drawIdx].numbers = numbers;
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

/**
 * Run a single scrape attempt for a lottery draw.
 * Returns the formatted numbers if new results found, null otherwise.
 */
async function runScrape(scraperConfig, drawConfig) {
  const source = scraperConfig.source;

  try {
    if (source === 'manual') return null;
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

  // Compare arrays
  const currentStr = current.filter(n => n !== '-').join(',');
  const newStr = newNumbers.filter(n => n !== '-').join(',');
  return currentStr !== newStr;
}

/**
 * Start polling for a specific lottery draw.
 */
function startPolling(scraperConfig, drawConfig, drawIndex) {
  const key = `${scraperConfig.lotteryId}:${drawIndex}`;

  // Don't start if already polling
  if (activePollers[key]) {
    log(`Already polling ${key}`);
    return;
  }

  const config = readConfig();
  const pollInterval = (config.pollIntervalSeconds || 45) * 1000;
  const timeoutMs = (config.defaultTimeoutMinutes || 120) * 60 * 1000;
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
    attempts: 0
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

    const numbers = await runScrape(scraperConfig, drawConfig);

    if (numbers && hasNewNumbers(scraperConfig.lotteryId, drawConfig.time, numbers)) {
      log(`New result for ${scraperConfig.lotteryId} "${drawConfig.time}": ${numbers.join(',')}`);
      updateDraw(scraperConfig.lotteryId, drawConfig.time, numbers, null);
      stopPolling(key);
      scraperStatus[key].status = 'completed';
      scraperStatus[key].result = numbers;
    }
  }
}

/**
 * Stop polling for a specific key.
 */
function stopPolling(key) {
  if (activePollers[key]) {
    clearInterval(activePollers[key]);
    delete activePollers[key];
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
    const numbers = await runScrape(scraperConfig, drawConfig);
    if (numbers && numbers.length > 0) {
      updateDraw(lotteryId, drawConfig.time, numbers, null);
      results.push({ time: drawConfig.time, numbers, updated: true });
    } else {
      results.push({ time: drawConfig.time, numbers: null, updated: false });
    }
  }
  return { lotteryId, results };
}

/**
 * Initialize the scheduler. Sets up cron jobs for each lottery draw.
 */
function init() {
  const config = readConfig();
  log('Initializing scraper scheduler...');

  for (const scraperConfig of config.scrapers) {
    for (let di = 0; di < scraperConfig.draws.length; di++) {
      const drawConfig = scraperConfig.draws[di];
      const [hours, minutes] = drawConfig.startPolling.split(':').map(Number);

      // Create cron expression: "minutes hours * * *" (every day)
      const cronExpr = `${minutes} ${hours} * * *`;

      cron.schedule(cronExpr, () => {
        startPolling(scraperConfig, drawConfig, di);
      }, { timezone: config.timezone || 'America/New_York' });

      log(`  Scheduled ${scraperConfig.lotteryId} "${drawConfig.time}" → poll at ${drawConfig.startPolling}`);
    }
  }

  // Daily reset at midnight: clear all statuses
  cron.schedule('0 0 * * *', () => {
    log('Midnight reset: clearing all scraper statuses');
    for (const key of Object.keys(activePollers)) {
      stopPolling(key);
    }
    for (const key of Object.keys(scraperStatus)) {
      delete scraperStatus[key];
    }
  }, { timezone: config.timezone || 'America/New_York' });

  log(`Scheduler initialized with ${config.scrapers.length} lottery configs`);
}

/**
 * Get current scraper status for all jobs.
 */
function getStatus() {
  return {
    activePollers: Object.keys(activePollers),
    jobs: scraperStatus
  };
}

module.exports = { init, getStatus, manualScrape };
