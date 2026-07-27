/**
 * Interactive setup wizard: fills .env for you.
 *
 *   npm run setup
 *
 * - Verifies BOT_TOKEN live against Telegram (shows the bot's @username).
 * - Auto-detects chat IDs: you message the bot from each phone, it captures them.
 * - Reads service-account.json and shows which email to share the Sheet with.
 * - Accepts a full spreadsheet URL and extracts the ID.
 * - Writes .env with 600 permissions, then optionally runs init-sheet.
 *
 * Safe to re-run: existing .env values are offered as defaults.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { parse as parseEnv } from 'dotenv';
import { buildUserFields, extractSpreadsheetId, parseUserNames, renderEnv, type TgUser } from './setup-lib';

const ENV_PATH = '.env';

/** Thrown when stdin closes (Ctrl-D / EOF) so we can exit cleanly. */
class AbortSetup extends Error {}

async function verifyBotToken(token: string): Promise<{ username: string } | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username: string } };
    return json.ok && json.result ? { username: json.result.username } : null;
  } catch {
    return null;
  }
}

async function verifyOpenRouter(key: string): Promise<boolean> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function getUpdates(token: string, offset: number, timeout: number): Promise<any[]> {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${timeout}`,
  );
  const json = (await res.json()) as { result?: any[] };
  return json.result ?? [];
}

async function captureChatIds(token: string, rl: readline.Interface): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  let offset = 0;
  console.log('\n📲 Buka chat bot di HP tiap orang lalu kirim pesan apa saja (mis. "hai").');
  // Prime the offset so we ignore anything already sitting in the queue is NOT
  // desired here — we WANT recent messages, so we start from 0 and read all.
  for (;;) {
    process.stdout.write('   ...menunggu pesan (±10 dtk)...\n');
    let updates: any[] = [];
    try {
      updates = await getUpdates(token, offset, 10);
    } catch {
      console.log('   ⚠️  Gagal menghubungi Telegram, coba lagi.');
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message ?? u.edited_message ?? u.channel_post;
      if (msg?.chat?.id) {
        const name = msg.from?.first_name ?? msg.chat?.first_name ?? String(msg.chat.id);
        found.set(msg.chat.id, name);
      }
    }
    if (found.size > 0) {
      console.log('   Terdeteksi:');
      for (const [id, name] of found) console.log(`     • ${id} — ${name}`);
    } else {
      console.log('   Belum ada pesan masuk.');
    }
    const more = (
      await rl.question('   Tekan Enter kalau semua sudah terdeteksi, atau ketik "lagi": ')
    )
      .trim()
      .toLowerCase();
    if (more !== 'lagi') break;
  }
  return found;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => {
    closed = true;
  });
  const ask = async (q: string, def?: string): Promise<string> => {
    if (closed) throw new AbortSetup();
    try {
      const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
      return a || def || '';
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_USE_AFTER_CLOSE') throw new AbortSetup();
      throw e;
    }
  };

  const existing = existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH)) : {};
  const v: Record<string, string> = { ...existing };

  console.log('\n🛠  Setup Budget Bot — isi nilai berikut (Enter = pakai default).\n');

  // --- BOT_TOKEN (verified) ---
  for (;;) {
    const token = await ask('BOT_TOKEN dari @BotFather', existing.BOT_TOKEN);
    if (!token) {
      console.log('   Wajib diisi.');
      continue;
    }
    process.stdout.write('   memverifikasi... ');
    const me = await verifyBotToken(token);
    if (me) {
      console.log(`✅ @${me.username}`);
      v.BOT_TOKEN = token;
      break;
    }
    console.log('❌ token tidak valid.');
    if ((await ask('Coba lagi? (y/n)', 'y')).toLowerCase() !== 'y') {
      v.BOT_TOKEN = token; // keep what they typed
      break;
    }
  }

  // --- Chat IDs + names ---
  console.log('\n👥 Chat ID pengguna yang diizinkan.');
  const mode = (
    await ask('Deteksi otomatis (kirim pesan ke bot) atau manual? (auto/manual)', 'auto')
  ).toLowerCase();

  const users: TgUser[] = [];
  if (mode.startsWith('a') && v.BOT_TOKEN) {
    const found = await captureChatIds(v.BOT_TOKEN, rl);
    for (const [id, name] of found) users.push({ id, name });
  }
  if (users.length === 0) {
    const idsRaw = await ask('ALLOWED_CHAT_IDS (angka dipisah koma)', existing.ALLOWED_CHAT_IDS);
    for (const idStr of idsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
      users.push({ id: Number(idStr), name: '' });
    }
  }
  // Confirm display names.
  const existingNames = parseUserNames(existing.USER_NAMES);
  for (const u of users) {
    const def = u.name || existingNames.get(String(u.id)) || '';
    u.name = await ask(`  Nama untuk ${u.id}`, def || undefined);
  }
  const fields = buildUserFields(users);
  v.ALLOWED_CHAT_IDS = fields.allowedChatIds;
  v.USER_NAMES = fields.userNames;

  // --- OpenRouter ---
  console.log('\n🤖 OpenRouter (openrouter.ai → Keys).');
  const orKey = await ask('OPENROUTER_API_KEY', existing.OPENROUTER_API_KEY);
  if (orKey) {
    process.stdout.write('   memverifikasi... ');
    console.log((await verifyOpenRouter(orKey)) ? '✅ ok' : '⚠️  tidak bisa diverifikasi (lanjut saja)');
  }
  v.OPENROUTER_API_KEY = orKey;
  v.OPENROUTER_MODEL = await ask('OPENROUTER_MODEL (teks)', existing.OPENROUTER_MODEL || 'deepseek/deepseek-chat');
  v.OPENROUTER_VISION_MODEL = await ask(
    'OPENROUTER_VISION_MODEL (foto)',
    existing.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash',
  );

  // --- Google Sheets ---
  console.log('\n📊 Google Sheets.');
  const saPath = await ask('GOOGLE_SERVICE_ACCOUNT_PATH', existing.GOOGLE_SERVICE_ACCOUNT_PATH || './service-account.json');
  v.GOOGLE_SERVICE_ACCOUNT_PATH = saPath;
  if (existsSync(saPath)) {
    try {
      const sa = JSON.parse(readFileSync(saPath, 'utf8')) as { client_email?: string };
      if (sa.client_email) {
        console.log(`   ✅ Ditemukan. Share Google Sheet ke email ini (Editor):`);
        console.log(`      ${sa.client_email}`);
      }
    } catch {
      console.log('   ⚠️  File ada tapi bukan JSON valid.');
    }
  } else {
    console.log(`   ⚠️  Belum ada di ${saPath}. Unduh JSON service account dari Google Cloud & simpan di path itu.`);
  }
  const sidRaw = await ask('SPREADSHEET_ID (boleh tempel URL penuh)', existing.SPREADSHEET_ID);
  v.SPREADSHEET_ID = extractSpreadsheetId(sidRaw);
  if (sidRaw && v.SPREADSHEET_ID !== sidRaw) console.log(`   → ID: ${v.SPREADSHEET_ID}`);

  // --- Runtime ---
  console.log('\n⏰ Runtime.');
  v.TZ = await ask('TZ', existing.TZ || 'Asia/Jakarta');
  for (;;) {
    const day = await ask('BUDGET_START_DAY (1-31, tanggal gajian)', existing.BUDGET_START_DAY || '25');
    const n = Number(day);
    if (Number.isInteger(n) && n >= 1 && n <= 31) {
      v.BUDGET_START_DAY = String(n);
      break;
    }
    console.log('   Harus angka 1-31.');
  }

  // --- Write ---
  writeFileSync(ENV_PATH, renderEnv(v));
  try {
    chmodSync(ENV_PATH, 0o600);
    if (existsSync(v.GOOGLE_SERVICE_ACCOUNT_PATH)) chmodSync(v.GOOGLE_SERVICE_ACCOUNT_PATH, 0o600);
  } catch {
    /* non-fatal on some filesystems */
  }
  console.log(`\n✅ .env tersimpan (chmod 600).`);

  // --- Offer to bootstrap the spreadsheet ---
  const canInit = existsSync(v.GOOGLE_SERVICE_ACCOUNT_PATH) && v.SPREADSHEET_ID;
  if (canInit) {
    const run = (await ask('\nBuat tab + kategori di spreadsheet sekarang? (y/n)', 'y')).toLowerCase();
    if (run === 'y') {
      rl.close();
      const bin = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
      const r = spawnSync(`./node_modules/.bin/${bin}`, ['scripts/init-sheet.ts'], { stdio: 'inherit' });
      if (r.status !== 0) console.log('\n⚠️  init-sheet belum berhasil. Jalankan manual: npm run init-sheet');
      printNext();
      return;
    }
  } else {
    console.log('\nℹ️  Lengkapi service-account.json & SPREADSHEET_ID, lalu jalankan: npm run init-sheet');
  }

  rl.close();
  printNext();
}

function printNext(): void {
  console.log('\n▶ Langkah berikutnya:');
  console.log('   1. (jika belum) npm run init-sheet   # buat tab spreadsheet');
  console.log('   2. npm run build && npm start        # jalankan bot');
  console.log('   atau npm run dev                     # mode dev\n');
}

main().catch((err) => {
  if (err instanceof AbortSetup) {
    console.log('\n\nSetup dibatalkan (tidak ada perubahan yang belum tersimpan hilang).');
    process.exit(0);
  }
  console.error('Setup gagal:', err);
  process.exit(1);
});
