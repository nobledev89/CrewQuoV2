/**
 * What leaves the platform in a data export, named column by column.
 *
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §7 and §14 step 5, and owner decision §13.2 — export is **free for everyone,
 * including the free `crew` plan**, so there is no entitlement key here and no plan
 * check anywhere downstream. JSON plus CSV per table, never a PDF: the format exists to
 * be re-imported, re-checked and diffed by the auditor who asked for it.
 *
 * **The allowlist is per *column*, not per table, and that is the whole reason this file
 * exists.** A table-level list looks sufficient right up until you read one row. A crew
 * member's `time_logs` row is unambiguously about them — their date, their hours, their
 * approval — and it also carries `resolved_rate`, a frozen snapshot of what the hiring
 * company pays the provider company for that hour. That is an inter-company commercial
 * term. The person whose hours they are has no claim on it and frequently is not paid it,
 * since PAY is what one company charges another and not what an individual earns. So a
 * personal export built from "the tables where this person appears" hands every crew
 * member their employer's margin, and it does so while looking exactly like compliance.
 *
 * The same asymmetry runs the other way. A company export is scoped to rows the company
 * owns or is a party to, which structurally excludes the counterparty's own rate cards —
 * but §4's rule that a provider never reads a client's BILL figure is a *field* rule, and
 * an export is the largest surface it has ever had to survive.
 *
 * So: two scopes, each an explicit list of tables, each table an explicit list of
 * columns, each with the reason written down. Nothing is derived from the schema, because
 * a spec derived from the schema grows a new column every time the schema does — silently,
 * in a migration whose author was thinking about something else.
 */

/** One table's contribution to a bundle. */
export interface ExportTableSpec {
  /** Table name, which is also the bundle's filename stem: `time_logs.json`/`.csv`. */
  readonly table: string;
  /** Why this table belongs in this scope. One line, for the person reading the bundle. */
  readonly because: string;
  /** How rows are narrowed. Prose, and the builder's query has to match it. */
  readonly scope: string;
  /** Exactly the columns that leave. Anything not named here does not go. */
  readonly columns: readonly string[];
  /**
   * Columns deliberately withheld from a table that is otherwise included, with the
   * reason. Not required — most tables have nothing interesting to say — but where a
   * column was considered and rejected, saying so is what stops it being added back by
   * somebody who assumes it was an oversight.
   */
  readonly withheld?: readonly { readonly column: string; readonly why: string }[];
}

/**
 * A person's own data. Free and unconditional — it is a legal obligation, and charging
 * for an obligation makes it an upsell.
 */
