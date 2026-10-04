/**
 * Google Sheets is the single source of truth. This module wraps every read/write.
 *
 * - Auth via Service Account JWT (key file from GOOGLE_SERVICE_ACCOUNT_PATH).
 * - Writes are serialized through a mutex so two users appending at once can't race.
 * - Transient errors (429 / 5xx / ECONNRESET) get one retry after a short pause.
 * - init() fails fast if the spreadsheet or required tabs are missing.
 */

import { google, sheets_v4 } from 'googleapis';
import { config } from '../config';
import type { Budget, SavingGoal, Transaction, TransactionType } from '../types';
import { logger } from '../utils/logger';
import { fromYMD } from '../utils/period';

const SHEET_TRANSACTIONS = 'Transactions';
const SHEET_BUDGETS = 'Budgets';
const SHEET_CATEGORIES = 'Categories';
const SHEET_SAVINGS = 'Tabungan';

/** Transactions columns span A:J (J = type). */
const TX_RANGE = `${SHEET_TRANSACTIONS}!A:J`;

let sheets: sheets_v4.Sheets;
/** Title -> numeric sheetId (gid), needed for row deletion. */
const sheetIds = new Map<string, number>();

// --- write serialization ----------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

// --- transient retry --------------------------------------------------------

const RETRY_DELAY_MS = 1_000;

function isTransient(err: unknown): boolean {
  const e = err as { code?: number | string; response?: { status?: number } };
  const status = typeof e?.code === 'number' ? e.code : e?.response?.status;
  // 429 = per-minute read/write quota; it clears on its own.
  if (status === 429 || (status && status >= 500 && status <= 599)) return true;
  return e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT' || e?.code === 'ENOTFOUND';
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isTransient(err)) {
      logger.warn('Sheets transient error, retrying once', { error: String(err) });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      return await fn();
    }
    throw err;
  }
}

// --- helpers ----------------------------------------------------------------

function requireSheetId(title: string): number {
  const id = sheetIds.get(title);
  if (id === undefined) throw new Error(`Sheet "${title}" tidak ditemukan (jalankan init)`);
  return id;
}

async function readRange(range: string): Promise<string[][]> {
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: config.SPREADSHEET_ID, range }),
  );
  return (res.data.values as string[][] | undefined) ?? [];
}

function normalizeType(raw: string | undefined): TransactionType {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'income') return 'income';
  if (v === 'saving') return 'saving';
  return 'expense'; // empty (old rows) or "expense"
}

/** Map a raw Transactions row (A:J) to a Transaction, or null if malformed. */
function rowToTransaction(row: string[]): Transaction | null {
  if (!row || row.length === 0) return null;
  const [timestamp, date, user, amount, category, description, payment_method, raw_input, id, type] = row;
  if (!id) return null;
  // Strip thousands separators; the sheet may display amounts as "Rp 5.700.000"
  // (a currency format), but the value is always an integer.
  const amt = Number(String(amount ?? '').replace(/[^\d-]/g, ''));
  return {
    timestamp: timestamp ?? '',
    date: date ?? '',
    user: user ?? '',
    amount: Number.isFinite(amt) ? amt : 0,
    category: category ?? '',
    description: description ?? '',
    payment_method: (payment_method as Transaction['payment_method']) ?? 'cash',
    raw_input: raw_input ?? '',
    id,
    type: normalizeType(type),
  };
}

// --- init -------------------------------------------------------------------

export async function init(): Promise<void> {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth });

  let meta;
  try {
    meta = await withRetry(() =>
      sheets.spreadsheets.get({ spreadsheetId: config.SPREADSHEET_ID }),
    );
  } catch (err) {
    throw new Error(
      `Tidak bisa mengakses spreadsheet (${config.SPREADSHEET_ID}). ` +
        `Pastikan SPREADSHEET_ID benar & spreadsheet di-share ke email service account. Detail: ${String(err)}`,
    );
  }

  for (const s of meta.data.sheets ?? []) {
    const title = s.properties?.title;
    const id = s.properties?.sheetId;
    if (title && id !== null && id !== undefined) sheetIds.set(title, id);
  }

  const missing = [SHEET_TRANSACTIONS, SHEET_BUDGETS, SHEET_CATEGORIES].filter(
    (t) => !sheetIds.has(t),
  );
  if (missing.length > 0) {
    throw new Error(
      `Spreadsheet kekurangan sheet wajib: ${missing.join(', ')}. ` +
        `Jalankan \`npm run init-sheet\` untuk membuatnya.`,
    );
  }

  logger.info('Google Sheets terhubung', { title: meta.data.properties?.title });
}

// --- categories -------------------------------------------------------------

export async function getCategories(): Promise<string[]> {
  const rows = await readRange(`${SHEET_CATEGORIES}!A:A`);
  const out: string[] = [];
  for (const r of rows) {
    const v = (r[0] ?? '').trim();
    if (!v) continue;
    if (/^(kategori|category)$/i.test(v)) continue; // skip header
    out.push(v);
  }
  return out;
}

/** Append a category. Returns false if it already exists (case-insensitive). */
export function addCategory(name: string): Promise<boolean> {
  return serialize(async () => {
    const rows = await readRange(`${SHEET_CATEGORIES}!A:A`);
    const exists = rows.some((r) => (r[0] ?? '').trim().toLowerCase() === name.trim().toLowerCase());
    if (exists) return false;
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: config.SPREADSHEET_ID,
        range: `${SHEET_CATEGORIES}!A:A`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[name]] },
      }),
    );
    return true;
  });
}

