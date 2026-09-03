import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  BUDGET_CATEGORIES,
  FEATURE_KEYS,
  INVOICE_SOURCE_TYPES,
  LOCATION_REFERENCE_TABLES,
  SCHEDULE_RESOURCE_TYPES,
  SCHEDULE_STATUSES,
  TIMELINE_SOURCES,
  VARIATION_LINE_KINDS,
  VARIATION_STATUSES,
} from '@crewquo/shared';

/**
 * Migration ⇄ shared-code ⇄ seed parity for Phase 11.
 *
 * The mechanism `catalogParity.test.ts` established for Phase 8 and
 * `reports/parity.test.ts` reused for Phase 10. It reads the files rather than the
 * database so it runs in CI with no Postgres.
 *
 * **Six of the assertions below are the packet's own findings turned into tests
 * that fail if somebody tidies the finding away**, which is the only way a reason
 * written in a comment survives the person who did not read it: the absent
 * `currency` column, the line-total check constraints, the constraint-name trap in
 * `invoice_items`, the nullable user references, the shift type §31 does not
 * declare, and the two registry entries.
 */

const ROOT = join(__dirname, '../../../../..');
const read = (file: string): string =>
  readFileSync(join(ROOT, 'infra/migrations', file), 'utf8');

/**
 * The DDL with its prose removed.
 *
 * Every negative assertion runs against this rather than against the file, because
 * these migrations **describe the thing they refuse** — `0046` quotes §30.2's
 * `currency text not null` in the comment explaining why it is absent. Asserting
 * over the comments would make the file fail for saying what it does, and the
 * obvious fix would be to delete the explanation. The colour scan and the drag scan
 * both learned this the hard way.
 */
const ddl = (sql: string): string => sql.replace(/--.*/g, '');

/**
 * A migration's `create table` block, without its `comment on` statements.
 *
 * `ddl()` alone is not enough for a *negative* assertion about a column, and this
 * file learned that the same way the colour scan did: `comment on column
 * project_budgets.vehicle_cents is '… no source of actual vehicle spend …'` is a
 * SQL **string**, not a comment, so it survives comment-stripping and makes
 * "declares no `currency`" fail on the sentence explaining why there is none.
 */
const tableBlock = (sql: string, table: string): string => {
  const body = ddl(sql);
  const start = body.indexOf(`create table if not exists ${table}`);
  const end = body.indexOf('comment on', start);
  return body.slice(start, end === -1 ? undefined : end);
};

/** TypeScript with its comments stripped, for the same reason. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const VARIATIONS = read('0045_variations.sql');
const BUDGETS = read('0046_project_budgets.sql');
const SCHEDULING = read('0047_scheduling.sql');
const SEED = readFileSync(join(ROOT, 'infra/seed/index.ts'), 'utf8');

describe('0045 ⇄ the shared enums', () => {
  it('ships every variation status the machine can reach', () => {
    const match = ddl(VARIATIONS).match(
      /status text not null default 'DRAFT' check \(status in\s*([\s\S]*?)\)\),/
    );
    expect(match, 'the status constraint should be findable').toBeTruthy();
    const fromDdl = [...(match?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(fromDdl.sort()).toEqual([...VARIATION_STATUSES].sort());
  });

  it('ships every line kind', () => {
    for (const kind of VARIATION_LINE_KINDS) {
      expect(ddl(VARIATIONS)).toContain(`'${kind}'`);
    }
  });

  it('registers every action and entity type the routes record', () => {
    const routes = readFileSync(join(__dirname, 'routes.ts'), 'utf8');
    for (const action of [
      'variation.created',
      'variation.updated',
      'variation.deleted',
      'variation.submitted',
      'variation.withdrawn',
      'variation.approved',
      'variation.rejected',
      'variation.completed',
      'variation.client_approval_recorded',
    ]) {
      expect(AUDIT_ACTIONS).toContain(action);
      expect(routes).toContain(action);
    }
    expect(AUDIT_ENTITY_TYPES).toContain('VARIATION');
  });
});

describe('packet finding 5 — the line identity is a check constraint', () => {
  it('binds both totals to quantity × unit in the database', () => {
    const sql = ddl(VARIATIONS);
    expect(sql).toMatch(
      /constraint variation_lines_cost_identity\s*\n?\s*check \(cost_cents = round\(quantity \* unit_cost_cents\)\)/
    );
    expect(sql).toMatch(
      /constraint variation_lines_sell_identity\s*\n?\s*check \(sell_cents = round\(quantity \* unit_sell_cents\)\)/
    );
  });

  /**
   * The API's own arithmetic has to agree with the constraint exactly, and
   * `Math.round(quantity * unitCents)` does not — `0.29 × 50` is `14.50`, which
   * Postgres rounds to 15 and IEEE 754 evaluates as `14.499999999999998`. This
   * asserts the *shape* of the fix, so somebody "simplifying" the function back
   * fails here as well as in `variations.test.ts`.
   */
  it('computes it in integer hundredths on the API side', () => {
    const shared = readFileSync(
      join(ROOT, 'packages/shared/src/variations.ts'),
      'utf8'
    );
    const body = shared.slice(
      shared.indexOf('export function lineTotalCents'),
      shared.indexOf('export interface VariationLineTotals')
    );
    expect(body).toContain('Math.round(quantity * 100)');
    expect(body).not.toMatch(/return Math\.round\(quantity \* unitCents\)/);
  });

  it('gives the header no constraint, because a check cannot aggregate', () => {
    // Stated as a test so the absence reads as deliberate. The header is recomputed
    // in the transaction instead, and §12 asserts header = sum(lines) live.
    expect(ddl(VARIATIONS)).not.toMatch(/check \(sell_total_cents = /);
  });
});

