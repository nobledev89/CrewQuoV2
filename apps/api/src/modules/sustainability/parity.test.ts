import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  DEFAULT_DATA_QUALITY_WEIGHTS,
  DEFAULT_REPORT_DISCLAIMER,
  FEATURE_KEYS,
  LIMIT_KEYS,
  SETTINGS_DEFAULTS,
  SYSTEM_BUNDLE_CAPABILITIES,
  dataQualityWeightsSchema,
} from '@crewquo/shared';

/**
 * Migration ⇄ shared-code parity for Phase 9.
 *
 * The mechanism `catalogParity.test.ts` established for the Phase 8 catalogs, and
 * it exists here for a reason the packet states directly (finding 5): §39 gives
 * `data_quality_weights` `not null` with no default, which makes the table
 * uninsertable by hand, while the packet requires the **authority** for those
 * defaults to be shared code — *"a default that lives only in a migration cannot be
 * read by the engine; one that lives only in the engine means an edited settings
 * row and the code disagree about what 100% means."*
 *
 * The resolution is both copies with a test between them. This is that test, and it
 * reads the migration file rather than the database so it runs in CI with no
 * Postgres — the same trade `catalogParity.test.ts` makes.
 */

const ROOT = join(__dirname, '../../../../..');
const read = (file: string): string =>
  readFileSync(join(ROOT, 'infra/migrations', file), 'utf8');

/**
 * The DDL with its prose removed.
 *
 * Every negative assertion below has to run against this rather than against the
 * file, because these migrations DESCRIBE the thing they refuse — 0037 quotes
 * §39's `not null default 100` in the comment explaining why it is not there, and
 * 0040 quotes `vehicle_id` in the comment explaining why it is omitted. Asserting
 * over the comments would make the file fail for saying what it does, and the
 * obvious fix would be to delete the explanation.
 */
const ddl = (sql: string): string => sql.replace(/--.*/g, '');

const SETTINGS = read('0037_sustainability_settings.sql');
const FACTORS = read('0038_emission_factors.sql');
const ACTIVITIES = read('0040_project_activities.sql');
const SEED = readFileSync(join(ROOT, 'infra/seed/index.ts'), 'utf8');

describe('0037 ⇄ the carbon engine', () => {
  it('ships the same data-quality weights the engine computes with', () => {
    const match = SETTINGS.match(/data_quality_weights jsonb not null default\s*\n\s*'([^']+)'/);
    expect(match, 'the DDL default for data_quality_weights should be findable').toBeTruthy();
    const fromDdl: unknown = JSON.parse(match?.[1] ?? '{}');
    expect(fromDdl).toEqual(DEFAULT_DATA_QUALITY_WEIGHTS);
  });

  it('ships weights the engine would accept', () => {
    // The stronger half: a DDL default that summed to 0.9 would be a settings row
    // nobody edited that silently rescales every published percentage upward.
    const match = SETTINGS.match(/data_quality_weights jsonb not null default\s*\n\s*'([^']+)'/);
    expect(dataQualityWeightsSchema.safeParse(JSON.parse(match?.[1] ?? '{}')).success).toBe(true);
  });

  it('ships §29.3’s disclaimer, word for word', () => {
    const match = SETTINGS.match(/report_disclaimer text not null default\s*\n\s*'([\s\S]*?)',\n/);
    expect(match, 'the DDL default for report_disclaimer should be findable').toBeTruthy();
    // Postgres doubles a literal quote; the TypeScript constant does not.
    expect((match?.[1] ?? '').replace(/''/g, "'")).toBe(DEFAULT_REPORT_DISCLAIMER);
  });

  it('agrees with SETTINGS_DEFAULTS on every scalar default', () => {
    expect(SETTINGS).toContain(`default_country text not null default '${SETTINGS_DEFAULTS.defaultCountry}'`);
    expect(SETTINGS).toContain(`weight_unit   text not null default '${SETTINGS_DEFAULTS.weightUnit}'`);
    expect(SETTINGS).toContain(`distance_unit text not null default '${SETTINGS_DEFAULTS.distanceUnit}'`);
    expect(SETTINGS).toContain(
      `carbon_display_unit text not null default '${SETTINGS_DEFAULTS.carbonDisplayUnit}'`
    );
    expect(SETTINGS).toContain(
      `data_quality_warn_below int not null default ${SETTINGS_DEFAULTS.dataQualityWarnBelow}`
    );
  });
});

