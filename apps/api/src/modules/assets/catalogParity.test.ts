import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ASSET_TYPES, SYSTEM_DESTINATION_TYPES } from '@crewquo/shared';

/**
 * The migration, the shared module and the seed must agree about the catalogs.
 *
 * `capabilities/migrationParity.test.ts` established both the pattern and the
 * reason: a definition that lives in two places is right until somebody edits one
 * of them, and the edit that drifts is a row that exists in production and in no
 * test. Reading the SQL is not elegant; the alternative — asserting against a live
 * database — cannot run in CI without one, which means it would not run on the
 * pull request that introduced the drift.
 *
 * **Here it is load-bearing in a way it was not for capabilities.** A capability
 * that drifts grants somebody a button they should not have. A `counts_as_reuse`
 * flag that drifts changes what "reuse" means in a client's sustainability report
 * — §28.2's metrics are literally sums filtered by these booleans, so the seeded
 * row IS the definition of the number. And `default_unit_weight_kg` drifting from
 * "absent" to "16" is §41.1 breached silently, in the direction of a reported
 * tonne nobody measured.
 *
 * Three files are read: migration 0033, `packages/shared/src/assets.ts` through
 * its exports, and `infra/seed/index.ts` for the plan placements the seed rebuilds
 * from scratch on every run.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../../..');
const migration = readFileSync(join(repoRoot, 'infra/migrations/0033_asset_catalogs.sql'), 'utf8');
const seed = readFileSync(join(repoRoot, 'infra/seed/index.ts'), 'utf8');

/** One statement, from its opening keywords to the terminating semicolon. */
function statement(sql: string, startsWith: string): string {
  const start = sql.indexOf(startsWith);
  if (start < 0) throw new Error(`0033 has no statement starting "${startsWith}"`);
  const end = sql.indexOf(';', start);
  if (end < 0) throw new Error(`Statement "${startsWith}" is not terminated`);
  return sql.slice(start, end);
}

/** The row tuples of an insert's VALUES list, each split into trimmed columns. */
function rowsOf(block: string): string[][] {
  const valuesAt = block.indexOf(' values');
  const list = valuesAt < 0 ? block : block.slice(valuesAt);
  return [...list.matchAll(/\(([^()]*)\)/g)].flatMap((m) => {
    const inner = m[1];
    if (inner === undefined) return [];
    const cols = inner.split(',').map((c) => c.trim());
    // The column list of the insert itself has no quoted literals in it.
    return cols.some((c) => c.startsWith("'") || c === 'null') ? [cols] : [];
  });
}

const unquote = (v: string): string => v.replace(/^'|'$/g, '');
const asBool = (v: string): boolean => v === 'true';

/**
 * One plan's `features:` list out of the seed's PLANS array.
 *
 * Parsed rather than counted. The first version of this file counted occurrences
 * of `'asset_tracking',` across the whole file and got four for three plans —
 * the FEATURES catalog line matched too. A test that cannot tell a catalog entry
 * from a plan placement proves nothing about either, which is the same lesson
 * `capabilities/migrationParity.test.ts` records about slicing statements.
 */
function seedPlanFeatures(planId: string): string[] {
  const start = seed.indexOf(`id: '${planId}'`);
  if (start < 0) throw new Error(`The seed has no plan '${planId}'`);
  const featuresAt = seed.indexOf('features:', start);
  const after = seed.slice(featuresAt + 'features:'.length).trimStart();
  // `enterprise` is `features: ALL_FEATURES`, not a literal list. Returning the
  // identifier is the honest answer: this parser knows what the seed says, and
  // what ALL_FEATURES resolves to is the catalog's business, asserted separately.
  if (!after.startsWith('[')) return [after.slice(0, after.indexOf(',')).trim()];
  const open = seed.indexOf('[', featuresAt);
  const close = seed.indexOf(']', open);
  const body = seed.slice(open + 1, close);
  return body
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0 && !s.startsWith('//'));
}

// ── Asset types ──────────────────────────────────────────────────────────────

describe('migration 0033 and SYSTEM_ASSET_TYPES', () => {
  const rows = rowsOf(statement(migration, 'insert into asset_types (company_id, code'));

  it('seeds the same codes the module declares, in the same order', () => {
    expect(rows.map((r) => unquote(r[1] ?? ''))).toEqual(SYSTEM_ASSET_TYPES.map((t) => t.code));
  });

  it('seeds the same names and categories', () => {
    for (const [i, type] of SYSTEM_ASSET_TYPES.entries()) {
      expect(unquote(rows[i]?.[2] ?? '')).toBe(type.name);
      expect(unquote(rows[i]?.[3] ?? '')).toBe(type.category);
    }
  });

  it('seeds every row into the system catalog rather than a company', () => {
    for (const row of rows) expect(row[0]).toBe('null');
  });

  /**
   * §41.1, asserted against the SQL rather than against the intention. The insert
   * names four columns and `default_unit_weight_kg` is not among them, so there
   * is no position in any tuple where a weight could appear — which is a stronger
   * guarantee than 22 nulls somebody could edit one of.
   */
  it('names no weight column in the seed at all', () => {
    const columns = statement(migration, 'insert into asset_types (company_id, code').split(
      'values'
    )[0];
    expect(columns).not.toContain('default_unit_weight_kg');
    expect(columns).not.toContain('default_material_composition');
  });

  it('keeps the column itself, because an org populates it from its own weighing', () => {
    expect(migration).toContain('default_unit_weight_kg numeric(14,3)');
  });
});

