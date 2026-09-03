import {
  describeChangedFigures,
  describeProhibitedClaims,
  describeStaleSources,
  findProhibitedClaims,
  resolveSections,
  type ChangedFigure,
  type GeneratedReportDetail,
  type ReportAudience,
  type ReportKind,
  type ReportSnapshot,
  type SourceRevision,
  type StaleSource,
} from '@crewquo/shared';
import { query, queryOne, withTransaction } from '../../db';
import { AppError } from '../../http/errors';
import { recordAudit } from '../audit/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import { buildClientExportSnapshot, buildClientPeriodSnapshot } from './clientSnapshot';
import { loadImages } from './images';
import { renderReportPdf } from './render';
import {
  addFileReferences,
  currentClientCompanyId,
  findCurrentOfKind,
  findLiveByHash,
  findReport,
  insertReport,
  markSuperseded,
  setReportFile,
  toReportView,
  type ReportRow,
} from './repo';
import { assertSealed } from './seal';
import { buildEvidencePackSnapshot, buildSustainabilitySnapshot, type SnapshotResult } from './snapshot';
import { loadSourceRevisions } from './sources';
import { storeRenderedPdf } from './store';

/**
 * Generating a report — the transaction that turns a project into a frozen
 * document.
 *
 * Five things happen here in one order, and the order is the design:
 *
 *  1. **The claim guard runs before anything is read** (§29.3, packet finding 7).
 *     Applied here as well as on save, because a disclaimer edited before the
 *     guard shipped, restored from a backup, or written straight into the database
 *     would otherwise be frozen into a snapshot and rendered under a client's logo.
 *  2. **The project lock is taken**, the same `select … for update` on `projects`
 *     that `recalculateProject` takes, so a document is never assembled from a
 *     ledger that is halfway through being superseded.
 *  3. **The snapshot is built and sealed.**
 *  4. **A colliding seal returns the existing row** (finding 9). Regeneration after
 *     nothing changed is a no-op, so a `SUPERSEDED` row in the trail always means a
 *     figure actually moved.
 *  5. **The file references are written in the same transaction** (decision #27).
 *     A hold recorded afterwards is a hold a crash between the two writes silently
 *     omits, on the one table whose whole purpose is that nothing is omitted.
 *
 * The PDF is rendered and stored **after** the commit, because it is a cache and
 * not the record: object storage being unreachable must not lose a report whose
 * numbers are already correct (§9).
 */

export interface GenerateArgs {
  companyId: string;
  actorUserId: string;
  projectId: string | null;
  kind: ReportKind;
  audience: ReportAudience;
  title?: string;
  sections?: readonly string[];
  supersede?: boolean;
  /** CLIENT_PERIOD only. */
  clientCompanyId?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface GenerateResult {
  report: ReturnType<typeof toReportView>;
  /** True when the seal already existed and nothing new was written. */
  reused: boolean;
  supersededId: string | null;
}

export async function generateReport(args: GenerateArgs): Promise<GenerateResult> {
  const sections = resolveSections(args.kind, args.sections ?? null);

  const built = await buildFor(args, sections);
  assertDisclaimerIsHonest(built.snapshot);

  const existing = await findLiveByHash({
    projectId: args.projectId,
    companyId: args.companyId,
    kind: args.kind,
    contentHash: built.contentHash,
  });
  if (existing) {
    /*
     * Finding 9's whole payoff. A double-click, a retried request, or a
     * "regenerate with current data" on a project where nothing has changed all
     * land here and get the document that already exists — no second row, no
     * spurious supersession, and no `SUPERSEDED` entry in the trail that means
     * nothing moved.
     */
    return { report: toReportView(existing), reused: true, supersededId: null };
  }

  const { row, supersededId } = await withTransaction(async (client) => {
    if (args.projectId) {
      // The project lock — the same one `recalculateProject` takes, deliberately,
      // so the two cannot interleave. Nothing here takes an asset lock, so the
      // ordering that keeps the movement ledger deadlock-free is preserved.
      await client.query('select id from projects where id = $1 for update', [args.projectId]);
    }

    let predecessor: ReportRow | null = null;
    if (args.supersede !== false && args.projectId) {
      predecessor = await findCurrentOfKind(
        { projectId: args.projectId, kind: args.kind, audience: args.audience },
        client
      );
      if (predecessor) await markSuperseded(predecessor.id, client);
    }

    const inserted = await insertReport(
      {
        companyId: args.companyId,
        projectId: args.projectId,
        clientCompanyId: built.clientCompanyId,
        kind: args.kind,
        audience: args.audience,
        title: built.snapshot.meta.title,
        periodStart: built.snapshot.meta.periodStart,
        periodEnd: built.snapshot.meta.periodEnd,
        sections,
        snapshot: built.snapshot,
        contentHash: built.contentHash,
        factorSetIds: built.factorSetIds,
        disclaimer: built.snapshot.meta.disclaimer,
        supersedesId: predecessor?.id ?? null,
        generatedByUserId: args.actorUserId,
        generatedAt: new Date().toISOString(),
      },
      client
    );

    await addFileReferences({ reportId: inserted.id }, built.files, client);

    if (predecessor && predecessor.client_visible) {
      /*
       * The only supersession worth an event (packet §5), enqueued **inside the
       * transaction** because that is what the outbox is for: a report that
       * committed without its notice is a client who was never told their document
       * changed, and there is no later moment that reliably notices.
       *
       * If a client was sent a document in March and the figures behind it moved in
       * June, the payload says *which* figures — computed here from the two
       * snapshots rather than left to a consumer that would have to open both.
       */
      const changedFigures = diffHeadlines(predecessor.snapshot, built.snapshot);
      await enqueueOutboxEvent(
        {
          topic: 'report.superseded',
          aggregateType: 'GENERATED_REPORT',
          aggregateId: inserted.id,
          companyId: args.companyId,
          payload: {
            reportId: predecessor.id,
            supersededById: inserted.id,
            projectId: args.projectId,
            clientCompanyId: built.clientCompanyId
              ? await currentClientCompanyId(built.clientCompanyId)
              : null,
            title: inserted.title,
            changedFigures,
            summary: describeChangedFigures(changedFigures),
          },
          idempotencyKey: `report.superseded:${inserted.id}`,
        },
        client
      );
    }

    return { row: inserted, supersededId: predecessor?.id ?? null, previous: predecessor };
  });

  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    action: 'report.generated',
    entityType: 'GENERATED_REPORT',
    entityId: row.id,
    changes: {
      kind: args.kind,
      audience: args.audience,
      contentHash: built.contentHash,
      sections,
      supersedes: supersededId,
    },
    description: `${args.kind} report generated: "${row.title}"`,
    // Internal: which documents a company produced for itself is not the client's
    // business until one is deliberately disclosed, which is its own audited act.
    visibleToClient: false,
  });

  // Outside the transaction: the file is a cache, and storage being unreachable
  // must not roll back a document whose numbers are already right.
  await renderAndStore(row, args.actorUserId);

  const fresh = (await findReport(row.id)) ?? row;
  return { report: toReportView(fresh), reused: false, supersededId };
}

