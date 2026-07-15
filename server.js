require('dotenv').config();
const express = require('express');
const path = require('path');
const {
  applyScan, applyScanToRow, lookupBarcode, searchByHinban,
  matchByTag, linkBarcode,
} = require('./sheets');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PIN = (process.env.APP_PIN || '').trim();
const VISION_API_KEY = (process.env.VISION_API_KEY || '').trim();

app.use(express.json({ limit: '8mb' })); // 写真を受け取るため上限拡大
app.use(express.static(path.join(__dirname, 'public')));

// ---- 暗証番号(前後の空白は無視して比較) ----
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (!APP_PIN) return next();
  if ((req.headers['x-app-pin'] || '').trim() === APP_PIN) return next();
  return res.status(401).json({ ok: false, error: 'PIN_REQUIRED' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, vision: !!VISION_API_KEY, time: new Date().toISOString() });
});

// ---- 二重スキャン防止 ----
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
    return res.status(400).json({ ok: false, error: 'invalid mode' });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty < 0) {
    return res.status(400).json({ ok: false, error: 'invalid quantity' });
  }
  if (!force && isDuplicate(barcode, mode)) {
    return res.status(409).json({
      ok: false, code: 'DUPLICATE',
      error: '同じ商品を続けて読み取りました。本当にもう1点なら5秒あけてもう一度',
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
  if (!Array.isArray(scans)) return res.status(400).json({ ok: false, error: 'scans must be an array' });
  const results = [];
  for (const scan of scans) {
    try {
      const result = await applyScan({ barcode: scan.barcode, mode: scan.mode, quantity: Number(scan.quantity) });
      results.push({ ok: true, clientId: scan.clientId, result });
    } catch (err) {
      results.push({ ok: false, clientId: scan.clientId, error: err.message, code: err.code });
    }
  }
  res.json({ ok: true, results });
});

// ---- 値札の文字をGoogle Vision(文字読み取りAI)で解析 ----
async function readTagText(imageBase64) {
  const body = {
    requests: [{
      image: { content: imageBase64 },
      features: [{ type: 'TEXT_DETECTION' }],
    }],
  };
  const r = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (data.error) throw new Error(`Vision API: ${data.error.message}`);
  const resp = (data.responses && data.responses[0]) || {};
  if (resp.error) throw new Error(`Vision API: ${resp.error.message}`);
  return (resp.fullTextAnnotation && resp.fullTextAnnotation.text) || '';
}

// 値札テキストから 品番/COL/SIZE を抜き出す
function parseTag(text) {
  const t = text.toUpperCase().replace(/[：]/g, ':').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const hinbanMatch = t.match(/([A-Z]{2,6}\s?\d{2,4})\s*[\r\n ]?\s*([A-Z]{2,3}\s?\d{2,4})/);
  const hinban = hinbanMatch ? `${hinbanMatch[1]} ${hinbanMatch[2]}`.replace(/\s+/g, ' ').trim() : '';
  const colorMatch = t.match(/COL\s*:?\s*(\d{3,4})/);
  const sizeMatch = t.match(/SIZE\s*:?\s*([A-Z0-9]{1,6})/);
  return {
    hinban,
    color: colorMatch ? colorMatch[1] : '',
    size: sizeMatch ? sizeMatch[1] : '',
  };
}

// ---- v3の心臓部: 写真1枚で 自動照合→自動登録→(必要なら)保留処理を自動実行 ----
app.post('/api/tag-link', async (req, res) => {
  const { barcode, image, action } = req.body || {};
  if (!barcode || !image) return res.status(400).json({ ok: false, error: 'barcode and image are required' });
  if (!VISION_API_KEY) {
    return res.status(501).json({ ok: false, code: 'VISION_OFF', error: '写真読み取り機能が未開通です(VISION_API_KEY未設定)' });
  }
  try {
    const text = await readTagText(image);
    const parsed = parseTag(text);
    if (!parsed.hinban) {
      return res.json({ ok: true, matched: false, parsed, candidates: [], reason: '品番を読み取れませんでした。値札全体が写るように撮り直してください' });
    }
    let candidates = await matchByTag(parsed);
    // 別のバーコードが既に付いている行は自動対象から外す
    const free = candidates.filter((c) => !c.barcode || c.barcode === barcode.trim());

    if (free.length === 1) {
      const linked = await linkBarcode({ row: free[0].row, barcode });
      let executed = null;
      if (action && VALID_MODES.includes(action.mode)) {
        executed = await applyScanToRow({ row: free[0].row, mode: action.mode, quantity: Number(action.quantity) || 1 });
      }
      return res.json({ ok: true, matched: true, parsed, linked, executed });
    }
    return res.json({ ok: true, matched: false, parsed, candidates: free.length ? free : candidates });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 候補ボタンをタップした時: 登録+保留処理を一度に実行
app.post('/api/tag-link/confirm', async (req, res) => {
  const { row, barcode, action } = req.body || {};
  if (!Number.isInteger(row) || !barcode) return res.status(400).json({ ok: false, error: 'row and barcode required' });
  try {
    const linked = await linkBarcode({ row, barcode });
    let executed = null;
    if (action && VALID_MODES.includes(action.mode)) {
      executed = await applyScanToRow({ row, mode: action.mode, quantity: Number(action.quantity) || 1 });
    }
    res.json({ ok: true, linked, executed });
  } catch (err) {
    const status = err.code === 'CONFLICT' ? 409 : 500;
    res.status(status).json({ ok: false, error: err.message, code: err.code });
  }
});

// 予備: 品番テキスト検索(設定画面の奥に残す)
app.post('/api/link/search', async (req, res) => {
  const { hinban } = req.body || {};
  if (!hinban || typeof hinban !== 'string' || hinban.trim().length < 3) {
    return res.status(400).json({ ok: false, error: '品番を3文字以上入力してください' });
  }
  try {
    res.json({ ok: true, candidates: await searchByHinban(hinban) });
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
    res.json({ ok: true, result: await linkBarcode({ row, barcode }) });
  } catch (err) {
    const status = err.code === 'CONFLICT' ? 409 : 500;
    res.status(status).json({ ok: false, error: err.message, code: err.code });
  }
});

app.listen(PORT, () => console.log(`uranus-scanner v3 on ${PORT}`));
