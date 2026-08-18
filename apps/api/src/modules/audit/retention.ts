/**
 * Retention policy for audit rows (CREWQUO_V2_PLAN.md §3.6, §5B).
 *
 * Postgres has no row TTL, so every audit row is stamped with an `expires_at`
 * at write time and a nightly job deletes what has passed. The window comes
 * from the company's `audit_retention_days` limit, which the super admin edits
 * per plan — so this is the one place that translates that number into a
 * storage decision. Pure function, no I/O, so the mapping is unit-tested.
 */
export type AuditExpiry =
  /** Retention is 0 (or unconfigured): purge every row for the company. */
  | { kind: 'none' }
  /** The plan grants unlimited retention: stamped 'infinity', never purged. */
  | { kind: 'infinity' }
  | { kind: 'days'; days: number };

/**
 * `null` means unlimited (the entitlements convention). `undefined` means the
 * plan has no `audit_retention_days` row at all — a misconfiguration we treat as
 * "no retention" rather than "keep forever", so it fails cheap and visibly.
 */
export function auditExpiry(retentionDays: number | null | undefined): AuditExpiry {
  if (retentionDays === null) return { kind: 'infinity' };
  if (retentionDays === undefined || retentionDays <= 0) return { kind: 'none' };
  return { kind: 'days', days: Math.floor(retentionDays) };
}
