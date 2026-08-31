import { COMPANY_CLOSURE_PLAN, PERSONAL_CLOSURE_PLAN, type ClosureStep } from '@crewquo/shared';

/**
 * The SQL behind each step of a closure plan.
 *
 * **The plan lives in `packages/shared/src/deletion.ts` and the statements live
 * here, paired in both directions by `steps.test.ts`.** Same shape as the export
 * (`data-export/queries.ts`), and the same reason: a policy written next to its
 * implementation drifts from it silently, in whichever direction nobody is looking.
 * Here the dangerous direction is a `delete` under a step the plan calls PRESERVE —
 * so the test asserts the *verb* of every statement against the declared action, not
 * merely that a statement exists.
 *
 * **`$1` is the subject and it is the only parameter**, which is why the ordering
 * below matters: see `PERSONAL_ACTING_ORDER`.
 */
export interface ClosureStatement {
  /**
   * One statement. `$1` is the subject — a user id, or a company id.
   *
   * `delete` for REMOVE, `update` for ANONYMISE, and for PRESERVE a
   * `select count(*)::int as n` that counts what survived. The preserved counts are
   * not decoration: they are the evidence, on the permanent record, that the half of
   * the promise the product cannot keep was at least kept honestly — the hours are
   * still there, and the row says how many.
   */
  readonly sql: string;
}

/**
 * A person's closure, statement by statement.
 *
 * Nothing here touches a row belonging to a company the person happened to work
 * for, other than their membership. The hours, expenses, submissions and audit rows
 * are counted and left exactly as they are.
 */
export const PERSONAL_STATEMENTS: Readonly<Record<string, ClosureStatement>> = {
  /*
   * The anonymisation. Not a delete: `time_logs.logged_by_user_id` is `not null`
   * with no cascade, so Postgres would refuse — and §13.1 wanted the attribution
   * anyway.
   *
   * `is_super_admin` is cleared with the rest, which looks out of place in a list
   * of personal fields and is not: an anonymised row with the platform-staff bit
   * still set is a console account with no owner. `email_verified_at` goes because
   * a verified tombstone is a claim about an address nobody holds.
   */
  users: {
    sql: `update users
             set email = 'withdrawn-' || id || '@closed.crewquo.invalid',
                 name = 'Withdrawn person',
                 avatar_url = null,
                 password_hash = null,
                 google_sub = null,
                 is_super_admin = false,
                 email_verified_at = null,
                 anonymized_at = now(),
                 updated_at = now()
           where id = $1 and anonymized_at is null`,
  },
  memberships: { sql: `delete from memberships where user_id = $1` },
  auth_sessions: { sql: `delete from auth_sessions where user_id = $1` },
  refresh_tokens: { sql: `delete from refresh_tokens where user_id = $1` },
  auth_factors: { sql: `delete from auth_factors where user_id = $1` },
  auth_recovery_codes: { sql: `delete from auth_recovery_codes where user_id = $1` },
  /*
   * Keyed on the address rather than the account — `auth_attempts.identity_key` is
   * deliberately not a foreign key, because most failed sign-ins name an address
   * with no account and those are the ones worth counting (0016). So this statement
   * has to read the live email, which is why the `users` step runs last.
   */
  auth_attempts: {
    sql: `delete from auth_attempts
           where identity_key = (select lower(email) from users where id = $1)`,
  },
  push_tokens: { sql: `delete from push_tokens where user_id = $1` },
  notification_preferences: {
    sql: `delete from notification_preferences where user_id = $1`,
  },
  notifications: { sql: `delete from notifications where recipient_user_id = $1` },
  // Pending only, and keyed on the address for the same reason as `auth_attempts`.
  invites: {
    sql: `delete from invites
           where status = 'PENDING'
             and lower(email) = (select lower(email) from users where id = $1)`,
  },

  // ── Preserved, and counted so the record can prove it ──────────────────────
  time_logs: { sql: `select count(*)::int as n from time_logs where logged_by_user_id = $1` },
  expenses: { sql: `select count(*)::int as n from expenses where logged_by_user_id = $1` },
  project_submissions: {
    sql: `select count(*)::int as n from project_submissions where submitted_by_user_id = $1`,
  },
  audit_logs: { sql: `select count(*)::int as n from audit_logs where actor_user_id = $1` },
  line_item_notes: {
    sql: `select count(*)::int as n from line_item_notes where author_user_id = $1`,
  },
  data_exports: {
    sql: `select count(*)::int as n from data_exports where subject_user_id = $1`,
  },
  company_creation_allowances: {
    sql: `select count(*)::int as n from company_creation_allowances where user_id = $1`,
  },
  trial_grants: { sql: `select count(*)::int as n from trial_grants where user_id = $1` },
};

/**
 * A company's closure.
 *
 * Read this next to `COMPANY_CLOSURE_PLAN`: the PRESERVE list is longer than the
 * REMOVE list, and that is the answer rather than a shortfall. §10 is
 * unconditional — one tenant's closure may never remove another tenant's record of
 * a shared fact — and almost everything a company owns after it has traded is
 * jointly held.
 */
