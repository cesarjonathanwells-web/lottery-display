const TIMEZONE = 'America/New_York';

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
  return dateStr === yesterday.toISOString().slice(0, 10);
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { timeZone: TIMEZONE });
  console.log(`[Scraper ${ts}] ${msg}`);
}

module.exports = { TIMEZONE, getToday, getNowEST, parseDrawTime, hasTimePassed, isToday, isRecent, log };
