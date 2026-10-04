/**
 * OpenRouter client. Two entry points:
 *   - parseTransaction(text)  -> text model (deepseek), returns ParsedTransaction[]
 *   - parseImage(dataUrl)     -> vision model (gemini), returns items or not_receipt
 *
 * The LLM is used purely as a parser: temperature 0, strict JSON output, validated
 * with zod. It never invents absolute dates (only date_offset) and never invents
 * categories outside the injected list.
 */

import { z } from 'zod';
import { config } from '../config';
import { PAYMENT_METHODS, type ParsedTransaction, type PaymentMethod, type TransactionType } from '../types';
import { logger } from '../utils/logger';
import { toYMD } from '../utils/period';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TEXT_TIMEOUT_MS = 15_000;
const VISION_TIMEOUT_MS = 30_000;
// Generous on purpose: a truncated JSON array fails to parse as a whole, and the
// text handler then falls back to recording ONE "Lainnya" item for the message.
// A bank-mutation screenshot can easily hold 20+ items.
const TEXT_MAX_TOKENS = 1_500;
const VISION_MAX_TOKENS = 3_000;
const RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Low-level request with timeout + single retry on transient failures.
// ---------------------------------------------------------------------------

type Message =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'user'; content: Array<Record<string, unknown>> };

function isTransient(status?: number): boolean {
  return status === undefined || status === 429 || (status >= 500 && status <= 504);
}

async function callOpenRouter(
  model: string,
  messages: Message[],
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const body = JSON.stringify({
    model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Back off before the retry; an instant retry after a 429 just fails again.
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Title': 'budget-bot',
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (isTransient(res.status) && attempt === 0) {
          lastErr = new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
          logger.warn('OpenRouter transient error, retrying', { status: res.status });
          continue;
        }
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error('OpenRouter: empty completion');
      return content;
    } catch (err) {
      lastErr = err;
      const transient =
        err instanceof Error && (err.name === 'AbortError' || err.message.includes('fetch'));
      if (transient && attempt === 0) {
        logger.warn('OpenRouter request failed, retrying', { error: String(err) });
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('OpenRouter: unknown failure');
}

// ---------------------------------------------------------------------------
// JSON extraction & validation.
// ---------------------------------------------------------------------------

/** Strip ```json fences and locate the first JSON array/object in the text. */
function extractJson(raw: string): unknown {
  let s = raw.trim();
  // Remove leading/trailing markdown code fences if present.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(s);
  } catch {
    // Fall back to slicing out the outermost [] or {}.
    const firstArr = s.indexOf('[');
    const firstObj = s.indexOf('{');
    const starts = [firstArr, firstObj].filter((i) => i >= 0);
    if (starts.length === 0) throw new Error('Tidak ada JSON pada respons LLM');
    const start = Math.min(...starts);
    const open = s[start];
    const close = open === '[' ? ']' : '}';
    const end = s.lastIndexOf(close);
    if (end <= start) throw new Error('JSON tidak lengkap pada respons LLM');
    return JSON.parse(s.slice(start, end + 1));
  }
}

/**
 * Numeric field that the model may emit as a string. Strings are often copied
 * straight off a receipt with grouping separators, so "25.000" / "Rp 1.250.000"
 * (id-ID) and "25,000" (en-US) must read as thousands, not as 25.0 / 1.25.
 */
const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const s = v.replace(/[^\d.,-]/g, '');
  let n: number;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) n = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = Number(s.replace(/,/g, ''));
  else n = Number(s.replace(',', '.'));
  return Number.isNaN(n) ? 0 : n;
};

const RawItemSchema = z.object({
  amount: z.preprocess(toNum, z.number()),
  category: z.string().optional(),
  description: z.string().optional(),
  payment_method: z.string().optional(),
  date_offset: z.preprocess(toNum, z.number()).optional(),
  type: z.string().optional(),
  merchant: z.string().optional(),
  confidence: z.string().optional(),
});