/** Delete a category row (case-insensitive match). Returns true if a row was removed. */
export function removeCategory(name: string): Promise<boolean> {
  return serialize(async () => {
    const rows = await readRange(`${SHEET_CATEGORIES}!A:A`);
    let rowIndex = -1; // 0-based == sheet row - 1
    for (let i = 0; i < rows.length; i++) {
      const v = (rows[i][0] ?? '').trim();
      if (/^(kategori|category)$/i.test(v)) continue; // never delete the header
      if (v.toLowerCase() === name.trim().toLowerCase()) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex < 0) return false;
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: requireSheetId(SHEET_CATEGORIES),
                  dimension: 'ROWS',
                  startIndex: rowIndex,
                  endIndex: rowIndex + 1,
                },
              },
            },
          ],
        },
      }),
    );
    return true;
  });
}

// --- budgets ----------------------------------------------------------------

export async function getBudgets(): Promise<Budget[]> {
  const rows = await readRange(`${SHEET_BUDGETS}!A:B`);
  const out: Budget[] = [];
  for (const r of rows) {
    const category = (r[0] ?? '').trim();
    if (!category) continue;
    if (/^(category|kategori)$/i.test(category)) continue; // skip header
    const limit = Number(String(r[1] ?? '').replace(/[^\d-]/g, ''));
    out.push({ category, monthly_limit: Number.isFinite(limit) ? limit : 0 });
  }
  return out;
}

/** Create or update a category's monthly budget. Returns the applied limit. */
export function setBudget(category: string, limit: number): Promise<void> {
  return serialize(async () => {
    const rows = await readRange(`${SHEET_BUDGETS}!A:B`);
    let rowIndex = -1; // 0-based within the returned range
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] ?? '').trim().toLowerCase() === category.trim().toLowerCase()) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex >= 0) {
      const rowNumber = rowIndex + 1; // A1 rows are 1-based
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: config.SPREADSHEET_ID,
          range: `${SHEET_BUDGETS}!A${rowNumber}:B${rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[category, limit]] },
        }),
      );
    } else {
      await withRetry(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: config.SPREADSHEET_ID,
          range: `${SHEET_BUDGETS}!A:B`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[category, limit]] },
        }),
      );
    }
  });
}

// --- savings goals (Tabungan) -----------------------------------------------

export async function getSavingGoals(): Promise<SavingGoal[]> {
  if (!sheetIds.has(SHEET_SAVINGS)) return [];
  const rows = await readRange(`${SHEET_SAVINGS}!A:B`);
  const out: SavingGoal[] = [];
  for (const r of rows) {
    const goal = (r[0] ?? '').trim();
    if (!goal) continue;
    if (/^(goal|tujuan)$/i.test(goal)) continue; // skip header
    const target = Number(String(r[1] ?? '').replace(/[^\d-]/g, ''));
    out.push({ goal, target: Number.isFinite(target) ? target : 0 });
  }
  return out;
}

/** Create or update a savings goal's target. */
export function setSavingTarget(goal: string, target: number): Promise<void> {
  return serialize(async () => {
    const rows = await readRange(`${SHEET_SAVINGS}!A:B`);
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] ?? '').trim().toLowerCase() === goal.trim().toLowerCase()) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex >= 0) {
      const rowNumber = rowIndex + 1;
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: config.SPREADSHEET_ID,
          range: `${SHEET_SAVINGS}!A${rowNumber}:B${rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[goal, target]] },
        }),
      );
    } else {
      await withRetry(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: config.SPREADSHEET_ID,
          range: `${SHEET_SAVINGS}!A:B`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[goal, target]] },
        }),
      );
    }
  });
}

// --- transactions -----------------------------------------------------------

export function appendTransactions(txs: Transaction[]): Promise<void> {
  if (txs.length === 0) return Promise.resolve();
  return serialize(async () => {
    const values = txs.map((t) => [
      t.timestamp,
      t.date,
      t.user,
      t.amount,
      t.category,
      t.description,
      t.payment_method,
      t.raw_input,
      t.id,
      t.type,
    ]);
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: config.SPREADSHEET_ID,
        range: TX_RANGE,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      }),
    );
  });
}

/** All transactions whose date (col B) falls within [start, end] inclusive. */
export async function getTransactionsInPeriod(start: Date, end: Date): Promise<Transaction[]> {
  const rows = await readRange(TX_RANGE);
  const out: Transaction[] = [];
  for (const r of rows) {
    if ((r[0] ?? '').toLowerCase() === 'timestamp') continue; // header
    const tx = rowToTransaction(r);
    if (!tx) continue;
    const d = fromYMD(tx.date) ?? fromYMD(tx.timestamp);
    if (!d) continue;
    if (d.getTime() >= start.getTime() && d.getTime() <= end.getTime()) out.push(tx);
  }
  return out;
}

/** Every recorded transaction (all types, all time). */
export async function getAllTransactions(): Promise<Transaction[]> {
  const rows = await readRange(TX_RANGE);
  const out: Transaction[] = [];
  for (const r of rows) {
    if ((r[0] ?? '').toLowerCase() === 'timestamp') continue; // header
    const tx = rowToTransaction(r);
    if (tx) out.push(tx);
  }
  return out;
}

/**
 * Delete the transaction row whose id (col I) matches. Returns the deleted
 * transaction, or null if no row matched.
 */
export function deleteTransactionById(id: string): Promise<Transaction | null> {
  return serialize(async () => {
    const rows = await readRange(TX_RANGE);
    let rowIndex = -1; // 0-based within range == 0-based sheet row
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][8] ?? '') === id) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex < 0) return null;
    const deleted = rowToTransaction(rows[rowIndex]);

    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.SPREADSHEET_ID,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: requireSheetId(SHEET_TRANSACTIONS),
                  dimension: 'ROWS',
                  startIndex: rowIndex,
                  endIndex: rowIndex + 1,
                },
              },
            },
          ],
        },
      }),
    );
    return deleted;
  });
}
