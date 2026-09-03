import type { jsPDF } from 'jspdf';
import {
  DEFAULT_REPORT_DISCLAIMER,
  formatCarbonKg,
  formatMassKg,
  type ClientExportSnapshot,
  type ClientPeriodSnapshot,
  type EvidencePackSnapshot,
  type GeneratedReportView,
  type ReportSectionKey,
  type ReportSnapshot,
  type SnapshotEvidenceItem,
  type SnapshotMassRow,
  type SustainabilitySnapshot,
} from '@crewquo/shared';
import { formatMoney, formatTimestamp } from '../exports/model';
import { createDocument } from '../exports/document';
import {
  CONTENT_WIDTH,
  Cursor,
  MARGIN,
  ascii,
  drawBarChart,
  drawBullets,
  drawFigures,
  drawFooters,
  drawNote,
  drawPairs,
  drawParagraph,
  drawSectionHeading,
  drawTable,
  fit,
  type Column,
  type LabelledValue,
} from '../exports/layout';

/**
 * Rendering a frozen snapshot (§29.1, §29.2, §29.5, §29.6) — steps 10.5 to 10.7.
 *
 * ── IT READS THE SNAPSHOT AND NOTHING ELSE ──────────────────────────────────
 *
 * Not a style rule: it is §29.4. *"Re-rendering a report reads the snapshot; it
 * never recalculates. A 2026 report opened in 2028, after two new factor sets have
 * been imported and three weights corrected, produces byte-identical numbers."*
 *
 * So this file takes a `ReportSnapshot` and a `GeneratedReportView` and touches no
 * database. The only other input is a map of already-fetched image bytes, resolved
 * by the caller from the file ids the snapshot itself froze — because a renderer
 * that could go looking for the current photographs would produce a document that
 * changes when somebody uploads one.
 *
 * ── AND IT IS DETERMINISTIC ─────────────────────────────────────────────────
 *
 * `createDocument` seeds the PDF `/ID` from the content hash and pins
 * `/CreationDate` to the row's own `generated_at` in UTC. Same snapshot, same
 * bytes, on any machine, in any year — which is the milestone.
 */

export interface RenderInput {
  report: GeneratedReportView;
  snapshot: ReportSnapshot;
  /** File id → bytes, for the images the snapshot named. Missing ids are named. */
  images: Map<string, { bytes: Buffer; format: 'PNG' | 'JPEG' }>;
}

/*
 * ── THE FINDING THIS BUILD ADDED ────────────────────────────────────────────
 *
 * **§13.6's banner is not in here, and the acceptance script is what settled it.**
 *
 * The packet's §12 step 7 asserts that correcting a weight and re-rendering
 * produces the same bytes. The first implementation put the staleness sentences on
 * the cover — which is where a reader would want them — and step 7 failed, because
 * correcting the weight bumped `project_assets.revision` and the banner appeared.
 *
 * The test was right and the design was wrong. A live comparison inside a frozen
 * document makes the document a function of the present, which is the one thing
 * §29.4 exists to forbid: two people opening "the same report" a month apart would
 * get different files, and the seal printed in the footer would no longer describe
 * what is on the page.
 *
 * So the divergence is reported **beside** the document rather than inside it —
 * `staleSources` and `staleNotes` on the detail response, rendered by the screen
 * that offers the download. §23's *"amended N times appears wherever the entry
 * appears"* is satisfied where a person can act on it, and the artefact keeps the
 * promise that makes it worth having.
 */

const MASS_COLS: Column[] = [{ width: 300 }, { width: 110, right: true }, { width: 105, right: true }];
const LINE_COLS: Column[] = [
  { width: 62 },
  { width: 195 },
  { width: 60 },
  { width: 44, right: true },
  { width: 44, right: true },
  { width: 110, right: true },
];

