const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday } = require('./utils');

const PAGE_URL = 'https://goldoceanlottery.net';
const DRAW_ORDER = ['MAÑANA', 'MEDIO DIA', 'MEDIA TARDE', 'TARDE', 'NOCHE'];

async function fetchAll() {
  const html = await fetchPage(PAGE_URL);
  const $ = cheerio.load(html);
  const results = {};

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
      // Check if hero numbers already appear in a NUMEROS row
      const heroKey = heroNumbers.join(',');
      const alreadyCaptured = DRAW_ORDER.some(label => {
        const r = results[label];
        return r && r.available && r.numbers.join(',') === heroKey;
      });

      if (!alreadyCaptured) {
        // Try to extract draw label from "JUEGO: <label>" text
        const juegoText = heroCard.find('h2').text().trim();
        const labelMatch = juegoText.match(/JUEGO:\s*(.+)/i);
        const heroLabel = labelMatch && labelMatch[1].trim() ? labelMatch[1].trim() : null;

        if (heroLabel && DRAW_ORDER.includes(heroLabel)) {
          results[heroLabel] = { numbers: heroNumbers, available: true };
        } else {
          // No explicit label — assign to the first unavailable draw
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

  return results;
}

async function scrapeDraw(scraperConfig, drawConfig) {
  const results = await fetchAll();
  const draw = results[drawConfig.drawLabel];

  if (!draw || !draw.available) return null;

  const numbers = draw.numbers.map(n => n.padStart(2, '0'));
  return { numbers, date: getToday(), closed: false };
}

module.exports = { scrapeDraw };
