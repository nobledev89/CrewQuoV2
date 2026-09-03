import {
  AVOIDED_METHODOLOGY_WARNING,
  DATA_QUALITY_COMPONENT_LABELS,
  computeMassBalance,
  describeGaps,
  formatMassKg,
  formatCarbonKg,
  type ClientWorkforceSummary,
  type EvidencePackSnapshot,
  type InternalWorkforce,
  type ReportAudience,
  type ReportSectionKey,
  type ReportSnapshot,
  type ReportSnapshotMeta,
  type SnapshotCarbon,
  type SnapshotDocumentRow,
  type SnapshotEvidenceItem,
  type SnapshotMassRow,
  type SnapshotProject,
  type SustainabilitySnapshot,
  type WorkforceBlock,
} from '@crewquo/shared';
import { AppError } from '../../http/errors';
import { destinationNames, loadForBalance } from '../assets/massBalance';
import { loadProjectCarbonView } from '../sustainability/projectCarbon';
import { contentHash } from './seal';
import type { FileReferenceRole } from './repo';
import {
  loadAssetLines,
  loadDiary,
  loadDocuments,
  loadEvidence,
  loadLedgerIds,
  loadMaterials,
  loadMovements,
  loadProjectHeader,
  loadSourceRevisions,
  loadWorkforce,
  type MovementDetailRow,
  type ProjectHeaderRow,
} from './sources';

/**
 * Building a §29.4 snapshot — steps 10.4 and 10.5 of the Phase 10 build order.
 *
 * ── TWO BUILDERS, NOT ONE BUILDER AND A FILTER ───────────────────────────────
 *
 * `reporting-signoff.md` §0 finding 3. §29.1 section 3 names the project's
 * subcontractors; §29.5 forbids "subcontractor identity" in a file that leaves the
 * building; and §29.4 gives the document a `client_visible` boolean. One snapshot
 * serving both audiences makes the exclusion a filter somebody can forget, which is
 * the thing §29.5 says it must not be — *"so the exclusion cannot be forgotten by a
 * later edit the way a `select` list can"*.
 *
 * So `workforceFor` returns two different **types**. `InternalWorkforce` carries
 * `subcontractors: { companyId, name, hours }[]`; `ClientWorkforceSummary` carries
 * `subcontractedOrganisations: number` and has **no field a name could occupy**. A
 * provider's identity is not removed from a client's document; there is nowhere in
 * the shape for it to be.
 *
 * ── AND NOTHING HERE COMPUTES A FIGURE ───────────────────────────────────────
 *
 * Masses come from `computeMassBalance`, which Phase 8 tested exhaustively. Carbon
 * comes from `loadProjectCarbonView`, which is the same function the on-screen §28
 * section calls. A snapshot is a **copy of what the section said**, and a second
 * implementation would be exactly the disagreement §29.4 then freezes for ever.
 */

/** Evidence is capped in the snapshot, not in the rendering — see `sources.ts`. */
const EVIDENCE_LIMIT = 24;

const REUSE_DOC_CATEGORIES = ['DONATION_RECEIPT', 'DELIVERY_NOTE', 'COLLECTION_NOTE'] as const;
const WASTE_DOC_CATEGORIES = ['WASTE_TRANSFER_NOTE', 'WEIGHBRIDGE_TICKET'] as const;
const RECYCLING_DOC_CATEGORIES = ['RECYCLING_CERTIFICATE'] as const;

export interface SnapshotResult {
  snapshot: ReportSnapshot;
  contentHash: string;
  factorSetIds: string[];
  clientCompanyId: string | null;
  files: { fileId: string; role: FileReferenceRole }[];
}

export interface BuildArgs {
  projectId: string;
  audience: ReportAudience;
  sections: ReportSectionKey[];
  title?: string;
}

// ── The audience boundary ─────────────────────────────────────────────────────

function workforceFor(
  audience: ReportAudience,
  rows: readonly { provider_company_id: string; provider_company_name: string; hours: string; people: string }[],
  ownerCompanyId: string
): WorkforceBlock {
  const people = rows.reduce((n, r) => n + Number(r.people), 0);
  const hours = rows.reduce((n, r) => n + Number(r.hours), 0);

  if (audience === 'CLIENT') {
    const summary: ClientWorkforceSummary = {
      audience: 'CLIENT',
      people,
      hours,
      // The owner is not one of its own subcontractors. Counting the rows would
      // report "5 subcontracted organisations" on a job four companies worked.
      subcontractedOrganisations: rows.filter((r) => r.provider_company_id !== ownerCompanyId)
        .length,
    };
    return summary;
  }

  const internal: InternalWorkforce = {
    audience: 'INTERNAL',
    people,
    hours,
    subcontractors: rows.map((r) => ({
      companyId: r.provider_company_id,
      name: r.provider_company_name,
      hours: Number(r.hours),
    })),
  };
  return internal;
}

