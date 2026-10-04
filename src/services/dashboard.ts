/**
 * Dashboard + Rekap Bulanan builder/styler — shared by the `/refresh` bot command
 * and the `style-sheet` CLI. Rebuilds the Dashboard & Rekap Bulanan tabs (live
 * formulas) and restyles every tab. Non-destructive & idempotent; transaction
 * rows are never modified.
 */

import { google, sheets_v4 } from 'googleapis';
import { config } from '../config';

type Req = sheets_v4.Schema$Request;
type Color = sheets_v4.Schema$Color;

const DEFAULT_CATEGORIES = [
  'Makan', 'Transportasi', 'Belanja Rumah Tangga', 'Kesehatan', 'Hiburan',
  'Tagihan', 'Anak & Keluarga', 'Investasi & Tabungan', 'Sosial & Hadiah', 'Lainnya',
];

// --- palette -----------------------------------------------------------------

function hex(h: string): Color {
  const n = h.replace('#', '');
  return {
    red: parseInt(n.slice(0, 2), 16) / 255,
    green: parseInt(n.slice(2, 4), 16) / 255,
    blue: parseInt(n.slice(4, 6), 16) / 255,
  };
}

const WHITE = hex('#ffffff');

interface SheetTheme {
  headerBg: Color;
  altBand: Color;
  tab: Color;
}

const THEMES: Record<string, SheetTheme> = {
  Dashboard: { headerBg: hex('#0f766e'), altBand: hex('#f0fdfa'), tab: hex('#0d9488') },
  Transactions: { headerBg: hex('#1e40af'), altBand: hex('#eff6ff'), tab: hex('#2563eb') },
  Budgets: { headerBg: hex('#166534'), altBand: hex('#f0fdf4'), tab: hex('#16a34a') },
  Categories: { headerBg: hex('#6b21a8'), altBand: hex('#faf5ff'), tab: hex('#9333ea') },
  Tabungan: { headerBg: hex('#0e7490'), altBand: hex('#ecfeff'), tab: hex('#0891b2') },
};

const CURRENCY = '"Rp "#,##0';

// Warm "planner" palette for the Dashboard (inspired by the reference template).
const DASH = {
  cream: hex('#fdfcf3'),
  ink: hex('#3f3f46'),
  cardIncome: hex('#15803d'), // green
  cardExpense: hex('#c2410c'), // burnt orange
  cardSaving: hex('#1d4ed8'), // blue
  cardSaldo: hex('#0f766e'), // teal
  section: hex('#44403c'), // stone-800 (section bars)
  tableHeader: hex('#115e59'), // teal-800 (expense table)
  savingHeader: hex('#1e3a8a'), // blue-900 (saving table)
  logHeader: hex('#57534e'), // stone-600 (list headers)
  totalBg: hex('#fde68a'), // warm amber
  border: hex('#d6d3d1'), // stone-300
  attnRed: hex('#fee2e2'),
  attnRedInk: hex('#991b1b'),
  attnAmber: hex('#fef9c3'),
  attnGreen: hex('#dcfce7'),
};

// --- request builders --------------------------------------------------------

function grid(
  sheetId: number,
  sr: number,
  er: number | undefined,
  sc: number,
  ec: number | undefined,
): sheets_v4.Schema$GridRange {
  const r: sheets_v4.Schema$GridRange = { sheetId, startRowIndex: sr, startColumnIndex: sc };
  if (er !== undefined) r.endRowIndex = er;
  if (ec !== undefined) r.endColumnIndex = ec;
  return r;
}

function setFreeze(sheetId: number, rows: number): Req {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: rows } },
      fields: 'gridProperties.frozenRowCount',
    },
  };
}

function tabAndGridlines(sheetId: number, tab: Color, hideGridlines = false): Req {
  return {
    updateSheetProperties: {
      properties: { sheetId, tabColor: tab, gridProperties: { hideGridlines: hideGridlines } },
      fields: 'tabColor,gridProperties.hideGridlines',
    },
  };
}

function headerFormat(sheetId: number, cols: number, bg: Color, fontSize = 10): Req {
  return {
    repeatCell: {
      range: grid(sheetId, 0, 1, 0, cols),
      cell: {
        userEnteredFormat: {
          backgroundColor: bg,
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          textFormat: { bold: true, foregroundColor: WHITE, fontSize },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)',
    },
  };
}

function rowHeight(sheetId: number, sr: number, er: number, px: number): Req {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: sr, endIndex: er },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function colWidth(sheetId: number, col: number, px: number): Req {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 },
      properties: { pixelSize: px },
      fields: 'pixelSize',
    },
  };
}

function hideCols(sheetId: number, sc: number, ec: number): Req {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: sc, endIndex: ec },
      properties: { hiddenByUser: true },
      fields: 'hiddenByUser',
    },
  };
}

function banding(sheetId: number, sr: number, er: number | undefined, ec: number, theme: SheetTheme): Req {
  return {
    addBanding: {
      bandedRange: {
        range: grid(sheetId, sr, er, 0, ec),
        rowProperties: {
          headerColor: theme.headerBg,
          firstBandColor: WHITE,
          secondBandColor: theme.altBand,
        },
      },
    },
  };
}

/** `er` undefined = to the last row (an unbounded range can never exceed the grid). */
function numberFormat(sheetId: number, sr: number, er: number | undefined, sc: number, ec: number, pattern: string, type: string, align?: string): Req {
  const uef: sheets_v4.Schema$CellFormat = { numberFormat: { type, pattern } };
  let fields = 'userEnteredFormat.numberFormat';
  if (align) {
    uef.horizontalAlignment = align;
    fields += ',userEnteredFormat.horizontalAlignment';
  }
  return { repeatCell: { range: grid(sheetId, sr, er, sc, ec), cell: { userEnteredFormat: uef }, fields } };
}

