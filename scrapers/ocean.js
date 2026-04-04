const cheerio = require('cheerio');
const { fetchPage } = require('./http');
const { getToday } = require('./utils');

const PAGE_URL = 'https://goldoceanlottery.net';

async function fetchAll() {
  const html = await fetchPage(PAGE_URL);
  const $ = cheerio.load(html);
  const results = {};

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
