import { describe, expect, it } from 'vitest';
import { formatRupiah, formatRupiahShort, parseRupiah } from './currency';

describe('parseRupiah', () => {
  const cases: Array<[string, number | null]> = [
    ['25rb', 25000],
    ['25k', 25000],
    ['200k', 200000],
    ['2,5jt', 2500000],
    ['2.5jt', 2500000],
    ['2jt', 2000000],
    ['18.500', 18500],
    ['1.250.000', 1250000],
    ['2500', 2500],
    ['parkir 2', 2000],
    ['5', 5000],
    ['500', 500000],
    ['makan siang 25rb', 25000],
    ['grab ke rs 18.500', 18500],
    ['token listrik 200k kemarin', 200000],
    ['gopay 50k bensin', 50000],
    ['halo bot', null],
    ['tidak ada angka disini', null],
  ];

  it.each(cases)('parses %s -> %s', (input, expected) => {
    expect(parseRupiah(input)).toBe(expected);
  });
});

describe('formatRupiah', () => {
  it.each([
    [0, 'Rp 0'],
    [18500, 'Rp 18.500'],
    [4250000, 'Rp 4.250.000'],
    [1000000, 'Rp 1.000.000'],
    [-5000, 'Rp -5.000'],
  ] as Array<[number, string]>)('%d -> %s', (n, expected) => {
    expect(formatRupiah(n)).toBe(expected);
  });
});

describe('formatRupiahShort', () => {
  it.each([
    [500, 'Rp 500'],
    [416000, 'Rp 416rb'],
    [1000000, 'Rp 1jt'],
    [2500000, 'Rp 2,5jt'],
  ] as Array<[number, string]>)('%d -> %s', (n, expected) => {
    expect(formatRupiahShort(n)).toBe(expected);
  });
});
