/**
 * Ephemeral store for transactions awaiting user confirmation (low-confidence
 * photo parses). Kept in memory only — a lost bot restart just drops them, which
 * is fine: nothing was written to the sheet yet.
 */

import type { Transaction } from '../types';

interface PendingEntry {
  txs: Transaction[];
  createdAt: number;
}

const store = new Map<string, PendingEntry>();
const MAX_AGE_MS = 30 * 60 * 1000; // 30 min

export function put(token: string, txs: Transaction[], nowMs: number): void {
  store.set(token, { txs, createdAt: nowMs });
  // Opportunistic cleanup of stale entries.
  for (const [k, v] of store) {
    if (nowMs - v.createdAt > MAX_AGE_MS) store.delete(k);
  }
}

/** Retrieve and remove the pending transactions for a token. */
export function take(token: string): Transaction[] | undefined {
  const entry = store.get(token);
  if (!entry) return undefined;
  store.delete(token);
  return entry.txs;
}
