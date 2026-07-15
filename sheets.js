const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1knSllsHeEML_zDU4DrEeVWsjSf38PWvmqszjrN_7BQw';
const SHEET_NAME = process.env.SHEET_NAME || '在庫管理';
const BARCODE_COLUMN = process.env.BARCODE_COLUMN || 'A';
const HINBAN_COLUMN = process.env.HINBAN_COLUMN || 'B';
const NAME_COLUMN = process.env.NAME_COLUMN || 'C';
const COLOR_COLUMN = process.env.COLOR_COLUMN || 'D';
const SIZE_COLUMN = process.env.SIZE_COLUMN || 'E';
const STOCK_COLUMN = process.env.STOCK_COLUMN || 'F';
const PRICE_COLUMN = process.env.PRICE_COLUMN || 'G';
const UPDATED_COLUMN = process.env.UPDATED_COLUMN || 'H';
// データ範囲の右端列(新レイアウトでは最終更新のH列が最右)
const LAST_COLUMN = process.env.LAST_COLUMN || UPDATED_COLUMN;
const HISTORY_SHEET = process.env.HISTORY_SHEET || '変更履歴';
const DATA_START_ROW = Number(process.env.DATA_START_ROW || 5);

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  return require('./credentials.json');
}

let sheetsClientPromise = null;
async function getSheetsClient() {
  if (!sheetsClientPromise) {
    const auth = new google.auth.GoogleAuth({
      credentials: loadCredentials(),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    sheetsClientPromise = google.sheets({ version: 'v4', auth: client });
  }
  return sheetsClientPromise;
}

function colToIndex(col) {
  let idx = 0;
  for (const ch of col.toUpperCase()) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

// 表記ゆれ吸収: 大文字化・全半角スペース除去
function norm(s) {
  return (s || '').toString().toUpperCase().replace(/[\s　]+/g, '').trim();
}

function rowFromValues(v, rowNum) {
  const pick = (col) => (v[colToIndex(col)] || '').toString().trim();
  return {
    row: rowNum,
    hinban: pick(HINBAN_COLUMN),
    name: pick(NAME_COLUMN),
    color: pick(COLOR_COLUMN),
    size: pick(SIZE_COLUMN),
    stock: Number(pick(STOCK_COLUMN) || 0),
    price: pick(PRICE_COLUMN),
    barcode: pick(BARCODE_COLUMN),
  };
}

async function getAllRows() {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A${DATA_START_ROW}:${LAST_COLUMN}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  return rows.map((v, i) => rowFromValues(v, i + DATA_START_ROW))
             .filter((r) => r.hinban);
}

async function getRowData(row) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A${row}:${LAST_COLUMN}${row}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const v = (res.data.values && res.data.values[0]) || [];
  return rowFromValues(v, row);
}

async function findRowByBarcode(barcode) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!${BARCODE_COLUMN}${DATA_START_ROW}:${BARCODE_COLUMN}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  const target = barcode.trim();
  const offset = rows.findIndex((r) => (r[0] || '').toString().trim() === target);
  if (offset === -1) return null;
  return offset + DATA_START_ROW;
}

// 品番テキスト検索(予備用)
async function searchByHinban(hinban) {
  const all = await getAllRows();
  const target = norm(hinban);
  return all.filter((r) => norm(r.hinban).includes(target)).slice(0, 30);
}

// 写真から読んだ「品番・色・サイズ」で候補を絞り込む(v3の心臓部)
async function matchByTag({ hinban, color, size }) {
  const all = await getAllRows();
  const h = norm(hinban);
  if (!h) return [];
  let cand = all.filter((r) => norm(r.hinban) === h);
  if (cand.length === 0) {
    // 完全一致がなければ部分一致で救済
    cand = all.filter((r) => norm(r.hinban).includes(h) || h.includes(norm(r.hinban)));
  }
  if (color && cand.some((r) => norm(r.color) === norm(color))) {
    cand = cand.filter((r) => norm(r.color) === norm(color));
  }
  if (size && cand.some((r) => norm(r.size) === norm(size))) {
    cand = cand.filter((r) => norm(r.size) === norm(size));
  }
  return cand.slice(0, 8);
}

async function updateCell(col, row, value) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${col}${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

async function appendHistory({ hinban, name, action, before, after, delta }) {
  try {
    const sheets = await getSheetsClient();
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HISTORY_SHEET}!A:G`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[now, hinban, name, action, before, after, delta]] },
    });
  } catch (e) {
    console.error('履歴書き込み失敗:', e.message);
  }
}

const MODE_DEF = {
  sale:    { label: '販売',       sign: -1 },
  return:  { label: '返品',       sign: +1 },
  restock: { label: '入荷',       sign: +1 },
  promo:   { label: 'プロモ出庫', sign: -1 },
  dispose: { label: '破棄',       sign: -1 },
  manual:  { label: '手動修正',   sign: 0  },
};

async function applyScan({ barcode, mode, quantity }) {
  const def = MODE_DEF[mode];
  if (!def) throw new Error(`不明なモード: ${mode}`);
  const row = await findRowByBarcode(barcode);
  if (!row) {
    const err = new Error('この商品はまだ登録されていません');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return applyScanToRow({ row, mode, quantity });
}

async function applyScanToRow({ row, mode, quantity }) {
  const def = MODE_DEF[mode];
  const data = await getRowData(row);
  let newStock;
  if (mode === 'manual') newStock = quantity;
  else newStock = data.stock + def.sign * quantity;
  let clamped = false;
  if (newStock < 0) { newStock = 0; clamped = true; }
  await updateCell(STOCK_COLUMN, row, newStock);
  // 最終更新日時をH列に記録
  await updateCell(UPDATED_COLUMN, row, new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
  await appendHistory({
    hinban: data.hinban,
    name: `${data.name} ${data.color} ${data.size}`.trim(),
    action: def.label,
    before: data.stock,
    after: newStock,
    delta: newStock - data.stock,
  });
  return { ...data, mode, modeLabel: def.label, previousStock: data.stock, newStock, clamped };
}

async function lookupBarcode(barcode) {
  const row = await findRowByBarcode(barcode);
  if (!row) {
    const err = new Error('この商品はまだ登録されていません');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return getRowData(row);
}

async function linkBarcode({ row, barcode }) {
  const clean = barcode.trim();
  const existing = await findRowByBarcode(clean);
  if (existing && existing !== row) {
    const d = await getRowData(existing);
    const err = new Error(`このバーコードは既に ${d.hinban} ${d.color} ${d.size} に登録済みです`);
    err.code = 'CONFLICT';
    throw err;
  }
  const data = await getRowData(row);
  if (data.barcode && data.barcode !== clean) {
    const err = new Error('この行には別のバーコードが登録済みです');
    err.code = 'CONFLICT';
    throw err;
  }
  if (data.barcode !== clean) {
    await updateCell(BARCODE_COLUMN, row, clean);
    await appendHistory({
      hinban: data.hinban,
      name: `${data.name} ${data.color} ${data.size}`.trim(),
      action: `バーコード自動登録(${clean})`,
      before: data.stock,
      after: data.stock,
      delta: 0,
    });
  }
  return { ...data, barcode: clean };
}

module.exports = {
  applyScan, applyScanToRow, lookupBarcode, searchByHinban,
  matchByTag, linkBarcode, MODE_DEF,
};