/**
 * Branding, client-first (decision #30).
 *
 * The client company's own report logo is the default and a project override wins.
 * The override exists because a **placeholder client has no members**, so nobody can
 * set its settings row and the contractor is the only party able to supply the
 * asset. Which source won is frozen alongside the id: a reader a year later should
 * be able to see whose asset it was rather than only that there was one.
 */
export function resolveClientBranding(header: ProjectHeaderRow): {
  logoFileId: string | null;
  logoSource: 'PROJECT_OVERRIDE' | 'CLIENT_DEFAULT' | 'NONE';
} {
  if (header.client_override_logo_file_id) {
    return { logoFileId: header.client_override_logo_file_id, logoSource: 'PROJECT_OVERRIDE' };
  }
  if (header.client_default_logo_file_id) {
    return { logoFileId: header.client_default_logo_file_id, logoSource: 'CLIENT_DEFAULT' };
  }
  return { logoFileId: null, logoSource: 'NONE' };
}

// ── Shared assembly ───────────────────────────────────────────────────────────

function projectBlock(header: ProjectHeaderRow): SnapshotProject {
  return {
    id: header.id,
    name: header.name,
    // A project has no `reference` column; §29.1's cover means the site's, and
    // inventing a project-level one for a cover page would be a schema decision
    // taken by a report.
    reference: header.site_reference,
    status: header.status,
    startsOn: header.starts_on,
    endsOn: header.ends_on,
    site: header.site_name,
    notes: header.notes,
  };
}

/** A mass table row with its share, and `null` rather than 0% when nothing landed. */
export function massRows(
  entries: readonly { label: string; massKg: number }[],
  totalKg: number
): SnapshotMassRow[] {
  return entries
    .filter((e) => e.massKg > 0)
    .map((e) => ({
      label: e.label,
      massKg: e.massKg,
      // §28.2: a rate over nothing is not 0%.
      pct: totalKg > 0 ? (e.massKg / totalKg) * 100 : null,
    }));
}

function movementMass(row: MovementDetailRow): number {
  return Number(row.weight_kg ?? 0);
}

function evidenceItems(
  rows: readonly { file_id: string; caption: string | null; category: string; captured_at: string | null }[]
): SnapshotEvidenceItem[] {
  return rows.map((r) => ({
    fileId: r.file_id,
    // Never null in the snapshot: a caption is what a reader sees under the
    // photograph, and `null` there would render as an empty caption that reads as
    // a missing one.
    caption: r.caption ?? '',
    category: r.category,
    capturedAt: r.captured_at,
  }));
}

function documentRows(
  rows: readonly {
    id: string;
    title: string;
    category: string;
    issued_on: string | null;
    reference: string | null;
    file_id: string | null;
  }[]
): SnapshotDocumentRow[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    issuedOn: r.issued_on,
    reference: r.reference,
    fileId: r.file_id,
  }));
}

