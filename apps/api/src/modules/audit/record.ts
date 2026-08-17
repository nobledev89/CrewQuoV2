import type { AuditAction, AuditEntityType } from '@crewquo/shared';
import type { Queryable } from '../../db';
import { resolveEntitlements } from '../entitlements/cache';
import { insertAuditLog } from './repo';
import { auditExpiry } from './retention';

/**
 * The single write path into the audit trail (CREWQUO_V2_PLAN.md §3.6).
 *
 * `companyId` is whose activity this is — the actor's active company — and
 * `visibleToClient` decides whether the company that hired them may see the row
 * in the portal. Descriptions are written for that audience: they never name a
 * counterparty company, so a visible row can't leak who a subcontractor is.
 *
 * Recording never fails the request that triggered it: a broken trail is worth
 * less than a broken approval. Failures are logged loudly instead. Callers still
 * `await` so ordering stays deterministic and dev logs line up with the request.
 */
export interface AuditEvent {
  companyId: string;
  actorUserId?: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  description?: string | null;
  visibleToClient?: boolean;
}

export async function recordAudit(event: AuditEvent, runner?: Queryable): Promise<void> {
  try {
    const ent = await resolveEntitlements(event.companyId);
    const expiry = auditExpiry(ent.limits.audit_retention_days);
    if (expiry.kind === 'skip') return; // plan keeps no trail — nothing to write

    await insertAuditLog(
      {
        companyId: event.companyId,
        actorUserId: event.actorUserId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        changes: event.changes ?? null,
        description: event.description ?? null,
        visibleToClient: event.visibleToClient ?? false,
        expiry,
      },
      runner
    );
  } catch (err) {
    console.error(`[audit] failed to record ${event.action}:`, err);
  }
}
