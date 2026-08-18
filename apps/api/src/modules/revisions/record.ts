import type { Queryable } from '../../db';
import { query, queryOne } from '../../db';

/**
 * `record_revisions` — the *what changed* trail (CREWQUO_V2_PLAN.md §36).
 *
 * `audit_logs` already records **that** something happened, on every mutation.
 * §36 adds before/after values for the records where the numbers themselves are
 * the evidence: weights, destinations, emission factors, **approved time and
 * rates**, variations, sign-off and closed diary entries. This domain — commercial
 * agreements — is the first to reach that list, which is why the table lands here
 * rather than in a later phase.
 *
 * Two rules are copied deliberately from `recordAudit`:
 *
 *  1. **Writing never throws into the caller.** §36 is explicit: *"revision writes
 *     never throw into the caller — a broken trail must not fail an approval"*. A
 *     failure is logged loudly and the business transaction stands. Callers still
 *     `await` so ordering stays deterministic.
 *  2. **`companyId` is whose record changed**, not whose session did it. A provider
 *     submitting a schedule changes a record the provider owns; the approval that
 *     follows changes rate cards the hiring company owns. Recording the actor's
 *     company on both would make the hiring company's trail claim it authored the
 *     proposal.
 *
 * Unlike audit rows, revisions are **not** subject to `audit_retention_days` here.
 * §36 carves out revisions attached to a generated report; the same reasoning
 * applies to the ones backing money already paid, and the operating-model packet
 * for this domain states that as the retention rule.
 */

export interface RevisionEvent {
  /** The company that owns the changed record. */
  companyId: string;
  /** e.g. 'rate_proposal', 'rate_card', 'engagement_terms'. Free text by design (§36). */
  entityType: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /**
   * Required by §36 on the starred records. The caller decides, because "starred"
   * is a property of the record class, not of this function.
   */
  reason?: string | null;
  changedByUserId?: string | null;
}

/**
 * The fields whose values actually differ between `before` and `after`.
 *
 * Computed here rather than passed in so a caller cannot describe a change it did
 * not make. Compared by JSON value, so `null` → `null` is not a change and
 * `5000` → `5000` is not one either, however the caller assembled the objects.
 */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): string[] {
  if (!before) return after ? Object.keys(after).sort() : [];
  if (!after) return Object.keys(before).sort();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

/**
 * Append a revision. `revision` is allocated as `max + 1` for the entity inside
 * the same statement, so two concurrent writers cannot both claim the same number
 * — the `unique (entity_type, entity_id, revision)` index would reject the second,
 * which is the correct outcome and is caught by the never-throw wrapper.
 */
export async function recordRevision(
  event: RevisionEvent,
  runner?: Queryable
): Promise<void> {
  try {
    const fields = changedFields(event.before, event.after);
    await query(
      `insert into record_revisions
         (company_id, entity_type, entity_id, revision, action,
          before, after, changed_fields, reason, changed_by_user_id)
       select $1, $2, $3,
              coalesce(max(r.revision), 0) + 1,
              $4, $5::jsonb, $6::jsonb, $7::text[], $8, $9
         from record_revisions r
        where r.entity_type = $2 and r.entity_id = $3`,
      [
        event.companyId,
        event.entityType,
        event.entityId,
        event.action,
        event.before === undefined || event.before === null
          ? null
          : JSON.stringify(event.before),
        event.after === undefined || event.after === null ? null : JSON.stringify(event.after),
        fields,
        event.reason ?? null,
        event.changedByUserId ?? null,
      ],
      runner
    );
  } catch (err) {
    console.error(
      `[revisions] failed to record ${event.action} on ${event.entityType}/${event.entityId}:`,
      err
    );
  }
}

export interface RevisionRow {
  revision: number;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  reason: string | null;
  changedByUserId: string | null;
  changedByName: string | null;
  changedAt: string;
}

/** One record's history, newest first. Scoped by company — a revision is not public. */
export async function listRevisions(args: {
  companyId: string;
  entityType: string;
  entityId: string;
  limit?: number;
}): Promise<RevisionRow[]> {
  const rows = await query<{
    revision: number;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    changed_fields: string[];
    reason: string | null;
    changed_by_user_id: string | null;
    changed_by_name: string | null;
    changed_at: Date;
  }>(
    `select r.revision, r.action, r.before, r.after, r.changed_fields,
            r.reason, r.changed_by_user_id, u.name as changed_by_name, r.changed_at
       from record_revisions r
       left join users u on u.id = r.changed_by_user_id
      where r.company_id = $1 and r.entity_type = $2 and r.entity_id = $3
      order by r.revision desc
      limit $4`,
    [args.companyId, args.entityType, args.entityId, args.limit ?? 50]
  );
  return rows.map((row) => ({
    revision: row.revision,
    action: row.action,
    before: row.before,
    after: row.after,
    changedFields: row.changed_fields,
    reason: row.reason,
    changedByUserId: row.changed_by_user_id,
    changedByName: row.changed_by_name,
    changedAt: row.changed_at.toISOString(),
  }));
}

/** How many revisions a record has — the "amended N times" figure §36 asks for. */
export async function countRevisions(entityType: string, entityId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from record_revisions
      where entity_type = $1 and entity_id = $2`,
    [entityType, entityId]
  );
  return row?.n ?? 0;
}