describe('packet finding 1 — project_budgets has no currency column', () => {
  it('declares no currency column', () => {
    const table = tableBlock(BUDGETS, 'project_budgets');
    expect(table).toContain('project_id uuid not null');
    expect(table).not.toMatch(/\bcurrency\b/);
  });

  it('still explains why in the prose, so the next reader does not add it back', () => {
    // The one assertion in this file that runs against the comments on purpose:
    // migration 0017 deleted this column from three other tables, and a reason
    // nobody can find is a reason somebody overrules.
    expect(BUDGETS).toContain('0017');
    expect(BUDGETS).toMatch(/reporting_currency/);
  });

  it('declares all ten of §30.2 and nothing else', () => {
    const sql = ddl(BUDGETS);
    for (const key of BUDGET_CATEGORIES) {
      const column = key === 'revenue' ? 'revenue_cents' : `${key}_cents`;
      expect(sql).toContain(column);
    }
  });

  it('stores no actuals at all, which is §30.2 in words', () => {
    // "Actuals are computed, never stored — storing them would create two sources
    // of truth that drift."
    expect(tableBlock(BUDGETS, 'project_budgets')).not.toMatch(/actual/i);
  });

  it('holds one budget per project', () => {
    expect(ddl(BUDGETS)).toContain('project_budgets_one_per_project unique');
  });
});

describe('packet finding 12 — five nullable user references, and no sixth', () => {
  it('never declares created_by_user_id not null', () => {
    for (const sql of [VARIATIONS, BUDGETS, SCHEDULING]) {
      expect(ddl(sql)).not.toMatch(/created_by_user_id uuid not null/);
    }
  });

  /**
   * Every **actor** column, which is what the finding is about: the person who
   * created, updated, reviewed or captured a record. `on delete set null` is what
   * lets the 2026-08-20 closure promise anonymise a person while the record stands.
   */
  it('sets every actor reference to null on deletion, so closure can anonymise', () => {
    const ACTOR =
      /(created_by|updated_by|reviewed_by|captured_by)_user_id uuid references users\(id\)([^,\n]*)/g;
    for (const sql of [VARIATIONS, BUDGETS, SCHEDULING]) {
      const refs = [...ddl(sql).matchAll(ACTOR)].map((m) => m[2]);
      expect(refs.length).toBeGreaterThan(0);
      for (const tail of refs) expect(tail).toContain('on delete set null');
    }
  });

  /**
   * And the one deliberate exception, asserted so it stays deliberate.
   *
   * `resource_availability.user_id` cascades, because that row is the opposite kind
   * of thing from the rest: it is personal data about somebody's private time
   * rather than evidence of anything, and an anonymised window pointing at nobody
   * is data retained for no reason. It is not an actor column.
   */
  it('cascades the one row that is private rather than evidential', () => {
    const table = tableBlock(SCHEDULING, 'resource_availability');
    expect(table).toMatch(/user_id\s+uuid references users\(id\) on delete cascade/);
  });
});

