import { Router } from 'express';
import {
  KIND_AUDIENCES,
  availableSections,
  clientPeriodQuerySchema,
  createSignoffSchema,
  defaultSections,
  generateReportSchema,
  setReportVisibilitySchema,
  voidReportSchema,
  type FeatureKey,
  type ReportKind,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { queryOne } from '../../db';
import { recordAudit } from '../audit/record';
import { assertCapability } from '../capabilities/guards';
import { enqueueOutboxEvent } from '../delivery/repo';
import { hasFeature } from '../entitlements/guards';
import { projectAccess, type ProjectAccess } from '../assets/routes';
import { withTransaction } from '../../db';
import {
  generateReport,
  renderStoredReport,
  reportDetail,
  reportFilename,
} from './generate';
import {
  currentClientCompanyId,
  findReport,
  listCompanyPeriodReports,
  listProjectReports,
  setClientVisible,
  toReportView,
  voidReport,
  type ReportRow,
} from './repo';
import { SealMismatch } from './seal';
import { captureSignoff, currentSignoffs, listSignoffs, toSignoffView } from './signoff';

/**
 * The reporting and sign-off routes (§29, §34, §38.2) — steps 10.5 to 10.9.
 *
 * ── FOUR CHECKS PER OPERATION, AND THE THIRD IS THE ONE THAT VARIES ─────────
 *
 * Feature entitlement, capability, company edge, resource scope — the matrix in
 * `reporting-signoff.md` §4. Two rows in it are worth reading before editing
 * anything here:
 *
 * **`commercial.read` gates the client export and not the sustainability report.**
 * The client export is money; a supervisor who may not see what the job is worth on
 * screen must not be able to produce a PDF of it, or the whole reason
 * `commercial.read` was carved out of the Supervisor bundle is undone by a button
 * on the Reports tab. The sustainability report contains no money at all, which is
 * why a supervisor can generate one.
 *
 * **`client_reporting` is checked against the generating company** rather than a
 * project owner, exactly as `custom_factors` is: a client-period report spans many
 * projects and "which project owner's plan?" has no answer.
 */

export const projectReportsRouter = Router();
export const reportsRouter = Router();

/** Which plan key each kind is sold under (§43). */
const FEATURE_FOR_KIND: Record<ReportKind, FeatureKey> = {
  SUSTAINABILITY: 'sustainability_reports',
  EVIDENCE_PACK: 'evidence_pack',
  // §29.5 is the client's half of Phase 4's export, so it is sold under the same
  // key rather than a fifth one nobody would know to look for.
  CLIENT_EXPORT: 'exports',
  CLIENT_PERIOD: 'client_reporting',
};

async function assertReportFeature(access: ProjectAccess, kind: ReportKind): Promise<void> {
  const key = FEATURE_FOR_KIND[kind];
  if (!(await hasFeature(access.ownerCompanyId, key))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? `Your plan does not include: ${key}`
        : `This project’s owner does not have ${key} enabled`,
      { feature: key }
    );
  }
}

/**
 * Reports are the **owner's**, not a provider's.
 *
 * `projectAccess` admits an assigned subcontractor, which is right for a mass
 * balance and wrong for a document: a report is the project owner's published
 * claim, and a provider generating one would be publishing on somebody else's
 * behalf. A provider asking gets the same 404 an unrelated company gets.
 */
async function ownerAccess(projectId: string, companyId: string): Promise<ProjectAccess> {
  const access = await projectAccess(projectId, companyId);
  if (!access.isOwner) throw new AppError('NOT_FOUND', 'Project not found');
  return access;
}

// ── The catalog ──────────────────────────────────────────────────────────────

/**
 * GET /v1/projects/:projectId/reports/sections?kind=…
 *
 * What this build can actually produce. A section keyed to a later phase is absent
 * here as well as from the document (packet finding 11), so a screen cannot offer a
 * toggle for a feature that does not exist.
 */
