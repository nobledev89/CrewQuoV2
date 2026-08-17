import { Router } from 'express';
import { listAuditLogsQuerySchema, updateAuditSettingsSchema } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import {
  canManageAuditSettings,
  canReadCounterpartyAudit,
  isEngagementParticipant,
  type EngagementEdge,
} from '../../authorization/policies';
import { findEngagementEdge } from '../engagements/repo';
import { hasFeature } from '../entitlements/guards';
import {
  getAuditSettings,
  listClientVisibleAuditLogs,
  listOwnAuditLogs,
  upsertAuditSettings,
} from './repo';
import { recordAudit } from './record';

/**
 * Audit trail reads & per-engagement portal settings (CREWQUO_V2_PLAN.md §3.6, §7).
 * Writes happen through `recordAudit` at the mutation sites — there is no endpoint
 * that appends to the trail.
 */

function edgeOf(row: { client_company_id: string; provider_company_id: string }): EngagementEdge {
  return { clientCompanyId: row.client_company_id, providerCompanyId: row.provider_company_id };
}

export const auditLogsRouter = Router();

/**
 * GET /v1/audit-logs — the active company's own trail, or (with `engagementId`)
 * the client-visible slice of the provider's trail on that edge.
 */
auditLogsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const q = listAuditLogsQuerySchema.parse(req.query);
    const filter = {
      entityType: q.entityType,
      entityId: q.entityId,
      limit: q.limit,
      before: q.before,
    };

    let data;
    if (q.engagementId) {
      const row = await findEngagementEdge(q.engagementId);
      if (!row) throw new AppError('NOT_FOUND', 'Engagement not found');
      const edge = edgeOf(row);
      // Not an endpoint at all: 404 rather than 403, so the edge's existence stays private.
      if (!isEngagementParticipant(ctx.companyId, edge)) {
        throw new AppError('NOT_FOUND', 'Engagement not found');
      }
      const settings = await getAuditSettings(q.engagementId);
      const allowed = canReadCounterpartyAudit({
        companyId: ctx.companyId,
        edge,
        providerHasAuditVisibility: await hasFeature(edge.providerCompanyId, 'audit_visibility'),
        showAuditTrail: settings.showAuditTrail,
      });
      if (!allowed) {
        throw new AppError('FORBIDDEN', 'The audit trail is not shared on this engagement');
      }
      data = await listClientVisibleAuditLogs(edge.providerCompanyId, filter);
    } else {
      if (!(await hasFeature(ctx.companyId, 'audit_visibility'))) {
        throw new AppError('FORBIDDEN', 'Your plan does not include: audit_visibility', {
          feature: 'audit_visibility',
        });
      }
      data = await listOwnAuditLogs(ctx.companyId, filter);
    }

    // Keyset cursor: only offer one when the page came back full.
    const nextBefore = data.length === q.limit ? (data[data.length - 1]?.createdAt ?? null) : null;
    res.json({ data, nextBefore });
  })
);

// ── /v1/audit-settings ────────────────────────────────────────────────────────

export const auditSettingsRouter = Router();

/** Either side of the edge may read the settings; only the provider side sets them. */
auditSettingsRouter.get(
  '/:engagementId',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const engagementId = param(req, 'engagementId');
    const row = await findEngagementEdge(engagementId);
    if (!row || !isEngagementParticipant(ctx.companyId, edgeOf(row))) {
      throw new AppError('NOT_FOUND', 'Engagement not found');
    }
    res.json({ settings: await getAuditSettings(engagementId) });
  })
);

auditSettingsRouter.put(
  '/:engagementId',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const engagementId = param(req, 'engagementId');
    const row = await findEngagementEdge(engagementId);
    if (!row || !isEngagementParticipant(ctx.companyId, edgeOf(row))) {
      throw new AppError('NOT_FOUND', 'Engagement not found');
    }
    if (!canManageAuditSettings(ctx.companyId, ctx.role, edgeOf(row))) {
      throw new AppError('FORBIDDEN', 'Only the provider side may change portal settings');
    }
    const patch = updateAuditSettingsSchema.parse(req.body ?? {});
    const settings = await upsertAuditSettings(engagementId, patch);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'audit_settings.updated',
      entityType: 'ENGAGEMENT',
      entityId: engagementId,
      changes: { ...patch },
      description: 'Portal settings updated',
    });
    res.json({ settings });
  })
);
