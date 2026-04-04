const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scraper = require('./scrapers');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = path.join(__dirname, 'data', 'results.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Simple token store (in-memory, resets on restart)
const tokens = new Set();

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !tokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Public API ---

app.get('/api/results', (req, res) => {
  res.json(readData());
});

// --- Auth ---

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    tokens.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// --- Admin API (protected) ---

// Update a specific draw's numbers
app.put('/api/results/:lotteryId/:drawIndex', authMiddleware, (req, res) => {
  const { lotteryId, drawIndex } = req.params;
  const { numbers, time, clearStatus } = req.body;

  if (numbers && (!Array.isArray(numbers) || !numbers.every(n => typeof n === 'string'))) {
    return res.status(400).json({ error: 'numbers must be an array of strings' });
  }
  if (time && typeof time !== 'string') {
    return res.status(400).json({ error: 'time must be a string' });
  }

  const data = readData();
  const idx = parseInt(drawIndex, 10);

  for (const col of data.columns) {
    for (const lottery of col.lotteries) {
      if (lottery.id === lotteryId && lottery.draws[idx]) {
        if (numbers) {
          lottery.draws[idx].numbers = numbers;
          // Admin override clears any scraper status
          delete lottery.draws[idx].status;
          delete lottery.draws[idx].corrected;
        }
        if (time) lottery.draws[idx].time = time;
        if (clearStatus) {
          delete lottery.draws[idx].status;
          delete lottery.draws[idx].corrected;
        }
        lottery.draws[idx].date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        writeData(data);
        return res.json({ ok: true });
      }
    }
  }
  res.status(404).json({ error: 'Draw not found' });
});

// Add a new draw to a lottery
app.post('/api/results/:lotteryId/draws', authMiddleware, (req, res) => {
  const { lotteryId } = req.params;
  const { time, numbers } = req.body;
  const data = readData();

  for (const col of data.columns) {
    for (const lottery of col.lotteries) {
      if (lottery.id === lotteryId) {
        lottery.draws.push({ time, numbers, date: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) });
        writeData(data);
        return res.json({ ok: true });
      }
    }
  }
  res.status(404).json({ error: 'Lottery not found' });
});

// Delete a draw
app.delete('/api/results/:lotteryId/:drawIndex', authMiddleware, (req, res) => {
  const { lotteryId, drawIndex } = req.params;
  const data = readData();
  const idx = parseInt(drawIndex, 10);

  for (const col of data.columns) {
    for (const lottery of col.lotteries) {
      if (lottery.id === lotteryId && lottery.draws[idx]) {
        lottery.draws.splice(idx, 1);
        writeData(data);
        return res.json({ ok: true });
      }
    }
  }
  res.status(404).json({ error: 'Draw not found' });
});

// Clear all draws for all lotteries
app.post('/api/results/clear-all', authMiddleware, (req, res) => {
  const data = readData();
  for (const col of data.columns) {
    for (const lottery of col.lotteries) {
      lottery.draws = [];
    }
  }
  writeData(data);
  res.json({ ok: true });
});

// --- Scraper API (protected) ---

app.get('/api/scraper-status', authMiddleware, (req, res) => {
  res.json(scraper.getStatus());
});

app.post('/api/scraper/run-all', authMiddleware, async (req, res) => {
  try {
    const result = await scraper.scrapeAll({ acceptRecent: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scraper/run/:lotteryId', authMiddleware, async (req, res) => {
  const { lotteryId } = req.params;
  try {
    const result = await scraper.manualScrape(lotteryId, { acceptRecent: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lottery server running on port ${PORT}`);
  scraper.init();
});
