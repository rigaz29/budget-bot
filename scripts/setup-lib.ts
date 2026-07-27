/**
 * Pure helpers for the setup wizard — no I/O, no side effects, so they can be
 * unit-tested. The interactive shell lives in setup.ts.
 */

export interface TgUser {
  id: number;
  name: string;
}

/** Accept a raw spreadsheet id or a full share URL and return just the id. */
export function extractSpreadsheetId(input: string): string {
  const m = /\/d\/([a-zA-Z0-9-_]+)/.exec(input);
  return (m ? m[1] : input).trim();
}

/** Parse an existing "id:Name,id:Name" string into a lookup map. */
export function parseUserNames(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf(':');
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return map;
}

/** Build the ALLOWED_CHAT_IDS + USER_NAMES fields from confirmed users. */
export function buildUserFields(users: TgUser[]): { allowedChatIds: string; userNames: string } {
  return {
    allowedChatIds: users.map((u) => u.id).join(','),
    userNames: users
      .filter((u) => u.name)
      .map((u) => `${u.id}:${u.name}`)
      .join(','),
  };
}

/** Render the full .env file from a values map, applying defaults. */
export function renderEnv(v: Record<string, string>): string {
  return `# === Telegram ===
BOT_TOKEN=${v.BOT_TOKEN ?? ''}
ALLOWED_CHAT_IDS=${v.ALLOWED_CHAT_IDS ?? ''}
USER_NAMES=${v.USER_NAMES ?? ''}

# === OpenRouter (LLM) ===
OPENROUTER_API_KEY=${v.OPENROUTER_API_KEY ?? ''}
OPENROUTER_MODEL=${v.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat'}
OPENROUTER_VISION_MODEL=${v.OPENROUTER_VISION_MODEL ?? 'google/gemini-2.5-flash'}

# === Google Sheets ===
GOOGLE_SERVICE_ACCOUNT_PATH=${v.GOOGLE_SERVICE_ACCOUNT_PATH ?? './service-account.json'}
SPREADSHEET_ID=${v.SPREADSHEET_ID ?? ''}

# === Runtime ===
TZ=${v.TZ ?? 'Asia/Jakarta'}
BUDGET_START_DAY=${v.BUDGET_START_DAY ?? '25'}
`;
}
