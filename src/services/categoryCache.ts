/**
 * In-memory cache of the category enum. Loaded from the Categories sheet at
 * startup so categories can be added without redeploying; refresh via
 * `/kategori reload`.
 */

import * as sheets from './sheets';
import { logger } from '../utils/logger';

const FALLBACK_CATEGORIES = [
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

let cache: string[] = [...FALLBACK_CATEGORIES];

export function getCategories(): string[] {
  return cache;
}

/** Re-read categories from the sheet. Falls back to defaults if the sheet is empty. */
export async function reload(): Promise<string[]> {
  const fromSheet = await sheets.getCategories();
  if (fromSheet.length > 0) {
    cache = fromSheet;
  } else {
    cache = [...FALLBACK_CATEGORIES];
    logger.warn('Sheet Categories kosong, memakai kategori default.');
  }
  return cache;
}