function normalizeType(raw?: string): TransactionType {
  const v = (raw ?? '').toLowerCase().trim();
  if (/(income|pemasukan|masuk|gaji|pendapatan)/.test(v)) return 'income';
  if (/(saving|tabung|nabung|invest)/.test(v)) return 'saving';
  return 'expense';
}

/** Title-case a free-form source/goal name (income & saving categories). */
function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function normalizePaymentMethod(raw?: string): PaymentMethod {
  const v = (raw ?? '').toLowerCase().trim();
  if ((PAYMENT_METHODS as readonly string[]).includes(v)) return v as PaymentMethod;
  if (/(gopay|ovo|dana|shopeepay|shopee pay|linkaja|e-?wallet)/.test(v)) return 'ewallet';
  if (/qris/.test(v)) return 'qris';
  if (/(transfer|^tf$|trf|virtual\s?account|\bva\b)/.test(v)) return 'transfer';
  if (/debit/.test(v)) return 'debit';
  if (/(credit|kredit|\bcc\b|kartu kredit)/.test(v)) return 'cc';
  return 'cash';
}

/** Snap a free-form category onto the allowed list (case-insensitive), else "Lainnya". */
function normalizeCategory(raw: string | undefined, categories: string[]): string {
  const v = (raw ?? '').trim().toLowerCase();
  const hit = categories.find((c) => c.toLowerCase() === v);
  if (hit) return hit;
  return categories.find((c) => c.toLowerCase() === 'lainnya') ?? 'Lainnya';
}

function normalizeItem(raw: z.infer<typeof RawItemSchema>, categories: string[]): ParsedTransaction {
  const merchant = raw.merchant?.trim() || undefined;
  let description = (raw.description ?? '').trim();
  if (merchant && !description.toLowerCase().includes(merchant.toLowerCase())) {
    description = description ? `${description} (${merchant})` : merchant;
  }
  const offset = Math.min(0, Math.max(-366, Math.round(raw.date_offset ?? 0)));
  const confidence = raw.confidence?.toLowerCase() === 'low' ? 'low' : raw.confidence?.toLowerCase() === 'high' ? 'high' : undefined;
  const type = normalizeType(raw.type);

  // Expense categories snap to the enum; income/saving use a free-form
  // source / goal name (Gaji, Bonus, Dana Darurat, Liburan, ...).
  let category: string;
  if (type === 'expense') {
    category = normalizeCategory(raw.category, categories);
  } else {
    const free = (raw.category ?? '').trim();
    category = free ? titleCase(free) : type === 'income' ? 'Umum' : 'Tabungan';
  }

  return {
    amount: Math.round(Math.abs(raw.amount)),
    category,
    description: description || 'Transaksi',
    payment_method: normalizePaymentMethod(raw.payment_method),
    date_offset: offset,
    type,
    merchant,
    confidence,
  };
}

/** Coerce parsed JSON (array | object | single item) into a validated item list. */
export function coerceItems(parsed: unknown, categories: string[]): ParsedTransaction[] {
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const items: ParsedTransaction[] = [];
  for (const el of arr) {
    const r = RawItemSchema.safeParse(el);
    if (!r.success) continue;
    if (!Number.isFinite(r.data.amount)) continue;
    items.push(normalizeItem(r.data, categories));
  }
  return items;
}

// ---------------------------------------------------------------------------
// Prompts.
// ---------------------------------------------------------------------------

const DAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

/**
 * The model has no clock: without this it cannot turn "senin", "tgl 1" or a
 * date printed on a receipt into a date_offset. Appended at the END of the
 * system prompt so the long static prefix stays cacheable.
 */
function todayLine(now: Date): string {
  return `\n\nHARI INI: ${DAYS_ID[now.getDay()]}, ${toYMD(now)}. Hitung date_offset relatif terhadap tanggal ini.`;
}

