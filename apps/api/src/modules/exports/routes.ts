import type { RequestHandler } from 'express';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { requireFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { findUserById } from '../users/repo';
import { getProject } from '../projects/repo';
import { buildProjectExportModel } from './data';
import { exportFilename, type ExportFormat } from './model';
import { renderProjectPdf } from './pdf';
import { renderProjectXlsx } from './xlsx';

/**
 * Project exports (CREWQUO_V2_PLAN.md §7): `GET /v1/projects/:id/export.pdf` and
 * `.xlsx`, gated on the `exports` feature.
 *
 * Owner side only — `getProject` is scoped to the active company, so a provider
 * or a portal client asking for someone else's project gets a 404 rather than a
 * file. The client-facing export is Phase 10 (§29), rendered from a stored report
 * snapshot instead of a live recalculation.
 *
 * An export is a disclosure event, so it is audited. The row is internal: which
 * files an owner pulled off its own project is not something the client sees.
 */

const CONTENT_TYPE: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function exportHandler(format: ExportFormat): RequestHandler {
  return asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const project = await getProject(ctx.companyId, uuidParam(req, 'id'));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');

    const user = await findUserById(ctx.userId);
    const generatedAt = new Date().toISOString();
    const model = await buildProjectExportModel({
      project,
      generatedByName: user?.name ?? 'Unknown user',
      generatedAt,
    });

    const body = format === 'pdf' ? renderProjectPdf(model) : await renderProjectXlsx(model);
    const filename = exportFilename(project.name, project.id, format);

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'project.exported',
      entityType: 'PROJECT',
      entityId: project.id,
      changes: { format, filename, bytes: body.byteLength },
      description: `Project "${project.name}" exported as ${format.toUpperCase()}`,
    });

    res.setHeader('Content-Type', CONTENT_TYPE[format]);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(body.byteLength));
    // A regenerated export reflects data as of the request; never let a proxy
    // hand back yesterday's figures.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(body);
  });
}

/**
 * Mounted onto the projects router (the paths are `/v1/projects/:id/export.*`).
 * Kept here so the export module owns its own wiring.
 */
export function registerExportRoutes(router: {
  get: (path: string, ...handlers: RequestHandler[]) => unknown;
}): void {
  const gate = requireFeature('exports');
  router.get('/:id/export.pdf', gate, exportHandler('pdf'));
  router.get('/:id/export.xlsx', gate, exportHandler('xlsx'));
}
