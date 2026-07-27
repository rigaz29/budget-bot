/**
 * Bootstrap the spreadsheet structure so you don't have to build tabs by hand.
 *
 *   npm run init-sheet
 *
 * Reads SPREADSHEET_ID + GOOGLE_SERVICE_ACCOUNT_PATH from .env, then:
 *   - creates any missing tab (Transactions, Budgets, Categories, Config)
 *   - writes header rows where a sheet has none
 *   - seeds the default categories if the Categories tab is empty
 *
 * Idempotent: safe to run repeatedly. Never deletes or overwrites your data.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as dotenv from 'dotenv';
import { google, sheets_v4 } from 'googleapis';

dotenv.config();

const DEFAULT_CATEGORIES = [
  'Makan',
  'Transportasi',
  'Belanja Rumah Tangga',
  'Kesehatan',
  'Hiburan',
  'Tagihan',
  'Anak & Keluarga',
  'Investasi & Tabungan',
  'Sosial & Hadiah',
  'Lainnya',
];

interface TabSpec {
  title: string;
  headers: string[];
  seed?: string[][];
}

const TABS: TabSpec[] = [
  {
    title: 'Transactions',
    headers: ['timestamp', 'date', 'user', 'amount', 'category', 'description', 'payment_method', 'raw_input', 'id', 'type'],
  },
  { title: 'Budgets', headers: ['category', 'monthly_limit'] },
  { title: 'Categories', headers: ['category'], seed: DEFAULT_CATEGORIES.map((c) => [c]) },
  { title: 'Tabungan', headers: ['goal', 'target'] },
  { title: 'Config', headers: ['key', 'value'] },
];

async function getValues(sheets: sheets_v4.Sheets, spreadsheetId: string, range: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values as string[][] | undefined) ?? [];
}

export async function bootstrap(): Promise<void> {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const saPath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './service-account.json';

  if (!spreadsheetId) {
    console.error('❌ SPREADSHEET_ID belum diisi di .env. Jalankan `npm run setup` dulu.');
    process.exit(1);
  }
  if (!existsSync(saPath)) {
    console.error(`❌ Service account tidak ditemukan: ${saPath}\n   Unduh JSON dari Google Cloud & simpan di path itu.`);
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: saPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Tell the user which email must have edit access.
  try {
    const sa = JSON.parse(readFileSync(saPath, 'utf8')) as { client_email?: string };
    if (sa.client_email) console.log(`🔑 Service account: ${sa.client_email}`);
  } catch {
    /* ignore */
  }

  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId });
  } catch (err) {
    console.error(
      `❌ Tidak bisa mengakses spreadsheet (${spreadsheetId}).\n` +
        `   Pastikan ID benar & sheet di-share ke email service account sebagai Editor.\n   Detail: ${String(err)}`,
    );
    process.exit(1);
  }
  console.log(`📄 Spreadsheet: ${meta.data.properties?.title}\n`);

  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean) as string[]);

  // 1. Create missing tabs.
  const toCreate = TABS.filter((t) => !existing.has(t.title));
  if (toCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toCreate.map((t) => ({ addSheet: { properties: { title: t.title } } })),
      },
    });
    for (const t of toCreate) console.log(`➕ Tab dibuat: ${t.title}`);
  }

  // 2. Headers + seed data.
  for (const tab of TABS) {
    const headerRow = await getValues(sheets, spreadsheetId, `${tab.title}!A1:Z1`);
    const hasHeader = headerRow.length > 0 && (headerRow[0]?.[0] ?? '').trim() !== '';
    if (!hasHeader) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab.title}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [tab.headers] },
      });
      console.log(`🧾 Header ditulis: ${tab.title} (${tab.headers.join(', ')})`);
    }

    if (tab.seed) {
      const data = await getValues(sheets, spreadsheetId, `${tab.title}!A2:A`);
      const nonEmpty = data.filter((r) => (r[0] ?? '').trim() !== '');
      if (nonEmpty.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tab.title}!A2`,
          valueInputOption: 'RAW',
          requestBody: { values: tab.seed },
        });
        console.log(`🌱 Seed ${tab.seed.length} kategori default ke ${tab.title}`);
      }
    }
  }

  // 3. Migration: ensure existing Transactions header has the new "type" column (J1).
  const j1 = await getValues(sheets, spreadsheetId, 'Transactions!J1');
  if ((j1[0]?.[0] ?? '').trim() === '') {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Transactions!J1',
      valueInputOption: 'RAW',
      requestBody: { values: [['type']] },
    });
    console.log('🧾 Kolom "type" ditambahkan ke header Transactions (J1)');
  }

  console.log('\n✅ Spreadsheet siap. Jalankan bot: `npm start`');
}

bootstrap().catch((err) => {
  console.error('❌ init-sheet gagal:', err);
  process.exit(1);
});
