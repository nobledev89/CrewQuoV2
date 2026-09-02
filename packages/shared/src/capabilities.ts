import { z } from 'zod';
import { membershipRoleSchema, type MembershipRole } from './enums';

/**
 * Capabilities — the job-function layer that sits on top of the four membership
 * roles (CREWQUO_V2_PLAN.md §37), and step 0 of the Phase 7 build order in
 * `docs/operating-model/project-evidence.md` §14.
 *
 * **The roles do not change.** `OWNER`/`ADMIN`/`MANAGER`/`MEMBER` keep their
 * meaning and every existing check keeps working. What this adds is the
 * distinction a role cannot express: a Supervisor who writes the site diary
 * without seeing margin, and a Finance user who sees margin without being able
 * to close a day.
 *
 * The division of labour matches the entitlements engine deliberately, because
 * it is the same shape and it already works. **The keys live in code** — like
 * `FEATURE_KEYS`, adding one is a deliberate edit and a one-line enforcement
 * hook. **The membership lives in the database** — like `plan_features`, so a
 * company can build its own bundles without a deploy. This module owns the keys
 * and the pure resolution algebra, and knows nothing about Postgres.
 */

export const CAPABILITY_KEYS = [
  'project.read',
  'project.manage',
  'schedule.manage',
  'crew.manage',
  'time.log.own',
  'time.review',
  'expense.log',
  'expense.review',
  'diary.write',
  'diary.close',
  'evidence.upload',
  'evidence.manage',
  'evidence.publish',
  'document.upload',
  'document.manage',
  'asset.write',
  'asset.destination.set',
  'asset.weight.verify',
  'sustainability.read',
  /**
   * Phase 9's **one** new key (`sustainability.md` §0 finding 10).
   *
   * §37's vocabulary shipped with three sustainability keys and all three are the
   * sustainability lead's; none of them covers a project manager or a supervisor
   * recording that a van did 240 km, which is the only routine, field-captured,
   * non-admin write the phase adds.
   *
   * The two ways of avoiding a new key are both worse. Gating the write on
   * `sustainability.read` makes a key whose name lies about what granting it does.
   * Reusing `asset.write` — the nearest neighbour, already in the Supervisor bundle
   * — would mean anyone who can record a chair can also attribute a journey to a
   * subcontractor's van, which is `provider_company_id`, which is an assertion
   * about another business.
   */
  'sustainability.write',
  'sustainability.factors.manage',
  'sustainability.settings.manage',
  'variation.create',
  'variation.approve',
  'commercial.read',
  'commercial.manage',
  'invoice.manage',
  'signoff.capture',
  'report.generate',
  'compliance.manage',
] as const;
export const capabilityKeySchema = z.enum(CAPABILITY_KEYS);
export type CapabilityKey = z.infer<typeof capabilityKeySchema>;

export const SYSTEM_BUNDLE_KEYS = [
  'admin',
  'project_manager',
  'supervisor',
  'worker',
  'finance',
  'sustainability',
] as const;
export const systemBundleKeySchema = z.enum(SYSTEM_BUNDLE_KEYS);
export type SystemBundleKey = z.infer<typeof systemBundleKeySchema>;

/**
 * The Worker set, and the rule that makes the rest of the table safe:
 * **every system bundle is a superset of Worker.**
 *
 * §37's bundle rows are summaries of a job function, not exhaustive grants, and
 * reading them literally produces a Finance user who cannot log their own hours
 * and a Supervisor who cannot see the project they are standing on. Since the
 * default mapping below hands every existing `MEMBER` the Worker bundle and
 * every existing `MANAGER` the Project Manager bundle, a bundle that omitted
 * these would silently remove an ability those people have today — which is
 * exactly the "zero behaviour change" this layer promises.
 *
 * `evidence.upload` is in the floor rather than beside it because §37 puts it in
 * Worker, and a person who may photograph a wall is not thereby able to publish
 * it to a client or re-tag somebody else's batch — those are separate keys.
 */
