const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1knSllsHeEML_zDU4DrEeVWsjSf38PWvmqszjrN_7BQw';
const SHEET_NAME = process.env.SHEET_NAME || '在庫管理';
const BARCODE_COLUMN = process.env.BARCODE_COLUMN || 'A';
const NAME_COLUMN = process.env.NAME_COLUMN || 'B';
const STOCK_COLUMN = process.env.STOCK_COLUMN || 'H';

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }
  // Falls back to a local credentials.json (gitignored) for local dev.
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

async function findRowByBarcode(barcode) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!${BARCODE_COLUMN}2:${BARCODE_COLUMN}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];
  const offset = rows.findIndex((r) => (r[0] || '').trim() === barcode.trim());
  if (offset === -1) return null;
  return offset + 2; // account for header row + 1-indexing
}

async function getRowData(row) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!A${row}:${STOCK_COLUMN}${row}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const values = (res.data.values && res.data.values[0]) || [];
  const nameIdx = colToIndex(NAME_COLUMN) - colToIndex('A');
  const stockIdx = colToIndex(STOCK_COLUMN) - colToIndex('A');
  return {
    name: values[nameIdx] || '',
    stock: Number(values[stockIdx] || 0),
  };
}

async function updateStock(row, newStock) {
  const sheets = await getSheetsClient();
  const range = `${SHEET_NAME}!${STOCK_COLUMN}${row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newStock]] },
  });
}

/**
 * mode: 'sale' (decrement), 'restock' (increment), 'manual' (set absolute value)
 */
async function applyScan({ barcode, mode, quantity }) {
  const row = await findRowByBarcode(barcode);
  if (!row) {
    const err = new Error(`バーコード ${barcode} が見つかりません`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const { name, stock } = await getRowData(row);
  let newStock;
  if (mode === 'sale') newStock = stock - quantity;
  else if (mode === 'restock') newStock = stock + quantity;
  else if (mode === 'manual') newStock = quantity;
  else throw new Error(`不明なモード: ${mode}`);

  if (newStock < 0) newStock = 0;
  await updateStock(row, newStock);
  return { barcode, name, row, previousStock: stock, newStock };
}

module.exports = { applyScan, findRowByBarcode, getRowData, updateStock };
