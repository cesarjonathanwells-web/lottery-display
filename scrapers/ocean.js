const cheerio = require('cheerio');
const { fetchPage } = require('./http');

const URL = 'https://goldoceanlottery.net';

const LABEL_TO_TIME = {
  'MAÑANA': '10:00 AM',
  'MEDIO DIA': '1:00 PM',
  'MEDIA TARDE': '3:00 PM',
  'TARDE': '6:00 PM',
  'NOCHE': '9:00 PM'
};

/**
 * Scrapes goldoceanlottery.net. Parses hero card for latest draw,
 * then NUMEROS section only (stops before 4 CIFRAS).
 */
async function scrape() {
  try {
    const html = await fetchPage(URL);
    const $ = cheerio.load(html);
    const results = {};
    const labelTexts = ['MAÑANA', 'MEDIO DIA', 'MEDIA TARDE', 'TARDE', 'NOCHE'];
    const seen = new Set();

    // 1. Hero card — latest draw
    const heroCard = $('.go-card-hero');
    if (heroCard.length) {
      const heroMatch = heroCard.text().match(/NUMEROS\s*-\s*(MAÑANA|MEDIO DIA|MEDIA TARDE|TARDE|NOCHE)/i);
      if (heroMatch) {
        const heroLabel = heroMatch[1].toUpperCase();
        const heroBalls = [];
        heroCard.find('.go-ball').each((_, b) => heroBalls.push($(b).text().trim()));
        if (heroBalls.length >= 3) {
          results[heroLabel] = { numbers: heroBalls.slice(0, 3), available: !heroBalls.every(b => b === '--') };
          seen.add(heroLabel);
        }
      }
    }

    // 2. NUMEROS section only — stop at 4 CIFRAS
    let in4Cifras = false;
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      if (text === '4 CIFRAS' && $(el).children().length === 0) { in4Cifras = true; return; }
      if (in4Cifras) return;

      if (labelTexts.includes(text) && $(el).children().length === 0 && !seen.has(text)) {
        seen.add(text);
        const parent = $(el).closest('[class*="go-draw"]').length ? $(el).closest('[class*="go-draw"]') : $(el).parent();
        const balls = [];
        parent.find('.go-ball').each((_, b) => balls.push($(b).text().trim()));
        if (balls.length === 0) {
          const nextRow = $(el).parent().next();
          nextRow.find('.go-ball').each((_, b) => balls.push($(b).text().trim()));
        }
        if (balls.length >= 3) {
          results[text] = { numbers: balls.slice(0, 3), available: !balls.every(b => b === '--') };
        }
      }
    });

    return results;
  } catch (err) {
    console.error('[ocean] Scrape error:', err.message);
    return {};
  }
}

function getDraw(drawLabel, scrapedData) {
  return scrapedData[drawLabel] || null;
}

function formatNumbers(numbers) {
  return numbers.map(n => n.padStart(2, '0'));
}

module.exports = { scrape, getDraw, formatNumbers, LABEL_TO_TIME };