describe('the Phase 6 hook, and the constraint-name trap', () => {
  it('adds VARIATION to invoice_items.source_type in both places', () => {
    expect(INVOICE_SOURCE_TYPES).toContain('VARIATION');
    expect(ddl(VARIATIONS)).toMatch(
      /check \(source_type in \('TIME_LOG','EXPENSE','MANUAL','VARIATION'\)\)/
    );
  });

  it('requires a source id for a variation line', () => {
    expect(ddl(VARIATIONS)).toMatch(
      /source_type in \('TIME_LOG','EXPENSE','VARIATION'\) and source_id is not null/
    );
  });

  /**
   * **The trap, pinned.** `0008` declared its two table-level checks anonymously,
   * so Postgres generated the names: `invoice_items_check` is the AMOUNT IDENTITY
   * and `invoice_items_check1` is the source pairing. The first draft of `0045`
   * dropped `invoice_items_check` to replace the pairing — which would have
   * silently removed the guard keeping an invoice line's total equal to its
   * quantity times its unit price, on a table whose rows are sent to clients.
   *
   * Nothing would have failed. This is the assertion that would.
   */
  it('keeps the amount identity, under a name nobody has to guess at', () => {
    const sql = ddl(VARIATIONS);
    expect(sql).toContain('drop constraint if exists invoice_items_check1');
    expect(sql).toMatch(
      /add constraint invoice_items_amount_identity\s*\n?\s*check \(amount_cents = round\(quantity \* unit_amount_cents\)\)/
    );
  });
});

describe('0047 ⇄ §31', () => {
  it('ships every resource type and status', () => {
    for (const type of SCHEDULE_RESOURCE_TYPES) expect(ddl(SCHEDULING)).toContain(`'${type}'`);
    for (const status of SCHEDULE_STATUSES) expect(ddl(SCHEDULING)).toContain(`'${status}'`);
  });

  /**
   * Packet finding 6. §31 gives an assignment two instants and asks for a planned
   * cost through the rate engine, and every rate the engine resolves is keyed on a
   * shift type. Deriving one from `starts_at.getHours()` would put a rate rule back
   * in code eleven phases after the owner had the `FRI_SAT_NIGHT` branch removed.
   */
  it('declares the shift type §31 does not, and derives it from no clock', () => {
    expect(ddl(SCHEDULING)).toMatch(
      /shift_type text check \(shift_type in \('WEEKDAY_DAY','NIGHT','SUNDAY','SHIFT','DAILY'\)\)/
    );
    /*
     * Stripped of comments before matching, and this file's own header explains
     * why — it failed here first. `planFor`'s doc comment *names* the thing it
     * refuses (`starts_at.getHours()`), which is the trap the colour scan hit on
     * its first run: a tool that reads prose as code makes documenting a fix cost
     * you a build.
     */
    const routes = code(readFileSync(join(__dirname, '../scheduling/routes.ts'), 'utf8'));
    expect(routes).not.toMatch(/getHours\(\)/);
    expect(routes).not.toMatch(/getUTCHours\(\)/);
  });

  it('permits exactly one resource per row', () => {
    expect(ddl(SCHEDULING)).toContain('schedule_assignments_one_resource');
    expect(ddl(SCHEDULING)).toContain('schedule_assignments_headcount');
  });

  /** Packet finding 7 — two tables §31 names in prose and declares nowhere. */
  it('declares the two tables §31 only describes', () => {
    expect(ddl(SCHEDULING)).toContain('create table if not exists resource_availability');
    expect(ddl(SCHEDULING)).toContain('create table if not exists project_role_requirements');
  });

  /**
   * An availability window naming a user is personal data about somebody's private
   * time. "Unavailable Thursday afternoons" is frequently a medical appointment, and
   * a field for the reason is a field somebody writes it in.
   */
  it('gives an availability window no reason column', () => {
    const sql = ddl(SCHEDULING);
    const table = sql.slice(
      sql.indexOf('create table if not exists resource_availability'),
      sql.indexOf('comment on table resource_availability')
    );
    expect(table).not.toMatch(/\breason\b/);
  });

  /** Packet finding 8 — the third time this column was deferred. */
  it('adds project_activities.vehicle_id, now that it has a reader', () => {
    expect(ddl(SCHEDULING)).toMatch(
      /alter table project_activities add column if not exists vehicle_id uuid[\s\S]*?on delete set null/
    );
  });

  it('keeps the columns a subcontractor with no fleet row needs', () => {
    // 0040's reasoning is unchanged: a subcontractor's van is a category and a fuel
    // without a `vehicles` row, and the prefill copies rather than joins so retiring
    // a vehicle cannot restate a published figure.
    expect(ddl(SCHEDULING)).not.toMatch(/drop column.*vehicle_category/);
    expect(ddl(SCHEDULING)).not.toMatch(/drop column.*fuel_type/);
  });
});

