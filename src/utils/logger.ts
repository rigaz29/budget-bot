/**
 * Dead-simple structured-ish logging to stdout/stderr.
 * systemd/journalctl captures both streams; no log files.
 */

import { toISOLocal } from './period';

function ts(): string {
  // Local time in the configured TZ (WIB), so log lines match the sheet's timestamps.
  return toISOLocal(new Date());
}

function fmt(level: string, msg: string, meta?: unknown): string {
  const base = `${ts()} [${level}] ${msg}`;
  if (meta === undefined) return base;
  if (meta instanceof Error) return `${base} :: ${meta.stack ?? meta.message}`;
  try {
    return `${base} :: ${JSON.stringify(meta)}`;
  } catch {
    return `${base} :: ${String(meta)}`;
  }
}

export const logger = {
  info(msg: string, meta?: unknown): void {
    console.log(fmt('INFO', msg, meta));
  },
  warn(msg: string, meta?: unknown): void {
    console.warn(fmt('WARN', msg, meta));
  },
  error(msg: string, meta?: unknown): void {
    console.error(fmt('ERROR', msg, meta));
  },
};
