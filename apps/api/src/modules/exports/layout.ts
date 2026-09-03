import type { jsPDF } from 'jspdf';

/**
 * The page primitives every PDF in this codebase is drawn with.
 *
 * Extracted from `pdf.ts` when §29's report engine needed the same tables, the
 * same page breaks and the same truncation rule. Two implementations of "draw a
 * table that breaks across pages with repeated headers" is two sets of column
 * arithmetic, and the second one is always the one with the off-by-one.
 *
 * **Layout only.** Nothing here computes and nothing formats money — every string
 * that reaches these functions came out of `model.ts` or a frozen snapshot, which
 * is what keeps a figure from reading differently depending on which file the
 * client opened.
 *
 * Deliberately plain: A4 portrait, one typeface, right-aligned numerics, grey
 * rules. §29.6's *"keep them plain"* applied to the page as well as to the charts.
 */

export const PAGE = { width: 595.28, height: 841.89 };
export const MARGIN = 40;
export const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
export const BOTTOM_LIMIT = PAGE.height - MARGIN - 24; // leaves room for the footer

/** Column widths sum to CONTENT_WIDTH; `right` marks numeric columns. */
export interface Column {
  width: number;
  right?: boolean;
}

export interface LabelledValue {
  label: string;
  value: string;
  /** Totals and margins are emphasised by both renderers. */
  emphasis?: boolean;
}

export class Cursor {
  y = MARGIN;
  constructor(readonly doc: jsPDF) {}

  /** Start a new page if `needed` points won't fit below the current line. */
  ensure(needed: number): void {
    if (this.y + needed <= BOTTOM_LIMIT) return;
    this.doc.addPage();
    this.y = MARGIN;
  }

  page(): void {
    this.doc.addPage();
    this.y = MARGIN;
  }
}

/**
 * Trim a string to fit `width`, marking the cut with an ASCII ellipsis.
 *
 * Not `…`: jsPDF's built-in Helvetica encodes Latin-1, where U+2026 has no
 * codepoint and is dropped from the page without a trace — a truncated value would
 * silently read as a complete one.
 */
export function fit(doc: jsPDF, text: string, width: number): string {
  if (doc.getTextWidth(text) <= width) return text;
  let out = text;
  while (out.length > 1 && doc.getTextWidth(`${out}...`) > width) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

/**
 * Fold a string to what Helvetica can actually encode.
 *
 * The counterpart to `model.ts`'s ASCII rule, and it exists because a *snapshot*
 * carries customer prose — a project name, a caption, a signer's comment — which
 * `model.ts` never had to. An em dash or a curly quote in a caption is dropped
 * from the page silently; folding the common ones keeps the sentence readable
 * instead of losing punctuation nobody can see is missing.
 */
export function ascii(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ | /g, ' ')
    .replace(/[•·]/g, '-')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, '?');
}

export function drawTitle(c: Cursor, title: string, subtitle: string): void {
  const { doc } = c;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text(fit(doc, ascii(title), CONTENT_WIDTH), MARGIN, c.y + 14);
  c.y += 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(fit(doc, ascii(subtitle), CONTENT_WIDTH), MARGIN, c.y + 8);
  doc.setTextColor(0);
  c.y += 20;
}

/** Two-column key/value block used for headers and summaries. */
export function drawPairs(c: Cursor, pairs: readonly LabelledValue[]): void {
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
      doc.text(fit(doc, ascii(pair.label), labelWidth - 6), x, c.y + 10);
      doc.setTextColor(0);
      doc.setFont('helvetica', pair.emphasis ? 'bold' : 'normal');
      doc.setFontSize(9.5);
      doc.text(fit(doc, ascii(pair.value), colWidth - labelWidth - 8), x + labelWidth, c.y + 10);
    });
    c.y += rowHeight;
  }
  c.y += 6;
}

export function drawSectionHeading(c: Cursor, text: string): void {
  const { doc } = c;
  c.ensure(30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(ascii(text), MARGIN, c.y + 10);
  c.y += 16;
  doc.setDrawColor(210);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, c.y, MARGIN + CONTENT_WIDTH, c.y);
  c.y += 8;
}

