const TIMEZONE = 'America/New_York';

// Viewers read the board in AST, which never changes. US draws run on Eastern
// time, so they land an hour later in AST during US standard time.
const LOCAL_TIMEZONE = 'America/Tortola';
const US_LOTTERIES = new Set(['newyork', 'florida', 'georgia', 'newjersey', 'connecticut']);

function getToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function getNowEST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

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

function isUSLottery(lotteryId) {
  return US_LOTTERIES.has(lotteryId);
}

// The clock a lottery's draw times are written in, and its cron jobs run on.
function drawTimezone(lotteryId) {
  return isUSLottery(lotteryId) ? TIMEZONE : LOCAL_TIMEZONE;
}

function hourIn(instant, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(instant));
}

// Draw times stay in Eastern everywhere (cron, keys, slot matching). This only
// makes the label viewers see. dateStr picks the offset, so it follows DST on
// its own. A late draw can wrap past midnight, e.g. 11:40 PM -> 12:40 AM.
function toLocalTime(timeStr, dateStr) {
  const parsed = parseDrawTime(timeStr);
  if (!parsed) return timeStr;
  const instant = new Date(`${dateStr}T16:00:00Z`);
  if (Number.isNaN(instant.getTime())) return timeStr;
  const offset = (hourIn(instant, LOCAL_TIMEZONE) - hourIn(instant, TIMEZONE) + 24) % 24;
  const hours = (parsed.hours + offset) % 24;
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(parsed.minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

function hasTimePassed(timeStr) {
  const parsed = parseDrawTime(timeStr);
  if (!parsed) return true;
  const now = getNowEST();
  return (now.getHours() * 60 + now.getMinutes()) >= (parsed.hours * 60 + parsed.minutes);
}

function isToday(dateStr) {
  return dateStr === getToday();
}

function isRecent(dateStr) {
  if (!dateStr) return false;
  if (isToday(dateStr)) return true;
  const yesterday = new Date(getNowEST());
  yesterday.setDate(yesterday.getDate() - 1);
  return dateStr === yesterday.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function cachedFetch(cache, key, ttl, fetcher) {
  const entry = cache.get(key);
  if (entry && (Date.now() - entry.ts) < ttl) {
    return entry.data;
  }
  const data = await fetcher();
  cache.set(key, { data, ts: Date.now() });
  return data;
}

function padNumbers(arr) {
  return arr.map(n => String(n).padStart(2, '0'));
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: TIMEZONE });
  console.log(`[Scraper ${ts}] ${msg}`);
}

module.exports = { TIMEZONE, LOCAL_TIMEZONE, isUSLottery, drawTimezone, toLocalTime, getToday, getNowEST, parseDrawTime, hasTimePassed, isToday, isRecent, cachedFetch, padNumbers, log };