projectReportsRouter.get(
  '/:projectId/reports/sections',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await ownerAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertCapability(ctx, 'report.generate');

    const kinds: ReportKind[] = ['SUSTAINABILITY', 'EVIDENCE_PACK', 'CLIENT_EXPORT'];
    res.json({
      kinds: kinds.map((kind) => ({
        kind,
        feature: FEATURE_FOR_KIND[kind],
        audiences: KIND_AUDIENCES[kind],
        defaults: defaultSections(kind),
        sections: availableSections(kind).map((s) => ({
          key: s.key,
          label: s.label,
          defaultOn: s.defaultOn,
          toggleable: s.toggleable,
        })),
      })),
    });
  })
);

// ── Generate, list, read ─────────────────────────────────────────────────────

projectReportsRouter.post(
  '/:projectId/reports',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await ownerAccess(uuidParam(req, 'projectId'), ctx.companyId);
    const input = generateReportSchema.parse(req.body);
    if (input.kind === 'CLIENT_PERIOD') {
      throw new AppError('VALIDATION', 'A client period report is not scoped to one project');
    }

    await assertReportFeature(access, input.kind);
    await assertCapability(ctx, 'report.generate');
    if (input.kind === 'SUSTAINABILITY') await assertCapability(ctx, 'sustainability.read');
    // The money gate — see the header.
    if (input.kind === 'CLIENT_EXPORT') await assertCapability(ctx, 'commercial.read');

    const result = await generateReport({
      companyId: access.ownerCompanyId,
      actorUserId: ctx.userId,
      projectId: access.projectId,
      kind: input.kind,
      audience: input.audience,
      title: input.title,
      sections: input.sections,
      supersede: input.supersedes,
    });

    // 200 rather than 201 on a reuse: nothing was created, and a client that keys
    // on the status can tell a fresh document from a returned one.
    res.status(result.reused ? 200 : 201).json({
      report: result.report,
      reused: result.reused,
      supersededId: result.supersededId,
    });
  })
);

projectReportsRouter.get(
  '/:projectId/reports',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await ownerAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertCapability(ctx, 'report.generate');

    const rows = await listProjectReports(access.projectId, {
      kind: typeof req.query.kind === 'string' ? (req.query.kind as ReportKind) : undefined,
      includeSuperseded: req.query.includeSuperseded === 'true',
    });
    res.json({ reports: rows.map(toReportView) });
  })
);

projectReportsRouter.get(
  '/:projectId/signoffs',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projectId = uuidParam(req, 'projectId');
    const access = await projectAccess(projectId, ctx.companyId);
    if (!(await hasFeature(access.ownerCompanyId, 'client_signoff'))) {
      // An empty section rather than a refusal, matching how the portal answers a
      // client whose provider has not bought a feature: the caller has done nothing
      // wrong and cannot fix somebody else's plan.
      res.json({ signoffs: [], current: [] });
      return;
    }
    await assertCapability(ctx, 'project.read');

    const [all, current] = await Promise.all([listSignoffs(projectId), currentSignoffs(projectId)]);
    res.json({
      signoffs: all.map(toSignoffView),
      current: current.map(toSignoffView),
    });
  })
);

/**
 * POST /v1/projects/:projectId/signoffs — §34's capture.
 *
 * `evidenceSnapshot` arrives from the device and is stored verbatim (§8). The
 * server adds `signed_at` from its own clock and the content hash; a replayed
 * `clientId` returns the original row rather than a second signature.
 */
