import ExcelJS from 'exceljs';
import {
  EXPENSE_TABLE_HEAD,
  PRICING_GAP_NOTE,
  PROVIDER_TABLE_HEAD,
  TIME_TABLE_HEAD,
  formatDateRange,
  hasPricingGap,
  type ProjectExportModel,
} from './model';

/**
 * XLSX renderer (CREWQUO_V2_PLAN.md §2, §7).
 *
 * **Where this deliberately differs from the PDF:** money reaches a spreadsheet
 * as a *number* with a currency number-format, not as a pre-formatted string. A
 * workbook of strings can't be summed, sorted or pivoted, which is the only
 * reason to ask for XLSX instead of PDF. The values are the same model values —
 * nothing is recomputed here, and minor units are divided by 100 in one helper —
 * so Excel and the PDF still say the same thing about the same figure.
 *
 * A null stays an **empty cell**, never a zero: `SUM` over a column with a
 * pricing gap must not silently produce a total that looks complete (§6).
 *
 * The library is `exceljs`, not the `xlsx` the plan named. SheetJS's public-npm
 * `xlsx@0.18.5` is the last registry release and carries CVE-2023-30533 and
 * CVE-2024-22363; current builds ship only from the vendor's own CDN, which pnpm
 * lockfiles and CI resolve badly. `exceljs` is maintained, write-oriented and has
 * no equivalent advisory. Nothing else about §2's "one server-side rendering
 * path" changes.
 */

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFF1F3F5' },
};

/** Minor units → the major-unit number a spreadsheet should hold. */
function money(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

/** Excel number format for a currency, e.g. `"USD" #,##0.00`. */
function moneyFormat(currency: string): string {
  const safe = currency.replace(/[^A-Za-z]/g, '').slice(0, 3) || 'USD';
  return `"${safe}" #,##0.00`;
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
  });
}

function addSummarySheet(wb: ExcelJS.Workbook, model: ProjectExportModel): void {
  const ws = wb.addWorksheet('Summary');
  ws.columns = [
    { key: 'label', width: 26 },
    { key: 'value', width: 34 },
  ];
  const fmt = moneyFormat(model.summary.currency);
  const s = model.summary;

  const text = (label: string, value: string | null) => {
    ws.addRow([label, value ?? '—']);
  };
  const amount = (label: string, cents: number | null, bold = false) => {
    const row = ws.addRow([label, money(cents)]);
    row.getCell(2).numFmt = fmt;
    if (bold) row.font = { bold: true };
  };

  styleHeaderRow(ws.addRow(['Project export', '']));
  text('Project', model.project.name);
  text('Status', model.project.status);
  text('Dates', formatDateRange(model.project.startsOn, model.project.endsOn));
  text('Company', model.ownerCompanyName);
  text('Client', model.clientCompanyName);
  text('Currency', model.summary.currency);
  text('Generated', `${model.generatedAt} by ${model.generatedByName}`);
  ws.addRow([]);

  styleHeaderRow(ws.addRow(['Totals', '']));
  ws.addRow(['Approved time logs', s.approvedTimeLogs]);
  ws.addRow(['Approved expenses', s.approvedExpenses]);
  amount('Labour cost (PAY)', s.laborCostCents);
  amount('Expenses', s.expenseCostCents);
  amount('Total cost', s.totalCostCents, true);
  amount('Client bill (BILL)', s.billCents);
  amount('Margin', s.marginCents, true);
  const pct = ws.addRow(['Margin %', s.marginPct === null ? null : s.marginPct / 100]);
  pct.getCell(2).numFmt = '0.00%';

  if (hasPricingGap(model)) {
    ws.addRow([]);
    const note = ws.addRow(['Note', PRICING_GAP_NOTE]);
    note.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    note.getCell(2).font = { italic: true };
  }
}

function addProviderSheet(wb: ExcelJS.Workbook, model: ProjectExportModel): void {
  const ws = wb.addWorksheet('By provider');
  ws.columns = [
    { width: 32 },
    { width: 14 },
    { width: 16 },
    { width: 14 },
    { width: 16 },
  ];
  const fmt = moneyFormat(model.summary.currency);
  styleHeaderRow(ws.addRow([...PROVIDER_TABLE_HEAD]));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const p of model.summary.byProvider) {
    const row = ws.addRow([
      p.providerCompanyName,
      p.approvedTimeLogs,
      money(p.laborCostCents),
      money(p.expenseCostCents),
      money(p.laborCostCents + p.expenseCostCents),
    ]);
    [3, 4, 5].forEach((i) => {
      row.getCell(i).numFmt = fmt;
    });
  }
}

function addTimeSheet(wb: ExcelJS.Workbook, model: ProjectExportModel): void {
  const ws = wb.addWorksheet('Approved time');
  ws.columns = [
    { width: 12 },
    { width: 26 },
    { width: 20 },
    { width: 14 },
    { width: 18 },
    { width: 10 },
    { width: 10 },
    { width: 16 },
  ];
  const fmt = moneyFormat(model.summary.currency);
  styleHeaderRow(ws.addRow([...TIME_TABLE_HEAD]));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const l of model.timeLines) {
    const row = ws.addRow([
      l.date,
      l.providerName,
      l.roleName,
      l.shiftType,
      l.rateLabel ?? '—',
      l.hoursRegular,
      l.hoursOt,
      money(l.payCents),
    ]);
    row.getCell(6).numFmt = '0.00';
    row.getCell(7).numFmt = '0.00';
    row.getCell(8).numFmt = fmt;
  }
}

function addExpenseSheet(wb: ExcelJS.Workbook, model: ProjectExportModel): void {
  const ws = wb.addWorksheet('Approved expenses');
  ws.columns = [{ width: 12 }, { width: 26 }, { width: 18 }, { width: 40 }, { width: 16 }];
  const fmt = moneyFormat(model.summary.currency);
  styleHeaderRow(ws.addRow([...EXPENSE_TABLE_HEAD]));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const l of model.expenseLines) {
    const row = ws.addRow([
      l.date,
      l.providerName,
      l.category ?? '—',
      l.description ?? '—',
      money(l.amountCents),
    ]);
    row.getCell(5).numFmt = fmt;
  }
}

/** Render the model to XLSX bytes. */
export async function renderProjectXlsx(model: ProjectExportModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CrewQuo';
  // `created` is part of the file's bytes; stamping it from the model keeps a
  // re-render of the same snapshot byte-stable (§29.4 depends on this later).
  wb.created = new Date(model.generatedAt);
  wb.modified = wb.created;

  addSummarySheet(wb, model);
  addProviderSheet(wb, model);
  addTimeSheet(wb, model);
  addExpenseSheet(wb, model);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
