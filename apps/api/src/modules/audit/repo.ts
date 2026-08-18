import type { AuditLogView, AuditSettings, UpdateAuditSettings } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import type { AuditExpiry } from './retention';

/**
 * Audit-trail & portal-settings persistence (CREWQUO_V2_PLAN.md §3.6).
 * `audit_logs` is append-only: nothing here updates or deletes a row except
 * `deleteExpiredAuditLogs`, the retention purge.
 */

interface AuditLogRow {
  id: string;
  company_id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  changes: Record<string, unknown> | null;
  description: string | null;
  visible_to_client: boolean;
  created_at: Date;
}

function toAuditLogView(r: AuditLogRow): AuditLogView {
  return {
    id: r.id,
    companyId: r.company_id,
    actorUserId: r.actor_user_id,
    actorName: r.actor_name,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    changes: r.changes,
    description: r.description,
    visibleToClient: r.visible_to_client,
    createdAt: r.created_at.toISOString(),
  };
}

const AUDIT_SELECT = `
  select a.id, a.company_id, a.actor_user_id, u.name as actor_name, a.action,
         a.entity_type, a.entity_id, a.changes, a.description, a.visible_to_client,
         a.created_at
    from audit_logs a
    left join users u on u.id = a.actor_user_id`;

export interface InsertAuditLog {
  companyId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: Record<string, unknown> | null;
  description: string | null;
  visibleToClient: boolean;
}

export async function insertAuditLog(input: InsertAuditLog, runner?: Queryable): Promise<void> {
  const params: unknown[] = [
    input.companyId,
    input.actorUserId,
    input.action,
    input.entityType,
    input.entityId,
    input.changes ? JSON.stringify(input.changes) : null,
    input.description,
    input.visibleToClient,
  ];

  await query(
    `insert into audit_logs (company_id, actor_user_id, action, entity_type, entity_id,
                             changes, description, visible_to_client, expires_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'infinity'::timestamptz)`,
    params,
    runner
  );
}

export interface AuditLogFilter {
  entityType?: string;
  entityId?: string;
  limit: number;
  before?: string;
}

/** The active company's own trail. */
export function listOwnAuditLogs(
  companyId: string,
  filter: AuditLogFilter
): Promise<AuditLogView[]> {
  return runAuditQuery(['a.company_id = $1'], [companyId], filter);
}

/**
 * The counterparty trail a client sees in the portal: the provider's rows, and
 * only those the writer flagged client-visible. The caller must already have
 * checked `canReadCounterpartyAudit`.
 */
export function listClientVisibleAuditLogs(
  providerCompanyId: string,
  filter: AuditLogFilter
): Promise<AuditLogView[]> {
  return runAuditQuery(
    ['a.company_id = $1', 'a.visible_to_client = true'],
    [providerCompanyId],
    filter
  );
}

async function runAuditQuery(
  clauses: string[],
  params: unknown[],
  filter: AuditLogFilter
): Promise<AuditLogView[]> {
  const where = [...clauses];
  const args = [...params];
  if (filter.entityType) {
    args.push(filter.entityType);
    where.push(`a.entity_type = $${args.length}`);
  }
  if (filter.entityId) {
    args.push(filter.entityId);
    where.push(`a.entity_id = $${args.length}`);
  }
  if (filter.before) {
    args.push(filter.before);
    where.push(`a.created_at < $${args.length}::timestamptz`);
  }
  args.push(filter.limit);
  const rows = await query<AuditLogRow>(
    `${AUDIT_SELECT} where ${where.join(' and ')}
      order by a.created_at desc limit $${args.length}`,
    args
  );
  return rows.map(toAuditLogView);
}

/** Companies currently holding audit rows, used by the policy-driven purge. */
export async function listAuditCompanyIds(): Promise<string[]> {
  const rows = await query<{ company_id: string }>('select distinct company_id from audit_logs');
  return rows.map((row) => row.company_id);
}

/** Retention purge — the only delete path for audit_logs. Returns rows removed. */
export async function deleteExpiredAuditLogsForCompany(
  companyId: string,
  expiry: AuditExpiry
): Promise<number> {
  if (expiry.kind === 'infinity') return 0;
  const predicate = expiry.kind === 'none'
    ? 'true'
    : `created_at < now() - ($2 || ' days')::interval`;
  const params = expiry.kind === 'days' ? [companyId, String(expiry.days)] : [companyId];
  const rows = await query<{ id: string }>(
    `delete from audit_logs where company_id = $1 and ${predicate} returning id`,
    params
  );
  return rows.length;
}

// ── Portal settings ───────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = { clientCanComment: true, showAuditTrail: false };

interface AuditSettingsRow {
  engagement_id: string;
  client_can_comment: boolean;
  show_audit_trail: boolean;
}

/** Settings for an engagement, falling back to defaults when no row exists yet. */
export async function getAuditSettings(engagementId: string): Promise<AuditSettings> {
  const row = await queryOne<AuditSettingsRow>(
    `select engagement_id, client_can_comment, show_audit_trail
       from audit_settings where engagement_id = $1`,
    [engagementId]
  );
  return row
    ? {
        engagementId: row.engagement_id,
        clientCanComment: row.client_can_comment,
        showAuditTrail: row.show_audit_trail,
      }
    : { engagementId, ...DEFAULT_SETTINGS };
}

export async function upsertAuditSettings(
  engagementId: string,
  patch: UpdateAuditSettings
): Promise<AuditSettings> {
  const row = await queryOne<AuditSettingsRow>(
    // The ::boolean casts are load-bearing: Postgres cannot infer a parameter's
    // type through coalesce() and would otherwise treat these as text.
    `insert into audit_settings (engagement_id, client_can_comment, show_audit_trail)
     values ($1, coalesce($2::boolean, $4::boolean), coalesce($3::boolean, $5::boolean))
     on conflict (engagement_id) do update set
       client_can_comment = coalesce($2::boolean, audit_settings.client_can_comment),
       show_audit_trail   = coalesce($3::boolean, audit_settings.show_audit_trail),
       updated_at = now()
     returning engagement_id, client_can_comment, show_audit_trail`,
    [
      engagementId,
      patch.clientCanComment ?? null,
      patch.showAuditTrail ?? null,
      DEFAULT_SETTINGS.clientCanComment,
      DEFAULT_SETTINGS.showAuditTrail,
    ]
  );
  return {
    engagementId: row!.engagement_id,
    clientCanComment: row!.client_can_comment,
    showAuditTrail: row!.show_audit_trail,
  };
}
