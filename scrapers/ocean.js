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

/**
 * Scrapes goldoceanlottery.net and returns draw results.
 * Returns: { "MAÑANA": { numbers: ["57", "14", "91"], available: true }, ... }
 */
async function scrape() {
  const { data: html } = await axios.get(URL, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const results = {};

  // Find all elements that contain draw labels
  const labelTexts = ['MAÑANA', 'MEDIO DIA', 'MEDIA TARDE', 'TARDE', 'NOCHE'];

  // The page has draw sections with labels and ball elements
  // Structure: parent container has label + .go-result-row with .go-ball elements
  $('*').each((_, el) => {
    const text = $(el).text().trim();
    if (labelTexts.includes(text) && $(el).children().length === 0) {
      // This is a label element - find the associated balls
      const parent = $(el).closest('[class*="go-draw"]').length
        ? $(el).closest('[class*="go-draw"]')
        : $(el).parent();

      const balls = [];
      parent.find('.go-ball').each((_, b) => {
        balls.push($(b).text().trim());
      });

      // If no balls in immediate parent, look in next sibling row
      if (balls.length === 0) {
        const nextRow = $(el).parent().next();
        nextRow.find('.go-ball').each((_, b) => {
          balls.push($(b).text().trim());
        });
      }

      if (balls.length > 0) {
        const available = !balls.every(b => b === '--' || b === '—');
        // Take first 3 as the pick-3 numbers (4th is bonus/gold ball)
        const numbers = balls.slice(0, 3);
        results[text] = { numbers, available };
      }
    }
  });

  return results;
}

/**
 * Get result for a specific draw label.
 * @param {string} drawLabel - "MAÑANA", "MEDIO DIA", etc.
 * @param {object} scrapedData - Result from scrape()
 * @returns {{ numbers: string[], available: boolean } | null}
 */
function getDraw(drawLabel, scrapedData) {
  return scrapedData[drawLabel] || null;
}

/**
 * Format Ocean numbers into our pick3 format.
 * Ocean shows 2-digit numbers already.
 */
function formatNumbers(numbers) {
  return numbers.map(n => n.padStart(2, '0'));
}

module.exports = { scrape, getDraw, formatNumbers, LABEL_TO_TIME };
