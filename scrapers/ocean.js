const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday } = require('./utils');

const PAGE_URL = 'https://goldoceanlottery.net';
const DRAW_LABELS = ['MAÑANA', 'MEDIO DIA', 'MEDIA TARDE', 'TARDE', 'NOCHE'];

async function fetchAll() {
  const html = await fetchPage(PAGE_URL);
  const $ = cheerio.load(html);
  const results = {};
  const seen = new Set();

  // Hero card — latest draw
  const heroCard = $('.go-card-hero');
  if (heroCard.length) {
    const heroMatch = heroCard.text().match(/NUMEROS\s*-\s*(MAÑANA|MEDIO DIA|MEDIA TARDE|TARDE|NOCHE)/i);
    if (heroMatch) {
      const label = heroMatch[1].toUpperCase();
      const balls = [];
      heroCard.find('.go-ball').each((_, b) => balls.push($(b).text().trim()));
      if (balls.length >= 3) {
        results[label] = { numbers: balls.slice(0, 3), available: !balls.every(b => b === '--') };
        seen.add(label);
      }
    }
  }

  // NUMEROS section — stop at 4 CIFRAS
  let in4Cifras = false;
  $('*').each((_, el) => {
    const text = $(el).text().trim();
    if (text === '4 CIFRAS' && $(el).children().length === 0) { in4Cifras = true; return; }
    if (in4Cifras) return;

    if (DRAW_LABELS.includes(text) && $(el).children().length === 0 && !seen.has(text)) {
      seen.add(text);
      const parent = $(el).closest('[class*="go-draw"]').length
        ? $(el).closest('[class*="go-draw"]')
        : $(el).parent();
      const balls = [];
      parent.find('.go-ball').each((_, b) => balls.push($(b).text().trim()));
      if (balls.length === 0) {
        $(el).parent().next().find('.go-ball').each((_, b) => balls.push($(b).text().trim()));
      }
      if (balls.length >= 3) {
        results[text] = { numbers: balls.slice(0, 3), available: !balls.every(b => b === '--') };
      }
    }
  });

  return results;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const allDraws = await fetchAll();
  const draw = allDraws[drawConfig.drawLabel];

  if (!draw || !draw.available) return null;

  const numbers = draw.numbers.map(n => n.padStart(2, '0'));
  return { numbers, date: getToday(), closed: false };
}

module.exports = { scrapeDraw };
