import { Router } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { isOwnerOrAdmin } from '../../authorization/policies';
import { recordAudit } from '../audit/record';
import { buildExport, exportFilename } from './build';
import { recordDataExport } from './repo';
import type { ExportScope } from './queries';

/**
 * Data export (`docs/operating-model/observability-data-lifecycle.md` §14 step 5).
 *
 * `GET /v1/me/export` — a person's own data. `GET /v1/companies/:id/export` — a company's
 * commercial record, for its owners and admins.
 *
 * **No entitlement check on either, and that is the owner's decision rather than an
 * omission.** §13.2 was answered "free for everyone, including the free `crew` plan": a
 * person's own data is a legal obligation and charging for an obligation makes it an
 * upsell, and a company export somebody must upgrade to get is a hostage rather than a
 * feature. So there is no `requireFeature` here, no plan key to register, and nothing to
 * get wrong. If a future edit adds a gate, it is reversing a decision and should say so.
 *
 * **Export ships before deletion, in that order and never the reverse** (§14 step 5).
 * Deletion first would mean the first person to use the erasure path had no way to take
 * their records with them, and it is the one mistake here that cannot be repaired
 * afterwards.
 */
export const meExportRouter = Router();
export const companyExportRouter = Router();

async function respond(
  res: Parameters<Parameters<typeof asyncHandler>[0]>[1],
  scope: ExportScope,
  subjectId: string,
  requestedByUserId: string
): Promise<void> {
  const built = await buildExport(scope, subjectId);
  await recordDataExport({
    scope,
    subjectUserId: scope === 'PERSONAL' ? subjectId : null,
    subjectCompanyId: scope === 'COMPANY' ? subjectId : null,
    requestedByUserId,
    tableCount: built.tableCount,
    rowCount: built.rowCount,
    byteSize: built.zip.byteLength,
  });

  const filename = exportFilename(scope, built.manifest.generatedAt);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Never cached, by anything. A bundle of a whole tenant's commercial history sitting in
  // a shared proxy or a browser's disk cache is the one place this design refuses to put
  // it — the whole reason it is generated per request under authorization rather than
  // parked behind a link (see 0021's comment).
  res.setHeader('Cache-Control', 'no-store, private');
  res.send(built.zip);
}

meExportRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    // `getCtx`, not `getCompanyCtx`: a personal export needs no active company, and
    // requiring one would refuse the export to somebody whose only membership was just
    // removed — which is exactly when a person asks for their data.
    const ctx = getCtx(req);
    await respond(res, 'PERSONAL', ctx.userId, ctx.userId);
  })
);

companyExportRouter.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    // 404 rather than 403 for the wrong company, matching `GET /v1/companies/:id`:
    // whether a company id exists is not this caller's business.
    if (id !== ctx.companyId) throw new AppError('NOT_FOUND', 'Company not found');
    if (!isOwnerOrAdmin(ctx.role)) {
      throw new AppError('FORBIDDEN', 'Only an owner or admin can export company data');
    }

    await respond(res, 'COMPANY', id, ctx.userId);

    /*
     * Audited, and only the company scope is.
     *
     * A company export is a disclosure of the company's record by one of its members, and
     * the other owners are entitled to know it happened — the same reasoning that audits a
     * project export. A *personal* export has no company whose audit trail it belongs in,
     * and writing it into whichever company happened to be active would file a person's
     * subject-access request as an event in their employer's log. It is recorded in
     * `data_exports` instead.
     */
    await recordAudit({
      companyId: id,
      actorUserId: ctx.userId,
      action: 'company.exported',
      entityType: 'COMPANY',
      entityId: id,
      changes: { scope: 'COMPANY' },
      description: 'Company data exported',
    });
  })
);