/** The current sign-off for the whole project — the row nothing supersedes (§3). */
async function currentSignoffBlock(
  projectId: string
): Promise<SustainabilitySnapshot['completion']['signoff']> {
  const { query } = await import('../../db');
  const rows = await query<{
    signer_name: string;
    signer_company: string | null;
    signer_role: string | null;
    signed_at: Date;
    completion_statement: string;
    comments: string | null;
    signature_file_id: string | null;
  }>(
    `select s.signer_name, s.signer_company, s.signer_role, s.signed_at,
            s.completion_statement, s.comments, s.signature_file_id
       from client_signoffs s
      where s.project_id = $1 and s.phase is null
        and not exists (select 1 from client_signoffs n where n.supersedes_id = s.id)
      order by s.signed_at desc limit 1`,
    [projectId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    signerName: row.signer_name,
    signerCompany: row.signer_company,
    signerRole: row.signer_role,
    signedAt: row.signed_at.toISOString(),
    completionStatement: row.completion_statement,
    comments: row.comments,
    signatureFileId: row.signature_file_id,
  };
}

// ── §29.1: the Sustainability & Completion report ────────────────────────────

export async function buildSustainabilitySnapshot(args: BuildArgs): Promise<SnapshotResult> {
  const header = await loadProjectHeader(args.projectId);
  if (!header) throw new AppError('NOT_FOUND', 'Project not found');
  const scope = args.audience === 'CLIENT' ? 'CLIENT' : 'OWNER';

  const [
    assets,
    destNames,
    carbon,
    workforce,
    materials,
    movements,
    evidence,
    revisions,
    ledgerIds,
    signoff,
  ] = await Promise.all([
    loadForBalance(args.projectId),
    destinationNames(args.projectId),
    loadProjectCarbonView(args.projectId, header.owner_company_id),
    loadWorkforce(args.projectId),
    loadMaterials(args.projectId),
    loadMovements(args.projectId),
    loadEvidence(args.projectId, scope, EVIDENCE_LIMIT),
    loadSourceRevisions(args.projectId),
    loadLedgerIds(args.projectId),
    currentSignoffBlock(args.projectId),
  ]);

  const balance = computeMassBalance(assets);
  const massUnit = carbon.display.massUnit;

  const outcomes = massRows(
    balance.byDestination.map((d) => ({
      label: destNames.get(d.code) ?? d.code,
      massKg: d.massKg,
    })),
    balance.allocatedKg
  );

  const materialRows = massRows(
    materials.map((m) => ({ label: m.category, massKg: Number(m.mass_kg) })),
    balance.allocatedKg
  );

  const reuse = massRows(
    groupBy(
      movements.filter((m) => m.counts_as_reuse || m.counts_as_retained_in_use),
      (m) => m.organisation_name ?? m.destination_name
    ),
    balance.allocatedKg
  );

  const waste = massRows(
    groupBy(
      movements.filter((m) => m.counts_as_recycling || m.counts_as_recovery || m.counts_as_landfill),
      (m) => `${m.destination_name}${m.organisation_name ? ` — ${m.organisation_name}` : ''}`
    ),
    balance.allocatedKg
  );

  const carbonBlock: SnapshotCarbon = {
    projectEmissionsKgCo2e: carbon.projectEmissionsKgCo2e,
    avoidedKgCo2e: carbon.avoidedKgCo2e,
    byBucket: carbon.byBucket.map((b) => ({ ...b })),
    byScope: carbon.byScope.map((b) => ({ ...b })),
    // Phase 9's §13.1, built as recommended and labelled wherever it appears. It is
    // stated on the document rather than inferred from the disclaimer's wording,
    // because a company that edits the disclaimer must not be able to un-state it.
    scope2Basis: 'LOCATION_BASED',
    methodologyWarning: AVOIDED_METHODOLOGY_WARNING,
    // §28.3: "a report that quietly omits its own gaps is the failure mode this
    // whole section exists to prevent." Both sets, deduplicated, because the
    // section already merges them and the document must say what the screen said.
    gaps: [...new Set([...carbon.gaps, ...describeGaps(balance, { massUnit })])],
    completeness: {
      pct: carbon.completeness.pct,
      warnBelow: carbon.completeness.warnBelow,
      components: carbon.completeness.components.map((c) => ({
        ...c,
        label: DATA_QUALITY_COMPONENT_LABELS[c.component],
      })),
    },
    calculatedAt: carbon.calculatedAt,
    ledgerFingerprint: ledgerIds.length > 0 ? contentHash(ledgerIds) : null,
  };

  const branding = resolveClientBranding(header);

  const body: SustainabilitySnapshot = {
    kind: 'SUSTAINABILITY',
    project: projectBlock(header),
    overview: {
      /*
       * Both null, and deliberately so. There is no `project_manager_user_id` or
       * `supervisor_user_id` on `projects` — crew roles arrive with §31's
       * scheduling in Phase 11 — and picking "whoever closed the most diary days"
       * would be a name on a completion report that nobody appointed. §41.1's rule
       * about numbers applies to people: an absent fact is absent.
       */
      projectManager: null,
      supervisor: null,
      workforce: workforceFor(args.audience, workforce, header.owner_company_id),
    },
    executiveSummary: executiveSummary(header, balance, carbonBlock, massUnit),
    highlights: highlights(balance, carbonBlock, massUnit, carbon.display.carbonUnit),
    massHandledKg: balance.handledKg,
    outcomes,
    materials: materialRows,
    reuse,
    waste,
    rates: {
      retainedInUsePct: pct(balance.rates.retainedInUse),
      diversionPct: pct(balance.rates.diverted),
      reusePct: pct(balance.rates.reuse),
      recyclingPct: pct(balance.rates.recycling),
    },
    carbon: carbonBlock,
    evidence: evidenceItems(evidence),
    completion: {
      completedOn: header.ends_on,
      signoff,
    },
  };

  const meta = metaFor({
    header,
    audience: args.audience,
    kind: 'SUSTAINABILITY',
    title: args.title ?? `${header.name} — Sustainability & Completion Report`,
    sections: args.sections,
    branding,
    factorSets: carbon.factorSets,
    revisions,
    display: carbon.display,
    files: [
      ...evidence.map((e) => ({ fileId: e.file_id, role: 'EVIDENCE' as const })),
      ...(signoff?.signatureFileId
        ? [{ fileId: signoff.signatureFileId, role: 'SIGNATURE' as const }]
        : []),
    ],
  });

  return sealed(meta, body, header.client_company_id);
}

// ── §29.2: the evidence / completion pack ────────────────────────────────────

export async function buildEvidencePackSnapshot(args: BuildArgs): Promise<SnapshotResult> {
  const header = await loadProjectHeader(args.projectId);
  if (!header) throw new AppError('NOT_FOUND', 'Project not found');
  const scope = args.audience === 'CLIENT' ? 'CLIENT' : 'OWNER';

  const [
    workforce,
    diary,
    assetLines,
    movements,
    evidence,
    wasteDocs,
    recyclingDocs,
    donationDocs,
    revisions,
    signoff,
    carbon,
  ] = await Promise.all([
    loadWorkforce(args.projectId),
    loadDiary(args.projectId, scope),
    loadAssetLines(args.projectId),
    loadMovements(args.projectId),
    loadEvidence(args.projectId, scope, EVIDENCE_LIMIT),
    loadDocuments(args.projectId, scope, WASTE_DOC_CATEGORIES),
    loadDocuments(args.projectId, scope, RECYCLING_DOC_CATEGORIES),
    loadDocuments(args.projectId, scope, REUSE_DOC_CATEGORIES),
    loadSourceRevisions(args.projectId),
    currentSignoffBlock(args.projectId),
    loadProjectCarbonView(args.projectId, header.owner_company_id),
  ]);

  const body: EvidencePackSnapshot = {
    kind: 'EVIDENCE_PACK',
    project: projectBlock(header),
    workforce: workforceFor(args.audience, workforce, header.owner_company_id),
    workCompleted: diary
      .map((d) => d.work_completed?.trim())
      .filter((s): s is string => typeof s === 'string' && s.length > 0),
    diary: diary.map((d) => ({
      entryId: d.id,
      date: d.entry_date,
      // §13.6's integer. The document freezes what the day was at; a later
      // amendment moves the live one and the divergence becomes a banner.
      revision: d.revision,
      weather: d.weather,
      narrative: [d.work_completed, d.delays, d.notes].filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0
      ),
      attendanceCount: Number(d.attendance_count),
      status: d.status,
    })),
    hours: workforceHours(args.audience, workforce, header.owner_company_id),
    photos: evidenceItems(evidence),
    assets: assetLines.map((a) => ({
      id: a.id,
      name: a.name,
      quantity: Number(a.quantity),
      massKg: a.mass_kg === null ? null : Number(a.mass_kg),
      outcome: (a.outcome_destinations ?? []).length > 0 ? 'RECORDED' : 'PENDING',
      destinations: a.outcome_destinations ?? [],
    })),
    destinationRecords: movements.map((m) => ({
      movementId: m.id,
      assetName: m.asset_name,
      destination: m.destination_name,
      organisation: m.organisation_name,
      movedOn: m.moved_on,
      quantity: Number(m.quantity),
      massKg: m.weight_kg === null ? null : Number(m.weight_kg),
      reference: m.document_reference,
    })),
    wasteTransferNotes: documentRows(wasteDocs),
    recyclingDocuments: documentRows(recyclingDocs),
    donationEvidence: documentRows(donationDocs),
    signoff,
  };

  const branding = resolveClientBranding(header);
  const docFiles = [...wasteDocs, ...recyclingDocs, ...donationDocs]
    .map((d) => d.file_id)
    .filter((id): id is string => id !== null);

  const meta = metaFor({
    header,
    audience: args.audience,
    kind: 'EVIDENCE_PACK',
    title: args.title ?? `${header.name} — Evidence & Completion Pack`,
    sections: args.sections,
    branding,
    factorSets: carbon.factorSets,
    revisions,
    display: carbon.display,
    files: [
      ...evidence.map((e) => ({ fileId: e.file_id, role: 'EVIDENCE' as const })),
      ...docFiles.map((id) => ({ fileId: id, role: 'DOCUMENT' as const })),
      ...(signoff?.signatureFileId
        ? [{ fileId: signoff.signatureFileId, role: 'SIGNATURE' as const }]
        : []),
    ],
  });

  return sealed(meta, body, header.client_company_id);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupBy(
  rows: readonly MovementDetailRow[],
  key: (row: MovementDetailRow) => string
): { label: string; massKg: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    totals.set(k, (totals.get(k) ?? 0) + movementMass(row));
  }
  return [...totals.entries()]
    .map(([label, massKg]) => ({ label, massKg }))
    .sort((a, b) => b.massKg - a.massKg);
}