/** §29.3, at the moment the claim would be published. */
function assertDisclaimerIsHonest(snapshot: ReportSnapshot): void {
  const claims = findProhibitedClaims(snapshot.meta.disclaimer);
  if (claims.length === 0) return;
  throw new AppError('VALIDATION', describeProhibitedClaims(claims), {
    claims: claims.map((c) => ({ phrase: c.phrase, rule: c.rule })),
  });
}

async function buildFor(args: GenerateArgs, sections: string[]): Promise<SnapshotResult> {
  const resolved = sections as never;
  switch (args.kind) {
    case 'SUSTAINABILITY':
      return buildSustainabilitySnapshot({
        projectId: requireProject(args),
        audience: args.audience,
        sections: resolved,
        title: args.title,
      });
    case 'EVIDENCE_PACK':
      return buildEvidencePackSnapshot({
        projectId: requireProject(args),
        audience: args.audience,
        sections: resolved,
        title: args.title,
      });
    case 'CLIENT_EXPORT':
      return buildClientExportSnapshot({
        projectId: requireProject(args),
        audience: 'CLIENT',
        sections: resolved,
        title: args.title,
      });
    case 'CLIENT_PERIOD':
      if (!args.clientCompanyId || !args.periodStart || !args.periodEnd) {
        throw new AppError('VALIDATION', 'A client period report needs a client and a period');
      }
      return buildClientPeriodSnapshot({
        companyId: args.companyId,
        clientCompanyId: args.clientCompanyId,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        sections: resolved,
        audience: args.audience,
        title: args.title,
      });
  }
}

function requireProject(args: GenerateArgs): string {
  if (!args.projectId) throw new AppError('VALIDATION', 'This report kind needs a project');
  return args.projectId;
}

/**
 * What moved between two documents, in the terms a client reads.
 *
 * Only the headline figures, and deliberately: a client who is told *"the diversion
 * rate moved from 91.8% to 89.4%"* knows what to do, and one who is handed a diff
 * of four hundred snapshot keys knows nothing.
 */