export const PERSONAL_EXPORT: readonly ExportTableSpec[] = [
  {
    table: 'account',
    because: 'The identity itself: who this account is and when it was confirmed.',
    scope: 'The one `users` row for the requester.',
    columns: ['id', 'email', 'name', 'avatar_url', 'email_verified_at', 'created_at', 'updated_at'],
    withheld: [
      { column: 'password_hash', why: 'A credential. Exporting a hash publishes something offline-crackable about a password the person may reuse.' },
      { column: 'google_sub', why: "An identifier in another provider's namespace, not a fact about this person that this platform is entitled to hand out." },
      { column: 'is_super_admin', why: 'A platform authorization fact about the operator role, not personal data about the human.' },
    ],
  },
  {
    table: 'memberships',
    because: 'Which companies this person belongs to, in what role — the shape of their working life on the platform.',
    scope: 'Rows where `user_id` is the requester.',
    columns: ['id', 'company_id', 'role', 'status', 'created_at', 'updated_at'],
  },
  {
    table: 'time_logs',
    because: 'The hours this person recorded, and what happened to them.',
    scope: 'Rows where `logged_by_user_id` is the requester.',
    columns: [
      'id', 'project_id', 'provider_company_id', 'role_id', 'shift_type', 'work_date',
      'hours_regular', 'hours_ot', 'status', 'reviewed_at', 'reject_reason',
      'created_at', 'updated_at',
    ],
    withheld: [
      {
        column: 'resolved_rate',
        why: "The frozen PAY snapshot — an inter-company commercial term, not this person's wage. Including it would hand every crew member their employer's cost base under the heading of their own data.",
      },
      {
        column: 'reviewed_by_user_id',
        why: 'Identifies the approver, who is a different person. Whether their hours were approved is the requester\'s fact; who approved them is not.',
      },
    ],
  },
  {
    table: 'expenses',
    because: 'What this person spent and claimed back. The amount is theirs, unlike a rate.',
    scope: 'Rows where `logged_by_user_id` is the requester.',
    columns: [
      'id', 'project_id', 'provider_company_id', 'amount_cents', 'category', 'description',
      'status', 'reviewed_at', 'reject_reason', 'created_at', 'updated_at',
    ],
    withheld: [
      { column: 'receipt_url', why: 'A storage pointer, not a value. It will be a real file in the bundle once the storage service exists (Phase 7.0); a dangling URL now would look like data and resolve to nothing.' },
      { column: 'reviewed_by_user_id', why: "Identifies the approver, who is somebody else. That the claim was approved is the requester's fact; who approved it is not." },
    ],
  },
  {
    table: 'project_submissions',
    because: 'The periods of work this person submitted for approval.',
    scope: 'Rows where `submitted_by_user_id` is the requester.',
    columns: ['id', 'project_id', 'provider_company_id', 'period_start', 'period_end', 'status', 'reviewed_at', 'reject_reason', 'created_at', 'updated_at'],
    withheld: [{ column: 'reviewed_by_user_id', why: "Identifies the approver, who is somebody else. A subject-access request is not a route to a colleague's activity." }],
  },
  {
    table: 'sessions',
    because: 'Where this account has been signed in — the record the security screen shows, in a form that can be kept.',
    scope: 'Rows in `auth_sessions` where `user_id` is the requester.',
    columns: ['id', 'device_label', 'created_at', 'last_used_at', 'expires_at', 'revoked_at', 'revoked_cause'],
    withheld: [
      { column: 'revoked_by_user_id', why: 'An operator or another owner; identifying them is not part of this person\'s record.' },
      { column: 'revoked_reason', why: 'Free text written by whoever revoked it, for their own audit — not a statement to the subject.' },
    ],
  },
  {
    table: 'notifications',
    because: 'What the platform told this person, so the record of being told survives the account.',
    scope: 'Rows where `recipient_user_id` is the requester.',
    columns: ['id', 'company_id', 'kind', 'title', 'body', 'urgency', 'requires_action', 'read_at', 'resolved_at', 'dismissed_at', 'created_at'],
    withheld: [{ column: 'resolved_by_user_id', why: 'Somebody else may have resolved the task on their behalf, and naming that person exports a fact about them rather than about the requester.' }],
  },
  {
    table: 'notification_preferences',
    because: 'The choices this person made about being contacted.',
    scope: 'Rows where `user_id` is the requester.',
    columns: ['user_id', 'digest', 'channels', 'quiet_hours_start', 'quiet_hours_end', 'time_zone', 'created_at', 'updated_at'],
  },
];

/**
 * A company's own commercial record.
 *
 * Scoped to what the company owns or is a party to. The counterparty's rate cards are
 * excluded structurally rather than by a filter — `where company_id = $1` cannot return
 * somebody else's card — which is the right way round: a boundary enforced by the shape
 * of the query rather than by remembering to add a condition.
 */