/** §28.2's rates are fractions; the report prints percentages. */
function pct(rate: number | null): number | null {
  return rate === null ? null : rate * 100;
}

/**
 * The hours table, and the audience boundary again.
 *
 * For a client it is one row — the total — because a per-subcontractor hours table
 * is a supply chain with a column of numbers next to it.
 */
function workforceHours(
  audience: ReportAudience,
  rows: readonly { provider_company_id: string; provider_company_name: string; hours: string }[],
  ownerCompanyId: string
): { label: string; hoursRegular: number; hoursOt: number }[] {
  if (audience === 'CLIENT') {
    const total = rows.reduce((n, r) => n + Number(r.hours), 0);
    return [{ label: 'Total labour hours', hoursRegular: total, hoursOt: 0 }];
  }
  return rows.map((r) => ({
    label:
      r.provider_company_id === ownerCompanyId
        ? `${r.provider_company_name} (own staff)`
        : r.provider_company_name,
    hoursRegular: Number(r.hours),
    hoursOt: 0,
  }));
}

/**
 * §29.1 section 2: *"a factual summary … Assembled from recorded data; **no
 * invented narrative**."*
 *
 * Every sentence here is a template over figures that already exist, and a figure
 * that is null produces **no sentence** rather than a sentence with a gap in it.
 * That is the difference between a summary and a paragraph that says the project
 * emitted nothing.
 */
