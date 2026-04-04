const axios = require('axios');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,es;q=0.8'
};

async function fetchPage(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      if (typeof data === 'string' && data.trim().length === 0) {
        throw new Error(`Empty response body from ${url}`);
      }
      return data;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

module.exports = { fetchPage };