function borderBox(sheetId: number, sr: number, er: number, sc: number, ec: number, color: Color): Req {
  const line = { style: 'SOLID', color };
  return {
    updateBorders: {
      range: grid(sheetId, sr, er, sc, ec),
      top: line, bottom: line, left: line, right: line, innerHorizontal: line,
    },
  };
}

// --- meta --------------------------------------------------------------------

interface SheetMeta {
  sheetId: number;
  title: string;
  bandedRangeIds: number[];
  hasFilter: boolean;
  conditionalCount: number;
  mergeCount: number;
  chartIds: number[];
}

async function getMeta(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<Map<string, SheetMeta>> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields:
      'sheets(properties(sheetId,title),merges,bandedRanges(bandedRangeId),basicFilter,conditionalFormats,charts(chartId))',
  });
  const map = new Map<string, SheetMeta>();
  for (const s of res.data.sheets ?? []) {
    const title = s.properties?.title;
    const sheetId = s.properties?.sheetId;
    if (!title || sheetId === null || sheetId === undefined) continue;
    map.set(title, {
      sheetId,
      title,
      bandedRangeIds: (s.bandedRanges ?? []).map((b) => b.bandedRangeId!).filter((x) => x != null),
      hasFilter: !!s.basicFilter,
      conditionalCount: (s.conditionalFormats ?? []).length,
      mergeCount: (s.merges ?? []).length,
      chartIds: (s.charts ?? []).map((c) => c.chartId!).filter((x) => x != null),
    });
  }
  return map;
}