export const COMPANY_EXPORT: readonly ExportTableSpec[] = [
  {
    table: 'company',
    because: 'The company record itself, including the settings every figure in this bundle is denominated and dated by.',
    scope: 'The one `companies` row.',
    columns: ['id', 'name', 'currency', 'country', 'registration_id', 'time_zone', 'created_at', 'updated_at'],
    withheld: [
      { column: 'registration_id_normalized', why: 'A derived matching key for the duplicate check, not a fact the company stated about itself.' },
      { column: 'claimed_by_company_id', why: 'Internal placeholder-claiming bookkeeping; it describes another company\'s action.' },
      { column: 'settings', why: 'A mixed bag including internal fixture markers. Anything in it that is a real setting has its own column or its own table.' },
    ],
  },
  {
    table: 'members',
    because: 'Who is in this company and in what role — the membership facts a company\'s admins already administer.',
    scope: '`memberships` joined to `users`, for this company.',
    columns: ['id', 'user_id', 'name', 'email', 'role', 'status', 'created_at', 'updated_at'],
    withheld: [{ column: 'password_hash', why: 'A credential, never exportable in any scope, and the reason this join names its columns instead of selecting the whole user row.' }],
  },
  {
    table: 'engagements',
    because: 'The trading relationships this company is a party to, and the terms agreed on them.',
    scope: 'Rows where this company is the client or the provider.',
    columns: [
      'id', 'client_company_id', 'provider_company_id', 'status', 'created_by_company_id',
      'payment_terms_days', 'purchase_order_reference', 'purchase_order_ceiling_cents',
      'terms_updated_at', 'provider_accepted_at', 'decision_reason', 'created_at', 'updated_at',
    ],
  },
  {
    table: 'projects',
    because: 'The work. Owned projects in full; projects this company was engaged on, as a party to them.',
    scope: 'Rows where this company is the owner, the client, or the provider on an assignment.',
    columns: ['id', 'owner_company_id', 'client_company_id', 'engagement_id', 'name', 'status', 'client_visible', 'starts_on', 'ends_on', 'notes', 'reporting_currency', 'time_zone', 'created_at', 'updated_at'],
  },
  {
    table: 'project_assignments',
    because: 'Which provider was put on which project, and whether they accepted.',
    scope: 'Assignments on projects in scope, or where this company is the provider.',
    columns: ['id', 'project_id', 'provider_company_id', 'engagement_id', 'acceptance', 'accepted_at', 'decision_reason', 'created_at', 'updated_at'],
  },
  {
    table: 'role_catalog',
    because: "This company's own role definitions.",
    scope: 'Rows where `company_id` is this company.',
    columns: ['id', 'name', 'created_at', 'updated_at'],
  },
  {
    table: 'rate_cards',
    because: "This company's own priced rules — both PAY and BILL, because both are its own.",
    scope: 'Rows where `company_id` is this company. A counterparty\'s cards are unreachable by construction.',
    columns: [
      'id', 'kind', 'counterparty_company_id', 'role_id', 'rate_mode', 'rate_label',
      'hourly_rate_cents', 'ot_hourly_rate_cents', 'shift_rate_cents', 'daily_rate_cents',
      'min_hours', 'weekend_multiplier', 'night_multiplier', 'effective_from', 'effective_to',
      'active', 'version', 'locked', 'supersedes_rate_card_id', 'created_at', 'updated_at',
    ],
  },
  {
    table: 'time_logs',
    because: 'The hours behind every figure in this bundle, including the frozen rate the company was charged or paid.',
    scope: 'Rows on projects this company owns, or where this company is the provider.',
    columns: [
      'id', 'project_id', 'provider_company_id', 'logged_by_user_id', 'role_id', 'shift_type',
      'work_date', 'hours_regular', 'hours_ot', 'status', 'resolved_rate', 'reviewed_at',
      'reject_reason', 'created_at', 'updated_at',
    ],
  },
  {
    table: 'expenses',
    because: 'Costs claimed against this company\'s projects.',
    scope: 'Rows on projects this company owns, or where this company is the provider.',
    columns: ['id', 'project_id', 'provider_company_id', 'logged_by_user_id', 'amount_cents', 'category', 'description', 'status', 'reviewed_at', 'reject_reason', 'created_at', 'updated_at'],
  },
  {
    table: 'invoices',
    because: 'What was billed, to whom, and when it was due.',
    scope: 'Rows where this company is the issuer or the counterparty.',
    columns: ['id', 'engagement_id', 'issuer_company_id', 'counterparty_company_id', 'project_id', 'number', 'status', 'subtotal_cents', 'tax_cents', 'total_cents', 'issued_at', 'due_at', 'created_at', 'updated_at'],
  },
  {
    table: 'invoice_items',
    because: 'The lines those totals are made of.',
    scope: 'Items on invoices in scope.',
    columns: ['id', 'invoice_id', 'description', 'quantity', 'unit_amount_cents', 'amount_cents', 'source_type', 'source_id', 'created_at'],
  },
  {
    table: 'audit_logs',
    because: 'This company\'s own record of who did what — the evidence trail, not a summary of it.',
    scope: 'Rows where `company_id` is this company.',
    columns: ['id', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'changes', 'description', 'visible_to_client', 'created_at'],
    withheld: [{ column: 'expires_at', why: 'A retention mechanism, not a fact about the audited event.' }],
  },
];