function executiveSummary(
  header: ProjectHeaderRow,
  balance: ReturnType<typeof computeMassBalance>,
  carbon: SnapshotCarbon,
  massUnit: Parameters<typeof formatMassKg>[1]
): string[] {
  const lines: string[] = [];
  const period =
    header.starts_on && header.ends_on
      ? ` between ${header.starts_on} and ${header.ends_on}`
      : '';
  lines.push(
    `${header.name}${header.site_name ? ` at ${header.site_name}` : ''} was delivered by ${header.owner_company_name}${
      header.client_company_name ? ` for ${header.client_company_name}` : ''
    }${period}.`
  );

  if (balance.handledKg > 0) {
    lines.push(
      `${formatMassKg(balance.handledKg, massUnit)} of material was handled, of which ${formatMassKg(balance.allocatedKg, massUnit)} has a recorded final outcome.`
    );
  }
  if (balance.pendingKg > 0) {
    lines.push(
      `${formatMassKg(balance.pendingKg, massUnit)} is still pending a final destination and is excluded from every rate below.`
    );
  }
  if (balance.rates.retainedInUse !== null) {
    lines.push(
      `${(balance.rates.retainedInUse * 100).toFixed(1)}% of allocated material was retained in use and ${((balance.rates.diverted ?? 0) * 100).toFixed(1)}% was diverted from landfill.`
    );
  }
  if (carbon.projectEmissionsKgCo2e !== null) {
    lines.push(
      `Project greenhouse gas emissions were ${formatCarbonKg(carbon.projectEmissionsKgCo2e)}.`
    );
  }
  if (carbon.avoidedKgCo2e !== null && carbon.avoidedKgCo2e > 0) {
    lines.push(
      `Estimated avoided emissions were ${formatCarbonKg(carbon.avoidedKgCo2e)}, reported separately and never deducted from the figure above.`
    );
  }
  if (carbon.gaps.length > 0) {
    lines.push(
      `${carbon.gaps.length} data gap${carbon.gaps.length === 1 ? '' : 's'} affected these figures and ${carbon.gaps.length === 1 ? 'is' : 'are'} listed in full under Carbon methodology.`
    );
  }
  return lines;
}