/**
 * The regression test for the finding this packet was written for.
 *
 * §39's DDL reads `default_displacement_pct numeric(5,2) not null default 100`, and
 * §45's owner decision of 2026-08-18 says displacement defaults to `UNKNOWN`, never
 * 100%. The column as written cannot express `UNKNOWN` and defaults to the one
 * value the decision forbids — so every company would begin claiming maximal
 * avoided emissions on every reuse movement, with `ASSUMED_FULL` recorded as the
 * basis of an assumption nobody made.
 *
 * **The way a reversed default returns is one plausible column at a time, added by
 * somebody who never knew it had been removed on purpose.** `money-boundary.md`
 * learned that the expensive way. These three assertions and step 6 of the
 * acceptance script are what catch it.
 */
describe('0037 and the displacement default (packet §0 finding 1)', () => {
  it('defaults the basis to UNKNOWN', () => {
    expect(SETTINGS).toContain("default_displacement_basis text not null default 'UNKNOWN'");
  });

  it('leaves the percentage NULLABLE, so UNKNOWN is representable', () => {
    expect(SETTINGS).toMatch(/default_displacement_pct numeric\(5,2\)\s*\n\s*check/);
    // Anchored to the column's own definition line. A looser `[^;]*` would run to
    // the end of the whole `create table` statement and match the `not null` on
    // some later column, which is a test that passes for the wrong reason.
    expect(ddl(SETTINGS)).not.toMatch(/default_displacement_pct\s+numeric\(5,2\)\s+not null/);
  });

  it('never restores `default 100`', () => {
    expect(ddl(SETTINGS)).not.toMatch(/default_displacement_pct[^\n]*default\s+100/);
  });

  it('pairs the two with an equality, not an implication', () => {
    // `=` refuses ASSUMED_FULL carrying a stray 80 as firmly as USER_DEFINED
    // carrying nothing: 100% is what ASSUMED_FULL means, and a second copy of it is
    // a second answer the resolver would have to guess between.
    expect(SETTINGS).toContain(
      "(default_displacement_basis = 'USER_DEFINED') = (default_displacement_pct is not null)"
    );
  });
});

/**
 * Finding 2: the third table to give a nullable `company_id` a unique constraint
 * that does nothing to the platform rows it was meant to protect.
 */
describe('0038/0039 uniqueness over a nullable company_id', () => {
  it('gives emission_factor_sets the partial pair rather than one constraint', () => {
    expect(FACTORS).toContain('emission_factor_sets_company_name_version_idx');
    expect(FACTORS).toContain('emission_factor_sets_platform_name_version_idx');
    expect(FACTORS).toContain('where company_id is not null');
    expect(FACTORS).toContain('where company_id is null');
  });

  it('does not use the constraint §26.1 wrote, which binds nothing platform-side', () => {
    // In Postgres nulls are distinct in a unique index, so `unique (company_id,
    // name, version)` over a nullable company_id lets two identical platform sets
    // coexist — and which factor id a calculation cites then depends on join order.
    expect(ddl(FACTORS)).not.toMatch(/unique\s*\(\s*company_id,\s*name,\s*version\s*\)/);
  });

  it('gives product_carbon_factors the same pair, which §26.3 gave it none of', () => {
    const products = read('0039_product_carbon_factors.sql');
    expect(products).toContain('product_carbon_factors_company_identity_idx');
    expect(products).toContain('product_carbon_factors_platform_identity_idx');
    // verification_status is IN the key on purpose: an org legitimately holds an
    // EPD and a generic for the same chair, which is what the tier walk chooses
    // between. A key without it would make §26.3's preference order unimplementable.
    expect(products).toMatch(/product_carbon_factors_company_identity_idx[\s\S]*?verification_status/);
  });
});

/**
 * Finding 3: `created_by_user_id not null` against the closure promise, for the
 * third time — and the check that the class was fixed rather than the instance.
 */
describe('0040 and the closure decision of 2026-08-20', () => {
  it('makes created_by_user_id nullable with on delete set null', () => {
    expect(ACTIVITIES).toContain('created_by_user_id uuid references users(id) on delete set null');
    expect(ddl(ACTIVITIES)).not.toMatch(/created_by_user_id[^,]*not null/);
  });

  it('omits vehicle_id, which points at a Phase 11 table', () => {
    // 0030's rule: "a column nothing writes and nothing reads is indistinguishable,
    // on inspection, from one whose writer is broken."
    expect(ddl(ACTIVITIES)).not.toContain('vehicle_id');
  });

  it('keeps vehicle_category, fuel_type and distance_km, which have a Phase 9 reader', () => {
    // The distinction Phase 8 drew: a subcontractor's van is a vehicle category and
    // a fuel type without a `vehicles` row anywhere. The FK is what waits.
    expect(ACTIVITIES).toContain('vehicle_category text');
    expect(ACTIVITIES).toContain('fuel_type text');
    expect(ACTIVITIES).toContain('distance_km numeric');
  });

  it('carries the sync contract §27.3 has none of', () => {
    expect(ACTIVITIES).toContain('revision int not null default 1');
    expect(ACTIVITIES).toContain('deleted_at timestamptz');
    expect(ACTIVITIES).toContain('project_activities_bump_revision');
  });
});