const WORKER_CAPABILITIES: readonly CapabilityKey[] = [
  'project.read',
  'time.log.own',
  'expense.log',
  'evidence.upload',
];

function bundle(...extra: CapabilityKey[]): readonly CapabilityKey[] {
  return [...new Set([...WORKER_CAPABILITIES, ...extra])];
}

/**
 * §37's system bundles, as data. Seeded into `capability_bundles` /
 * `capability_bundle_items` by migration `0026`; this is the definition the
 * migration and its tests both read, so the two cannot drift.
 */
export const SYSTEM_BUNDLE_CAPABILITIES: Record<SystemBundleKey, readonly CapabilityKey[]> = {
  admin: CAPABILITY_KEYS,

  project_manager: bundle(
    'project.manage',
    'schedule.manage',
    'crew.manage',
    'time.review',
    'expense.review',
    'diary.write',
    'diary.close',
    'evidence.manage',
    'evidence.publish',
    'document.upload',
    'document.manage',
    'asset.write',
    'asset.destination.set',
    'asset.weight.verify',
    'sustainability.read',
    'sustainability.write',
    'variation.create',
    'variation.approve',
    'commercial.read',
    'commercial.manage',
    'signoff.capture',
    'report.generate'
  ),

  /**
   * The bundle the whole layer exists to make expressible: everything needed to
   * run a site day, and **no `commercial.read`**. A supervisor confirming who
   * was on site has no business seeing what the job is worth, and today the
   * only way to give them the first is to give them the second.
   *
   * No `asset.weight.verify` either. §25.3 makes a VERIFIED weight a documented
   * claim rather than an opinion, which is the Sustainability function's job,
   * not the person with the tape measure.
   */
  supervisor: bundle(
    'diary.write',
    'diary.close',
    'asset.write',
    'asset.destination.set',
    /*
     * Phase 9's one new key, placed beside `asset.write` and `diary.write` — the
     * two it most resembles in who holds them and what they record. A supervisor
     * recording a fuel fill as it happens is the capture case the whole sync
     * contract was designed against; withholding it would leave the only
     * field-captured table in the phase writable by nobody who is on site.
     */
    'sustainability.write',
    'variation.create',
    'signoff.capture'
  ),

  worker: bundle(),

  finance: bundle(
    'time.review',
    'expense.review',
    'variation.approve',
    'commercial.read',
    'commercial.manage',
    'invoice.manage',
    'report.generate'
  ),

  sustainability: bundle(
    'document.upload',
    'document.manage',
    'asset.write',
    'asset.destination.set',
    'asset.weight.verify',
    'sustainability.read',
    'sustainability.write',
    'sustainability.factors.manage',
    'sustainability.settings.manage',
    'compliance.manage',
    'report.generate'
  ),
};

/**
 * §37's safe default: a membership with no bundle derives one from its role.
 *
 * This is the line that makes the layer shippable in one migration. Every
 * membership that exists today — seeded, invited, demo fixture, prototype — has
 * a null `bundle_key`, resolves through here, and keeps exactly the abilities it
 * has now. Nothing regresses on the day the table lands, and no company sees a
 * difference until somebody deliberately assigns a bundle.
 */
export function defaultBundleForRole(role: MembershipRole): SystemBundleKey {
  switch (role) {
    case 'OWNER':
    case 'ADMIN':
      return 'admin';
    case 'MANAGER':
      return 'project_manager';
    case 'MEMBER':
      return 'worker';
  }
}