function drawTableHeader(c: Cursor, head: readonly string[], cols: readonly Column[]): void {
  const { doc } = c;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(90);
  let x = MARGIN;
  head.forEach((label, i) => {
    const col = cols[i]!;
    const text = fit(doc, ascii(label), col.width - 6);
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

export function drawTable(
  c: Cursor,
  head: readonly string[],
  cols: readonly Column[],
  rows: readonly string[][],
  emptyNote: string
): void {
  const { doc } = c;
  if (rows.length === 0) {
    c.ensure(16);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(ascii(emptyNote), MARGIN, c.y + 9);
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
      const text = fit(doc, ascii(cell), col.width - 6);
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

/** A wrapped paragraph in the body face. */
export function drawParagraph(c: Cursor, text: string, opts: { size?: number } = {}): void {
  const { doc } = c;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(opts.size ?? 9);
  const lines = doc.splitTextToSize(ascii(text), CONTENT_WIDTH) as string[];
  for (const line of lines) {
    c.ensure(12);
    doc.text(line, MARGIN, c.y + 8);
    c.y += 12;
  }
  c.y += 4;
}

/** A caution — a pricing gap, a data gap, a superseded source. */
export function drawNote(c: Cursor, text: string): void {
  const { doc } = c;
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.5);
  doc.setTextColor(140, 70, 0);
  const lines = doc.splitTextToSize(ascii(text), CONTENT_WIDTH) as string[];
  c.ensure(lines.length * 11 + 6);
  for (const line of lines) {
    doc.text(line, MARGIN, c.y + 8);
    c.y += 11;
  }
  doc.setTextColor(0);
  c.y += 6;
}

/** A bulleted list, ASCII bullets for the Latin-1 reason above. */
export function drawBullets(c: Cursor, items: readonly string[]): void {
  const { doc } = c;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  for (const item of items) {
    const lines = doc.splitTextToSize(ascii(item), CONTENT_WIDTH - 14) as string[];
    c.ensure(lines.length * 12);
    lines.forEach((line, i) => {
      if (i === 0) doc.text('-', MARGIN, c.y + 8);
      doc.text(line, MARGIN + 12, c.y + 8);
      c.y += 12;
    });
  }
  c.y += 4;
}

/**
 * §29.1 section 4's figure strip, and the two headlines it has to keep apart.
 *
 * Rendered as tiles rather than a table because §28.4 asks for the emissions and
 * the avoided figure to read as two separate statements. A table with a total row
 * is exactly the shape locked decision #17 forbids.
 */
export function drawFigures(
  c: Cursor,
  figures: readonly { label: string; value: string; note: string | null }[]
): void {
  if (figures.length === 0) return;
  const { doc } = c;
  const perRow = 3;
  const boxWidth = CONTENT_WIDTH / perRow;

  for (let i = 0; i < figures.length; i += perRow) {
    const row = figures.slice(i, i + perRow);
    c.ensure(46);
    row.forEach((figure, col) => {
      const x = MARGIN + col * boxWidth;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(110);
      doc.text(fit(doc, ascii(figure.label), boxWidth - 10), x, c.y + 9);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.setTextColor(0);
      doc.text(fit(doc, ascii(figure.value), boxWidth - 10), x, c.y + 26);
      if (figure.note) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(130);
        doc.text(fit(doc, ascii(figure.note), boxWidth - 10), x, c.y + 38);
        doc.setTextColor(0);
      }
    });
    c.y += 48;
  }
  c.y += 4;
}

/**
 * §29.6's one chart: a horizontal bar, drawn with rectangles.
 *
 * *"Keep them plain: mass balance as a stacked bar in hierarchy order, outcomes as
 * a horizontal bar … No 3-D, no donuts-with-a-number-in-the-middle for anything
 * that is not a single share of a whole."*
 *
 * Greys rather than a palette, because a report is printed as often as it is read
 * and a colour-coded chart that prints as five identical greys is worse than one
 * drawn in greys on purpose. Every bar is labelled with its own value, so the
 * chart never carries information the text does not.
 */
export function drawBarChart(
  c: Cursor,
  rows: readonly { label: string; value: number; display: string }[]
): void {
  if (rows.length === 0) return;
  const { doc } = c;
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (max <= 0) return;

  const labelWidth = 150;
  const valueWidth = 90;
  const barArea = CONTENT_WIDTH - labelWidth - valueWidth - 12;
  const rowHeight = 15;

  for (const row of rows) {
    c.ensure(rowHeight);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(60);
    doc.text(fit(doc, ascii(row.label), labelWidth - 6), MARGIN, c.y + 9);

    const width = Math.max(1, (row.value / max) * barArea);
    doc.setFillColor(120, 120, 120);
    doc.rect(MARGIN + labelWidth, c.y + 2, width, 9, 'F');

    doc.setTextColor(0);
    doc.text(ascii(row.display), MARGIN + CONTENT_WIDTH, c.y + 9, { align: 'right' });
    c.y += rowHeight;
  }
  doc.setTextColor(0);
  c.y += 8;
}

/**
 * The footer on every page.
 *
 * `caption` says what the document is — *"internal document"* on an owner's copy,
 * the content hash on a frozen report. A reader holding two printed copies can
 * compare the seal without opening either file.
 */
export function drawFooters(doc: jsPDF, caption: string): void {
  const total = doc.getNumberOfPages();
  for (let page = 1; page <= total; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(140);
    doc.text(ascii(caption), MARGIN, PAGE.height - MARGIN + 6);
    doc.text(`Page ${String(page)} of ${String(total)}`, PAGE.width - MARGIN, PAGE.height - MARGIN + 6, {
      align: 'right',
    });
    doc.setTextColor(0);
  }
}