/** §29.1 section 4's strip. A null figure produces no tile, never a zero. */
function highlights(
  balance: ReturnType<typeof computeMassBalance>,
  carbon: SnapshotCarbon,
  massUnit: Parameters<typeof formatMassKg>[1],
  carbonUnit: Parameters<typeof formatCarbonKg>[1]
): { label: string; value: string; note: string | null }[] {
  const out: { label: string; value: string; note: string | null }[] = [];
  if (balance.handledKg > 0) {
    out.push({
      label: 'Material managed',
      value: formatMassKg(balance.handledKg, massUnit),
      note: balance.hasUnknownMass ? 'A floor: some lines have no recorded weight' : null,
    });
  }
  if (balance.rates.retainedInUse !== null) {
    out.push({
      label: 'Kept in use',
      value: `${(balance.rates.retainedInUse * 100).toFixed(1)}%`,
      note: 'Of allocated mass; pending mass is excluded',
    });
  }
  if (balance.rates.diverted !== null) {
    out.push({
      label: 'Diverted from landfill',
      value: `${(balance.rates.diverted * 100).toFixed(1)}%`,
      note: null,
    });
  }
  if (carbon.projectEmissionsKgCo2e !== null) {
    out.push({
      label: 'Project emissions',
      value: formatCarbonKg(carbon.projectEmissionsKgCo2e, carbonUnit),
      note: 'Scope 1, 2 and 3 inventory emissions',
    });
  }
  if (carbon.avoidedKgCo2e !== null) {
    out.push({
      label: 'Estimated avoided emissions',
      value: formatCarbonKg(carbon.avoidedKgCo2e, carbonUnit),
      note: 'Reported separately — never netted (decision #17)',
    });
  }
  return out;
}

export function metaFor(args: {
  header: ProjectHeaderRow;
  audience: ReportAudience;
  kind: ReportSnapshotMeta['kind'];
  title: string;
  sections: ReportSectionKey[];
  branding: { logoFileId: string | null; logoSource: 'PROJECT_OVERRIDE' | 'CLIENT_DEFAULT' | 'NONE' };
  factorSets: ReportSnapshotMeta['factorSets'];
  revisions: ReportSnapshotMeta['sourceRevisions'];
  display: ReportSnapshotMeta['display'];
  files: { fileId: string; role: FileReferenceRole }[];
}): ReportSnapshotMeta & { __files: { fileId: string; role: FileReferenceRole }[] } {
  const logoFiles = [
    ...(args.header.owner_logo_file_id
      ? [{ fileId: args.header.owner_logo_file_id, role: 'LOGO' as const }]
      : []),
    ...(args.branding.logoFileId
      ? [{ fileId: args.branding.logoFileId, role: 'LOGO' as const }]
      : []),
  ];
  const files = [...args.files, ...logoFiles];

  return {
    schemaVersion: 1,
    kind: args.kind,
    audience: args.audience,
    title: args.title,
    periodStart: args.header.starts_on,
    periodEnd: args.header.ends_on,
    contractor: {
      companyId: args.header.owner_company_id,
      name: args.header.owner_company_name,
      logoFileId: args.header.owner_logo_file_id,
    },
    client: {
      companyId: args.header.client_company_id,
      name: args.header.client_company_name,
      logoFileId: args.branding.logoFileId,
      logoSource: args.branding.logoSource,
    },
    disclaimer: args.header.report_disclaimer,
    sections: args.sections,
    factorSets: args.factorSets,
    sourceRevisions: args.revisions,
    fileIds: [...new Set(files.map((f) => f.fileId))].sort(),
    display: args.display,
    __files: files,
  };
}

/**
 * Seal it.
 *
 * `__files` is stripped before hashing — it is bookkeeping for the caller, and a
 * key beginning with an underscore inside a sealed document would be a permanent
 * invitation to add more of them.
 */
export function sealed(
  meta: ReportSnapshotMeta & { __files: { fileId: string; role: FileReferenceRole }[] },
  body: ReportSnapshot['body'],
  clientCompanyId: string | null
): SnapshotResult {
  const { __files: files, ...cleanMeta } = meta;
  const snapshot: ReportSnapshot = { meta: cleanMeta, body };
  return {
    snapshot,
    contentHash: contentHash(snapshot),
    factorSetIds: cleanMeta.factorSets.map((f) => f.id),
    clientCompanyId,
    files,
  };
}