function buildTextSystemPrompt(categories: string[], now: Date): string {
  return `Kamu adalah parser transaksi keuangan Bahasa Indonesia. Ubah pesan user menjadi JSON.

ATURAN OUTPUT:
- Keluarkan HANYA JSON array, tanpa penjelasan, tanpa markdown fence.
- Setiap item: {"amount": number, "category": string, "description": string, "payment_method": string, "date_offset": number, "type": string}
- amount: integer rupiah (tanpa titik/koma).
- type: "expense" (pengeluaran, default), "income" (pemasukan/uang masuk), atau "saving" (menabung/investasi).
  * income bila ada kata: gaji, gajian, bonus, thr, komisi, honor, fee, dividen, bunga, refund, cashback, dapat, terima, uang masuk, pemasukan.
  * saving bila ada kata: nabung, menabung, tabung, tabungan, sisihkan, deposito, investasi, reksadana, saham, emas.
  * selain itu "expense".
- category:
  * untuk type "expense": HARUS salah satu dari: ${categories.join(', ')}. Jika ragu pilih "Lainnya".
  * untuk type "income": sumber pemasukan (mis. "Gaji", "Bonus", "THR", "Refund"). Bebas.
  * untuk type "saving": nama tujuan tabungan (mis. "Dana Darurat", "Liburan", "Umroh"). Bebas; "Tabungan" bila tidak spesifik.
- payment_method: HARUS salah satu dari: cash, qris, transfer, ewallet, debit, cc, lainnya. Default "cash" bila tidak disebut. gopay/ovo/dana/shopeepay => ewallet; qris => qris; tf/trf/transfer => transfer.
- date_offset: 0 = hari ini, -1 = kemarin, -2 = 2 hari lalu, dst. JANGAN mengarang tanggal absolut.
- description: ringkas, huruf kapital di awal.

ATURAN NOMINAL RUPIAH:
- 25rb / 25k = 25000
- 2,5jt / 2.5jt = 2500000
- 18.500 = 18500 (titik = pemisah ribuan)
- 1.250.000 = 1250000
- Angka tanpa satuan dan < 1000 dianggap ribuan (mis. "parkir 2" = 2000).

Jika pesan BUKAN transaksi (sapaan, pertanyaan) keluarkan array kosong: []

CONTOH:
Input: makan siang 25rb
Output: [{"amount":25000,"category":"Makan","description":"Makan siang","payment_method":"cash","date_offset":0,"type":"expense"}]

Input: grab ke rs 18.500
Output: [{"amount":18500,"category":"Transportasi","description":"Grab ke RS","payment_method":"cash","date_offset":0,"type":"expense"}]

Input: gopay 50k bensin
Output: [{"amount":50000,"category":"Transportasi","description":"Bensin","payment_method":"ewallet","date_offset":0,"type":"expense"}]

Input: makan 25rb, parkir 2rb, kopi 18rb
Output: [{"amount":25000,"category":"Makan","description":"Makan","payment_method":"cash","date_offset":0,"type":"expense"},{"amount":2000,"category":"Transportasi","description":"Parkir","payment_method":"cash","date_offset":0,"type":"expense"},{"amount":18000,"category":"Makan","description":"Kopi","payment_method":"cash","date_offset":0,"type":"expense"}]

Input: gaji bulan ini 8jt
Output: [{"amount":8000000,"category":"Gaji","description":"Gaji bulanan","payment_method":"transfer","date_offset":0,"type":"income"}]

Input: dapat bonus 2jt kemarin
Output: [{"amount":2000000,"category":"Bonus","description":"Bonus","payment_method":"transfer","date_offset":-1,"type":"income"}]

Input: nabung dana darurat 500rb
Output: [{"amount":500000,"category":"Dana Darurat","description":"Nabung dana darurat","payment_method":"transfer","date_offset":0,"type":"saving"}]

Input: nabung 1jt buat liburan
Output: [{"amount":1000000,"category":"Liburan","description":"Nabung liburan","payment_method":"transfer","date_offset":0,"type":"saving"}]

Input: belanja sayur kemarin 75rb
Output: [{"amount":75000,"category":"Belanja Rumah Tangga","description":"Belanja sayur","payment_method":"cash","date_offset":-1,"type":"expense"}]

Input: halo bot
Output: []${todayLine(now)}`;
}

