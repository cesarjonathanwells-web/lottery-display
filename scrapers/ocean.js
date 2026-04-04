const axios = require('axios');
const cheerio = require('cheerio');

const URL = 'https://goldoceanlottery.net';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
};

// Map Ocean draw labels to our draw times
const LABEL_TO_TIME = {
  'MAÑANA': '10:00 AM',
  'MEDIO DIA': '1:00 PM',
  'MEDIA TARDE': '3:00 PM',
  'TARDE': '6:00 PM',
  'NOCHE': '9:00 PM'
};

// Reverse map
const TIME_TO_LABEL = {};
for (const [k, v] of Object.entries(LABEL_TO_TIME)) TIME_TO_LABEL[v] = k;

/**
 * Scrapes goldoceanlottery.net and returns draw results.
 *
 * The page has:
 *  1. A hero card at top showing the latest draw (e.g. "JUEGO: NUMEROS - NOCHE")
 *  2. A "NUMEROS" section with MAÑANA / MEDIO DIA / MEDIA TARDE / TARDE / NOCHE rows
 *  3. A "4 CIFRAS" section with duplicate labels — we must SKIP this
 *
 * We only take the FIRST occurrence of each label (the NUMEROS section),
 * and also parse the hero for the latest draw which may not be in the list yet.
 *
 * Returns: { "MAÑANA": { numbers: ["57", "14", "91"], available: true }, ... }
 */
async function scrape() {
  const { data: html } = await axios.get(URL, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const results = {};

  const labelTexts = ['MAÑANA', 'MEDIO DIA', 'MEDIA TARDE', 'TARDE', 'NOCHE'];
  const seen = new Set();

  // 1. Parse the hero card for the latest draw
  const heroCard = $('.go-card-hero');
  if (heroCard.length) {
    const heroText = heroCard.text();
    const heroMatch = heroText.match(/NUMEROS\s*-\s*(MAÑANA|MEDIO DIA|MEDIA TARDE|TARDE|NOCHE)/i);
    if (heroMatch) {
      const heroLabel = heroMatch[1].toUpperCase();
      const heroBalls = [];
      heroCard.find('.go-ball').each((_, b) => heroBalls.push($(b).text().trim()));
      if (heroBalls.length >= 3) {
        const available = !heroBalls.every(b => b === '--' || b === '—');
        results[heroLabel] = { numbers: heroBalls.slice(0, 3), available };
        seen.add(heroLabel);
      }
    }
  }

  // 2. Parse the NUMEROS section — take only FIRST occurrence of each label
  //    (before 4 CIFRAS section starts)
  let in4Cifras = false;

  $('*').each((_, el) => {
    const text = $(el).text().trim();

    // Detect when we enter the 4 CIFRAS section — stop collecting
    if (text === '4 CIFRAS' && $(el).children().length === 0) {
      in4Cifras = true;
      return;
    }

    if (in4Cifras) return;

    if (labelTexts.includes(text) && $(el).children().length === 0 && !seen.has(text)) {
      seen.add(text);

      const parent = $(el).closest('[class*="go-draw"]').length
        ? $(el).closest('[class*="go-draw"]')
        : $(el).parent();

      const balls = [];
      parent.find('.go-ball').each((_, b) => balls.push($(b).text().trim()));

      if (balls.length === 0) {
        const nextRow = $(el).parent().next();
        nextRow.find('.go-ball').each((_, b) => balls.push($(b).text().trim()));
      }

      if (balls.length >= 3) {
        const available = !balls.every(b => b === '--' || b === '—');
        results[text] = { numbers: balls.slice(0, 3), available };
      }
    }
  });

  return results;
}

/**
 * Get result for a specific draw label.
 */
function getDraw(drawLabel, scrapedData) {
  return scrapedData[drawLabel] || null;
}

/**
 * Format Ocean numbers into our pick3 format.
 */
function formatNumbers(numbers) {
  return numbers.map(n => n.padStart(2, '0'));
}

module.exports = { scrape, getDraw, formatNumbers, LABEL_TO_TIME };