export function renderReportPdf(input: RenderInput): Buffer {
  const { report, snapshot } = input;
  const doc = createDocument({ seal: report.contentHash, createdAt: report.generatedAt });
  const c = new Cursor(doc);
  const has = (key: ReportSectionKey): boolean => report.sections.includes(key);

  drawCover(c, input);

  switch (snapshot.body.kind) {
    case 'SUSTAINABILITY':
      renderSustainability(c, input, snapshot.body, has);
      break;
    case 'EVIDENCE_PACK':
      renderEvidencePack(c, input, snapshot.body, has);
      break;
    case 'CLIENT_EXPORT':
      renderClientExport(c, snapshot.body, has);
      break;
    case 'CLIENT_PERIOD':
      renderClientPeriod(c, snapshot.body, has);
      break;
  }

  /*
   * The seal on every page.
   *
   * A reader holding two printed copies can compare thirty-two characters and know
   * whether they are the same document, without opening a file or trusting a
   * filename. It is the cheapest thing §29.4 buys and the only part of it a person
   * standing at a printer can use.
   */
  drawFooters(
    doc,
    `${report.audience === 'INTERNAL' ? 'Internal copy' : 'Client copy'} | generated ${formatTimestamp(report.generatedAt)} | seal ${report.contentHash.slice(0, 16)}`
  );
  return Buffer.from(doc.output('arraybuffer'));
}

// ── The cover (§29.1 section 1) ──────────────────────────────────────────────

function drawCover(c: Cursor, input: RenderInput): void {
  const { doc } = c;
  const { meta } = input.snapshot;

  const logoHeight = drawLogos(c, input);
  c.y += logoHeight;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(fit(doc, ascii(meta.title), CONTENT_WIDTH), MARGIN, c.y + 18);
  c.y += 30;

  const pairs: LabelledValue[] = [
    { label: 'Contractor', value: meta.contractor.name },
    { label: 'Client', value: meta.client.name ?? 'Not recorded' },
  ];
  if (meta.periodStart || meta.periodEnd) {
    pairs.push({
      label: 'Reporting period',
      value: `${meta.periodStart ?? 'open'} to ${meta.periodEnd ?? 'open'}`,
    });
  }
  pairs.push({ label: 'Generated', value: formatTimestamp(input.report.generatedAt) });
  if (input.snapshot.body.kind === 'SUSTAINABILITY' || input.snapshot.body.kind === 'EVIDENCE_PACK') {
    const project = input.snapshot.body.project;
    pairs.push({ label: 'Project', value: project.name });
    if (project.site) pairs.push({ label: 'Site', value: project.site });
    if (project.reference) pairs.push({ label: 'Reference', value: project.reference });
  }
  drawPairs(c, pairs);

}

/**
 * The two logos (§29.1, decision #30).
 *
 * Contractor left, client right. A logo whose bytes could not be retrieved leaves
 * **nothing** rather than a placeholder box: a report with an empty rectangle where
 * a client's brand should be reads as broken, and the document is not less true
 * without it.
 */
function drawLogos(c: Cursor, input: RenderInput): number {
  const { doc } = c;
  const { meta } = input.snapshot;
  const height = 34;
  let drew = false;

  const contractor = meta.contractor.logoFileId
    ? input.images.get(meta.contractor.logoFileId)
    : undefined;
  if (contractor) {
    doc.addImage(contractor.bytes, contractor.format, MARGIN, c.y, 0, height);
    drew = true;
  }
  const client = meta.client.logoFileId ? input.images.get(meta.client.logoFileId) : undefined;
  if (client) {
    // Right-aligned by a fixed box: `addImage` with width 0 scales from the
    // intrinsic size, which we cannot measure here, so the client mark gets a
    // stated 110pt box and keeps its aspect ratio inside it.
    doc.addImage(client.bytes, client.format, MARGIN + CONTENT_WIDTH - 110, c.y, 110, height, undefined, 'FAST');
    drew = true;
  }
  return drew ? height + 14 : 0;
}

// ── §29.1: the twelve sections ───────────────────────────────────────────────

