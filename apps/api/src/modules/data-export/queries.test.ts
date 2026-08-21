import { describe, expect, it } from 'vitest';
import { COMPANY_EXPORT, PERSONAL_EXPORT, type ExportTableSpec } from '@crewquo/shared';
import { COMPANY_QUERIES, PERSONAL_QUERIES, selectFor, type TableQuery } from './queries';

const SCOPES = [
  { name: 'PERSONAL', spec: PERSONAL_EXPORT, queries: PERSONAL_QUERIES },
  { name: 'COMPANY', spec: COMPANY_EXPORT, queries: COMPANY_QUERIES },
] as const;

describe.each(SCOPES)('$name export queries', ({ spec, queries }) => {
  /**
   * The pairing has to be exhaustive in both directions, and the two failures are
   * different in kind.
   *
   * A spec table with no query exports as an empty file, which reads to the recipient as
   * "you have no data" rather than as a bug — the worst failure available here, because
   * it is indistinguishable from a correct answer. A query with no spec table is a table
   * somebody meant to export and nothing will.
   */
  it('has a query for every table in the spec', () => {
    for (const table of spec) {
      expect(queries[table.table], `no query for ${table.table}`).toBeDefined();
    }
  });

  it('has no query for a table the spec does not name', () => {
    const named = new Set(spec.map((t) => t.table));
    for (const table of Object.keys(queries)) {
      expect(named.has(table), `${table} has a query but is not in the spec`).toBe(true);
    }
  });

  it('scopes every query to the subject', () => {
    for (const [table, query] of Object.entries(queries)) {
      // A `where` that does not mention $1 is a query returning every tenant's rows. This
      // is the single assertion in this file whose failure would be a cross-tenant
      // disclosure rather than an omission.
      expect(query.where, `${table} is not scoped to the subject`).toContain('$1');
    }
  });

  it('orders every query, so two exports of unchanged data are diffable', () => {
    for (const [table, query] of Object.entries(queries)) {
      expect(query.orderBy.length, `${table} has no ordering`).toBeGreaterThan(0);
    }
  });

  it('selects exactly the spec columns, and nothing else', () => {
    for (const table of spec) {
      const sql = selectFor(table, queries[table.table]!);
      for (const column of table.columns) {
        expect(sql, `${table.table} does not select ${column}`).toContain(`as "${column}"`);
      }
      // One alias per column and no extras: counting the aliases catches a select list
      // that grew, which is the drift direction that matters.
      expect((sql.match(/ as "/g) ?? []).length).toBe(table.columns.length);
      for (const withheld of table.withheld ?? []) {
        expect(sql, `${table.table} selects the withheld ${withheld.column}`).not.toContain(
          `as "${withheld.column}"`
        );
      }
    }
  });
});

describe('selectFor', () => {
  const spec: ExportTableSpec = {
    table: 'thing',
    because: 'x'.repeat(30),
    scope: 'y'.repeat(30),
    columns: ['id', 'name'],
  };

  it('quotes bare column names', () => {
    const query: TableQuery = { from: 'things', where: 'id = $1', orderBy: 'id' };
    expect(selectFor(spec, query)).toBe('select "id" as "id", "name" as "name" from things where id = $1 order by id');
  });

  it('uses an expression where one is given, for a joined column', () => {
    const query: TableQuery = {
      from: 'things t join others o on o.id = t.other_id',
      where: 't.id = $1',
      expr: { id: 't.id', name: 'o.name' },
      orderBy: 't.id',
    };
    expect(selectFor(spec, query)).toContain('t.id as "id", o.name as "name"');
  });

  it('aliases every column to its spec name, so the CSV header matches the manifest', () => {
    // Without the alias, a joined column arrives named for its source table and the CSV
    // header stops matching the manifest that describes it.
    const query: TableQuery = { from: 'auth_sessions', where: 'user_id = $1', orderBy: 'id' };
    expect(selectFor({ ...spec, columns: ['id'] }, query)).toContain('"id" as "id"');
  });
});

describe('the members join, which is the one query that reaches into users', () => {
  it('never selects a credential, because the select list is the spec\'s', () => {
    const members = COMPANY_EXPORT.find((t) => t.table === 'members')!;
    const sql = selectFor(members, COMPANY_QUERIES.members!);
    expect(sql).not.toContain('password_hash');
    expect(sql).toContain('u.email');
    expect(sql).toContain('m.role');
  });
});
