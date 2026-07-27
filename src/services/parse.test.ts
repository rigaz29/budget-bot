import { describe, expect, it } from 'vitest';
import { coerceItems } from './llm';

const CATS = [
  'Makan',
  'Transportasi',
  'Belanja Rumah Tangga',
  'Kesehatan',
  'Hiburan',
  'Tagihan',
  'Anak & Keluarga',
  'Investasi & Tabungan',
  'Sosial & Hadiah',
  'Lainnya',
];

describe('coerceItems (zod validation + normalization)', () => {
  it('normalizes a well-formed item', () => {
    const [item] = coerceItems(
      [{ amount: 25000, category: 'makan', description: 'Makan siang', payment_method: 'cash', date_offset: 0 }],
      CATS,
    );
    expect(item).toMatchObject({
      amount: 25000,
      category: 'Makan',
      description: 'Makan siang',
      payment_method: 'cash',
      date_offset: 0,
    });
  });

  it('snaps unknown categories to Lainnya (case-insensitive match otherwise)', () => {
    expect(coerceItems([{ amount: 1000, category: 'transportasi' }], CATS)[0].category).toBe('Transportasi');
    expect(coerceItems([{ amount: 1000, category: 'ngawur' }], CATS)[0].category).toBe('Lainnya');
  });

  it('maps payment-method synonyms', () => {
    expect(coerceItems([{ amount: 1, payment_method: 'gopay' }], CATS)[0].payment_method).toBe('ewallet');
    expect(coerceItems([{ amount: 1, payment_method: 'qris' }], CATS)[0].payment_method).toBe('qris');
    expect(coerceItems([{ amount: 1, payment_method: 'tf' }], CATS)[0].payment_method).toBe('transfer');
    expect(coerceItems([{ amount: 1 }], CATS)[0].payment_method).toBe('cash');
  });

  it('clamps date_offset to (-366..0]', () => {
    expect(coerceItems([{ amount: 1, date_offset: 5 }], CATS)[0].date_offset).toBe(0);
    expect(coerceItems([{ amount: 1, date_offset: -1 }], CATS)[0].date_offset).toBe(-1);
    expect(coerceItems([{ amount: 1, date_offset: -9999 }], CATS)[0].date_offset).toBe(-366);
  });

  it('rounds and absolutes the amount', () => {
    expect(coerceItems([{ amount: -50000.4 }], CATS)[0].amount).toBe(50000);
  });

  it('merges merchant into an empty description', () => {
    const [item] = coerceItems([{ amount: 50000, category: 'Makan', description: '', merchant: 'Indomaret' }], CATS);
    expect(item.description).toBe('Indomaret');
  });

  it('carries low confidence through', () => {
    expect(coerceItems([{ amount: 1, confidence: 'low' }], CATS)[0].confidence).toBe('low');
  });

  it('wraps a single object and parses multi-item arrays', () => {
    expect(coerceItems({ amount: 1000, category: 'Makan' }, CATS)).toHaveLength(1);
    expect(coerceItems([{ amount: 1 }, { amount: 2 }, { amount: 3 }], CATS)).toHaveLength(3);
  });

  it('drops non-object garbage', () => {
    expect(coerceItems(['nope', 42, null], CATS)).toHaveLength(0);
  });
});

describe('transaction type (expense / income / saving)', () => {
  it('defaults to expense when type is absent', () => {
    expect(coerceItems([{ amount: 25000, category: 'Makan' }], CATS)[0].type).toBe('expense');
  });

  it('keeps income category free-form (not snapped to expense enum)', () => {
    const [item] = coerceItems([{ amount: 8000000, category: 'Gaji', type: 'income' }], CATS);
    expect(item.type).toBe('income');
    expect(item.category).toBe('Gaji');
  });

  it('title-cases and keeps saving goal free-form', () => {
    const [item] = coerceItems([{ amount: 500000, category: 'dana darurat', type: 'saving' }], CATS);
    expect(item.type).toBe('saving');
    expect(item.category).toBe('Dana Darurat');
  });

  it('defaults source/goal when income/saving category is empty', () => {
    expect(coerceItems([{ amount: 1, type: 'income' }], CATS)[0].category).toBe('Umum');
    expect(coerceItems([{ amount: 1, type: 'saving' }], CATS)[0].category).toBe('Tabungan');
  });

  it('recognizes type synonyms', () => {
    expect(coerceItems([{ amount: 1, category: 'X', type: 'pemasukan' }], CATS)[0].type).toBe('income');
    expect(coerceItems([{ amount: 1, category: 'X', type: 'nabung' }], CATS)[0].type).toBe('saving');
  });

  it('snaps expense category even when an expense-like category name is used', () => {
    const [item] = coerceItems([{ amount: 1, category: 'transportasi', type: 'expense' }], CATS);
    expect(item.category).toBe('Transportasi');
  });
});