projectReportsRouter.post(
  '/:projectId/signoffs',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await ownerAccess(uuidParam(req, 'projectId'), ctx.companyId);
    if (!(await hasFeature(access.ownerCompanyId, 'client_signoff'))) {
      throw new AppError('FORBIDDEN', 'Your plan does not include: client_signoff', {
        feature: 'client_signoff',
      });
    }
    await assertCapability(ctx, 'signoff.capture');

    const input = createSignoffSchema.parse(req.body);
    const project = await queryOne<{ engagement_id: string | null; client_company_id: string | null }>(
      `select engagement_id, client_company_id from projects where id = $1`,
      [access.projectId]
    );

    const result = await captureSignoff({
      projectId: access.projectId,
      companyId: access.ownerCompanyId,
      engagementId: project?.engagement_id ?? null,
      clientCompanyId: project?.client_company_id ?? null,
      actorUserId: ctx.userId,
      input,
      // `req.ip` respects the configured proxy hop count, which is why `trust
      // proxy` is set per deployment rather than defaulted to true.
      signedIp: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });

    res.status(result.replayed ? 200 : 201).json({
      signoff: toSignoffView(result.row),
      replayed: result.replayed,
    });
  })
);

// ── §38.2: the client period roll-up ─────────────────────────────────────────
//
// Registered BEFORE `/:id` deliberately. Express would fall through anyway since
// nothing here collides today, but "the literal path is registered first" is a
// property worth not relying on the fall-through for — a future `GET /:id` variant
// would otherwise swallow it silently, which is the same reasoning app.ts states
// about its router mounting order.

/**
 * POST /v1/reports/client-period
 *
 * The aggregation query and the report kind, shipped now; §38.2's UI is Phase 12.
 * *"Build the data architecture now … so nothing has to be reshaped later."*
 */
reportsRouter.post(
  '/client-period',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    if (!(await hasFeature(ctx.companyId, 'client_reporting'))) {
      throw new AppError('FORBIDDEN', 'Your plan does not include: client_reporting', {
        feature: 'client_reporting',
      });
    }
    await assertCapability(ctx, 'report.generate');
    await assertCapability(ctx, 'sustainability.read');

    const input = generateReportSchema.parse({ ...req.body, kind: 'CLIENT_PERIOD' });
    const period = clientPeriodQuerySchema.parse({
      clientCompanyId: input.clientCompanyId,
      from: input.periodStart,
      to: input.periodEnd,
    });

    const result = await generateReport({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      projectId: null,
      kind: 'CLIENT_PERIOD',
      audience: input.audience,
      title: input.title,
      sections: input.sections,
      clientCompanyId: period.clientCompanyId,
      periodStart: period.from,
      periodEnd: period.to,
    });

    res.status(result.reused ? 200 : 201).json({ report: result.report, reused: result.reused });
  })
);

reportsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'report.generate');
    res.json({ reports: (await listCompanyPeriodReports(ctx.companyId)).map(toReportView) });
  })
);

// ── One report ───────────────────────────────────────────────────────────────

async function readableReport(id: string, companyId: string): Promise<ReportRow> {
  const row = await findReport(id);
  // A report belonging to another company is indistinguishable from one that does
  // not exist.
  if (!row || row.company_id !== companyId) throw new AppError('NOT_FOUND', 'Report not found');
  return row;
}

reportsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'report.generate');
    const row = await readableReport(uuidParam(req, 'id'), ctx.companyId);
    res.json(await withSealCheck(() => reportDetail(row)));
  })
);

reportsRouter.get(
  '/:id/download.pdf',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'report.generate');
    const row = await readableReport(uuidParam(req, 'id'), ctx.companyId);
    const bytes = await withSealCheck(() => renderStoredReport(row));

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'project.exported',
      entityType: 'GENERATED_REPORT',
      entityId: row.id,
      changes: { kind: row.kind, audience: row.audience, bytes: bytes.byteLength },
      description: `Report "${row.title}" downloaded`,
    });

    sendPdf(res, bytes, reportFilename(row));
  })
);

/**
 * PATCH /v1/reports/:id/visibility — the disclosure (§29.4).
 *
 * The one operation in this phase that hands a document to somebody outside the
 * tenancy, so it is audited on both edges and the database refuses it outright on
 * an INTERNAL snapshot (`0043`'s `generated_reports_disclosure`).
 */