function renderSustainability(
  c: Cursor,
  input: RenderInput,
  body: SustainabilitySnapshot,
  has: (key: ReportSectionKey) => boolean
): void {
  if (has('EXECUTIVE_SUMMARY')) {
    drawSectionHeading(c, 'Executive summary');
    if (body.executiveSummary.length === 0) {
      drawParagraph(c, 'No recorded activity on this project yet.');
    } else {
      for (const line of body.executiveSummary) drawParagraph(c, line);
    }
  }

  if (has('PROJECT_OVERVIEW')) {
    drawSectionHeading(c, 'Project overview');
    const pairs: LabelledValue[] = [
      { label: 'Status', value: body.project.status },
      { label: 'Dates', value: `${body.project.startsOn ?? 'open'} to ${body.project.endsOn ?? 'open'}` },
    ];
    if (body.overview.projectManager) {
      pairs.push({ label: 'Project manager', value: body.overview.projectManager });
    }
    if (body.overview.supervisor) {
      pairs.push({ label: 'Supervisor', value: body.overview.supervisor });
    }
    pairs.push({ label: 'People on site', value: String(body.overview.workforce.people) });
    pairs.push({ label: 'Labour hours', value: body.overview.workforce.hours.toFixed(2) });
    /*
     * **The audience boundary, on the page.** The discriminant is the type's own,
     * so this branch cannot be got wrong by a later edit: there is no `.name` to
     * reach for on a `ClientWorkforceSummary`.
     */
    if (body.overview.workforce.audience === 'INTERNAL') {
      pairs.push({
        label: 'Subcontractors',
        value:
          body.overview.workforce.subcontractors.map((s) => s.name).join(', ') || 'None recorded',
      });
    } else {
      pairs.push({
        label: 'Subcontracted organisations',
        value: String(body.overview.workforce.subcontractedOrganisations),
      });
    }
    drawPairs(c, pairs);
  }

  if (has('SUSTAINABILITY_HIGHLIGHTS')) {
    drawSectionHeading(c, 'Sustainability highlights');
    if (body.highlights.length === 0) {
      // §41.1 on the page: nothing measured is not the same as nothing emitted.
      drawParagraph(c, 'No figures have been calculated for this project.');
    } else {
      drawFigures(c, body.highlights);
    }
  }

  if (has('ASSET_OUTCOMES')) {
    drawSectionHeading(c, 'Asset outcomes');
    drawMassTable(c, body.outcomes, 'No final outcomes have been recorded.');
    drawBarChart(
      c,
      body.outcomes.map((r) => ({
        label: r.label,
        value: r.massKg,
        display: formatMassKg(r.massKg, 'AUTO'),
      }))
    );
  }

  if (has('MATERIAL_BREAKDOWN')) {
    drawSectionHeading(c, 'Material breakdown');
    drawMassTable(c, body.materials, 'No material categories have a recorded outcome.');
  }

  if (has('REUSE_DONATION')) {
    drawSectionHeading(c, 'Reuse & donation');
    drawMassTable(c, body.reuse, 'Nothing was recorded as retained, reused or donated.');
  }

  if (has('RECYCLING_WASTE')) {
    drawSectionHeading(c, 'Recycling & waste');
    drawMassTable(c, body.waste, 'Nothing was recorded as recycled, recovered or landfilled.');
  }

  if (has('CARBON_SUMMARY')) {
    drawSectionHeading(c, 'Carbon summary');
    drawCarbon(c, body);
  }

  if (has('CARBON_METHODOLOGY')) {
    drawSectionHeading(c, 'Carbon methodology');
    drawMethodology(c, input, body);
  }

  if (has('EVIDENCE') && body.evidence.length > 0) {
    drawSectionHeading(c, 'Evidence');
    drawPhotoGrid(c, input, body.evidence);
  }

  if (has('PROJECT_COMPLETION')) {
    drawSectionHeading(c, 'Project completion');
    drawCompletion(c, input, body.completion);
  }
}

/**
 * §29.1 section 9, and locked decision #17 rendered rather than described.
 *
 * *"Project GHG emissions … and Estimated avoided emissions … as two separate
 * subsections. **Never netted by default.**"* There is no total row, no net line
 * and no arithmetic between the two figures anywhere in this function — the type
 * they arrive in has no `net` field either, and `firewall.test.ts` asserts that
 * none appears.
 */