function buildVisionSystemPrompt(categories: string[], now: Date): string {
  return `Kamu adalah parser struk belanja & bukti transaksi (screenshot mutasi/notifikasi bank/e-wallet) Bahasa Indonesia. Baca gambar dan ubah menjadi JSON.

ATURAN OUTPUT:
- Keluarkan HANYA JSON, tanpa penjelasan, tanpa markdown fence.
- Jika gambar BUKAN struk atau bukti transaksi (foto acak): keluarkan {"not_receipt": true}
- Selain itu keluarkan JSON array. Setiap item:
  {"amount": number, "category": string, "description": string, "payment_method": string, "date_offset": number, "type": string, "merchant": string, "confidence": "high"|"low"}
- amount: integer rupiah (grand total, SETELAH pajak/diskon/service charge). Untuk 1 struk = 1 transaksi (jangan per item).
- Untuk screenshot DAFTAR mutasi dengan banyak transaksi: keluarkan array berisi tiap transaksi.
- type: "expense" untuk uang keluar (struk belanja, pembayaran, transfer keluar), "income" untuk uang MASUK (mutasi kredit/dana diterima). Struk belanja selalu "expense".
- category:
  * type "expense": HARUS salah satu dari: ${categories.join(', ')}. Jika ragu "Lainnya".
  * type "income": sumber (mis. "Transfer Masuk", "Gaji"). Bebas.
- payment_method: cash, qris, transfer, ewallet, debit, cc, lainnya. Logo GoPay/OVO/Dana => ewallet; "QRIS" => qris; screenshot m-banking/transfer => transfer.
- date_offset: 0 = hari ini. Jika tanggal terbaca di struk, hitung selisih hari dari hari ini (mis. kemarin = -1). Jika tidak terbaca, 0.
- merchant: nama toko/merchant bila terbaca; string kosong bila tidak.
- confidence: "low" bila nominal buram/terpotong/ambigu, selain itu "high".${todayLine(now)}`;
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** `now` = when the user sent the message; date_offset is relative to it. */
export async function parseTransaction(
  text: string,
  categories: string[],
  now = new Date(),
): Promise<ParsedTransaction[]> {
  const content = await callOpenRouter(
    config.OPENROUTER_MODEL,
    [
      { role: 'system', content: buildTextSystemPrompt(categories, now) },
      { role: 'user', content: text },
    ],
    TEXT_MAX_TOKENS,
    TEXT_TIMEOUT_MS,
  );
  const parsed = extractJson(content);
  return coerceItems(parsed, categories).filter((t) => t.amount > 0);
}

export interface VisionResult {
  items: ParsedTransaction[];
  notReceipt: boolean;
}

export async function parseImage(
  dataUrl: string,
  caption: string | undefined,
  categories: string[],
  now = new Date(),
): Promise<VisionResult> {
  const userText = caption
    ? `Konteks dari user (prioritaskan ini): ${caption}\n\nAnalisa gambar berikut.`
    : 'Analisa gambar berikut.';

  const content = await callOpenRouter(
    config.OPENROUTER_VISION_MODEL,
    [
      { role: 'system', content: buildVisionSystemPrompt(categories, now) },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    VISION_MAX_TOKENS,
    VISION_TIMEOUT_MS,
  );

  const parsed = extractJson(content);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as Record<string, unknown>).not_receipt) {
    return { items: [], notReceipt: true };
  }
  const items = coerceItems(parsed, categories).filter((t) => t.amount > 0);
  return { items, notReceipt: false };
}
