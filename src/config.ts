/**
 * Environment loading & validation. Fail fast: if anything is missing or invalid,
 * the process refuses to start with a clear message.
 */

import { existsSync } from 'node:fs';
import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/** Parse "111111,222222" into a list of numeric chat IDs. */
const chatIdList = z
  .string()
  .min(1, 'ALLOWED_CHAT_IDS kosong')
  .transform((s, ctx) => {
    const ids = s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x));
    if (ids.length === 0 || ids.some((n) => !Number.isInteger(n))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ALLOWED_CHAT_IDS harus berupa angka dipisah koma' });
      return z.NEVER;
    }
    return ids;
  });

/** Parse "111111:Ryan,222222:Istri" into a Map<chatId, name>. */
const userNameMap = z
  .string()
  .default('')
  .transform((s) => {
    const map = new Map<number, string>();
    for (const pair of s.split(',').map((x) => x.trim()).filter(Boolean)) {
      const idx = pair.indexOf(':');
      if (idx === -1) continue;
      const id = Number(pair.slice(0, idx).trim());
      const name = pair.slice(idx + 1).trim();
      if (Number.isInteger(id) && name) map.set(id, name);
    }
    return map;
  });

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN wajib diisi'),
  ALLOWED_CHAT_IDS: chatIdList,
  USER_NAMES: userNameMap,

  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY wajib diisi'),
  OPENROUTER_MODEL: z.string().min(1).default('deepseek/deepseek-chat'),
  OPENROUTER_VISION_MODEL: z.string().min(1).default('google/gemini-2.5-flash'),

  GOOGLE_SERVICE_ACCOUNT_PATH: z
    .string()
    .min(1, 'GOOGLE_SERVICE_ACCOUNT_PATH wajib diisi')
    .refine((p) => existsSync(p), (p) => ({ message: `File service account tidak ditemukan: ${p}` })),
  SPREADSHEET_ID: z.string().min(1, 'SPREADSHEET_ID wajib diisi'),

  TZ: z
    .string()
    .min(1)
    .default('Asia/Jakarta')
    .refine(isValidTimeZone, (tz) => ({ message: `TZ tidak dikenal: ${tz} (mis. Asia/Jakarta)` })),
  BUDGET_START_DAY: z
    .string()
    .default('1')
    .transform((s) => parseInt(s, 10))
    .pipe(z.number().int().min(1).max(31)),
});

export type Config = z.infer<typeof EnvSchema> & {
  allowedChatIds: Set<number>;
  userNames: Map<number, string>;
};

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`❌ Konfigurasi environment tidak valid:\n${issues}`);
    process.exit(1);
  }
  const env = parsed.data;
  // All date math reads the process timezone. Apply the validated value so the
  // default actually takes effect — otherwise a missing TZ silently means UTC on
  // a VPS, and anything recorded 00:00–07:00 WIB lands on the previous day.
  process.env.TZ = env.TZ;
  return {
    ...env,
    allowedChatIds: new Set(env.ALLOWED_CHAT_IDS),
    userNames: env.USER_NAMES,
  };
}

export const config = load();

/** Resolve a chat ID to a display name, falling back to the numeric ID. */
export function resolveUserName(chatId: number): string {
  return config.userNames.get(chatId) ?? String(chatId);
}
