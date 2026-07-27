import { describe, expect, it } from 'vitest';
import { buildUserFields, extractSpreadsheetId, parseUserNames, renderEnv } from './setup-lib';

describe('extractSpreadsheetId', () => {
  it('extracts id from a full share URL', () => {
    expect(
      extractSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbC_de-FG123/edit#gid=0'),
    ).toBe('1AbC_de-FG123');
  });
  it('passes through a bare id', () => {
    expect(extractSpreadsheetId('1AbC_de-FG123')).toBe('1AbC_de-FG123');
  });
  it('trims whitespace', () => {
    expect(extractSpreadsheetId('  abc123  ')).toBe('abc123');
  });
});

describe('parseUserNames', () => {
  it('parses id:name pairs', () => {
    const m = parseUserNames('111:Ryan,222:Istri');
    expect(m.get('111')).toBe('Ryan');
    expect(m.get('222')).toBe('Istri');
  });
  it('tolerates empty/blank input', () => {
    expect(parseUserNames(undefined).size).toBe(0);
    expect(parseUserNames('').size).toBe(0);
  });
});

describe('buildUserFields', () => {
  it('joins ids and name pairs, skipping nameless users', () => {
    const f = buildUserFields([
      { id: 111, name: 'Ryan' },
      { id: 222, name: '' },
      { id: 333, name: 'Istri' },
    ]);
    expect(f.allowedChatIds).toBe('111,222,333');
    expect(f.userNames).toBe('111:Ryan,333:Istri');
  });
});

describe('renderEnv', () => {
  it('applies defaults for unset optional fields', () => {
    const out = renderEnv({ BOT_TOKEN: 'abc', ALLOWED_CHAT_IDS: '111', USER_NAMES: '111:Ryan' });
    expect(out).toContain('BOT_TOKEN=abc');
    expect(out).toContain('OPENROUTER_MODEL=deepseek/deepseek-chat');
    expect(out).toContain('OPENROUTER_VISION_MODEL=google/gemini-2.5-flash');
    expect(out).toContain('GOOGLE_SERVICE_ACCOUNT_PATH=./service-account.json');
    expect(out).toContain('TZ=Asia/Jakarta');
    expect(out).toContain('BUDGET_START_DAY=25');
  });
  it('preserves provided values over defaults', () => {
    const out = renderEnv({ TZ: 'Asia/Makassar', BUDGET_START_DAY: '1', OPENROUTER_MODEL: 'x/y' });
    expect(out).toContain('TZ=Asia/Makassar');
    expect(out).toContain('BUDGET_START_DAY=1');
    expect(out).toContain('OPENROUTER_MODEL=x/y');
  });
});
