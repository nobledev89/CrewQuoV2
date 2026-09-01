import { z } from 'zod';

/**
 * Entitlements catalog — the feature and limit keys the code enforces
 * (CREWQUO_V2_PLAN.md §5B). Adding a *new* key requires a one-line enforcement
 * hook; after that plans are fully admin-driven data. Keep in sync with the
 * seed (`infra/seed/index.ts`) and the DB `features`/`limits` tables.
 */

export const FEATURE_KEYS = [
  'rate_cards',
  'holiday_rates',
  'exports',
  'client_portal',
  'client_portal_notes',
  /**
   * Phase 7 (§43). The record, not the capture.
   *
   * **Checked against the project owner, never against the uploader** (owner
   * decision, 2026-09-01). A Crew-plan subcontractor may always photograph a
   * floor on somebody else's project and consumes that owner's entitlement doing
   * it; its own projects need this key on its own plan. Gating the uploader would
   * make a free subcontractor useless to a paying customer, which is the failure
   * the Crew plan was invented to prevent.
   */
  'project_evidence',
  'invoicing',
  'audit_visibility',
  'api_access',
  'sso',
  'white_label',
] as const;
export const featureKeySchema = z.enum(FEATURE_KEYS);
export type FeatureKey = z.infer<typeof featureKeySchema>;

export const LIMIT_KEYS = [
  'active_subcontractors',
  'internal_seats',
  'clients',
  'audit_retention_days',
  /**
   * Phase 7 (§43). Two limits with shapes nothing here had before, both recorded
   * in `docs/operating-model/project-evidence.md` §7.
   *
   * `storage_gb` is measured in **gigabytes, not objects**, so its `projected`
   * argument to `withinLimit` is a fraction rather than a count — see
   * `bytesToGb`. It is charged to the **project-owning** company (owner decision,
   * 2026-09-01), not the uploader, or a free subcontractor's allowance would pay
   * for a paying customer's evidence pack.
   *
   * `evidence_uploads_per_month` is the product's first **windowed** meter. Every
   * other key here is a current-state count with no clock in it; a month needs a
   * start, and the start is the company's own IANA zone rather than the server's
   * (`time.md`).
   */
  'storage_gb',
  'evidence_uploads_per_month',
] as const;
export const limitKeySchema = z.enum(LIMIT_KEYS);
export type LimitKey = z.infer<typeof limitKeySchema>;

/**
 * The resolved entitlements for a company: the set of enabled features and each
 * limit's value (`null` = unlimited). Produced by `resolveEntitlements` in the API.
 */
export const entitlementsSchema = z.object({
  planId: z.string(),
  operatesDownstream: z.boolean(),
  features: z.array(featureKeySchema),
  limits: z.record(limitKeySchema, z.number().int().nullable()),
});
export type Entitlements = z.infer<typeof entitlementsSchema>;

/** A single limit with its current usage — surfaced in the UI as "23 / 30". */
export const limitUsageSchema = z.object({
  key: limitKeySchema,
  value: z.number().int().nullable(), // null = unlimited
  /**
   * Not an integer since Phase 7. `storage_gb` is measured in gigabytes, so a
   * company holding 340 MB uses 0.33 of its allowance — and rounding that to an
   * integer would report every company under a gigabyte as using nothing at all,
   * which is the reading that makes a limit screen useless exactly when somebody
   * is trying to understand it. The *limit* stays an integer; the usage does not.
   */
  used: z.number(),
});
export type LimitUsage = z.infer<typeof limitUsageSchema>;

/** GET /v1/entitlements — resolved entitlements plus live usage. */
export const entitlementsResponseSchema = entitlementsSchema.extend({
  usage: z.array(limitUsageSchema),
});
export type EntitlementsResponse = z.infer<typeof entitlementsResponseSchema>;
