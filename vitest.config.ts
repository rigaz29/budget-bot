import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Dummy env so importing modules that transitively load ./config (which
    // validates env at import time) doesn't fail under test. Points the service
    // account path at an existing file to satisfy the existsSync check.
    env: {
      BOT_TOKEN: 'test-token',
      ALLOWED_CHAT_IDS: '111111',
      USER_NAMES: '111111:Test',
      OPENROUTER_API_KEY: 'test-key',
      GOOGLE_SERVICE_ACCOUNT_PATH: './package.json',
      SPREADSHEET_ID: 'test-sheet',
      TZ: 'Asia/Jakarta',
      BUDGET_START_DAY: '25',
    },
  },
});
