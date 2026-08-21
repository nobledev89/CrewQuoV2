import { COMPANY_EXPORT, PERSONAL_EXPORT, type ExportTableSpec } from '@crewquo/shared';

/**
 * Where each exported table's rows come from.
 *
 * **The select list is generated from the spec, never written here.** That is the point of
 * the file's shape: `packages/shared/src/data-export.ts` decides which columns leave, and
 * a query that also listed them could drift from it — silently, and in the direction that
 * matters, because the drift nobody notices is an extra column in the SQL. So a query
 * contributes a `from`, a `where` and, only where a bare column name would be ambiguous,
 * an expression per column. The columns themselves are the spec's.
 *
 * The same reasoning makes the pairing exhaustive in both directions, asserted in
 * `queries.test.ts`: a spec table with no query would export as an empty file, which reads
 * to the recipient as "you have no data" rather than as a bug, and a query with no spec
 * table is a table somebody meant to export and nothing will.
 */
export interface TableQuery {
  /** A `from` clause — a table, or a join where the spec's columns need one. */
  readonly from: string;
  /** The row scope. `$1` is the subject: a user id, or a company id. */
  readonly where: string;
  /**
   * SQL for a column whose bare name would not resolve — a joined table's column, or one
   * that needs qualifying because two tables in the `from` both have it.
   */
  readonly expr?: Readonly<Record<string, string>>;
  /** Stable ordering, so two exports of unchanged data are byte-identical and diffable. */
  readonly orderBy: string;
}

/**
 * A person's own rows.
 *
 * Every `where` is keyed on the requester's own id. There is no company in any of them,
 * deliberately: a personal export is not "everything in the companies I belong to", and
 * the scoping is what makes that true rather than a promise in the documentation.
 */
export const PERSONAL_QUERIES: Readonly<Record<string, TableQuery>> = {
  account: { from: 'users', where: 'id = $1', orderBy: 'id' },
  memberships: { from: 'memberships', where: 'user_id = $1', orderBy: 'created_at, id' },
  time_logs: { from: 'time_logs', where: 'logged_by_user_id = $1', orderBy: 'work_date, id' },
  expenses: { from: 'expenses', where: 'logged_by_user_id = $1', orderBy: 'created_at, id' },
  project_submissions: {
    from: 'project_submissions',
    where: 'submitted_by_user_id = $1',
    orderBy: 'period_start, id',
  },
  // The spec calls this `sessions` because that is the word the security screen uses to
  // the person reading it; the table is `auth_sessions`. The bundle is named for the
  // reader, not for the schema.
  sessions: { from: 'auth_sessions', where: 'user_id = $1', orderBy: 'created_at, id' },
  notifications: { from: 'notifications', where: 'recipient_user_id = $1', orderBy: 'created_at, id' },
  notification_preferences: {
    from: 'notification_preferences',
    where: 'user_id = $1',
    orderBy: 'user_id',
  },
};

/**
 * A company's own rows.
 *
 * Two scoping shapes recur, and the difference between them is the money boundary:
 *
 *   - **Owned or party to.** `engagements`, `invoices`, `projects` — this company is on
 *     one side of a two-sided record, and both sides are entitled to their copy.
 *   - **Keyed on `company_id`.** `rate_cards`, `role_catalog`, `audit_logs` — the row
 *     belongs to exactly one company, and a counterparty's equivalent row is unreachable
 *     by construction rather than excluded by a condition somebody has to remember. §4's
 *     rule that a provider never reads a client's BILL figure survives an export because
 *     of this line, not because of a filter.
 */
export const COMPANY_QUERIES: Readonly<Record<string, TableQuery>> = {
  company: { from: 'companies', where: 'id = $1', orderBy: 'id' },
  members: {
    from: 'memberships m join users u on u.id = m.user_id',
    where: 'm.company_id = $1',
    // Named columns from a join. `password_hash` is unreachable here because the select
    // list is the spec's and the spec withholds it — the reason this join is safe is the
    // same reason every other query is.
    expr: {
      id: 'm.id',
      user_id: 'm.user_id',
      name: 'u.name',
      email: 'u.email',
      role: 'm.role',
      status: 'm.status',
      created_at: 'm.created_at',
      updated_at: 'm.updated_at',
    },
    orderBy: 'm.created_at, m.id',
  },
  engagements: {
    from: 'engagements',
    where: 'client_company_id = $1 or provider_company_id = $1',
    orderBy: 'created_at, id',
  },
  projects: {
    from: 'projects',
    where:
      'owner_company_id = $1 or client_company_id = $1 or id in (select project_id from project_assignments where provider_company_id = $1)',
    orderBy: 'created_at, id',
  },
  project_assignments: {
    from: 'project_assignments',
    where:
      'provider_company_id = $1 or project_id in (select id from projects where owner_company_id = $1)',
    orderBy: 'created_at, id',
  },
  role_catalog: { from: 'role_catalog', where: 'company_id = $1', orderBy: 'name, id' },
  rate_cards: { from: 'rate_cards', where: 'company_id = $1', orderBy: 'effective_from, id' },
  time_logs: {
    from: 'time_logs',
    where:
      'provider_company_id = $1 or project_id in (select id from projects where owner_company_id = $1)',
    orderBy: 'work_date, id',
  },
  expenses: {
    from: 'expenses',
    where:
      'provider_company_id = $1 or project_id in (select id from projects where owner_company_id = $1)',
    orderBy: 'created_at, id',
  },
  invoices: {
    from: 'invoices',
    where: 'issuer_company_id = $1 or counterparty_company_id = $1',
    orderBy: 'created_at, id',
  },
  invoice_items: {
    from: 'invoice_items',
    where:
      'invoice_id in (select id from invoices where issuer_company_id = $1 or counterparty_company_id = $1)',
    orderBy: 'invoice_id, id',
  },
  audit_logs: { from: 'audit_logs', where: 'company_id = $1', orderBy: 'created_at, id' },
};

/**
 * `select <the spec's columns> from <the query's source> where <the query's scope>`.
 *
 * Identifiers are quoted and the column list comes from a frozen constant, so nothing
 * here is interpolated from a request. The subject is always `$1`.
 */
export function selectFor(spec: ExportTableSpec, query: TableQuery): string {
  const columns = spec.columns
    .map((c) => `${query.expr?.[c] ?? `"${c}"`} as "${c}"`)
    .join(', ');
  return `select ${columns} from ${query.from} where ${query.where} order by ${query.orderBy}`;
}

/** The two scopes, paired with their queries, as the builder consumes them. */
export const EXPORT_SCOPES = {
  PERSONAL: { spec: PERSONAL_EXPORT, queries: PERSONAL_QUERIES },
  COMPANY: { spec: COMPANY_EXPORT, queries: COMPANY_QUERIES },
} as const;

export type ExportScope = keyof typeof EXPORT_SCOPES;
