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
  used: z.number().int(),
});
export type LimitUsage = z.infer<typeof limitUsageSchema>;

/** GET /v1/entitlements — resolved entitlements plus live usage. */
export const entitlementsResponseSchema = entitlementsSchema.extend({
  usage: z.array(limitUsageSchema),
});
export type EntitlementsResponse = z.infer<typeof entitlementsResponseSchema>;
