import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_KEYS,
  REPORT_AUDIENCES,
  REPORT_KINDS,
  REPORT_STATUSES,
} from '@crewquo/shared';

/**
 * Migration ⇄ shared-code ⇄ seed parity for Phase 10.
 *
 * The mechanism `catalogParity.test.ts` established for the Phase 8 catalogs and
 * `sustainability/parity.test.ts` reused for Phase 9. It reads the files rather
 * than the database so it runs in CI with no Postgres.
 *
 * Two of the assertions below are the phase's own findings turned into a test that
 * fails if somebody tidies the finding away: the fourth report kind, and the
 * disclosure constraint that binds `client_visible` to `audience`.
 */

const ROOT = join(__dirname, '../../../../..');
const read = (file: string): string =>
  readFileSync(join(ROOT, 'infra/migrations', file), 'utf8');

/**
 * The DDL with its prose removed.
 *
 * Every negative assertion has to run against this rather than against the file,
 * because these migrations **describe the thing they refuse** — `0043` quotes
 * §29.4's three-value `kind` list in the comment explaining why there are four.
 * Asserting over the comments would make the file fail for saying what it does, and
 * the obvious fix would be to delete the explanation.
 */
const ddl = (sql: string): string => sql.replace(/--.*/g, '');

const REPORTS = read('0043_generated_reports.sql');
const SIGNOFF = read('0044_client_signoff.sql');
const SEED = readFileSync(join(ROOT, 'infra/seed/index.ts'), 'utf8');

