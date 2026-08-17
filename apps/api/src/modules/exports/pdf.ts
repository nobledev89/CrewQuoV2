import { jsPDF } from 'jspdf';
import {
  EXPENSE_TABLE_HEAD,
  PRICING_GAP_NOTE,
  PROVIDER_TABLE_HEAD,
  TIME_TABLE_HEAD,
  expenseRows,
  formatTimestamp,
  hasPricingGap,
  headerRows,
  providerRows,
  summaryRows,
  timeRows,
  type LabelledValue,
  type ProjectExportModel,
} from './model';

/**
 * PDF renderer (CREWQUO_V2_PLAN.md §2 "server-side jsPDF/xlsx in apps/api", §7).
 *
 * Layout only. Every string it prints already came out of `model.ts` — this file
 * computes nothing and formats no money, so a figure cannot differ between the
 * PDF and the XLSX. §29's report engine (Phase 10) renders through the same seam.
 *
 * Deliberately plain: A4 portrait, one typeface, right-aligned numerics, tables
 * that break across pages with repeated headers. No charts, no colour beyond grey
 * rules — this is a document someone prints and files.
 */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const BOTTOM_LIMIT = PAGE.height - MARGIN - 24; // leaves room for the footer

/** Column widths sum to CONTENT_WIDTH; `right` marks numeric columns. */
interface Column {
  width: number;
  right?: boolean;
}

const PROVIDER_COLS: Column[] = [
  { width: 155 },
  { width: 80, right: true },
  { width: 95, right: true },
  { width: 85, right: true },
  { width: 100, right: true },
];

// Widths sum to 515. `Shift` is 72 so WEEKDAY_DAY fits whole — Helvetica caps
// run ~0.66em, and at 62 the label was being cut to "WEEKDAY_".
const TIME_COLS: Column[] = [
  { width: 62 },
  { width: 80 },
  { width: 75 },
  { width: 72 },
  { width: 78 },
  { width: 38, right: true },
  { width: 34, right: true },
  { width: 76, right: true },
];

const EXPENSE_COLS: Column[] = [
  { width: 62 },
  { width: 95 },
  { width: 75 },
  { width: 173 },
  { width: 110, right: true },
];

class Cursor {
  y = MARGIN;
  constructor(readonly doc: jsPDF) {}

  /** Start a new page if `needed` points won't fit below the current line. */
  ensure(needed: number): void {
    if (this.y + needed <= BOTTOM_LIMIT) return;
    this.doc.addPage();
    this.y = MARGIN;
  }
}

/**
 * Trim a string to fit `width`, marking the cut with an ASCII ellipsis.
 *
 * Not `…`: jsPDF's built-in Helvetica encodes Latin-1, where U+2026 has no
 * codepoint and is dropped from the page without a trace — a truncated value
 * would silently read as a complete one.
 */
function fit(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(`${out}...`) > width) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function drawTitle(c: Cursor, model: ProjectExportModel): void {
  const { doc } = c;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(fit(doc, model.project.name, CONTENT_WIDTH), MARGIN, c.y + 14);
  c.y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(fit(doc, `${model.ownerCompanyName} - project export`, CONTENT_WIDTH), MARGIN, c.y + 8);
  doc.setTextColor(0);
  c.y += 20;
}

/** Two-column key/value block used for the header and the summary. */
function drawPairs(c: Cursor, pairs: LabelledValue[]): void {
  const { doc } = c;
  const colWidth = CONTENT_WIDTH / 2;
  const labelWidth = 108;
  const rowHeight = 15;

  for (let i = 0; i < pairs.length; i += 2) {
    c.ensure(rowHeight);
    const row = pairs.slice(i, i + 2);
    row.forEach((pair, col) => {
      const x = MARGIN + col * colWidth;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(110);
      doc.text(fit(doc, pair.label, labelWidth - 6), x, c.y + 10);
      doc.setTextColor(0);
      doc.setFont('helvetica', pair.emphasis ? 'bold' : 'normal');
      doc.setFontSize(9.5);
      doc.text(fit(doc, pair.value, colWidth - labelWidth - 8), x + labelWidth, c.y + 10);
    });
    c.y += rowHeight;
  }
  c.y += 6;
}

