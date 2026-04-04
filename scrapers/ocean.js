const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday, log } = require('./utils');

const PAGE_URL = 'https://goldoceanlottery.net';
const DRAW_ORDER = ['MAÑANA', 'MEDIO DIA', 'MEDIA TARDE', 'TARDE', 'NOCHE'];

const SPANISH_MONTHS = {
  'ENERO': '01', 'FEBRERO': '02', 'MARZO': '03', 'ABRIL': '04',
  'MAYO': '05', 'JUNIO': '06', 'JULIO': '07', 'AGOSTO': '08',
  'SEPTIEMBRE': '09', 'OCTUBRE': '10', 'NOVIEMBRE': '11', 'DICIEMBRE': '12'
};

function parseHeroDate($) {
  const text = $('.go-card-hero h1').text().trim();
  // Format: "ABRIL 4, 2026"
  const match = text.match(/^(\w+)\s+(\d+),?\s+(\d{4})$/);
  if (match) {
    const month = SPANISH_MONTHS[match[1].toUpperCase()];
    if (month) return `${match[3]}-${month}-${String(match[2]).padStart(2, '0')}`;
  }
  return getToday();
}

async function fetchAll() {
  const html = await fetchPage(PAGE_URL);
  const $ = cheerio.load(html);
  const results = {};
  const date = parseHeroDate($);

  // Parse NUMEROS section from results card
  const resultsCard = $('.go-card-results');
  const numerosSection = resultsCard.find('.mb-4').first();

  numerosSection.find('.go-result-row').each((_, row) => {
    const $row = $(row);
    const label = $row.find('.go-time-label').text().trim();
    if (!label) return;

    const numbers = [];
    $row.find('.go-ball--numeros').each((_, ball) => {
      numbers.push($(ball).text().trim());
    });

    const available = numbers.length > 0 && !numbers.every(n => n === '--');
    results[label] = { numbers, available };
  });

  // Parse hero card — shows the latest completed draw
  const heroCard = $('.go-card-hero');
  if (heroCard.length) {
    const heroNumbers = [];
    heroCard.find('.go-ball--numeros').each((_, ball) => {
      heroNumbers.push($(ball).text().trim());
    });
    const heroAvailable = heroNumbers.length > 0 && !heroNumbers.every(n => n === '--');

    if (heroAvailable) {
      const heroKey = heroNumbers.join(',');
      const alreadyCaptured = DRAW_ORDER.some(label => {
        const r = results[label];
        return r && r.available && r.numbers.join(',') === heroKey;
      });

      if (!alreadyCaptured) {
        const juegoText = heroCard.find('h2').text().trim();
        const labelMatch = juegoText.match(/JUEGO:\s*(.+)/i);
        const heroLabel = labelMatch && labelMatch[1].trim() ? labelMatch[1].trim() : null;

        if (heroLabel && DRAW_ORDER.includes(heroLabel)) {
          results[heroLabel] = { numbers: heroNumbers, available: true };
        } else {
          for (const label of DRAW_ORDER) {
            if (!results[label] || !results[label].available) {
              results[label] = { numbers: heroNumbers, available: true };
              break;
            }
          }
        }
      }
    }
  }

  return { draws: results, date };
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const { draws, date } = await fetchAll();
  const draw = draws[drawConfig.drawLabel];

  if (!draw || !draw.available) return null;

  const numbers = draw.numbers.map(n => n.padStart(2, '0'));
  log(`ocean "${drawConfig.drawLabel}" source date: ${date}`);
  return { numbers, date, closed: false };
}

module.exports = { scrapeDraw };
