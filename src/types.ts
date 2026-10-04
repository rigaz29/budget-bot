/**
 * Shared domain types.
 *
 * Zod schemas that validate LLM output live in `services/llm.ts` (co-located with
 * the parsing logic). This file holds the plain TypeScript shapes used across the app.
 */

/** Payment methods accepted by the parser and stored in column G. */
export const PAYMENT_METHODS = [
  'cash',
  'qris',
  'transfer',
  'ewallet',
  'debit',
  'cc',
  'lainnya',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Transaction direction:
 *   expense — money out (default; the original behaviour)
 *   income  — money in (gaji, bonus, refund, ...)
 *   saving  — money set aside toward a goal (nabung, ...)
 * For income/saving the `category` field holds the source / savings-goal name
 * (free text), not one of the expense categories.
 */
export const TRANSACTION_TYPES = ['expense', 'income', 'saving'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * A single transaction as parsed from user input (text or image), before it is
 * enriched with absolute date / user / id and written to the sheet.
 */
export interface ParsedTransaction {
  amount: number;
  category: string;
  description: string;
  payment_method: PaymentMethod;
  /** 0 = today, -1 = yesterday, etc. The bot converts this to an absolute date. */
  date_offset: number;
  /** expense (default) / income / saving. */
  type: TransactionType;
  /** Vision-only: merchant name if legible. Merged into description. */
  merchant?: string;
  /** Vision-only: "high" | "low". Low means the nominal was blurry/ambiguous. */
  confidence?: 'high' | 'low';
}

/** A fully-resolved transaction, ready to append as a Transactions row. */
export interface Transaction {
  /** ISO 8601 timestamp (WIB) — column A */
  timestamp: string;
  /** YYYY-MM-DD transaction date — column B */
  date: string;
  /** Display name (Ryan / Istri) — column C */
  user: string;
  /** Integer rupiah — column D */
  amount: number;
  /** Category enum value — column E */
  category: string;
  /** Short description — column F */
  description: string;
  /** Payment method — column G */
  payment_method: PaymentMethod;
  /** Original user input, for debugging — column H */
  raw_input: string;
  /** Short UUID, used by /undo and the cancel button — column I */
  id: string;
  /** expense / income / saving — column J (empty in old rows = expense) */
  type: TransactionType;
}

/** A budget limit for a category (sheet `Budgets`). */
export interface Budget {
  category: string;
  monthly_limit: number;
}

/** A savings goal with its target amount (sheet `Tabungan`). */
export interface SavingGoal {
  goal: string;
  target: number;
}

/** Inclusive budget period [start, end]. */
export interface BudgetPeriod {
  start: Date;
  end: Date;
}

/** Per-category rollup used by /recap and /budget. */
export interface CategorySpend {
  category: string;
  spent: number;
  limit: number | null;
}

/**
 * Snapshot of the current budget period, served by `services/periodCache` so
 * transaction confirmations can show the remaining budget without re-reading
 * the whole Transactions sheet.
 */
export interface PeriodSummary {
  period: BudgetPeriod;
  income: number;
  expense: number;
  saving: number;
  /** Sum of every category limit in the Budgets sheet (0 = no budget set). */
  totalLimit: number;
  spentByCategory: Record<string, number>;
  limitByCategory: Record<string, number>;
}