function drawCarbon(c: Cursor, body: SustainabilitySnapshot): void {
  const { carbon } = body;
  const { doc } = c;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  c.ensure(16);
  doc.text('Project greenhouse gas emissions', MARGIN, c.y + 9);
  c.y += 16;

  if (carbon.projectEmissionsKgCo2e === null) {
    drawParagraph(c, 'Not calculated. No emission factor set has been applied to this project.');
  } else {
    drawParagraph(c, `${formatCarbonKg(carbon.projectEmissionsKgCo2e)} (Scope 1, 2 and 3 inventory emissions).`);
    drawTable(
      c,
      ['Scope', 'Emissions'],
      [{ width: 405 }, { width: 110, right: true }],
      body.carbon.byScope
        .filter((s) => s.kgCo2e > 0)
        .map((s) => [`Scope ${s.scope.replace(/^SCOPE_?/, '')}`, formatCarbonKg(s.kgCo2e)]),
      'No scope-attributed emissions.'
    );
    // Phase 9's §13.1, said out loud on the page rather than left to be assumed.
    drawParagraph(
      c,
      `Electricity is reported on a ${carbon.scope2Basis === 'LOCATION_BASED' ? 'location-based' : 'market-based'} basis using published grid average factors.`,
      { size: 8.5 }
    );
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  c.ensure(16);
  doc.text('Estimated avoided emissions', MARGIN, c.y + 9);
  c.y += 16;

  if (carbon.avoidedKgCo2e === null) {
    drawParagraph(c, 'Not calculated.');
  } else {
    drawParagraph(c, `${formatCarbonKg(carbon.avoidedKgCo2e)}.`);
  }
  // §27.4: the warning travels with every avoided figure, "in the UI and in the
  // report, not only in an appendix". It is printed here, beside the number.
  drawNote(c, carbon.methodologyWarning);
}

/**
 * §29.1 section 10 — auto-generated from the citations the ledger already carries.
 *
 * *"factor set name · factor year · calculation methodology · data sources ·
 * baseline assumptions · lifecycle boundaries · estimation methodology ·
 * limitations · data-quality statement."*
 *
 * The gaps are here in full, and §28.3 says why in as many words: *"a report that
 * quietly omits its own gaps is the failure mode this whole section exists to
 * prevent."*
 */
function drawMethodology(c: Cursor, input: RenderInput, body: SustainabilitySnapshot): void {
  const { meta } = input.snapshot;

  if (meta.factorSets.length === 0) {
    drawParagraph(c, 'No emission factor set was applied, so no carbon figures are reported.');
  } else {
    drawTable(
      c,
      ['Factor set', 'Version', 'Year', 'Region'],
      [{ width: 245 }, { width: 100 }, { width: 80, right: true }, { width: 90 }],
      meta.factorSets.map((f) => [f.name, f.version, String(f.reportingYear), f.region]),
      'No factor set cited.'
    );
    if (new Set(meta.factorSets.map((f) => f.reportingYear)).size > 1) {
      // §38.2's disclosure, which binds at project level too: a project spanning a
      // year boundary legitimately cites two sets, and the reader is told.
      drawNote(
        c,
        'This report cites emission factors from more than one reporting year. Figures are not directly comparable with a single-year report.'
      );
    }
  }

  const quality = body.carbon.completeness;
  if (quality.pct === null) {
    drawParagraph(c, 'Data completeness: not measurable — no asset lines have been recorded.');
  } else {
    drawParagraph(
      c,
      `Data completeness: ${quality.pct.toFixed(1)}% (this company treats anything below ${String(quality.warnBelow)}% as requiring the figure to be shown with its completeness attached).`
    );
    drawTable(
      c,
      ['Component', 'Weight', 'Measured'],
      [{ width: 305 }, { width: 100, right: true }, { width: 110, right: true }],
      quality.components.map((component) => [
        component.label,
        `${(component.weight * 100).toFixed(0)}%`,
        component.value === null ? 'n/a' : `${(component.value * 100).toFixed(1)}%`,
      ]),
      'No components measured.'
    );
  }

  if (body.carbon.gaps.length > 0) {
    drawParagraph(c, 'Data gaps affecting the figures in this report:');
    drawBullets(c, body.carbon.gaps);
  } else {
    drawParagraph(c, 'No data gaps were identified for the figures in this report.');
  }

  if (body.carbon.calculatedAt) {
    drawParagraph(
      c,
      `Figures were calculated on ${formatTimestamp(body.carbon.calculatedAt)} and frozen into this document.`,
      { size: 8.5 }
    );
  }

  drawSectionHeading(c, 'Disclaimer');
  // The frozen text, never re-read from settings (§29.4). A blank one falls back
  // to §29.3's default rather than printing an empty section, because a report
  // with no methodology statement at all is the failure §29.3 exists to prevent.
  drawParagraph(c, input.snapshot.meta.disclaimer.trim() || DEFAULT_REPORT_DISCLAIMER, { size: 8.5 });
}

function drawCompletion(
  c: Cursor,
  input: RenderInput,
  completion: SustainabilitySnapshot['completion']
): void {
  const pairs: LabelledValue[] = [
    { label: 'Completion date', value: completion.completedOn ?? 'Not recorded' },
  ];
  if (!completion.signoff) {
    drawPairs(c, pairs);
    drawParagraph(c, 'No client sign-off has been captured for this project.');
    return;
  }

  const s = completion.signoff;
  pairs.push({ label: 'Signed by', value: s.signerName });
  if (s.signerRole) pairs.push({ label: 'Role', value: s.signerRole });
  if (s.signerCompany) pairs.push({ label: 'For', value: s.signerCompany });
  pairs.push({ label: 'Signed at', value: formatTimestamp(s.signedAt) });
  drawPairs(c, pairs);

  drawParagraph(c, s.completionStatement);
  if (s.comments) {
    drawParagraph(c, `Client comments: ${s.comments}`);
  }

  const signature = s.signatureFileId ? input.images.get(s.signatureFileId) : undefined;
  if (signature) {
    c.ensure(60);
    c.doc.addImage(signature.bytes, signature.format, MARGIN, c.y, 160, 50, undefined, 'FAST');
    c.y += 56;
  } else if (s.signatureFileId) {
    // Named rather than silent (§9). A missing signature image on a signed
    // document is a fact the reader needs, and a blank space is not one.
    drawNote(c, 'The captured signature image could not be retrieved for this rendering.');
  }
}

// ── §29.2: the evidence / completion pack ────────────────────────────────────

function renderEvidencePack(
  c: Cursor,
  input: RenderInput,
  body: EvidencePackSnapshot,
  has: (key: ReportSectionKey) => boolean
): void {
  if (has('PACK_PROJECT_DETAILS')) {
    drawSectionHeading(c, 'Project details');
    drawPairs(c, [
      { label: 'Status', value: body.project.status },
      { label: 'Dates', value: `${body.project.startsOn ?? 'open'} to ${body.project.endsOn ?? 'open'}` },
      { label: 'Site', value: body.project.site ?? 'Not recorded' },
      { label: 'People', value: String(body.workforce.people) },
    ]);
  }

  if (has('PACK_WORK_COMPLETED')) {
    drawSectionHeading(c, 'Work completed');
    if (body.workCompleted.length === 0) {
      drawParagraph(c, 'No work narrative has been recorded in the site diary.');
    } else {
      drawBullets(c, body.workCompleted);
    }
  }

  if (has('PACK_SITE_DIARY')) {
    drawSectionHeading(c, 'Site diary');
    drawTable(
      c,
      ['Date', 'Status', 'Weather', 'On site', 'Narrative'],
      [{ width: 62 }, { width: 62 }, { width: 78 }, { width: 50, right: true }, { width: 263 }],
      body.diary.map((d) => [
        d.date,
        d.status,
        d.weather ?? '-',
        String(d.attendanceCount),
        d.narrative.join(' '),
      ]),
      'No diary entries.'
    );
  }

  if (has('PACK_CREW')) {
    drawSectionHeading(c, 'Crew');
    if (body.workforce.audience === 'INTERNAL') {
      drawTable(
        c,
        ['Organisation', 'Hours'],
        [{ width: 405 }, { width: 110, right: true }],
        body.workforce.subcontractors.map((s) => [s.name, s.hours.toFixed(2)]),
        'No approved hours recorded.'
      );
    } else {
      drawPairs(c, [
        { label: 'People', value: String(body.workforce.people) },
        {
          label: 'Subcontracted organisations',
          value: String(body.workforce.subcontractedOrganisations),
        },
      ]);
    }
  }

  if (has('PACK_HOURS')) {
    drawSectionHeading(c, 'Hours');
    drawTable(
      c,
      ['', 'Hours'],
      [{ width: 405 }, { width: 110, right: true }],
      body.hours.map((h) => [h.label, h.hoursRegular.toFixed(2)]),
      'No approved hours recorded.'
    );
  }

  if (has('PACK_PHOTOS') && body.photos.length > 0) {
    drawSectionHeading(c, 'Photographs');
    drawPhotoGrid(c, input, body.photos);
  }

  if (has('PACK_ASSETS_REMOVED')) {
    drawSectionHeading(c, 'Assets removed');
    drawTable(
      c,
      ['Item', 'Qty', 'Mass', 'Destinations'],
      [{ width: 200 }, { width: 50, right: true }, { width: 80, right: true }, { width: 185 }],
      body.assets.map((a) => [
        a.name,
        String(a.quantity),
        a.massKg === null ? 'not weighed' : formatMassKg(a.massKg, 'AUTO'),
        a.destinations.join(', ') || 'Pending',
      ]),
      'No asset lines recorded.'
    );
  }

  if (has('PACK_DESTINATION_RECORDS')) {
    drawSectionHeading(c, 'Destination records');
    drawTable(
      c,
      ['Date', 'Item', 'Destination', 'Organisation', 'Mass', 'Reference'],
      [
        { width: 62 },
        { width: 110 },
        { width: 100 },
        { width: 105 },
        { width: 66, right: true },
        { width: 72 },
      ],
      body.destinationRecords.map((r) => [
        r.movedOn,
        r.assetName,
        r.destination,
        r.organisation ?? '-',
        r.massKg === null ? 'not weighed' : formatMassKg(r.massKg, 'AUTO'),
        r.reference ?? '-',
      ]),
      'No movements recorded.'
    );
  }

  if (has('PACK_WASTE_TRANSFER')) {
    drawSectionHeading(c, 'Waste transfer notes');
    drawDocumentTable(c, body.wasteTransferNotes);
  }
  if (has('PACK_RECYCLING_DOCS')) {
    drawSectionHeading(c, 'Recycling documentation');
    drawDocumentTable(c, body.recyclingDocuments);
  }
  if (has('PACK_DONATION_EVIDENCE')) {
    drawSectionHeading(c, 'Donation evidence');
    drawDocumentTable(c, body.donationEvidence);
  }

  /*
   * §29.2's variations (Phase 11, packet finding 11). This block did not exist and
   * did not need to: `PACK_VARIATIONS` carries `availableFrom: 11`, so it was
   * absent from the toggle list and absent from the document until
   * `CURRENT_BUILD_PHASE` moved — never rendered as an empty section asserting *no
   * variations* about a feature that did not exist.
   *
   * **`clientApprovalRecorded` prints as a column**, and that is the one decision
   * in this table. A completion pack listing a variation the contractor approved
   * without the client's own agreement on file, and not saying so, would be
   * asserting an agreement it cannot evidence — to the reader most likely to be
   * quoting it back during a dispute.
   *
   * No cost and no margin: the pack has both audiences, and the snapshot type has
   * no field either could come from.
   */
  if (has('PACK_VARIATIONS')) {
    drawSectionHeading(c, 'Variations');
    drawTable(
      c,
      ['Reference', 'Extra works', 'Requested', 'Agreed by client', 'To client'],
      [{ width: 70 }, { width: 190 }, { width: 65 }, { width: 100 }, { width: 90, right: true }],
      body.variations.map((v) => [
        v.reference ?? '-',
        v.description,
        v.requestedOn,
        v.clientApprovalRecorded ? (v.clientApprovedBy ?? 'Yes') : 'Not on file',
        formatMoney(v.sellTotalCents, body.currency),
      ]),
      'No variations were agreed on this project.'
    );
  }

  if (has('PACK_SIGNOFF')) {
    drawSectionHeading(c, 'Client sign-off');
    drawCompletion(c, input, { completedOn: body.project.endsOn, signoff: body.signoff });
  }
}

// ── §29.5: the client's BILL-side statement ──────────────────────────────────

function renderClientExport(
  c: Cursor,
  body: ClientExportSnapshot,
  has: (key: ReportSectionKey) => boolean
): void {
  if (has('STATEMENT_SUMMARY')) {
    drawSectionHeading(c, 'Summary');
    drawPairs(c, [
      { label: 'Status', value: body.project.status },
      { label: 'Dates', value: `${body.project.startsOn ?? 'open'} to ${body.project.endsOn ?? 'open'}` },
      { label: 'Labour', value: formatMoney(body.timeTotalCents, body.currency) },
      { label: 'Expenses', value: formatMoney(body.expenseTotalCents, body.currency) },
      { label: 'Total', value: formatMoney(body.totalCents, body.currency), emphasis: true },
      { label: 'Lines', value: String(body.lineItems.length) },
    ]);
    if (!body.pricingComplete) {
      /*
       * The floor, said plainly. §41.1 in money: at least one approved line had no
       * covering BILL rate and was not counted as zero, so the total above is what
       * *could* be priced rather than what the job costs.
       */
      drawNote(
        c,
        'This statement is provisional. At least one approved line had no rate covering its role, date and shift, so it is not included in the total above and has not been counted as zero.'
      );
    }
  }

  if (has('STATEMENT_LINE_ITEMS')) {
    drawSectionHeading(c, 'Line items');
    drawTable(
      c,
      ['Date', 'Description', 'Shift', 'Hours', 'OT', 'Amount'],
      LINE_COLS,
      body.lineItems.map((l) => [
        l.date,
        l.description,
        l.shiftType ?? '-',
        l.hoursRegular === null ? '-' : l.hoursRegular.toFixed(2),
        l.hoursOt === null ? '-' : l.hoursOt.toFixed(2),
        formatMoney(l.amountCents, body.currency),
      ]),
      'No approved lines on this project.'
    );
  }
}

// ── §38.2: the client period roll-up ─────────────────────────────────────────

function renderClientPeriod(
  c: Cursor,
  body: ClientPeriodSnapshot,
  has: (key: ReportSectionKey) => boolean
): void {
  if (has('PERIOD_SUMMARY')) {
    drawSectionHeading(c, 'Period summary');
    drawFigures(c, [
      { label: 'Projects', value: String(body.projectCount), note: null },
      {
        label: 'Total material managed',
        value: formatMassKg(body.totalMassKg, 'AUTO'),
        note: null,
      },
      {
        label: 'Retained in use',
        value: body.rates.retainedInUsePct === null ? 'n/a' : `${body.rates.retainedInUsePct.toFixed(1)}%`,
        note: 'Of allocated mass',
      },
      {
        label: 'Diverted from landfill',
        value: body.rates.diversionPct === null ? 'n/a' : `${body.rates.diversionPct.toFixed(1)}%`,
        note: null,
      },
      {
        label: 'Project emissions',
        value:
          body.carbon.projectEmissionsKgCo2e === null
            ? 'Not calculated'
            : formatCarbonKg(body.carbon.projectEmissionsKgCo2e),
        note: null,
      },
      {
        label: 'Estimated avoided emissions',
        value: body.carbon.avoidedKgCo2e === null ? 'Not calculated' : formatCarbonKg(body.carbon.avoidedKgCo2e),
        note: 'Reported separately - never netted',
      },
    ]);

    if (body.client.identities.length > 1) {
      /*
       * Packet finding 8, disclosed rather than assumed. A client that started as a
       * placeholder and later signed up trades under two company rows, and a total
       * covering both should say so — otherwise the only way to check the figure is
       * to know the merge happened.
       */
      drawParagraph(
        c,
        `This total covers ${String(body.client.identities.length)} recorded identities for this client: ${body.client.identities.map((i) => `${i.name}${i.placeholder ? ' (placeholder)' : ''}`).join(', ')}.`,
        { size: 8.5 }
      );
    }
    if (body.mixedFactorYears) {
      drawNote(
        c,
        `This period spans emission factors from ${body.factorYears.map(String).join(' and ')}. Figures from different factor years are not directly comparable.`
      );
    }
  }

  if (has('PERIOD_PROJECTS')) {
    drawSectionHeading(c, 'Projects');
    drawTable(
      c,
      ['Project', 'Start', 'End', 'Material'],
      [{ width: 245 }, { width: 80 }, { width: 80 }, { width: 110, right: true }],
      body.projects.map((p) => [
        p.name,
        p.startsOn ?? '-',
        p.endsOn ?? '-',
        formatMassKg(p.massKg, 'AUTO'),
      ]),
      'No projects in this period.'
    );
  }

  if (has('PERIOD_MATERIALS')) {
    drawSectionHeading(c, 'Materials');
    drawMassTable(c, body.materials, 'No material recorded in this period.');
  }

  if (has('PERIOD_CARBON')) {
    drawSectionHeading(c, 'Carbon');
    drawMassTable(c, body.outcomes, 'No outcomes recorded in this period.');
  }
}

// ── Shared pieces ────────────────────────────────────────────────────────────

function drawMassTable(c: Cursor, rows: readonly SnapshotMassRow[], empty: string): void {
  drawTable(
    c,
    ['', 'Mass', 'Share'],
    MASS_COLS,
    rows.map((r) => [
      r.label,
      formatMassKg(r.massKg, 'AUTO'),
      // §28.2: a rate over nothing is not 0%.
      r.pct === null ? 'n/a' : `${r.pct.toFixed(1)}%`,
    ]),
    empty
  );
}

function drawDocumentTable(
  c: Cursor,
  rows: readonly { title: string; reference: string | null; issuedOn: string | null }[]
): void {
  drawTable(
    c,
    ['Document', 'Reference', 'Issued'],
    [{ width: 300 }, { width: 130 }, { width: 85 }],
    rows.map((d) => [d.title, d.reference ?? '-', d.issuedOn ?? '-']),
    'None on file.'
  );
}

/**
 * §29.1 section 11 and §29.2's photographs — three to a row, captioned.
 *
 * A photograph whose bytes could not be retrieved is **named**, not skipped and not
 * left as a blank frame (§9): *"1 photograph referenced by this report could not be
 * retrieved"* is a fact about the document, and an empty box is a bug report.
 */
function drawPhotoGrid(
  c: Cursor,
  input: RenderInput,
  items: readonly SnapshotEvidenceItem[]
): void {
  const perRow = 3;
  const gap = 10;
  const cellWidth = (CONTENT_WIDTH - gap * (perRow - 1)) / perRow;
  const imageHeight = 96;
  let missing = 0;

  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    c.ensure(imageHeight + 26);
    const top = c.y;
    row.forEach((item, col) => {
      const x = MARGIN + col * (cellWidth + gap);
      const image = input.images.get(item.fileId);
      if (image) {
        c.doc.addImage(image.bytes, image.format, x, top, cellWidth, imageHeight, undefined, 'FAST');
      } else {
        missing += 1;
        c.doc.setDrawColor(200);
        c.doc.rect(x, top, cellWidth, imageHeight);
      }
      c.doc.setFont('helvetica', 'normal');
      c.doc.setFontSize(7.5);
      c.doc.setTextColor(110);
      c.doc.text(
        fit(c.doc, ascii(item.caption || item.category), cellWidth),
        x,
        top + imageHeight + 10
      );
      c.doc.setTextColor(0);
    });
    c.y = top + imageHeight + 22;
  }

  if (missing > 0) {
    drawNote(
      c,
      `${String(missing)} photograph${missing === 1 ? '' : 's'} referenced by this report could not be retrieved for this rendering. The reference is preserved in the report's stored contents.`
    );
  }
}

/** Exported for the determinism test, which renders the same input twice. */
export type { jsPDF };