function diffHeadlines(before: ReportSnapshot, after: ReportSnapshot): ChangedFigure[] {
  const pick = (
    snapshot: ReportSnapshot
  ): { emissions: number | null; avoided: number | null; mass: number | null } => {
    if (snapshot.body.kind === 'SUSTAINABILITY') {
      return {
        emissions: snapshot.body.carbon.projectEmissionsKgCo2e,
        avoided: snapshot.body.carbon.avoidedKgCo2e,
        mass: snapshot.body.massHandledKg,
      };
    }
    if (snapshot.body.kind === 'CLIENT_PERIOD') {
      return {
        emissions: snapshot.body.carbon.projectEmissionsKgCo2e,
        avoided: snapshot.body.carbon.avoidedKgCo2e,
        mass: snapshot.body.totalMassKg,
      };
    }
    if (snapshot.body.kind === 'CLIENT_EXPORT') {
      return { emissions: null, avoided: null, mass: snapshot.body.totalCents };
    }
    return { emissions: null, avoided: null, mass: null };
  };

  const a = pick(before);
  const b = pick(after);
  const out: ChangedFigure[] = [];
  if (a.mass !== b.mass) out.push({ label: 'Material managed (kg)', from: a.mass, to: b.mass });
  if (a.emissions !== b.emissions) {
    out.push({ label: 'Project emissions (kgCO2e)', from: a.emissions, to: b.emissions });
  }
  if (a.avoided !== b.avoided) {
    out.push({ label: 'Estimated avoided emissions (kgCO2e)', from: a.avoided, to: b.avoided });
  }
  return out;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Render a stored report, verifying its seal first.
 *
 * **A snapshot whose hash does not verify is refused rather than rendered with a
 * warning** (§9). A seal that still prints the document is a seal that does
 * nothing, and the warning lands on the screen of the person least able to act.
 */
export async function renderStoredReport(row: ReportRow): Promise<Buffer> {
  assertSealed(row.snapshot, row.content_hash);
  const images = await loadImages(row.snapshot.meta.fileIds);
  /*
   * **Nothing live reaches the renderer**, which is the correction the acceptance
   * script forced — see the note at the top of `render.ts`. The staleness of the
   * sources is reported beside the document, never printed inside it, because a
   * document that changes when its inputs change is not a §29.4 snapshot.
   */
  return renderReportPdf({ report: toReportView(row), snapshot: row.snapshot, images });
}

async function renderAndStore(row: ReportRow, actorUserId: string): Promise<void> {
  try {
    const bytes = await renderStoredReport(row);
    const fileId = await storeRenderedPdf({
      report: row,
      bytes,
      uploadedByUserId: actorUserId,
    });
    if (fileId) {
      await setReportFile(row.id, fileId);
      await addFileReferences({ reportId: row.id }, [{ fileId, role: 'RENDERED' }]);
    }
  } catch (err) {
    /*
     * Deliberately swallowed. The report row is committed and its numbers are
     * correct; the PDF is a cache the next read re-renders. Failing the request
     * here would tell a person their report was not produced when it was.
     */
    console.error(`[reports] could not store the rendered PDF for ${row.id}:`, err);
  }
}

// ── Staleness (§13.6, packet finding 10) ─────────────────────────────────────

/**
 * Which cited records have moved since the document was generated.
 *
 * One query against integers, compared against the revisions the snapshot froze.
 * Nothing is recalculated, nothing about the document changes, and the answer is a
 * banner rather than a rewrite — which is the resolution `project-evidence.md`
 * §13.6 recommended and this packet generalised from the diary to every record
 * class a snapshot cites.
 */
export async function staleSourcesFor(row: ReportRow): Promise<StaleSource[]> {
  if (!row.project_id) return [];
  const frozen = row.snapshot.meta.sourceRevisions;
  if (frozen.length === 0) return [];

  const current = await loadSourceRevisions(row.project_id);
  const byKey = new Map<string, SourceRevision>(
    current.map((r) => [`${r.kind}:${r.id ?? ''}`, r])
  );

  const stale: StaleSource[] = [];
  for (const was of frozen) {
    const now = byKey.get(`${was.kind}:${was.id ?? ''}`);
    // A record that has since been tombstoned is absent from `current`. It is not
    // reported as stale: the document cited what existed, and "this was deleted"
    // is a different sentence from "this was amended" — one this phase does not
    // have a place to say, so it says nothing rather than the wrong thing.
    if (!now || now.revision <= was.revision) continue;
    stale.push({ ...was, currentRevision: now.revision });
  }
  return stale;
}

export async function reportDetail(row: ReportRow): Promise<GeneratedReportDetail> {
  assertSealed(row.snapshot, row.content_hash);
  const staleSources = await staleSourcesFor(row);
  return {
    report: toReportView(row),
    snapshot: row.snapshot,
    staleSources,
    staleNotes: describeStaleSources(staleSources),
  };
}

/** A filename for a download. Length-capped ASCII — it crosses a header. */
export function reportFilename(row: ReportRow): string {
  const slug = row.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
    .toLowerCase();
  return `${slug || `report-${row.id.slice(0, 8)}`}.pdf`;
}

/** Count of live reports citing a file — used by the delete guard's message. */
export async function reportsCiting(fileId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `select count(*)::text as n from report_file_references where file_id = $1`,
    [fileId]
  );
  return Number(row?.n ?? 0);
}

/** Every report on a project, for the trail. */
export function reportIdsForProject(projectId: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(`select id from generated_reports where project_id = $1`, [
    projectId,
  ]);
}
