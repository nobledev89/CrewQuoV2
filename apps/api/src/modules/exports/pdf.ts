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
  type ProjectExportModel,
} from './model';
import { createDocument, seedFromParts } from './document';
import {
  CONTENT_WIDTH,
  Cursor,
  drawFooters,
  drawNote,
  drawPairs,
  drawParagraph,
  drawSectionHeading,
  drawTable,
  drawTitle,
  type Column,
} from './layout';

/**
 * PDF renderer (CREWQUO_V2_PLAN.md §2 "server-side jsPDF/xlsx in apps/api", §7).
 *
 * Layout only. Every string it prints already came out of `model.ts` — this file
 * computes nothing and formats no money, so a figure cannot differ between the
 * PDF and the XLSX. §29's report engine renders through the same `layout.ts`
 * primitives, which is why they moved out of here in Phase 10.
 *
 * Deliberately plain: A4 portrait, one typeface, right-aligned numerics, tables
 * that break across pages with repeated headers. No charts, no colour beyond grey
 * rules — this is a document someone prints and files.
 */

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

/**
 * Render the model to PDF bytes.
 *
 * **Deterministic**: identical model in, identical bytes out. The document's
 * identity is seeded from the project and the model's own `generatedAt` rather
 * than from a clock or a random number, which is what `document.ts` exists for —
 * see its header, and `determinism.test.ts` for the assertion.
 */
export function renderProjectPdf(model: ProjectExportModel): Buffer {
  const doc = createDocument({
    seal: seedFromParts('project-export', model.project.id, model.generatedAt),
    createdAt: model.generatedAt,
  });
  const c = new Cursor(doc);

  drawTitle(c, model.project.name, `${model.ownerCompanyName} - project export`);
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
    drawParagraph(c, model.project.notes);
  }

  drawFooters(doc, `Generated ${formatTimestamp(model.generatedAt)} | internal document`);
  return Buffer.from(doc.output('arraybuffer'));
}

// `CONTENT_WIDTH` is re-exported for the XLSX renderer's column sizing, which has
// always sized itself against the same page width so the two files line up when a
// reader has both open.
export { CONTENT_WIDTH };
