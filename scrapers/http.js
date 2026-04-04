const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
};

/**
 * Fetch a page with browser-like headers and a 15s timeout.
 * @param {string} url
 * @returns {Promise<string>} HTML string
 */
async function fetchPage(url) {
  const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  return data;
}

module.exports = { fetchPage };