reportsRouter.patch(
  '/:id/visibility',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'report.generate');
    const row = await readableReport(uuidParam(req, 'id'), ctx.companyId);
    const { clientVisible } = setReportVisibilitySchema.parse(req.body);

    if (clientVisible && row.audience !== 'CLIENT') {
      throw new AppError(
        'VALIDATION',
        'This report was assembled for internal readers and cannot be shared with the client. Generate a client copy instead.',
        { audience: row.audience }
      );
    }
    if (row.status !== 'GENERATED') {
      throw new AppError('VALIDATION', `A ${row.status.toLowerCase()} report cannot be shared`);
    }

    await withTransaction(async (client) => {
      const updated = await setClientVisible(row.id, clientVisible, client);
      if (!updated) throw new AppError('CONFLICT', 'This report is no longer current');
      if (clientVisible && row.client_company_id) {
        await enqueueOutboxEvent(
          {
            topic: 'report.disclosed',
            aggregateType: 'GENERATED_REPORT',
            aggregateId: row.id,
            companyId: ctx.companyId,
            payload: {
              reportId: row.id,
              projectId: row.project_id,
              // Followed forward through the placeholder tombstone. The row names
              // the identity the document was addressed to, which may be a
              // placeholder with no members; a notice sent there reaches nobody,
              // and it does so silently.
              clientCompanyId: await currentClientCompanyId(row.client_company_id),
              engagementId: null,
              title: row.title,
              kind: row.kind,
            },
            // Keyed on the report rather than on the act, so re-sharing a document
            // that was un-shared and shared again does not re-notify a client about
            // a document they already have.
            idempotencyKey: `report.disclosed:${row.id}`,
          },
          client
        );
      }
    });

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      // Two actions rather than one with a boolean: "who stopped sharing this" is
      // a question somebody asks, and it should not need a payload to answer.
      action: clientVisible ? 'report.disclosed' : 'report.undisclosed',
      entityType: 'GENERATED_REPORT',
      entityId: row.id,
      changes: { kind: row.kind, title: row.title },
      description: clientVisible
        ? `Report "${row.title}" shared with the client`
        : `Report "${row.title}" withdrawn from the client`,
      visibleToClient: true,
    });

    const fresh = await findReport(row.id);
    res.json({ report: toReportView(fresh!) });
  })
);

reportsRouter.post(
  '/:id/void',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'report.generate');
    const row = await readableReport(uuidParam(req, 'id'), ctx.companyId);
    const { reason } = voidReportSchema.parse(req.body);

    const updated = await voidReport(row.id, reason);
    if (!updated) {
      throw new AppError('VALIDATION', `A ${row.status.toLowerCase()} report cannot be voided`);
    }

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'report.voided',
      entityType: 'GENERATED_REPORT',
      entityId: row.id,
      changes: { reason, wasShared: row.client_visible },
      description: `Report "${row.title}" voided: ${reason}`,
      // The client is told when a document they were given is withdrawn. Voiding
      // frequently happens *because* it was disclosed by mistake.
      visibleToClient: row.client_visible,
    });

    const fresh = await findReport(row.id);
    res.json({ report: toReportView(fresh!) });
  })
);

// ── Shared ───────────────────────────────────────────────────────────────────

export function sendPdf(
  res: { setHeader: (k: string, v: string) => void; status: (n: number) => { end: (b: Buffer) => void } },
  bytes: Buffer,
  filename: string
): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(bytes.byteLength));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end(bytes);
}

/**
 * Turn a broken seal into a refusal a person can act on.
 *
 * §9's rule, and the only honest response: a snapshot whose hash does not verify is
 * a document whose stored contents have changed since they were sealed. It is
 * **never rendered anyway with a warning** — a seal that still prints the document
 * is a seal that does nothing.
 */
export async function withSealCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SealMismatch) {
      throw new AppError(
        'CONFLICT',
        'This report’s stored contents do not match its seal and cannot be produced. Generate a new report; the original row is preserved for investigation.',
        { expected: err.expected, actual: err.actual }
      );
    }
    throw err;
  }
}
