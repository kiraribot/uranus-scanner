const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1knSllsHeEML_zDU4DrEeVWsjSf38PWvmqszjrN_7BQw';
const SHEET_NAME = process.env.SHEET_NAME || '在庫管理';
const BARCODE_COLUMN = process.env.BARCODE_COLUMN || 'N';   // EAN(メーカーバーコード)列
const HINBAN_COLUMN = process.env.HINBAN_COLUMN || 'B';     // 品番列
const NAME_COLUMN = process.env.NAME_COLUMN || 'E';         // 品名列
const COLOR_COLUMN = process.env.COLOR_COLUMN || 'F';       // カラー列
const SIZE_COLUMN = process.env.SIZE_COLUMN || 'G';         // サイズ列
const STOCK_COLUMN = process.env.STOCK_COLUMN || 'H';       // 在庫数列
const PRICE_COLUMN = process.env.PRICE_COLUMN || 'I';       // 上代列
const HISTORY_SHEET = process.env.HISTORY_SHEET || '変更履歴';
const DATA_START_ROW = Number(process.env.DATA_START_ROW || 5); // データ開始行

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

async function getRowData(row) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A${row}:${BARCODE_COLUMN}${row}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const v = (res.data.values && res.data.values[0]) || [];
  const pick = (col) => (v[colToIndex(col)] || '').toString().trim();
  return {
    row,
    hinban: pick(HINBAN_COLUMN),
    name: pick(NAME_COLUMN),
    color: pick(COLOR_COLUMN),
    size: pick(SIZE_COLUMN),
    stock: Number(pick(STOCK_COLUMN) || 0),
    price: pick(PRICE_COLUMN),
    barcode: pick(BARCODE_COLUMN),
  };
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

async function searchByHinban(hinban) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A${DATA_START_ROW}:${BARCODE_COLUMN}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  const target = hinban.trim().toUpperCase().replace(/\s+/g, '');
  const results = [];
  rows.forEach((v, i) => {
    const pick = (col) => (v[colToIndex(col)] || '').toString().trim();
    const h = pick(HINBAN_COLUMN).toUpperCase().replace(/\s+/g, '');
    if (h && (h === target || h.includes(target))) {
      results.push({
        row: i + DATA_START_ROW,
        hinban: pick(HINBAN_COLUMN),
        name: pick(NAME_COLUMN),
        color: pick(COLOR_COLUMN),
        size: pick(SIZE_COLUMN),
        stock: Number(pick(STOCK_COLUMN) || 0),
        price: pick(PRICE_COLUMN),
        barcode: pick(BARCODE_COLUMN),
      });
    }
  });
  return results.slice(0, 30);
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
    const err = new Error(`バーコード ${barcode} は未登録です(紐付けモードで登録できます)`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const data = await getRowData(row);
  let newStock;
  if (mode === 'manual') newStock = quantity;
  else newStock = data.stock + def.sign * quantity;

  let clamped = false;
  if (newStock < 0) { newStock = 0; clamped = true; }

  await updateCell(STOCK_COLUMN, row, newStock);
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
    const err = new Error(`バーコード ${barcode} は未登録です`);
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
    const err = new Error(`このバーコードは既に ${d.hinban} ${d.color} ${d.size} (行${existing}) に登録済みです`);
    err.code = 'CONFLICT';
    throw err;
  }
  const data = await getRowData(row);
  if (data.barcode && data.barcode !== clean) {
    const err = new Error(`行${row}には別のバーコード(${data.barcode})が登録済みです`);
    err.code = 'CONFLICT';
    throw err;
  }
  await updateCell(BARCODE_COLUMN, row, clean);
  await appendHistory({
    hinban: data.hinban,
    name: `${data.name} ${data.color} ${data.size}`.trim(),
    action: `バーコード紐付け(${clean})`,
    before: data.stock,
    after: data.stock,
    delta: 0,
  });
  return { ...data, barcode: clean };
}

module.exports = { applyScan, lookupBarcode, searchByHinban, linkBarcode, MODE_DEF };