describe('0043 ⇄ the shared enums', () => {
  it('ships every report kind the code can produce', () => {
    const match = ddl(REPORTS).match(/kind text not null check \(kind in\s*([\s\S]*?)\)\),/);
    expect(match, 'the kind constraint should be findable').toBeTruthy();
    const fromDdl = [...(match?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(fromDdl.sort()).toEqual([...REPORT_KINDS].sort());
  });

  /**
   * Packet finding 2, pinned. §29.4's canonical DDL lists three kinds and §29.5
   * sends the client export to a snapshot none of them can be. Deleting this value
   * puts that contradiction back, and the symptom would be a client statement that
   * recalculates — which is the exact behaviour the owner decision of 2026-08-17
   * moved it out of Phase 4 to prevent.
   */
  it('carries the fourth kind §29.4 does not list', () => {
    expect(REPORT_KINDS).toContain('CLIENT_EXPORT');
    expect(ddl(REPORTS)).toContain("'CLIENT_EXPORT'");
  });

  it('ships every audience and status', () => {
    for (const audience of REPORT_AUDIENCES) expect(ddl(REPORTS)).toContain(`'${audience}'`);
    for (const status of REPORT_STATUSES) expect(ddl(REPORTS)).toContain(`'${status}'`);
  });
});

describe('the three disclosure layers (packet finding 3)', () => {
  /**
   * The layer a future route cannot forget. §29.1 names the subcontractors and
   * §29.5 forbids naming them in a file that leaves the building; without this
   * constraint, disclosure is a boolean applied to a document assembled for a
   * different reader.
   */
  it('binds client_visible to a CLIENT audience in the database', () => {
    const sql = ddl(REPORTS);
    expect(sql).toMatch(/constraint generated_reports_disclosure\s*\n?\s*check \(not client_visible or audience = 'CLIENT'\)/);
  });

  it('refuses an internal client-export outright', () => {
    expect(ddl(REPORTS)).toMatch(
      /check \(kind <> 'CLIENT_EXPORT' or audience = 'CLIENT'\)/
    );
  });

  it('makes the audience immutable through the frozen-row trigger', () => {
    expect(REPORTS).toContain('generated_reports_guard_frozen');
    expect(ddl(REPORTS)).toContain('new.audience is distinct from old.audience');
    expect(ddl(REPORTS)).toContain('new.snapshot is distinct from old.snapshot');
    expect(ddl(REPORTS)).toContain('new.content_hash is distinct from old.content_hash');
  });
});

describe('the frozen-document guards (packet findings 5 and 9)', () => {
  it('restricts project deletion rather than cascading it', () => {
    expect(ddl(REPORTS)).toMatch(/project_id uuid references projects\(id\) on delete restrict/);
    expect(ddl(SIGNOFF)).toMatch(
      /project_id uuid not null references projects\(id\) on delete restrict/
    );
  });

  it('never cascades a project into a report or a sign-off', () => {
    // The failure this replaced: every table added since Phase 7 chose `cascade`,
    // and a MANAGER could erase a client's signed sign-off with one unguarded call.
    expect(ddl(REPORTS)).not.toMatch(/references projects\(id\) on delete cascade/);
    expect(ddl(SIGNOFF)).not.toMatch(/references projects\(id\) on delete cascade/);
  });

  it('makes one live document per project, kind and seal', () => {
    expect(ddl(REPORTS)).toMatch(
      /create unique index[\s\S]*generated_reports_live_content_idx[\s\S]*where status = 'GENERATED'/
    );
  });
});

describe('0044 — append-only, and the hold', () => {
  it('refuses UPDATE and DELETE on a sign-off at the database', () => {
    expect(SIGNOFF).toContain('client_signoffs_no_update');
    expect(SIGNOFF).toContain('client_signoffs_no_delete');
    expect(ddl(SIGNOFF)).toMatch(/before update on client_signoffs/);
    expect(ddl(SIGNOFF)).toMatch(/before delete on client_signoffs/);
  });

  /** No status column, no `is_current` flag — the current row is derived (§3). */
  it('gives a sign-off no lifecycle to have transitions in', () => {
    const sql = ddl(SIGNOFF);
    const table = sql.slice(sql.indexOf('create table if not exists client_signoffs'), sql.indexOf('comment on table client_signoffs'));
    expect(table).not.toMatch(/\bstatus text\b/);
    expect(table).not.toMatch(/is_current/);
  });

  it('holds every file a frozen document points at', () => {
    expect(ddl(SIGNOFF)).toMatch(
      /file_id uuid not null references stored_files\(id\) on delete restrict/
    );
    expect(ddl(SIGNOFF)).toContain('report_file_references_one_owner');
  });

  /**
   * Postgres treats NULLs as distinct in a unique constraint, so one index over
   * both owner columns would permit the same file twice on the same report.
   */
  it('deduplicates per owner with two partial indexes', () => {
    expect(ddl(SIGNOFF)).toMatch(
      /create unique index[\s\S]*report_file_references_report_idx[\s\S]*where report_id is not null/
    );
    expect(ddl(SIGNOFF)).toMatch(
      /create unique index[\s\S]*report_file_references_signoff_idx[\s\S]*where signoff_id is not null/
    );
  });

  it('adds the per-project client logo override (decision #30)', () => {
    expect(ddl(SIGNOFF)).toMatch(
      /alter table projects add column if not exists client_logo_file_id uuid/
    );
  });
});

describe('§43 — the four feature keys', () => {
  const PHASE_10_KEYS = [
    'sustainability_reports',
    'evidence_pack',
    'client_signoff',
    'client_reporting',
  ] as const;

  it('exists in the shared catalog, the migration and the seed', () => {
    for (const key of PHASE_10_KEYS) {
      expect(FEATURE_KEYS).toContain(key);
      expect(REPORTS).toContain(`'${key}'`);
      expect(SEED).toContain(`'${key}'`);
    }
  });

  /**
   * The migration is not the authority — `infra/seed` deletes and rebuilds
   * `plan_features` to match itself, so a placement granted only in SQL is silently
   * revoked by the next seed run. This is the assertion that keeps the two in step.
   */
  it('places client_signoff on Starter in both, which is a stated departure from §43', () => {
    expect(REPORTS).toMatch(/'client_signoff'[\s\S]*?p\.id in \('starter'/);
    const starter = SEED.slice(SEED.indexOf("id: 'starter'"), SEED.indexOf("id: 'pro'"));
    expect(starter).toContain("'client_signoff'");
  });

  it('places reports and the evidence pack from Pro upward in both', () => {
    const pro = SEED.slice(SEED.indexOf("id: 'pro'"), SEED.indexOf("id: 'business'"));
    expect(pro).toContain("'sustainability_reports'");
    expect(pro).toContain("'evidence_pack'");
    expect(pro).not.toContain("'client_reporting'");
    expect(REPORTS).toMatch(/'sustainability_reports'[\s\S]*?p\.id in \('pro'/);
  });

  it('places client reporting from Business upward in both', () => {
    const business = SEED.slice(SEED.indexOf("id: 'business'"), SEED.indexOf("id: 'enterprise'"));
    expect(business).toContain("'client_reporting'");
    expect(REPORTS).toMatch(/'client_reporting'[\s\S]*?p\.id in \('business'/);
  });

  /**
   * §29.5 gets no key of its own and is sold under `exports`, so a fifth key
   * appearing here later would be a second price on one feature.
   */
  it('sells the client-facing export under the key Phase 4 already used', () => {
    const routes = readFileSync(join(__dirname, 'routes.ts'), 'utf8');
    expect(routes).toMatch(/CLIENT_EXPORT: 'exports'/);
  });
});
