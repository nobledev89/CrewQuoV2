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
  /**
   * Phase 7.4 (§43), and gated against the project owner exactly as
   * `project_evidence` is. A Crew-plan subcontractor must be able to file its
   * insurance and its waste transfer notes on a hiring company's job — a
   * subcontractor who cannot produce a WTN cannot legally move the waste.
   */
  'project_documents',
  /**
   * Phase 7.5 (§43), gated against the project owner exactly as the other two
   * are. A subcontractor keeps its own diary on a hiring company's job — §23's
   * unique key is `(project_id, company_id, entry_date)` precisely so it can — and
   * consumes the owner's entitlement doing it. **Reading a counterparty's diary is
   * the one place the packet's §4 checks the key on the *reader* instead:** the
   * hiring company is being shown a record it did not author, which is a feature
   * of its own plan rather than of the plan that produced the record.
   */
  'site_diary',
  /**
   * Phase 8 (§43), and gated against the **project owner** exactly as the three
   * Phase 7 keys above are. This is the same rule with a different noun rather
   * than a new decision — `assets-materials.md` §13.3 records it as precedent —
   * and the reasoning transfers word for word: a subcontractor who cannot record
   * what it removed cannot do a clearance job, and the Crew plan exists so a
   * subcontractor can work for a paying customer for nothing.
   *
   * The consequence, said plainly because §43 puts asset tracking at "—" on
   * Crew: a Crew company running *its own* project cannot record assets at all.
   * That is the intended shape of the free tier.
   */
  'asset_tracking',
  /**
   * Phase 9 (§43). **Two of these three follow the 2026-09-01 rule and one
   * deliberately does not** — `sustainability.md` §0 finding 9, and the first noun
   * that rule does not fit.
   *
   * `sustainability` and `carbon_engine` are read over a **project**, so they are
   * checked against `projects.owner_company_id` exactly as `asset_tracking` and the
   * three Phase 7 keys are. The project owner is who publishes the figure, quotes
   * it to a client and answers for it.
   *
   * `custom_factors` is **not project-scoped at all**, and transferring the rule by
   * analogy would have been wrong. A factor set is company reference data, imported
   * once and used across every project that company owns; there is no project to
   * find an owner of. It is checked against the **importing company's own plan**,
   * or a subcontractor importing its own factors while working on somebody else's
   * job would consume the project owner's allowance for data the project owner
   * cannot even see.
   *
   * The split matters because `carbon_engine` gates the *calculation* while
   * `sustainability` gates the *reading*: a company can hold the section and its
   * mass balance without buying the engine that multiplies those masses by factors,
   * which is what §43's table describes when it lists them on the same tiers but as
   * separate keys.
   */
  'sustainability',
  'carbon_engine',
  'custom_factors',
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
  /**
   * Phase 9 (§43). **Checked against the importing company, never against a project
   * owner** — the other half of `custom_factors` above, and the only limit in this
   * catalog whose subject is reference data rather than work.
   *
   * Enforced at the top of the importer, **before a byte is parsed** (packet §10),
   * because the importer's cost is per row rather than per request: one upload is
   * the most expensive authenticated operation in the product, and a ceiling
   * checked after parsing is a ceiling that has already been paid for.
   *
   * Like `storage_gb`, **no plan sets a value and an unset limit is silently
   * unlimited.** §43 proposes figures for storage and proposes none for factor sets,
   * so choosing one here would be a pricing judgement made by a code change.
   */
  'factor_sets',
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
