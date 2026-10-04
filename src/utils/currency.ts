/**
 * Rupiah parsing & formatting.
 *
 * `parseRupiah` is a best-effort regex fallback used ONLY when the LLM parse
 * fails/timeouts. The LLM handles the common cases; this keeps the bot useful
 * when OpenRouter is down.
 *
 * Rules (from the brief):
 *   25rb / 25k        => 25000
 *   2,5jt / 2.5jt     => 2500000
 *   18.500            => 18500        (dot = thousands separator)
 *   1.250.000         => 1250000
 *   parkir 2          => 2000         (bare number < 1000 is treated as thousands)
 */

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  rb: 1_000,
  ribu: 1_000,
  jt: 1_000_000,
  juta: 1_000_000,
};

/** Interpret one numeric token (+ optional satuan) into integer rupiah. */
function interpret(rawNum: string, satuan?: string): number | null {
  // Trim any trailing separators the greedy regex may have swallowed ("18.500.").
  const cleaned = rawNum.replace(/[.,]+$/, '');

  if (satuan) {
    const mult = MULTIPLIERS[satuan];
    // With a satuan, a separator is a decimal point: "2,5jt" -> 2.5 * 1_000_000.
    const n = parseFloat(cleaned.replace(',', '.'));
    if (Number.isNaN(n)) return null;
    return Math.round(n * mult);
  }

  // No satuan: separators are thousands markers. Strip them all.
  const digits = cleaned.replace(/[.,]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  let n = parseInt(digits, 10);
  if (Number.isNaN(n) || n === 0) return null;
  if (n < 1000) n *= 1000; // "parkir 2" => 2000
  return n;
}

/**
 * Scan free text and return the most plausible rupiah amount, or null.
 *
 * The first number with an explicit satuan ("25rb") wins — that is the price.
 * Without one, the largest bare number wins: quantities and day counts
 * ("2 porsi", "2 hari lalu") are small, prices are not.
 *
 * Longer satuan words are matched before shorter ones (juta before jt, etc.),
 * and a satuan must end at a word boundary so "2 kg" / "2 kopi" aren't "2k".
 */
export function parseRupiah(input: string): number | null {
  const text = input.toLowerCase();
  const re = /(\d[\d.,]*)(?:\s*(juta|ribu|jt|rb|k)\b)?/g;
  let largestBare: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = interpret(m[1], m[2]);
    if (value === null || value <= 0) continue;
    if (m[2]) return value;
    if (largestBare === null || value > largestBare) largestBare = value;
  }
  return largestBare;
}

/** Format integer rupiah as "Rp 18.500". */
export function formatRupiah(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const grouped = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `Rp ${sign}${grouped}`;
}

function trimNum(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '').replace('.', ',');
}

/** Compact format for recap ("Rp 416rb", "Rp 1,3jt"). */
export function formatRupiahShort(amount: number): string {
  const a = Math.round(amount);
  if (a >= 1_000_000) return `Rp ${trimNum(a / 1_000_000)}jt`;
  if (a >= 1_000) return `Rp ${trimNum(a / 1_000)}rb`;
  return `Rp ${a}`;
}
