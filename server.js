require('dotenv').config();
const express = require('express');
const path = require('path');
const { applyScan, lookupBarcode, searchByHinban, linkBarcode } = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PIN = process.env.APP_PIN || ''; // 空なら暗証番号なし(後方互換)

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 暗証番号チェック(全APIに適用、healthだけ除外) ----
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!APP_PIN) return next();
  if (req.headers['x-app-pin'] === APP_PIN) return next();
  return res.status(401).json({ ok: false, error: 'PIN_REQUIRED' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---- 二重スキャン防止(同じバーコード×同じモードを5秒以内に2回→ブロック) ----
const recentScans = new Map();
const DUP_WINDOW_MS = 5000;
function isDuplicate(barcode, mode) {
  const key = `${barcode}:${mode}`;
  const now = Date.now();
  const last = recentScans.get(key);
  recentScans.set(key, now);
  if (recentScans.size > 500) {
    for (const [k, t] of recentScans) if (now - t > DUP_WINDOW_MS) recentScans.delete(k);
  }
  return last && now - last < DUP_WINDOW_MS;
}

const VALID_MODES = ['sale', 'return', 'restock', 'promo', 'dispose', 'manual'];

app.post('/api/scan', async (req, res) => {
  const { barcode, mode, quantity, force } = req.body || {};

  if (!barcode || typeof barcode !== 'string') {
    return res.status(400).json({ ok: false, error: 'barcode is required' });
  }

  if (mode === 'check') {
    try {
      const result = await lookupBarcode(barcode);
      return res.json({ ok: true, result });
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : 500;
      return res.status(status).json({ ok: false, error: err.message, code: err.code });
    }
  }

  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ ok: false, error: `mode must be one of ${VALID_MODES.join(', ')}` });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) {
    return res.status(400).json({ ok: false, error: 'quantity must be a non-negative number' });
  }

  if (!force && isDuplicate(barcode, mode)) {
    return res.status(409).json({
      ok: false,
      code: 'DUPLICATE',
      error: '5秒以内に同じ読み取りがありました(二重スキャン防止)。本当に2点なら5秒待って再スキャン',
    });
  }

  try {
    const result = await applyScan({ barcode, mode, quantity: qty });
    res.json({ ok: true, result });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : 500;
    res.status(status).json({ ok: false, error: err.message, code: err.code });
  }
});

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
      results.push({ ok: false, clientId: scan.clientId, error: err.message, code: err.code });
    }
  }
  res.json({ ok: true, results });
});

app.post('/api/link/search', async (req, res) => {
  const { hinban } = req.body || {};
  if (!hinban || typeof hinban !== 'string' || hinban.trim().length < 3) {
    return res.status(400).json({ ok: false, error: '品番を3文字以上入力してください' });
  }
  try {
    const candidates = await searchByHinban(hinban);
    res.json({ ok: true, candidates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/link/bind', async (req, res) => {
  const { row, barcode } = req.body || {};
  if (!Number.isInteger(row) || row < 2 || !barcode) {
    return res.status(400).json({ ok: false, error: 'row and barcode are required' });
  }
  try {
    const result = await linkBarcode({ row, barcode });
    res.json({ ok: true, result });
  } catch (err) {
    const status = err.code === 'CONFLICT' ? 409 : 500;
    res.status(status).json({ ok: false, error: err.message, code: err.code });
  }
});

app.listen(PORT, () => {
  console.log(`uranus-scanner v2 listening on port ${PORT}`);
});