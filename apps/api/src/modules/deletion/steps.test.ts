import { describe, expect, it } from 'vitest';
import { NEVER_REMOVED_TABLES } from '@crewquo/shared';
import { CLOSURE_SPECS } from './steps';

const SCOPES = [
  { name: 'PERSONAL', spec: CLOSURE_SPECS.PERSONAL },
  { name: 'COMPANY', spec: CLOSURE_SPECS.COMPANY },
] as const;

/**
 * The plan and the statements are two files that must say the same thing, and the
 * ways they can disagree are not equally bad.
 *
 * A plan step with no statement does nothing and reports success — the worst
 * failure available here, because a closure that quietly skipped a table is
 * indistinguishable from one that ran. A statement with no plan step is a table
 * somebody meant to act on with no argument written down for why. And a statement
 * whose verb contradicts its declared action is the one that would destroy a
 * counterparty's record while the plan on screen said PRESERVE.
 */
describe.each(SCOPES)('$name closure steps', ({ spec }) => {
  it('has a statement for every step in the plan', () => {
    for (const step of spec.plan) {
      expect(spec.statements[step.table], `no statement for ${step.table}`).toBeDefined();
    }
  });

  it('has no statement for a table the plan does not name', () => {
    const named = new Set(spec.plan.map((s) => s.table));
    for (const table of Object.keys(spec.statements)) {
      expect(named.has(table), `${table} has a statement but no plan step`).toBe(true);
    }
  });

  /**
   * The assertion that matters most in this file. A `delete` under a step the plan
   * calls PRESERVE would remove a jointly-held record while every screen, manifest
   * and audit row said it was kept.
   */
  it('matches the verb of every statement to its declared action', () => {
    for (const step of spec.plan) {
      const sql = spec.statements[step.table]!.sql.trim().toLowerCase();
      if (step.action === 'REMOVE') {
        expect(sql.startsWith('delete'), `${step.table} is REMOVE but does not delete`).toBe(true);
      } else if (step.action === 'ANONYMISE') {
        expect(sql.startsWith('update'), `${step.table} is ANONYMISE but does not update`).toBe(true);
      } else {
        expect(
          sql.startsWith('select count(*)'),
          `${step.table} is PRESERVE and must only count`
        ).toBe(true);
      }
    }
  });

  it('scopes every statement to the subject', () => {
    for (const [table, statement] of Object.entries(spec.statements)) {
      // A statement with no `$1` acts on every tenant. This is the one failure here
      // that would be a platform-wide data loss rather than a missed table.
      expect(statement.sql, `${table} is not scoped to the subject`).toContain('$1');
    }
  });

  it('never deletes a jointly-held table, whatever the plan says', () => {
    // A second belt over the shared canary, because this file is where a `delete`
    // would actually be written.
    for (const [table, statement] of Object.entries(spec.statements)) {
      if (!statement.sql.trim().toLowerCase().startsWith('delete')) continue;
      expect(
        NEVER_REMOVED_TABLES.includes(table),
        `${table} is jointly held and this statement deletes it`
      ).toBe(false);
    }
  });

  it('runs exactly the acting steps, and only those', () => {
    const acting = spec.plan.filter((s) => s.action !== 'PRESERVE').map((s) => s.table);
    expect([...spec.actingOrder].sort()).toEqual([...acting].sort());
  });
});

describe('the order of a personal closure', () => {
  /**
   * `users` last, and this is not stylistic.
   *
   * `auth_attempts` and `invites` are keyed on the email address rather than the
   * account — deliberately, because most failed sign-ins name an address with no
   * account (0016). Anonymising the `users` row first leaves both sets of rows
   * un-findable, still holding a real address, and **both statements report zero
   * rows so the run reports success.** A silent failure in the one direction that
   * matters.
   */
  it('destroys the identity only after everything keyed on it is gone', () => {
    const order = CLOSURE_SPECS.PERSONAL.actingOrder;
    expect(order[order.length - 1]).toBe('users');
    for (const dependent of ['auth_attempts', 'invites']) {
      expect(order.indexOf(dependent)).toBeGreaterThan(-1);
      expect(order.indexOf(dependent)).toBeLessThan(order.indexOf('users'));
    }
  });

  it('reads the identity in exactly the statements that need it', () => {
    // The dependency is a subquery against `users`, so it is findable. If a third
    // statement grows one, this test is what says the ordering has to be re-thought.
    const readers = Object.entries(CLOSURE_SPECS.PERSONAL.statements)
      .filter(([, s]) => /from users where id = \$1|from users where id=\$1/.test(s.sql))
      .map(([table]) => table)
      .sort();
    expect(readers).toEqual(['auth_attempts', 'invites']);
  });
});

describe('the withdrawn identity, as written in SQL', () => {
  /**
   * The tombstone is generated in Postgres rather than passed in, so this asserts
   * the statement against the shared helper the rest of the product reads. Two
   * spellings of the same address would make "is this account closed" answerable two
   * ways.
   */
  it('matches the address the shared policy defines', () => {
    const sql = CLOSURE_SPECS.PERSONAL.statements.users!.sql;
    expect(sql).toContain("'withdrawn-' || id || '@closed.crewquo.invalid'");
    expect(sql).toContain("name = 'Withdrawn person'");
  });

  it('clears the platform-staff bit with the rest', () => {
    // An anonymised row with `is_super_admin` still set is a console account with
    // no owner — easy to miss in a list of personal fields, because it is not one.
    expect(CLOSURE_SPECS.PERSONAL.statements.users!.sql).toContain('is_super_admin = false');
  });

  it('is idempotent, so a replayed run cannot re-close an account', () => {
    expect(CLOSURE_SPECS.PERSONAL.statements.users!.sql).toContain('anonymized_at is null');
    expect(CLOSURE_SPECS.COMPANY.statements.companies!.sql).toContain('closed_at is null');
  });
});