/** One per-membership exception: `granted: false` removes, `true` adds. */
export const capabilityOverrideSchema = z.object({
  capabilityKey: capabilityKeySchema,
  granted: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CapabilityOverride = z.infer<typeof capabilityOverrideSchema>;

export interface ResolveCapabilitiesInput {
  role: MembershipRole;
  /** `memberships.bundle_key` — null derives from the role. */
  bundleKey: string | null;
  /**
   * The capabilities of the effective bundle as the database holds them. A
   * company bundle is arbitrary data, so this is a plain list rather than a
   * lookup into `SYSTEM_BUNDLE_CAPABILITIES` — the caller resolves the bundle,
   * this function applies the rules to it.
   */
  bundleCapabilities: readonly CapabilityKey[];
  overrides: readonly CapabilityOverride[];
}

/**
 * bundle ⊕ overrides, mirroring `mergeEntitlements`. Pure, so every rule below
 * is a unit test rather than a fixture.
 *
 * **An OWNER's capabilities are not configurable, and that is a lock-out rule
 * rather than a convenience.** A capability layer able to strip an owner of
 * `project.manage` can lock the only person with authority out of their own
 * company — and `access.md` §13.3 refused platform support access, so there is
 * deliberately nobody at CrewQuo who could put it back. The same reasoning
 * already guards roles in `membershipChangeRefusal`; this is that invariant
 * arriving in a second place rather than a new one.
 *
 * **An override may grant a capability the company's plan does not sell**, and
 * that is not a hole. A route requires `hasFeature` *and* `hasCapability` — the
 * plan answers "is this sold?" and the capability answers "may this person?".
 * Collapsing them would make an entitlement override the only way to change a
 * job function, which is how a billing decision starts deciding who may close a
 * day.
 */
export function resolveCapabilities(input: ResolveCapabilitiesInput): CapabilityKey[] {
  if (input.role === 'OWNER') return [...CAPABILITY_KEYS];

  const effective = new Set<CapabilityKey>(input.bundleCapabilities);
  for (const override of input.overrides) {
    if (override.granted) effective.add(override.capabilityKey);
    else effective.delete(override.capabilityKey);
  }
  // Stable order so a response body, a log line and a test all agree.
  return CAPABILITY_KEYS.filter((key) => effective.has(key));
}

/** Membership capabilities as the API reports them. */
export const membershipCapabilitiesSchema = z.object({
  membershipId: z.string().uuid(),
  role: membershipRoleSchema,
  /** Null means "derived from the role" — the UI says so rather than showing a blank. */
  bundleKey: z.string().nullable(),
  effectiveBundleKey: z.string(),
  bundleIsDerived: z.boolean(),
  overrides: z.array(capabilityOverrideSchema),
  capabilities: z.array(capabilityKeySchema),
  /** True when the answer is fixed by the OWNER rule above and nothing may change it. */
  locked: z.boolean(),
});
export type MembershipCapabilities = z.infer<typeof membershipCapabilitiesSchema>;

/** PATCH /v1/members/:membershipId/capabilities */
export const updateMembershipCapabilitiesSchema = z
  .object({
    /** Null clears the assignment and returns the membership to role-derived. */
    bundleKey: z.string().trim().min(1).max(64).nullable().optional(),
    overrides: z.array(capabilityOverrideSchema).max(CAPABILITY_KEYS.length).optional(),
  })
  .refine((v) => v.bundleKey !== undefined || v.overrides !== undefined, {
    message: 'Provide bundleKey, overrides, or both',
  })
  .superRefine((v, ctx) => {
    if (!v.overrides) return;
    const seen = new Set<string>();
    for (const o of v.overrides) {
      if (seen.has(o.capabilityKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['overrides'],
          // Two rows for one key means array order silently decides a permission,
          // which is the same defect the rate-label rules were rejected for.
          message: `Duplicate override for ${o.capabilityKey}`,
        });
        return;
      }
      seen.add(o.capabilityKey);
    }
  });
export type UpdateMembershipCapabilities = z.infer<typeof updateMembershipCapabilitiesSchema>;

/** A bundle as the catalog reports it. */
export const capabilityBundleSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  capabilities: z.array(capabilityKeySchema),
});
export type CapabilityBundle = z.infer<typeof capabilityBundleSchema>;

/** GET /v1/capabilities — the catalog plus the caller's own resolved set. */
export const capabilityCatalogSchema = z.object({
  capabilities: z.array(
    z.object({
      key: capabilityKeySchema,
      name: z.string(),
      description: z.string().nullable(),
      category: z.string(),
    })
  ),
  bundles: z.array(capabilityBundleSchema),
  mine: z.array(capabilityKeySchema),
});
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;