function drawSectionHeading(c: Cursor, text: string): void {
  const { doc } = c;
  c.ensure(30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(text, MARGIN, c.y + 10);
  c.y += 16;
  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, c.y, MARGIN + CONTENT_WIDTH, c.y);
  c.y += 8;
}

function drawTableHeader(c: Cursor, head: readonly string[], cols: Column[]): void {
  const { doc } = c;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(90);
  let x = MARGIN;
  head.forEach((label, i) => {
    const col = cols[i]!;
    const text = fit(doc, label, col.width - 6);
    if (col.right) {
      doc.text(text, x + col.width - 4, c.y + 9, { align: 'right' });
    } else {
      doc.text(text, x, c.y + 9);
    }
    x += col.width;
  });
  doc.setTextColor(0);
  c.y += 13;
  doc.setDrawColor(225);
  doc.line(MARGIN, c.y, MARGIN + CONTENT_WIDTH, c.y);
  c.y += 4;
}

function drawTable(
  c: Cursor,
  head: readonly string[],
  cols: Column[],
  rows: string[][],
  emptyNote: string
): void {
  const { doc } = c;
  if (rows.length === 0) {
    c.ensure(16);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(emptyNote, MARGIN, c.y + 9);
    doc.setTextColor(0);
    c.y += 18;
    return;
  }

  const rowHeight = 13;
  c.ensure(17 + rowHeight);
  drawTableHeader(c, head, cols);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  for (const row of rows) {
    if (c.y + rowHeight > BOTTOM_LIMIT) {
      doc.addPage();
      c.y = MARGIN;
      drawTableHeader(c, head, cols);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
    }
    let x = MARGIN;
    row.forEach((cell, i) => {
      const col = cols[i]!;
      const text = fit(doc, cell, col.width - 6);
      if (col.right) {
        doc.text(text, x + col.width - 4, c.y + 9, { align: 'right' });
      } else {
        doc.text(text, x, c.y + 9);
      }
      x += col.width;
    });
    c.y += rowHeight;
  }
  c.y += 8;
}

function drawNote(c: Cursor, text: string): void {
  const { doc } = c;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(140, 70, 0);
  const lines = doc.splitTextToSize(text, CONTENT_WIDTH) as string[];
  c.ensure(lines.length * 11 + 6);
  for (const line of lines) {
    doc.text(line, MARGIN, c.y + 8);
    c.y += 11;
  }
  doc.setTextColor(0);
  c.y += 6;
}

function drawFooters(doc: jsPDF, model: ProjectExportModel): void {
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(140);
    doc.text(
      `Generated ${formatTimestamp(model.generatedAt)} | internal document`,
      MARGIN,
      PAGE.height - MARGIN + 6
    );
    doc.text(`Page ${page} of ${total}`, PAGE.width - MARGIN, PAGE.height - MARGIN + 6, {
      align: 'right',
    });
    doc.setTextColor(0);
  }
}

/** Render the model to PDF bytes. */
export function renderProjectPdf(model: ProjectExportModel): Buffer {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const c = new Cursor(doc);

  drawTitle(c, model);
  drawPairs(c, headerRows(model));

  drawSectionHeading(c, 'Summary');
  drawPairs(c, summaryRows(model));
  if (hasPricingGap(model)) drawNote(c, PRICING_GAP_NOTE);

  drawSectionHeading(c, 'By provider');
  drawTable(c, PROVIDER_TABLE_HEAD, PROVIDER_COLS, providerRows(model), 'No approved work yet.');

  drawSectionHeading(c, 'Approved time');
  drawTable(c, TIME_TABLE_HEAD, TIME_COLS, timeRows(model), 'No approved time logs.');

  drawSectionHeading(c, 'Approved expenses');
  drawTable(c, EXPENSE_TABLE_HEAD, EXPENSE_COLS, expenseRows(model), 'No approved expenses.');

  if (model.project.notes) {
    drawSectionHeading(c, 'Notes');
    const lines = doc.splitTextToSize(model.project.notes, CONTENT_WIDTH) as string[];
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    for (const line of lines) {
      c.ensure(12);
      doc.text(line, MARGIN, c.y + 8);
      c.y += 12;
    }
  }

  drawFooters(doc, model);
  return Buffer.from(doc.output('arraybuffer'));
}