/**
 * Finding 10: the one new capability key, and the bundles it lands in.
 *
 * A capability added late gets added to whichever bundle the failing test names,
 * and the bundles are what §44's one-test-per-rule authorization suite asserts
 * against — so the migration and `SYSTEM_BUNDLE_CAPABILITIES` have to agree here
 * rather than in a review.
 */
describe('sustainability.write (packet §0 finding 10)', () => {
  it('exists in the shared vocabulary', () => {
    expect(CAPABILITY_KEYS).toContain('sustainability.write');
  });

  it('is inserted by 0040 with the same key', () => {
    expect(ACTIVITIES).toContain("('sustainability.write', 'Record activities'");
  });

  it('lands in exactly the bundles the migration names', () => {
    const inMigration = [...ACTIVITIES.matchAll(/\('(\w+)',\s+'sustainability\.write'\)/g)].map(
      (m) => m[1]
    );
    expect(new Set(inMigration)).toEqual(
      new Set(['admin', 'project_manager', 'supervisor', 'sustainability'])
    );
  });

  it('matches SYSTEM_BUNDLE_CAPABILITIES, which is what the auth suite reads', () => {
    for (const bundle of ['admin', 'project_manager', 'supervisor', 'sustainability'] as const) {
      expect(SYSTEM_BUNDLE_CAPABILITIES[bundle]).toContain('sustainability.write');
    }
    // Not the worker, who photographs and logs their own hours, and not finance,
    // who has no reason to assert what a van did.
    expect(SYSTEM_BUNDLE_CAPABILITIES.worker).not.toContain('sustainability.write');
    expect(SYSTEM_BUNDLE_CAPABILITIES.finance).not.toContain('sustainability.write');
  });
});

/**
 * Finding 9: three features and one limit, and the seed is the authority.
 *
 * `infra/seed` does `delete from plan_features where plan_id = $1` and rebuilds the
 * set to match itself, so a placement granted only by the migration is silently
 * revoked by the next seed run — the feature works in production until somebody
 * re-seeds, which is the worst possible time to find out. 0033 recorded that and
 * this asserts it.
 */
describe('entitlement keys ⇄ the seed', () => {
  it('declares all three features and the limit in shared code', () => {
    expect(FEATURE_KEYS).toContain('sustainability');
    expect(FEATURE_KEYS).toContain('carbon_engine');
    expect(FEATURE_KEYS).toContain('custom_factors');
    expect(LIMIT_KEYS).toContain('factor_sets');
  });

  it('seeds every one of them into the catalog', () => {
    for (const key of ['sustainability', 'carbon_engine', 'custom_factors', 'factor_sets']) {
      expect(SEED).toContain(`'${key}'`);
    }
  });

  it('places them on the same plans the migration grants them to', () => {
    // Both halves say Pro/Business/Enterprise for the first two and
    // Business/Enterprise for custom factors. Disagreeing would mean the feature
    // works until a re-seed and then stops.
    expect(FACTORS).toMatch(/where p\.id in \('pro', 'business', 'enterprise'\)/);
    expect(FACTORS).toMatch(/where p\.id in \('business', 'enterprise'\)/);

    // Each plan's `features` array, isolated by its own id, so "Pro does not list
    // custom_factors" is asserted over Pro rather than over the whole file — which
    // would pass on Business's copy of the key.
    const featuresOf = (planId: string): string => {
      const at = SEED.indexOf(`id: '${planId}'`);
      expect(at, `the seed should hold a plan called ${planId}`).toBeGreaterThan(-1);
      const start = SEED.indexOf('features: [', at);
      return SEED.slice(start, SEED.indexOf('],', start));
    };
    expect(featuresOf('pro')).toContain("'sustainability'");
    expect(featuresOf('pro')).toContain("'carbon_engine'");
    expect(featuresOf('pro')).not.toContain("'custom_factors'");
    expect(featuresOf('business')).toContain("'custom_factors'");
    // Crew is the free tier and holds none of the three, which is §43's shape and
    // the same answer `asset_tracking` got.
    expect(featuresOf('crew')).not.toContain("'sustainability'");
  });

  it('sets no per-plan value for factor_sets, which is a stated gap', () => {
    // The same treatment `storage_gb` gets. §43 proposes figures for storage and
    // none for factor sets, so choosing one here would be a pricing judgement made
    // by a seed file. An unset limit is silently unlimited and that is recorded.
    expect(SEED).not.toMatch(/factor_sets:\s*\d/);
  });
});