export const COMPANY_STATEMENTS: Readonly<Record<string, ClosureStatement>> = {
  /*
   * The name, country and registration id are untouched. See 0022: they are the
   * counterparty's record of who they traded with, and renaming them would buy a
   * legal person's privacy with the falsification of somebody else's books.
   */
  companies: {
    sql: `update companies set closed_at = now(), updated_at = now()
           where id = $1 and closed_at is null`,
  },
  memberships: { sql: `delete from memberships where company_id = $1` },
  invites: {
    sql: `delete from invites where target_company_id = $1 and status = 'PENDING'`,
  },
  /*
   * Cancelled, not deleted. A company that closed while on a paid plan is a fact
   * somebody will ask about; what has to stop is the renewal.
   */
  company_subscriptions: {
    sql: `update company_subscriptions set status = 'CANCELED', updated_at = now()
           where company_id = $1 and status <> 'CANCELED'`,
  },
  company_entitlement_overrides: {
    sql: `delete from company_entitlement_overrides where company_id = $1`,
  },
  /*
   * **Provider-side rows only.** `audit_settings` is per-engagement and owned by
   * the side whose data is being exposed (0005), so the row on an engagement where
   * the closing company is the *client* is the counterparty's setting about their
   * own exposure. Deleting that would be one tenant reconfiguring another's portal
   * on the way out.
   */
  audit_settings: {
    sql: `delete from audit_settings
           where engagement_id in (select id from engagements where provider_company_id = $1)`,
  },
  rate_card_templates: { sql: `delete from rate_card_templates where company_id = $1` },
  // Drafts only. An issued invoice is the counterparty's claim; a draft was never
  // shown to anybody. Items go by cascade.
  invoices: {
    sql: `delete from invoices where issuer_company_id = $1 and status = 'DRAFT'`,
  },
  notifications: { sql: `delete from notifications where company_id = $1` },

  // ── Preserved ─────────────────────────────────────────────────────────────
  rate_cards: { sql: `select count(*)::int as n from rate_cards where company_id = $1` },
  role_catalog: { sql: `select count(*)::int as n from role_catalog where company_id = $1` },
  engagements: {
    sql: `select count(*)::int as n from engagements
           where client_company_id = $1 or provider_company_id = $1`,
  },
  projects: {
    sql: `select count(*)::int as n from projects
           where owner_company_id = $1 or client_company_id = $1`,
  },
  time_logs: {
    sql: `select count(*)::int as n from time_logs t
           join projects p on p.id = t.project_id
          where t.provider_company_id = $1 or p.owner_company_id = $1`,
  },
  expenses: {
    sql: `select count(*)::int as n from expenses e
           join projects p on p.id = e.project_id
          where e.provider_company_id = $1 or p.owner_company_id = $1`,
  },
  audit_logs: { sql: `select count(*)::int as n from audit_logs where company_id = $1` },
  data_exports: {
    sql: `select count(*)::int as n from data_exports where subject_company_id = $1`,
  },
  trial_grants: { sql: `select count(*)::int as n from trial_grants where company_id = $1` },
};

/**
 * The order the acting steps run in, and it is not the plan's reading order.
 *
 * **`users` is last, because two other steps have to read the identity it
 * destroys.** `auth_attempts` and `invites` are keyed on the email address rather
 * than on the account — deliberately, for reasons that belong to those tables
 * (0016's comment on why `identity_key` is not a foreign key) — so anonymising the
 * `users` row first would leave both sets of rows orphaned and un-findable, holding
 * a real address after the closure claimed to have removed it. The failure would be
 * silent: both statements would report zero rows and the run would report success.
 *
 * Asserted in `steps.test.ts` rather than left as a comment, because "runs last" is
 * exactly the kind of property an unrelated refactor reorders.
 */
export const PERSONAL_ACTING_ORDER: readonly string[] = [
  'memberships',
  'auth_sessions',
  'refresh_tokens',
  'auth_factors',
  'auth_recovery_codes',
  'auth_attempts',
  'push_tokens',
  'notification_preferences',
  'notifications',
  'invites',
  'users',
];

/** The company arm has no such dependency; the plan's own order is fine. */
export const COMPANY_ACTING_ORDER: readonly string[] = [
  'memberships',
  'invites',
  'company_subscriptions',
  'company_entitlement_overrides',
  'audit_settings',
  'rate_card_templates',
  'invoices',
  'notifications',
  'companies',
];

export interface ClosureScopeSpec {
  readonly plan: readonly ClosureStep[];
  readonly statements: Readonly<Record<string, ClosureStatement>>;
  readonly actingOrder: readonly string[];
}

export const CLOSURE_SPECS: Readonly<Record<'PERSONAL' | 'COMPANY', ClosureScopeSpec>> = {
  PERSONAL: {
    plan: PERSONAL_CLOSURE_PLAN,
    statements: PERSONAL_STATEMENTS,
    actingOrder: PERSONAL_ACTING_ORDER,
  },
  COMPANY: {
    plan: COMPANY_CLOSURE_PLAN,
    statements: COMPANY_STATEMENTS,
    actingOrder: COMPANY_ACTING_ORDER,
  },
};