async function readCategories(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<string[]> {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Categories!A:A' });
    const rows = (res.data.values as string[][] | undefined) ?? [];
    const out = rows
      .map((r) => (r[0] ?? '').trim())
      .filter((v) => v && !/^(kategori|category)$/i.test(v));
    return out.length > 0 ? out : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

/**
 * Savings-goal names for the Dashboard savings table: goals with a target in the
 * Tabungan sheet, plus goals that so far only have deposits (the same union as
 * the bot's /tabungan). Reading the Tabungan sheet alone hid every rupiah saved
 * before a target was set. Matched case-insensitively; the sheet's spelling wins.
 */
async function readGoals(sheets: sheets_v4.Sheets, spreadsheetId: string): Promise<string[]> {
  const names = new Map<string, string>();
  const add = (name: string) => {
    const v = name.trim();
    if (v && !names.has(v.toLowerCase())) names.set(v.toLowerCase(), v);
  };
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Tabungan!A:A' });
    for (const r of (res.data.values as string[][] | undefined) ?? []) {
      if (!/^(goal|tujuan)$/i.test((r[0] ?? '').trim())) add(r[0] ?? '');
    }
  } catch {
    /* no Tabungan tab yet */
  }
  try {
    // E = category (the goal), J = type.
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Transactions!E:J' });
    for (const r of (res.data.values as string[][] | undefined) ?? []) {
      if ((r[5] ?? '').trim().toLowerCase() === 'saving') add(r[0] ?? '');
    }
  } catch {
    /* ignore — the table just lists the targets */
  }
  // Always render at least one row so the section isn't empty.
  return names.size > 0 ? [...names.values()] : ['(belum ada tujuan — set via /tabungan)'];
}

// --- Dashboard content -------------------------------------------------------

/**
 * Category / goal names are user-typed and written with USER_ENTERED: a leading
 * apostrophe keeps "=..." / "+..." / "-..." / "@..." a literal label instead of
 * being evaluated as a formula. The stored value stays the plain name, so the
 * VLOOKUP/SUMPRODUCT matches against it still work.
 */
function asLabel(name: string): string {
  return /^[=+\-@]/.test(name) ? `'${name}` : name;
}

function startFormula(): string {
  return (
    '=IF(DAY($K$2)>=MIN($K$3,DAY(EOMONTH($K$2,0))),' +
    'DATE(YEAR($K$2),MONTH($K$2),MIN($K$3,DAY(EOMONTH($K$2,0)))),' +
    'DATE(YEAR(EOMONTH($K$2,-1)),MONTH(EOMONTH($K$2,-1)),MIN($K$3,DAY(EOMONTH($K$2,-1)))))'
  );
}
function endFormula(): string {
  return (
    '=DATE(YEAR(EDATE($K$4,1)),MONTH(EDATE($K$4,1)),MIN($K$3,DAY(EOMONTH(EDATE($K$4,1),0))))-1'
  );
}

// Reusable formula fragments (whole-column, header-safe, shift-immune).
// Dates are stored as ISO "YYYY-MM-DD" text, which sorts correctly as text — so we
// compare as text against the period bounds ($K$6/$K$7). This avoids DATEVALUE,
// which is unreliable on ISO strings under the in_ID locale.
const F_DATE_IN = '(Transactions!$B:$B>=$K$6)*(Transactions!$B:$B<=$K$7)';
const F_AMT = 'IFERROR(Transactions!$D:$D*1,0)';
const F_INCOME = '(Transactions!$J:$J="income")';
const F_SAVING = '(Transactions!$J:$J="saving")';
const F_EXPENSE = '(Transactions!$J:$J<>"income")*(Transactions!$J:$J<>"saving")';

const INC_ROWS = 6;
const LOG_ROWS = 10;

// The recent-income / recent-expense lists sort by date, then by timestamp.
// Sorting by date alone keeps same-day rows in sheet order (oldest first), so on
// a day with more than LOG_ROWS entries the NEWEST ones were cut off the list.
// The timestamp (col A) rides along as a trailing column purely as the
// tie-breaker; ARRAY_CONSTRAIN then drops it from the output.

interface DashLayout {
  rows: (string | number | null)[][];
  rCardLabel: number;
  rCardValue: number;
  rSecExpense: number;
  rExpHeader: number;
  rExp0: number;
  rExpLast: number;
  rExpTotal: number;
  rFooter: number;
  rSecIncome: number;
  rIncHead: number;
  rIncData: number;
  rIncEnd: number;
  rSecSaving: number;
  rSavHead: number;
  rSav0: number;
  rSavLast: number;
  rSavTotal: number;
  rSecLog: number;
  rLogHead: number;
  rLogData: number;
  rLogEnd: number;
  width: number;
}

function buildDashboard(categories: string[], goals: string[], startDay: number): DashLayout {
  const width = 13; // A..M (J,K = settings; M = bar-color helper)
  const k = categories.length;
  const g = goals.length;

  const rCardLabel = 4;
  const rCardValue = 5;
  const rSecExpense = 7;
  const rExpHeader = 8;
  const rExp0 = 9;
  const rExpLast = rExp0 + k - 1;
  const rExpTotal = rExp0 + k;
  const rFooter = rExpTotal + 1;
  const rSecIncome = rFooter + 2;
  const rIncHead = rSecIncome + 1;
  const rIncData = rIncHead + 1;
  const rIncEnd = rIncData + INC_ROWS - 1;
  const rSecSaving = rIncEnd + 2;
  const rSavHead = rSecSaving + 1;
  const rSav0 = rSavHead + 1;
  const rSavLast = rSav0 + g - 1;
  const rSavTotal = rSav0 + g;
  const rSecLog = rSavTotal + 2;
  const rLogHead = rSecLog + 1;
  const rLogData = rLogHead + 1;
  const rLogEnd = rLogData + LOG_ROWS - 1;

  // null = leave cell untouched (so array-spill formulas can expand into them).
  const rows: (string | number | null)[][] = Array.from({ length: rLogData }, () => Array(width).fill(null));
  const set = (row1: number, col: number, val: string | number) => {
    rows[row1 - 1][col] = val;
  };

  // Title + period.
  set(1, 0, '💰  DASHBOARD BUDGET RUMAH TANGGA');
  set(2, 0, '=" 📅  "&TEXT($K$4,"d mmm yyyy")&"   —   "&TEXT($K$5,"d mmm yyyy")');

  // Hidden settings / period-math helpers (columns J,K).
  set(2, 9, 'Hari ini'); set(2, 10, '=TODAY()');
  set(3, 9, 'Tgl mulai'); set(3, 10, startDay);
  set(4, 9, 'Mulai'); set(4, 10, startFormula());
  set(5, 9, 'Akhir'); set(5, 10, endFormula());
  // Period bounds as ISO text, for text-based date filtering.
  set(6, 9, 'Mulai teks'); set(6, 10, '=TEXT($K$4,"yyyy-mm-dd")');
  set(7, 9, 'Akhir teks'); set(7, 10, '=TEXT($K$5,"yyyy-mm-dd")');

  // ARUS KAS cards (period). Saldo = Pemasukan − Pengeluaran − Tabungan.
  set(rCardLabel, 0, 'PEMASUKAN'); set(rCardLabel, 2, 'PENGELUARAN'); set(rCardLabel, 4, 'TABUNGAN'); set(rCardLabel, 6, 'SALDO');
  set(rCardValue, 0, `=SUMPRODUCT(${F_INCOME}*${F_DATE_IN}*${F_AMT})`);
  set(rCardValue, 2, `=SUMPRODUCT(${F_EXPENSE}*${F_DATE_IN}*${F_AMT})`);
  set(rCardValue, 4, `=SUMPRODUCT(${F_SAVING}*${F_DATE_IN}*${F_AMT})`);
  set(rCardValue, 6, '=$A$5-$C$5-$E$5');

  // PENGELUARAN vs BUDGET table.
  set(rSecExpense, 0, 'P E N G E L U A R A N   v s   B U D G E T');
  set(rExpHeader, 0, 'Kategori'); set(rExpHeader, 1, 'Budget'); set(rExpHeader, 2, 'Terpakai');
  set(rExpHeader, 3, 'Sisa'); set(rExpHeader, 4, '%'); set(rExpHeader, 5, 'Progress');
  for (let i = 0; i < k; i++) {
    const row = rExp0 + i;
    set(row, 0, asLabel(categories[i]));
    set(row, 1, `=IFERROR(VLOOKUP($A${row},Budgets!$A:$B,2,FALSE),0)`);
    set(row, 2, `=SUMPRODUCT((Transactions!$E:$E=$A${row})*${F_EXPENSE}*${F_DATE_IN}*${F_AMT})`);
    set(row, 3, `=IF($B${row}=0,"",$B${row}-$C${row})`);
    set(row, 4, `=IF($B${row}=0,"",$C${row}/$B${row})`);
    set(row, 5, `=IF($B${row}=0,"—",SPARKLINE($C${row},{"charttype","bar";"max",$B${row};"color1",$M${row}}))`);
    set(row, 12, `=IF($B${row}=0,"#cbd5e1",IF($C${row}/$B${row}>=0.9,"#ef4444",IF($C${row}/$B${row}>=0.7,"#f59e0b","#10b981")))`);
  }
  set(rExpTotal, 0, 'TOTAL');
  set(rExpTotal, 1, `=SUM($B$${rExp0}:$B$${rExpLast})`);
  set(rExpTotal, 2, `=SUM($C$${rExp0}:$C$${rExpLast})`);
  set(rExpTotal, 3, `=IF($B${rExpTotal}=0,"",$B${rExpTotal}-$C${rExpTotal})`);
  set(rExpTotal, 4, `=IF($B${rExpTotal}=0,"",$C${rExpTotal}/$B${rExpTotal})`);
  set(rExpTotal, 5, `=IF($B${rExpTotal}=0,"—",SPARKLINE($C${rExpTotal},{"charttype","bar";"max",$B${rExpTotal};"color1","#115e59"}))`);

  set(
    rFooter,
    0,
    `="🗓  Sisa "&MAX(0,$K$5-$K$2+1)&" hari    ·    "&IF($B${rExpTotal}=0,"Set budget via /budget untuk batas harian",` +
      `"Aman: Rp "&TEXT(IF(MAX(0,$K$5-$K$2+1)>0,MAX(0,$D${rExpTotal})/MAX(1,$K$5-$K$2+1),0),"#,##0")&" / hari")`,
  );

  // PEMASUKAN — recent income (spill, newest first).
  set(rSecIncome, 0, 'P E M A S U K A N');
  set(rIncHead, 0, 'Tanggal'); set(rIncHead, 1, 'Sumber'); set(rIncHead, 2, 'Nominal');
  set(
    rIncData,
    0,
    `=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(` +
      `{Transactions!$B:$B,Transactions!$E:$E,Transactions!$D:$D,Transactions!$A:$A},${F_INCOME}),1,FALSE,4,FALSE),${INC_ROWS},3),"Belum ada pemasukan")`,
  );

  // TABUNGAN — savings goals vs target (all-time; savings accumulate).
  set(rSecSaving, 0, 'T A B U N G A N');
  set(rSavHead, 0, 'Tujuan'); set(rSavHead, 1, 'Target'); set(rSavHead, 2, 'Terkumpul');
  set(rSavHead, 3, 'Sisa'); set(rSavHead, 4, '%'); set(rSavHead, 5, 'Progress');
  for (let i = 0; i < g; i++) {
    const row = rSav0 + i;
    set(row, 0, asLabel(goals[i]));
    set(row, 1, `=IFERROR(VLOOKUP($A${row},Tabungan!$A:$B,2,FALSE),0)`);
    set(row, 2, `=SUMPRODUCT((Transactions!$E:$E=$A${row})*${F_SAVING}*${F_AMT})`);
    set(row, 3, `=IF($B${row}=0,"",$B${row}-$C${row})`);
    set(row, 4, `=IF($B${row}=0,"",$C${row}/$B${row})`);
    set(row, 5, `=IF($B${row}=0,"—",SPARKLINE($C${row},{"charttype","bar";"max",$B${row};"color1",$M${row}}))`);
    set(row, 12, `=IF($B${row}=0,"#93c5fd",IF($C${row}/$B${row}>=1,"#16a34a","#1d4ed8"))`);
  }
  set(rSavTotal, 0, 'TOTAL');
  set(rSavTotal, 1, `=SUM($B$${rSav0}:$B$${rSavLast})`);
  set(rSavTotal, 2, `=SUM($C$${rSav0}:$C$${rSavLast})`);
  set(rSavTotal, 3, `=IF($B${rSavTotal}=0,"",$B${rSavTotal}-$C${rSavTotal})`);
  set(rSavTotal, 4, `=IF($B${rSavTotal}=0,"",$C${rSavTotal}/$B${rSavTotal})`);
  set(rSavTotal, 5, `=IF($B${rSavTotal}=0,"—",SPARKLINE($C${rSavTotal},{"charttype","bar";"max",$B${rSavTotal};"color1","#1e3a8a"}))`);

  // LACAK PENGELUARAN — recent expenses (spill).
  set(rSecLog, 0, 'L A C A K   P E N G E L U A R A N');
  set(rLogHead, 0, 'Tanggal'); set(rLogHead, 1, 'Kategori'); set(rLogHead, 2, 'Nominal'); set(rLogHead, 3, 'Catatan');
  set(
    rLogData,
    0,
    `=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER(` +
      `{Transactions!$B:$B,Transactions!$E:$E,Transactions!$D:$D,Transactions!$F:$F,Transactions!$A:$A},` +
      `(Transactions!$I:$I<>"")*(Transactions!$B:$B<>"date")*${F_EXPENSE}),1,FALSE,5,FALSE),${LOG_ROWS},4),"Belum ada pengeluaran")`,
  );

  return {
    rows, rCardLabel, rCardValue, rSecExpense, rExpHeader, rExp0, rExpLast, rExpTotal, rFooter,
    rSecIncome, rIncHead, rIncData, rIncEnd, rSecSaving, rSavHead, rSav0, rSavLast, rSavTotal,
    rSecLog, rLogHead, rLogData, rLogEnd, width,
  };
}

// --- Dashboard formatting ----------------------------------------------------

function dashboardRequests(sheetId: number, L: DashLayout): Req[] {
  const reqs: Req[] = [];
  const idx = (row1: number) => row1 - 1;
  const fmt = (
    sr: number, er: number, sc: number, ec: number,
    uef: sheets_v4.Schema$CellFormat, fields: string,
  ) => reqs.push({ repeatCell: { range: grid(sheetId, sr, er, sc, ec), cell: { userEnteredFormat: uef }, fields } });
  const merge = (sr: number, er: number, sc: number, ec: number) =>
    reqs.push({ mergeCells: { range: grid(sheetId, sr, er, sc, ec), mergeType: 'MERGE_ALL' } });
  const rh = (row1: number, px: number) => reqs.push(rowHeight(sheetId, idx(row1), row1, px));

  const sectionBar = (row1: number) => {
    merge(idx(row1), row1, 0, 8);
    fmt(idx(row1), row1, 0, 8,
      { backgroundColor: DASH.section, horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', padding: { left: 10 }, textFormat: { bold: true, foregroundColor: WHITE, fontSize: 10 } },
      'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,padding,textFormat)');
    rh(row1, 24);
  };

  // Budget/target table (cols A..F): header, white body, currency B-D, % E, borders.
  const tableBlock = (headerRow: number, data0: number, dataLast: number, totalRow: number, headerBg: Color) => {
    fmt(idx(headerRow), headerRow, 0, 6,
      { backgroundColor: headerBg, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: WHITE, fontSize: 10 } },
      'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
    rh(headerRow, 26);
    fmt(idx(data0), totalRow, 0, 6, { backgroundColor: WHITE }, 'userEnteredFormat.backgroundColor');
    reqs.push(numberFormat(sheetId, idx(data0), totalRow, 1, 4, CURRENCY, 'CURRENCY', 'RIGHT'));
    reqs.push(numberFormat(sheetId, idx(data0), totalRow, 4, 5, '0%', 'PERCENT', 'RIGHT'));
    fmt(idx(data0), dataLast, 0, 1,
      { horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP', padding: { left: 8 } },
      'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,padding)');
    fmt(idx(data0), totalRow, 5, 6, { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' },
      'userEnteredFormat(horizontalAlignment,verticalAlignment)');
    fmt(idx(totalRow), totalRow, 0, 6, { backgroundColor: DASH.totalBg, textFormat: { bold: true, fontSize: 10 } },
      'userEnteredFormat(backgroundColor,textFormat)');
    reqs.push(borderBox(sheetId, idx(headerRow), totalRow, 0, 6, DASH.border));
  };

  // Recent-list table (spill): header, white body (wrap), currency on one column.
  const listBlock = (headerRow: number, data0: number, dataEnd: number, ncols: number, currencyCol: number) => {
    fmt(idx(headerRow), headerRow, 0, ncols,
      { backgroundColor: DASH.logHeader, horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', padding: { left: 8 }, textFormat: { bold: true, foregroundColor: WHITE, fontSize: 10 } },
      'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,padding,textFormat)');
    rh(headerRow, 24);
    fmt(idx(data0), dataEnd, 0, ncols,
      { backgroundColor: WHITE, verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP', padding: { left: 8 } },
      'userEnteredFormat(backgroundColor,verticalAlignment,wrapStrategy,padding)');
    reqs.push(numberFormat(sheetId, idx(data0), dataEnd, currencyCol, currencyCol + 1, CURRENCY, 'CURRENCY', 'RIGHT'));
    reqs.push(borderBox(sheetId, idx(headerRow), dataEnd, 0, ncols, DASH.border));
  };

  // Cream page background over the whole used area.
  fmt(0, L.rLogEnd, 0, 13, { backgroundColor: DASH.cream }, 'userEnteredFormat.backgroundColor');

  // Title.
  merge(0, 1, 0, 8);
  fmt(0, 1, 0, 8,
    { backgroundColor: DASH.cream, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: DASH.ink, fontSize: 18 } },
    'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
  rh(1, 44);

  // Period subtitle.
  merge(1, 2, 0, 8);
  fmt(1, 2, 0, 8,
    { backgroundColor: DASH.cream, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { italic: true, foregroundColor: DASH.cardSaldo, fontSize: 11 } },
    'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
  rh(2, 24);

  // ARUS KAS cards.
  const cards: Array<[number, Color]> = [[0, DASH.cardIncome], [2, DASH.cardExpense], [4, DASH.cardSaving], [6, DASH.cardSaldo]];
  for (const [sc, color] of cards) {
    merge(idx(L.rCardLabel), L.rCardLabel, sc, sc + 2);
    merge(idx(L.rCardValue), L.rCardValue, sc, sc + 2);
    fmt(idx(L.rCardLabel), L.rCardLabel, sc, sc + 2,
      { backgroundColor: color, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: WHITE, fontSize: 9 } },
      'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
    fmt(idx(L.rCardValue), L.rCardValue, sc, sc + 2,
      { backgroundColor: color, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', numberFormat: { type: 'CURRENCY', pattern: CURRENCY }, textFormat: { bold: true, foregroundColor: WHITE, fontSize: 13 } },
      'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,numberFormat,textFormat)');
  }
  rh(L.rCardLabel, 22);
  rh(L.rCardValue, 40);

  // Sections.
  sectionBar(L.rSecExpense);
  tableBlock(L.rExpHeader, L.rExp0, L.rExpLast, L.rExpTotal, DASH.tableHeader);

  merge(idx(L.rFooter), L.rFooter, 0, 6);
  fmt(idx(L.rFooter), L.rFooter, 0, 6,
    { backgroundColor: hex('#f5f0e1'), horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { italic: true, foregroundColor: DASH.ink } },
    'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
  rh(L.rFooter, 26);

  sectionBar(L.rSecIncome);
  listBlock(L.rIncHead, L.rIncData, L.rIncEnd, 3, 2);

  sectionBar(L.rSecSaving);
  tableBlock(L.rSavHead, L.rSav0, L.rSavLast, L.rSavTotal, DASH.savingHeader);

  sectionBar(L.rSecLog);
  listBlock(L.rLogHead, L.rLogData, L.rLogEnd, 4, 2);

  // Expense over-budget highlight: >=90% red, 70-90% amber (only when budget set).
  reqs.push({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [grid(sheetId, idx(L.rExp0), L.rExpLast, 0, 6)],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND($B${L.rExp0}>0,$E${L.rExp0}>=0.9)` }] },
          format: { backgroundColor: DASH.attnRed, textFormat: { foregroundColor: DASH.attnRedInk } },
        },
      },
    },
  });
  reqs.push({
    addConditionalFormatRule: {
      index: 1,
      rule: {
        ranges: [grid(sheetId, idx(L.rExp0), L.rExpLast, 0, 6)],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND($B${L.rExp0}>0,$E${L.rExp0}>=0.7,$E${L.rExp0}<0.9)` }] },
          format: { backgroundColor: DASH.attnAmber },
        },
      },
    },
  });
  // Savings goal reached: >=100% green.
  reqs.push({
    addConditionalFormatRule: {
      index: 2,
      rule: {
        ranges: [grid(sheetId, idx(L.rSav0), L.rSavLast, 0, 6)],
        booleanRule: {
          condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=AND($B${L.rSav0}>0,$E${L.rSav0}>=1)` }] },
          format: { backgroundColor: DASH.attnGreen },
        },
      },
    },
  });

  // Column widths (A..H) + hide helper columns I..M.
  const widths: [number, number][] = [[0, 155], [1, 112], [2, 112], [3, 112], [4, 56], [5, 150], [6, 112], [7, 112]];
  for (const [c, px] of widths) reqs.push(colWidth(sheetId, c, px));
  reqs.push(hideCols(sheetId, 8, 13));

  // Freeze title+period, hide gridlines, teal tab, move to front.
  reqs.push(setFreeze(sheetId, 2));
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, index: 0, tabColor: THEMES.Dashboard.tab, gridProperties: { hideGridlines: true } },
      fields: 'index,tabColor,gridProperties.hideGridlines',
    },
  });

  return reqs;
}

// --- Rekap Bulanan tab -------------------------------------------------------

const MONTHS_N = 36; // rows generated (past + future); future months render blank

interface MonthlyLayout {
  rows: (string | number | null)[][];
  rHeader: number;
  rData0: number;
  rDataLast: number;
  rTotal: number;
  width: number;
}

/**
 * Monthly pivot over the single Transactions log — one row per calendar month
 * (grouped by LEFT(date,7) = "yyyy-mm"), all via live formulas. The base month is
 * the earliest transaction's month; rows past the current month stay blank.
 */
function buildMonthly(): MonthlyLayout {
  const width = 9; // A..I (H hidden: H1=minDate, H2=base, H{row}=month key)
  const N = MONTHS_N;
  const rHeader = 3;
  const rData0 = 4;
  const rDataLast = rData0 + N - 1;
  const rTotal = rData0 + N;

  const rows: (string | number | null)[][] = Array.from({ length: rTotal }, () => Array(width).fill(null));
  const set = (row1: number, col: number, val: string | number) => {
    rows[row1 - 1][col] = val;
  };

  set(1, 0, '🗓  REKAP BULANAN');
  // Hidden helpers. Earliest date via ISO text sort (no DATEVALUE — locale-safe).
  set(1, 7, '=IFERROR(INDEX(SORT(FILTER(Transactions!$B:$B,(Transactions!$B:$B<>"")*(Transactions!$B:$B<>"date")),1,TRUE),1,1),"")'); // H1 = earliest date text
  set(2, 7, '=IF($H$1="",DATE(YEAR(TODAY()),1,1),DATE(VALUE(LEFT($H$1,4)),VALUE(MID($H$1,6,2)),1))'); // H2 = base month

  set(rHeader, 0, 'Bulan'); set(rHeader, 1, 'Pemasukan'); set(rHeader, 2, 'Pengeluaran');
  set(rHeader, 3, 'Tabungan'); set(rHeader, 4, 'Saldo'); set(rHeader, 5, 'Saldo Kumulatif');

  for (let i = 0; i < N; i++) {
    const row = rData0 + i;
    set(row, 0, `=IF(EDATE($H$2,${i})>EOMONTH(TODAY(),0),"",TEXT(EDATE($H$2,${i}),"mmm yyyy"))`);
    set(row, 7, `=TEXT(EDATE($H$2,${i}),"yyyy-mm")`); // month key
    const key = `$H${row}`;
    set(row, 1, `=IF($A${row}="","",SUMPRODUCT((LEFT(Transactions!$B:$B,7)=${key})*(Transactions!$J:$J="income")*IFERROR(Transactions!$D:$D*1,0)))`);
    set(row, 2, `=IF($A${row}="","",SUMPRODUCT((LEFT(Transactions!$B:$B,7)=${key})*(Transactions!$J:$J<>"income")*(Transactions!$J:$J<>"saving")*IFERROR(Transactions!$D:$D*1,0)))`);
    set(row, 3, `=IF($A${row}="","",SUMPRODUCT((LEFT(Transactions!$B:$B,7)=${key})*(Transactions!$J:$J="saving")*IFERROR(Transactions!$D:$D*1,0)))`);
    set(row, 4, `=IF($A${row}="","",$B${row}-$C${row}-$D${row})`);
    set(row, 5, `=IF($A${row}="","",SUM($E$${rData0}:$E${row}))`);
  }

  set(rTotal, 0, 'TOTAL');
  set(rTotal, 1, `=SUM($B$${rData0}:$B$${rDataLast})`);
  set(rTotal, 2, `=SUM($C$${rData0}:$C$${rDataLast})`);
  set(rTotal, 3, `=SUM($D$${rData0}:$D$${rDataLast})`);
  set(rTotal, 4, `=$B${rTotal}-$C${rTotal}-$D${rTotal}`);
  set(rTotal, 5, `=$E${rTotal}`);

  return { rows, rHeader, rData0, rDataLast, rTotal, width };
}

function monthlyRequests(sheetId: number, L: MonthlyLayout): Req[] {
  const reqs: Req[] = [];
  const idx = (row1: number) => row1 - 1;
  const fmt = (
    sr: number, er: number, sc: number, ec: number,
    uef: sheets_v4.Schema$CellFormat, fields: string,
  ) => reqs.push({ repeatCell: { range: grid(sheetId, sr, er, sc, ec), cell: { userEnteredFormat: uef }, fields } });

  // Cream page + title.
  fmt(0, L.rTotal, 0, 9, { backgroundColor: DASH.cream }, 'userEnteredFormat.backgroundColor');
  reqs.push({ mergeCells: { range: grid(sheetId, 0, 1, 0, 6), mergeType: 'MERGE_ALL' } });
  fmt(0, 1, 0, 6,
    { backgroundColor: DASH.cream, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: DASH.ink, fontSize: 16 } },
    'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
  reqs.push(rowHeight(sheetId, 0, 1, 40));

  // Header row.
  fmt(idx(L.rHeader), L.rHeader, 0, 6,
    { backgroundColor: DASH.tableHeader, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: WHITE, fontSize: 10 } },
    'userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,textFormat)');
  reqs.push(rowHeight(sheetId, idx(L.rHeader), L.rHeader, 26));

  // White body + currency + alignment.
  fmt(idx(L.rData0), L.rTotal, 0, 6, { backgroundColor: WHITE }, 'userEnteredFormat.backgroundColor');
  reqs.push(numberFormat(sheetId, idx(L.rData0), L.rTotal, 1, 6, CURRENCY, 'CURRENCY', 'RIGHT'));
  fmt(idx(L.rData0), L.rTotal, 0, 1, { horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE', padding: { left: 8 } },
    'userEnteredFormat(horizontalAlignment,verticalAlignment,padding)');

  // Total row emphasis.
  fmt(idx(L.rTotal), L.rTotal, 0, 6, { backgroundColor: DASH.totalBg, textFormat: { bold: true, fontSize: 10 } },
    'userEnteredFormat(backgroundColor,textFormat)');

  // Negative Saldo / Saldo Kumulatif -> red text.
  reqs.push({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [grid(sheetId, idx(L.rData0), L.rTotal, 4, 6)],
        booleanRule: {
          condition: { type: 'NUMBER_LESS', values: [{ userEnteredValue: '0' }] },
          format: { textFormat: { foregroundColor: DASH.attnRedInk, bold: true } },
        },
      },
    },
  });

  reqs.push(borderBox(sheetId, idx(L.rHeader), L.rTotal, 0, 6, DASH.border));

  // Widths + hide helper columns G..I.
  const widths: [number, number][] = [[0, 108], [1, 120], [2, 122], [3, 115], [4, 120], [5, 138]];
  for (const [c, px] of widths) reqs.push(colWidth(sheetId, c, px));
  reqs.push(hideCols(sheetId, 6, 9));

  reqs.push(setFreeze(sheetId, L.rHeader));
  reqs.push({
    updateSheetProperties: {
      properties: { sheetId, index: 1, tabColor: hex('#b45309'), gridProperties: { hideGridlines: true } },
      fields: 'index,tabColor,gridProperties.hideGridlines',
    },
  });

  return reqs;
}

// --- data-tab formatting -----------------------------------------------------

function dataSheetRequests(m: SheetMeta, cols: number, theme: SheetTheme): Req[] {
  const reqs: Req[] = [];
  reqs.push(setFreeze(m.sheetId, 1));
  reqs.push(headerFormat(m.sheetId, cols, theme.headerBg));
  reqs.push(rowHeight(m.sheetId, 0, 1, 30));
  reqs.push(banding(m.sheetId, 0, undefined, cols, theme));
  reqs.push(tabAndGridlines(m.sheetId, theme.tab));
  return reqs;
}

// --- charts ------------------------------------------------------------------

function source(sheetId: number, sr: number, er: number, sc: number, ec: number): sheets_v4.Schema$ChartSourceRange {
  return { sources: [{ sheetId, startRowIndex: sr, endRowIndex: er, startColumnIndex: sc, endColumnIndex: ec }] };
}

/**
 * Two embedded charts (auto-update from cells; placed in empty areas below the
 * tables so they never overlap data):
 *  - Rekap Bulanan: column chart Pemasukan vs Pengeluaran per month.
 *  - Dashboard: donut of expense composition by category (current period).
 */
function chartRequests(dashId: number, L: DashLayout, rekapId: number, M: MonthlyLayout): Req[] {
  const reqs: Req[] = [];

  reqs.push({
    addChart: {
      chart: {
        spec: {
          title: 'Pemasukan vs Pengeluaran per Bulan',
          basicChart: {
            chartType: 'COLUMN',
            legendPosition: 'BOTTOM_LEGEND',
            headerCount: 1,
            domains: [{ domain: { sourceRange: source(rekapId, M.rHeader - 1, M.rDataLast, 0, 1) } }],
            series: [
              { series: { sourceRange: source(rekapId, M.rHeader - 1, M.rDataLast, 1, 2) }, targetAxis: 'LEFT_AXIS' },
              { series: { sourceRange: source(rekapId, M.rHeader - 1, M.rDataLast, 2, 3) }, targetAxis: 'LEFT_AXIS' },
            ],
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: rekapId, rowIndex: M.rTotal + 1, columnIndex: 0 },
            offsetXPixels: 5, offsetYPixels: 5, widthPixels: 640, heightPixels: 320,
          },
        },
      },
    },
  });

  reqs.push({
    addChart: {
      chart: {
        spec: {
          title: 'Komposisi Pengeluaran (periode ini)',
          pieChart: {
            legendPosition: 'RIGHT_LEGEND',
            pieHole: 0.45,
            domain: { sourceRange: source(dashId, L.rExp0 - 1, L.rExpLast, 0, 1) },
            series: { sourceRange: source(dashId, L.rExp0 - 1, L.rExpLast, 2, 3) },
          },
        },
        position: {
          overlayPosition: {
            anchorCell: { sheetId: dashId, rowIndex: L.rLogEnd + 1, columnIndex: 0 },
            offsetXPixels: 5, offsetYPixels: 5, widthPixels: 480, heightPixels: 300,
          },
        },
      },
    },
  });

  return reqs;
}

// --- main --------------------------------------------------------------------

export async function refreshDashboard(): Promise<{ categories: number; goals: number }> {
  const spreadsheetId = config.SPREADSHEET_ID;
  const startDay = config.BUDGET_START_DAY;

  const auth = new google.auth.GoogleAuth({
    keyFile: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  let meta = await getMeta(sheets, spreadsheetId);

  // 1. Normalize locale/timezone (so USER_ENTERED formulas parse predictably),
  //    and create the Dashboard tab if it doesn't exist yet.
  const pre: Req[] = [
    {
      updateSpreadsheetProperties: {
        properties: { locale: 'en_US', timeZone: 'Asia/Jakarta' },
        fields: 'locale,timeZone',
      },
    },
  ];
  const existingDash = meta.get('Dashboard');
  if (!existingDash) {
    pre.push({ addSheet: { properties: { title: 'Dashboard', gridProperties: { rowCount: 120, columnCount: 16 } } } });
  } else {
    // Ensure the existing tab is large enough for the new layout + helper column M.
    pre.push({
      updateSheetProperties: {
        properties: { sheetId: existingDash.sheetId, gridProperties: { rowCount: 120, columnCount: 16 } },
        fields: 'gridProperties.rowCount,gridProperties.columnCount',
      },
    });
  }
  if (!meta.has('Rekap Bulanan')) {
    pre.push({ addSheet: { properties: { title: 'Rekap Bulanan', gridProperties: { rowCount: 60, columnCount: 12 } } } });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: pre } });
  meta = await getMeta(sheets, spreadsheetId); // refresh (Dashboard may be new)

  const dash = meta.get('Dashboard')!;
  const categories = await readCategories(sheets, spreadsheetId);
  const goals = await readGoals(sheets, spreadsheetId);
  const layout = buildDashboard(categories, goals, startDay);

  const rekap = meta.get('Rekap Bulanan')!;
  const monthly = buildMonthly();

  // 2. Write Dashboard + Rekap Bulanan content (clear first so re-runs stay clean).
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Dashboard!A1:Z400' });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Dashboard!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: layout.rows },
  });
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: 'Rekap Bulanan!A1:Z60' });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Rekap Bulanan!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: monthly.rows },
  });

  // 3. Formatting batch. First clear things that conflict on re-run.
  const requests: Req[] = [];
  for (const m of meta.values()) {
    for (const id of m.bandedRangeIds) requests.push({ deleteBanding: { bandedRangeId: id } });
    for (const id of m.chartIds) requests.push({ deleteEmbeddedObject: { objectId: id } });
  }
  // Clear existing Dashboard conditional rules (highest index first).
  for (let i = dash.conditionalCount - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId: dash.sheetId, index: i } });
  }

  // Remove Google's leftover empty default tab ("Sheet1"), if present & empty.
  for (const title of ['Sheet1', 'Sheet 1']) {
    const m = meta.get(title);
    if (!m) continue;
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A1:Z100` });
      if (!(res.data.values && res.data.values.length)) {
        requests.push({ deleteSheet: { sheetId: m.sheetId } });
      }
    } catch {
      /* ignore */
    }
  }

  // Dashboard styling. Unmerge first so re-runs don't hit overlapping-merge errors.
  if (dash.mergeCount > 0) {
    requests.push({ unmergeCells: { range: grid(dash.sheetId, 0, undefined, 0, 12) } });
  }
  requests.push(...dashboardRequests(dash.sheetId, layout));

  // Rekap Bulanan styling.
  for (let i = rekap.conditionalCount - 1; i >= 0; i--) {
    requests.push({ deleteConditionalFormatRule: { sheetId: rekap.sheetId, index: i } });
  }
  if (rekap.mergeCount > 0) {
    requests.push({ unmergeCells: { range: grid(rekap.sheetId, 0, undefined, 0, 12) } });
  }
  requests.push(...monthlyRequests(rekap.sheetId, monthly));

  // Data tabs.
  const DATA_TABS: Array<[string, number]> = [
    ['Transactions', 10], // A..J (J = type)
    ['Budgets', 2],
    ['Categories', 1],
    ['Tabungan', 2],
  ];
  for (const [title, cols] of DATA_TABS) {
    const m = meta.get(title);
    if (!m) continue;
    const theme = THEMES[title];
    requests.push(...dataSheetRequests(m, cols, theme));
  }

  // Transactions: amount (D) currency + right align, date (B) centered, widths, filter.
  const tx = meta.get('Transactions');
  if (tx) {
    requests.push(numberFormat(tx.sheetId, 1, undefined, 3, 4, CURRENCY, 'CURRENCY', 'RIGHT'));
    requests.push({
      repeatCell: {
        range: grid(tx.sheetId, 1, undefined, 1, 2),
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
    const txw: [number, number][] = [[0, 155], [1, 95], [2, 80], [3, 110], [4, 150], [5, 220], [6, 120], [7, 200], [8, 90], [9, 90]];
    for (const [c, px] of txw) requests.push(colWidth(tx.sheetId, c, px));
    if (tx.hasFilter) requests.push({ clearBasicFilter: { sheetId: tx.sheetId } });
    // Include J so the tab can be filtered by type (income / saving / expense).
    requests.push({ setBasicFilter: { filter: { range: grid(tx.sheetId, 0, undefined, 0, 10) } } });
  }

  // Budgets: monthly_limit (B) currency, widths.
  const bg = meta.get('Budgets');
  if (bg) {
    requests.push(numberFormat(bg.sheetId, 1, undefined, 1, 2, CURRENCY, 'CURRENCY', 'RIGHT'));
    requests.push(colWidth(bg.sheetId, 0, 190));
    requests.push(colWidth(bg.sheetId, 1, 150));
  }
  const sav = meta.get('Tabungan');
  if (sav) {
    requests.push(numberFormat(sav.sheetId, 1, undefined, 1, 2, CURRENCY, 'CURRENCY', 'RIGHT'));
    requests.push(colWidth(sav.sheetId, 0, 190));
    requests.push(colWidth(sav.sheetId, 1, 150));
  }
  const cat = meta.get('Categories');
  if (cat) requests.push(colWidth(cat.sheetId, 0, 210));

  // Charts (old ones deleted above; add fresh so re-runs stay idempotent).
  requests.push(...chartRequests(dash.sheetId, layout, rekap.sheetId, monthly));

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  // Formulas were written under en_US so commas parse; switch display locale to
  // in_ID (Google's code for Indonesia) so amounts render Indonesian-style
  // (Rp1.800.000). Stored formulas are canonical and keep evaluating regardless.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ updateSpreadsheetProperties: { properties: { locale: 'in_ID' }, fields: 'locale' } }],
    },
  });

  return { categories: categories.length, goals: goals.length };
}
