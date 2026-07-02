require('dotenv').config();
const express = require('express');
const path = require('path');
const { applyScan } = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post('/api/scan', async (req, res) => {
  const { barcode, mode, quantity } = req.body || {};

  if (!barcode || typeof barcode !== 'string') {
    return res.status(400).json({ ok: false, error: 'barcode is required' });
  }
  if (!['sale', 'restock', 'manual'].includes(mode)) {
    return res.status(400).json({ ok: false, error: 'mode must be sale, restock, or manual' });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) {
    return res.status(400).json({ ok: false, error: 'quantity must be a non-negative number' });
  }

  try {
    const result = await applyScan({ barcode, mode, quantity: qty });
    res.json({ ok: true, result });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// Batch endpoint used to flush the offline queue once connectivity returns.
app.post('/api/scan/batch', async (req, res) => {
  const { scans } = req.body || {};
  if (!Array.isArray(scans)) {
    return res.status(400).json({ ok: false, error: 'scans must be an array' });
  }

  const results = [];
  for (const scan of scans) {
    try {
      const result = await applyScan({
        barcode: scan.barcode,
        mode: scan.mode,
        quantity: Number(scan.quantity),
      });
      results.push({ ok: true, clientId: scan.clientId, result });
    } catch (err) {
      results.push({ ok: false, clientId: scan.clientId, error: err.message });
    }
  }
  res.json({ ok: true, results });
});

app.listen(PORT, () => {
  console.log(`uranus-scanner listening on port ${PORT}`);
});
