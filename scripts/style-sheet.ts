/**
 * CLI: rebuild the Dashboard & Rekap Bulanan tabs and restyle everything.
 *
 *   npm run style-sheet
 *
 * Thin wrapper around refreshDashboard() in src/services/dashboard.ts, which is
 * the same code the bot's /refresh command runs.
 */

import { refreshDashboard } from '../src/services/dashboard';

refreshDashboard()
  .then((r) => {
    console.log('✨ Spreadsheet dipercantik!');
    console.log(`   • Dashboard: ${r.categories} kategori · ${r.goals} tujuan tabungan`);
    console.log('   • Tab: Dashboard, Rekap Bulanan + styling semua tab');
  })
  .catch((err) => {
    console.error('❌ style-sheet gagal:', err);
    process.exit(1);
  });