describe('packet finding 9 — the registries that were waiting', () => {
  it('adds schedule_assignments.location_id to the location registry', () => {
    expect(LOCATION_REFERENCE_TABLES.map((t) => t.table)).toContain('schedule_assignments');
  });

  /**
   * The Phase 8 gap this phase found: `project_assets.origin_location_id` and
   * `asset_movements.from_location_id` shipped in `0034`/`0035` and neither reached
   * the registry, so a location in use answered a `23503` — a 500 — rather than the
   * sentence `countLocationReferences` exists to produce.
   */
  it('adds the two Phase 8 entries that were missed', () => {
    const byTable = new Map(LOCATION_REFERENCE_TABLES.map((t) => [t.table, t]));
    expect(byTable.get('project_assets')?.column).toBe('origin_location_id');
    expect(byTable.get('asset_movements')?.column).toBe('from_location_id');
  });

  it('gives every registry entry a column the migrations actually declare', () => {
    // A registry may describe the product ahead of its migrations — the counter
    // skips a table that does not exist — but an entry naming a column that will
    // never exist is a silent no-op, which is worse than a missing entry.
    const all = ['0028_project_locations.sql', '0030_project_evidence.sql',
      '0031_project_documents.sql', '0032_site_diary.sql', '0034_project_assets.sql',
      '0035_asset_movements.sql', '0047_scheduling.sql'].map(read).join('\n');
    for (const ref of LOCATION_REFERENCE_TABLES) {
      expect(all, `${ref.table}.${ref.column}`).toContain(ref.column);
    }
  });
});

describe('§43 — the two feature keys', () => {
  const PHASE_11_KEYS = ['variations', 'scheduling'] as const;

  it('exists in the shared catalog, the migration and the seed', () => {
    for (const key of PHASE_11_KEYS) {
      expect(FEATURE_KEYS).toContain(key);
      expect(SEED).toContain(`'${key}'`);
    }
    expect(VARIATIONS).toContain("'variations'");
    expect(SCHEDULING).toContain("'scheduling'");
  });

  /**
   * The migration is not the authority — `infra/seed` deletes and rebuilds
   * `plan_features` to match itself, so a placement granted only in SQL is silently
   * revoked by the next seed run. And **§43 is followed exactly this time**, which
   * is what the Starter assertion pins: the first phase in four with no departure.
   */
  it('places both on Starter and up, in the migration and the seed', () => {
    expect(ddl(VARIATIONS)).toMatch(/'variations'[\s\S]*?p\.id in \('starter'/);
    expect(ddl(SCHEDULING)).toMatch(/'scheduling'[\s\S]*?p\.id in \('starter'/);
    const starter = SEED.slice(SEED.indexOf("id: 'starter'"), SEED.indexOf("id: 'pro'"));
    for (const key of PHASE_11_KEYS) expect(starter).toContain(`'${key}'`);
  });

  it('grants nothing to the Crew plan, which is the shape of the free tier', () => {
    const crew = SEED.slice(SEED.indexOf("id: 'crew'"), SEED.indexOf("id: 'starter'"));
    for (const key of PHASE_11_KEYS) expect(crew).not.toContain(`'${key}'`);
  });

  /**
   * `0027`'s defect, which cost a fresh-database migration run: a literal `insert
   * into plan_limits … values ('crew', …)` violates the foreign key on a database
   * where `plans` is still empty, and stops every later migration. Both Phase 11
   * migrations use the `select … from plans` shape, which yields no rows instead.
   */
  it('inserts plan rows by selecting from plans, so a fresh database migrates', () => {
    for (const sql of [VARIATIONS, SCHEDULING]) {
      expect(ddl(sql)).toMatch(/insert into plan_features \(plan_id, feature_key\)\s*\nselect/);
      expect(ddl(sql)).not.toMatch(/insert into plan_features[\s\S]{0,120}values \(/);
    }
  });

  it('gives the §35 timeline no feature key of its own', () => {
    // It is a union over ten record classes whose features differ; each source is
    // gated by the key that governs its records (packet §13.7).
    expect(FEATURE_KEYS).not.toContain('timeline');
    const gated = TIMELINE_SOURCES.filter((s) => s.feature !== null);
    expect(gated.length).toBeGreaterThan(4);
    for (const source of gated) {
      expect(FEATURE_KEYS).toContain(source.feature!);
    }
  });
});