// ── Destination types ────────────────────────────────────────────────────────

describe('migration 0033 and SYSTEM_DESTINATION_TYPES', () => {
  const rows = rowsOf(statement(migration, 'insert into destination_types\n'));

  it('seeds the eleven codes the module declares, in the same order', () => {
    expect(rows.map((r) => unquote(r[1] ?? ''))).toEqual(
      SYSTEM_DESTINATION_TYPES.map((d) => d.code)
    );
  });

  /**
   * The assertion this whole file exists for. Every §28.2 metric is a sum filtered
   * by one of these seven booleans, so a flag that differs between the seed and
   * the module is a rate that means one thing in the API's arithmetic and another
   * in the database it reads.
   */
  it('seeds every counts-as flag exactly as the module declares it', () => {
    for (const [i, declared] of SYSTEM_DESTINATION_TYPES.entries()) {
      const row = rows[i];
      expect(row, `no seeded row for ${declared.code}`).toBeDefined();
      if (!row) continue;
      expect({
        name: unquote(row[2] ?? ''),
        hierarchyTier: row[3] === 'null' ? null : Number(row[3]),
        countsAsRetainedInUse: asBool(row[4] ?? ''),
        countsAsReuse: asBool(row[5] ?? ''),
        countsAsRecycling: asBool(row[6] ?? ''),
        countsAsRecovery: asBool(row[7] ?? ''),
        countsAsLandfill: asBool(row[8] ?? ''),
        countsAsDiverted: asBool(row[9] ?? ''),
        isFinalOutcome: asBool(row[10] ?? ''),
        displacesReplacement: asBool(row[11] ?? ''),
      }).toEqual({
        name: declared.name,
        hierarchyTier: declared.hierarchyTier,
        countsAsRetainedInUse: declared.countsAsRetainedInUse,
        countsAsReuse: declared.countsAsReuse,
        countsAsRecycling: declared.countsAsRecycling,
        countsAsRecovery: declared.countsAsRecovery,
        countsAsLandfill: declared.countsAsLandfill,
        countsAsDiverted: declared.countsAsDiverted,
        isFinalOutcome: declared.isFinalOutcome,
        displacesReplacement: declared.displacesReplacement,
      });
    }
  });

  /** Locked decision #18, read out of the SQL that ships it. */
  it('seeds STORAGE with no tier and no final outcome', () => {
    const storage = rows.find((r) => unquote(r[1] ?? '') === 'STORAGE');
    expect(storage?.[3]).toBe('null');
    expect(storage?.[10]).toBe('false');
  });

  /**
   * The check constraint that stops a *company* row from reopening what the seed
   * gets right: a tier is what makes a destination rankable and a final outcome is
   * what makes it reportable, so an admin cannot create a tier-2 destination that
   * is not final, or a final one with no rung on the ladder.
   */
  it('constrains tier and finality to move together', () => {
    expect(migration).toContain('destination_types_tier_matches_finality');
  });

  it('gives the shadowing model the uniqueness §25.4 omitted', () => {
    expect(migration).toContain('destination_types_company_code_idx');
    expect(migration).toContain('destination_types_system_code_idx');
  });
});

// ── The entitlement placement ────────────────────────────────────────────────

describe('asset_tracking placement (§43)', () => {
  const PLANS_WITH_ASSETS = ['starter', 'pro', 'business', 'enterprise'];

  it('is granted by the migration to the four plans §43 proposes', () => {
    const grant = statement(migration, "select p.id, 'asset_tracking'");
    for (const plan of PLANS_WITH_ASSETS) expect(grant).toContain(`'${plan}'`);
    expect(grant).not.toContain("'crew'");
  });

  /**
   * The trap this test was written for. `infra/seed/index.ts` runs
   * `delete from plan_features where plan_id = $1` and rebuilds the set to match
   * its own PLANS array — so a placement granted only by the migration is
   * silently revoked by the next seed run. The feature works in production until
   * somebody re-seeds, which is the worst possible moment to discover it.
   *
   * `enterprise` takes `ALL_FEATURES` rather than a literal list, so it is
   * asserted through the catalog rather than through its plan block.
   */
  it('is also listed by the seed, which rebuilds plan_features from scratch', () => {
    for (const plan of ['starter', 'pro', 'business']) {
      expect(seedPlanFeatures(plan), `${plan} is missing asset_tracking`).toContain(
        'asset_tracking'
      );
    }
    expect(seedPlanFeatures('enterprise')).toEqual(['ALL_FEATURES']);
  });

  it('is in the seed catalog, so ALL_FEATURES and an override can both name it', () => {
    expect(seed).toContain("['asset_tracking', 'Asset & material tracking', 'sustainability']");
  });

  it('is a features row in the migration too, so an override FK resolves', () => {
    expect(migration).toContain('insert into features (key, name, description, category) values');
    expect(migration).toContain("('asset_tracking'");
  });

  it('is not granted to the free plan by either file', () => {
    expect(seedPlanFeatures('crew')).not.toContain('asset_tracking');
  });
});
