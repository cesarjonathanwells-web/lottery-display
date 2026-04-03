const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.lotterypost.com/results';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Referer': 'https://www.lotterypost.com/'
};

/**
 * Scrapes lotterypost.com for a specific state.
 * @param {string} state - State abbreviation: ny, ct, ga, fl, nj
 * Returns: { "Numbers Midday": { numbers: ["9","5","6"], date: "Friday, April 3, 2026" }, ... }
 */
async function scrape(state) {
  const url = `${BASE_URL}/${state}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const results = {};

  $('.resultsgame').each((_, game) => {
    const $game = $(game);
    const h2 = $game.find('h2').first();
    if (!h2.length) return;

    const gameName = h2.text().trim();
    const dateEl = $game.find('.resultsdate');
    const date = dateEl.text().trim();

    // Each resultsgame can have multiple resultsnumbers sections (midday/evening)
    // The first ul.resultsnums in each section contains the main draw numbers
    const drawSections = $game.find('.resultsnumbers');

    drawSections.each((sIdx, section) => {
      const $section = $(section);
      const dayNight = $section.find('.resultsdaynight').text().trim();
      const numsList = $section.find('ul.resultsnums').first();
      if (!numsList.length) return;

      const numbers = [];
      numsList.find('li').each((_, li) => {
        numbers.push($(li).text().trim());
      });

      if (numbers.length > 0) {
        // Build a unique key like "Numbers Midday" or "Win 4 Evening"
        // The h2 already contains the full name like "Numbers Midday"
        const key = sIdx === 0 ? gameName : `${gameName}_${sIdx}`;
        results[key] = { numbers, date, dayNight };
      }
    });

    // Fallback: if no resultsnumbers sections, try direct ul.resultsnums
    if (drawSections.length === 0) {
      const allNums = $game.find('ul.resultsnums');
      allNums.each((nIdx, ul) => {
        const numbers = [];
        $(ul).find('li').each((_, li) => {
          numbers.push($(li).text().trim());
        });
        if (numbers.length > 0) {
          const key = nIdx === 0 ? gameName : `${gameName}_${nIdx}`;
          results[key] = { numbers, date };
        }
      });
    }
  });

  return results;
}

/**
 * Extract Pick 3 and Pick 4 numbers for a state lottery draw.
 * Maps game names per state to our format.
 *
 * @param {string} state - State abbreviation
 * @param {string[]} gameNames - Game names to look for (from config)
 * @param {object} scrapedData - Result from scrape()
 * @returns {{ pick3: string[] | null, pick4: string[] | null }}
 */
function getDrawNumbers(state, gameNames, scrapedData) {
  let pick3 = null;
  let pick4 = null;

  for (const name of gameNames) {
    // Try exact match first
    let found = scrapedData[name];

    // Try partial match
    if (!found) {
      const key = Object.keys(scrapedData).find(k =>
        k.toLowerCase().includes(name.toLowerCase())
      );
      if (key) found = scrapedData[key];
    }

    if (found) {
      if (found.numbers.length === 3) {
        pick3 = found.numbers;
      } else if (found.numbers.length === 4) {
        pick4 = found.numbers;
      } else if (found.numbers.length === 2) {
        // Pick 2 (Florida)
        if (!pick3) pick3 = found.numbers;
      }
    }
  }

  return { pick3, pick4 };
}

/**
 * Format lotterypost numbers into our data model.
 * pick34 format: ["3","2","3","-","6","8","0","1"]
 * florida format: ["7","2","-","8","2","1","-","8","7","3","7"]
 */
function formatNumbers(pick3, pick4, lotteryFormat) {
  if (lotteryFormat === 'pick34') {
    if (pick3 && pick4) {
      return [...pick3, '-', ...pick4];
    }
    if (pick3) return pick3;
    if (pick4) return pick4;
    return [];
  }
  if (lotteryFormat === 'florida') {
    // Florida: Pick2 - Pick3 - Pick4
    const parts = [];
    if (pick3) {
      // pick3 here is actually Pick 2 (2 digits)
      parts.push(...pick3);
    }
    if (pick4) {
      // This is actually Pick 3 (3 digits) for florida
      if (parts.length > 0) parts.push('-');
      parts.push(...pick4);
    }
    return parts;
  }
  // Default pick3
  if (pick3) return pick3.map(n => n.padStart(2, '0'));
  return [];
}

module.exports = { scrape, getDrawNumbers, formatNumbers };