/**
 * Substrings that may never appear in any exported column name, in any scope.
 *
 * A canary over the allowlist rather than a second mechanism. The allowlist is already
 * the guarantee; this exists because the way an allowlist fails is somebody adding one
 * plausible line to it, and `password_hash` in a list of forty column names does not look
 * wrong at a glance. Every entry here is a name pattern that is *never* exportable
 * whatever the scope, so a future edit that reaches for one fails the build.
 */
export const NEVER_EXPORTED_PATTERNS: readonly string[] = [
  'password',
  'secret',
  'token',
  'hash',
  'google_sub',
  'recovery_code',
  'pepper',
  'is_super_admin',
];

/** Every column named by a scope, for the canary and for tests. */
export function exportedColumns(scope: readonly ExportTableSpec[]): string[] {
  return scope.flatMap((spec) => spec.columns);
}

/**
 * The bundle's own description of itself.
 *
 * Written into `manifest.json` so the bundle is self-explanatory a year later, in a
 * different tool, to somebody who has never seen this repository. It carries the
 * *withheld* list as well as the included one, because "why is my pay rate not in here"
 * is the first question a careful reader of a personal export will have, and an
 * unexplained absence reads as a bug or as evasion.
 */
export interface ExportManifest {
  readonly scope: 'PERSONAL' | 'COMPANY';
  readonly generatedAt: string;
  readonly subjectId: string;
  readonly tables: readonly {
    readonly table: string;
    readonly because: string;
    readonly scope: string;
    readonly rowCount: number;
    readonly columns: readonly string[];
    readonly withheld?: readonly { readonly column: string; readonly why: string }[];
  }[];
  readonly notes: readonly string[];
}

/**
 * The notes every bundle carries.
 *
 * The second is the sentence the deletion decision (§13.1) committed the product to
 * saying *before* the button rather than after it. It appears here because an export is
 * the thing a person does immediately before erasing themselves, which makes this bundle
 * the last honest moment to say what erasure will and will not do.
 */
export const EXPORT_NOTES: readonly string[] = [
  'Amounts are integer minor units of the currency named on the company record — 9200 is 92.00, and nothing here is rounded or converted.',
  'Deleting your account anonymises you and preserves the records: the hours you logged remain, without your name on them. Counterparties keep their own evidence of work already invoiced.',
  'Every table is a complete extract of its scope at the moment named in generatedAt, not a page of one.',
];

/**
 * One table as RFC 4180 CSV.
 *
 * Hand-rolled rather than pulled in, because the whole of CSV that matters here is the
 * quoting rule, and the failure it prevents is specific: a company called
 * `*SUS Contracting, Ltd` or a rejection reason containing a newline would otherwise
 * shift every following column by one and produce a file that opens cleanly and says
 * something false. A spreadsheet does not report a ragged row; it just shows the wrong
 * number under the wrong heading.
 *
 * Columns are taken from the spec, never from the first row's keys: a table whose first
 * row happens to have a null in the last column must still emit that column's header, or
 * two exports of the same table have different shapes and cannot be diffed.
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(','));
  }
  // Trailing newline: POSIX text files end with one, and its absence makes `wc -l`
  // and a good many importers disagree about the last row.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * One cell, quoted only where quoting is required.
 *
 * **Null and empty string are deliberately different**, and CSV gives exactly one way to
 * say so: an empty field is null, and `""` is the empty string. Collapsing them would
 * turn "no reason was given" into "the reason was blank", which in a rejection column is
 * a different claim about what happened.
 *
 * A Date becomes an ISO instant, and an object becomes JSON — a `jsonb` column such as
 * `resolved_rate` or an audit row's `changes` is structured data, and flattening it to
 * `[object Object]` is the one outcome worse than a nested string.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  // A leading =, +, - or @ is a formula to Excel and Sheets, so a description reading
  // `=1+1` executes on open. Prefixed with a tab inside the quotes, which every importer
  // treats as text and no spreadsheet treats as a formula.
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `\t${raw}` : raw;
  // The empty string is quoted even though it needs no escaping, because that is the only
  // way CSV has of distinguishing it from null. This was asserted in the comment above
  // before it was true in the code, and the test that checks the claim caught it.
  if (guarded === '') return '""';
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
