import { z } from 'zod';

/**
 * What closing an account actually does, named table by table.
 *
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §3, §5, §6, §10 and §14 step 5, and the owner decision recorded there as §13.1:
 * **anonymise the person, preserve the record** — with a live-engagement
 * precondition added for a company.
 *
 * **The reason this file exists is that "delete my data" is two promises and only
 * one of them can be kept in full.** Sam's time log is his employer's payroll
 * record and the hiring company's proof of an invoiced hour. Deleting it on Sam's
 * request destroys a record the other company is legally obliged to keep and never
 * agreed to lose; deleting nothing makes the promise a lie. So the personal fields
 * are overwritten, the account cannot sign in, and every evidence row survives
 * attributed to a withdrawn person — and the cost of that is stated to the person
 * *before* the button rather than discovered after it: **the hours you logged
 * remain, without your name on them.**
 *
 * Everything here is pure and data-shaped, for the same reason `data-export.ts` is:
 * a plan derived from the schema grows a step every time the schema does, silently,
 * in a migration whose author was thinking about something else. The executor in
 * `apps/api/src/modules/deletion/execute.ts` is paired to these lists in both
 * directions by a test, so a table added here with no step fails the build rather
 * than being quietly skipped.
 */

// ── The state machine ─────────────────────────────────────────────────────────

export const DELETION_STATUSES = [
  'REQUESTED',
  'SCHEDULED',
  'EXECUTING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;
export const deletionStatusSchema = z.enum(DELETION_STATUSES);
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;

export const DELETION_SCOPES = ['PERSONAL', 'COMPANY'] as const;
export const deletionScopeSchema = z.enum(DELETION_SCOPES);
export type DeletionScope = z.infer<typeof deletionScopeSchema>;

/**
 * The cooling-off window, and it is load-bearing rather than polite.
 *
 * Deletion is the one irreversible action a customer can take, and the two things
 * that most often precede it are a mistake and somebody else holding the account.
 * A delay with an unconditional notice to the holder turns both into a recoverable
 * event; without it, the notification arrives after the only copy is gone — which
 * is the same shape as the access packet's operator reset, and the same reason.
 *
 * Seven days rather than a token twenty-four hours: the person who most needs this
 * window is the one who is on site all week and reads their email on Sunday, and a
 * one-day window is a window that only protects people at their desks. Long enough
 * to be noticed, short enough that somebody who meant it is not left waiting on
 * the platform they are trying to leave.
 */
export const DELETION_COOLING_OFF_DAYS = 7;

/** The second notice goes one day out (§6). Both are urgent and both override quiet hours. */
export const DELETION_IMMINENT_NOTICE_HOURS = 24;

/** When a request made now becomes due. Stored on the row, never re-derived — see 0022. */
export function deletionScheduledFor(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + DELETION_COOLING_OFF_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Is the one-day-out notice due?
 *
 * Guarded on `alreadySent` rather than on a window, because a job that runs hourly
 * would otherwise send twenty-four of them. The row records when it went, so the
 * question is answerable after a restart.
 */
export function imminentNoticeDue(input: {
  now: Date;
  scheduledFor: Date;
  alreadySent: boolean;
}): boolean {
  if (input.alreadySent) return false;
  const lead = DELETION_IMMINENT_NOTICE_HOURS * 60 * 60 * 1000;
  return input.scheduledFor.getTime() - input.now.getTime() <= lead;
}

/**
 * Cancellable from `REQUESTED` and `SCHEDULED` only (§3).
 *
 * Not from `EXECUTING`: by then rows are being rewritten inside a transaction, and
 * a screen offering to stop something that cannot be stopped is worse than one
 * that says it is too late. Not from a terminal state for the obvious reason.
 */
export function canCancelDeletion(status: DeletionStatus): boolean {
  return status === 'REQUESTED' || status === 'SCHEDULED';
}

export function isTerminalDeletionStatus(status: DeletionStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED' || status === 'FAILED';
}

/**
 * A request the executor may act on.
 *
 * **`SCHEDULED` and not `REQUESTED`, and that is the safety property rather than a
 * tidy-up.** The notice to the holder goes through the outbox, and the handler that
 * sends it is what advances `REQUESTED → SCHEDULED`. So a row still in `REQUESTED`
 * when its deadline passes is a row nobody was warned about — a permanently
 * dead-lettered notice, a mail provider outage that outlasted the retry budget —
 * and running it would delete an account in silence. The whole value of a
 * cooling-off period is that the warning arrives first.
 */
export function deletionIsExecutable(input: {
  status: DeletionStatus;
  scheduledFor: Date;
  now: Date;
}): boolean {
  return input.status === 'SCHEDULED' && input.scheduledFor.getTime() <= input.now.getTime();
}

// ── The withdrawn identity ────────────────────────────────────────────────────

/**
 * What replaces a name once the person is gone.
 *
 * A name rather than a blank, because the attribution is the point: §13.1 chose
 * "attributed to a withdrawn person" over "attributed to nobody", and an approval
 * row whose actor column is empty reads as a bug in the audit trail rather than as
 * a person who left.
 */
export const WITHDRAWN_PERSON_NAME = 'Withdrawn person';

/**
 * The tombstone address.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so a stray
 * send cannot reach a real inbox — which matters because this value lands in a
 * column the notification path is perfectly willing to email. Keyed on the user id
 * so the `users.email` unique index is satisfied without a counter, and so two
 * closures cannot collide.
 *
 * **It carries nothing of the person.** No hash of the old address, no first
 * initial, no domain. A hashed email is still an identifier of a human being, and
 * keeping one to recognise somebody who asked to be forgotten is the erasure being
 * quietly declined. The consequence is stated rather than hidden: the old address
 * becomes registerable again, and a fresh registration is a fresh identity with a
 * fresh §3.1.1 first-company allowance. That is a free trial's worth of abuse
 * surface, traded for not retaining the one field the request was about.
 */
export function withdrawnEmail(userId: string): string {
  return `withdrawn-${userId}@closed.crewquo.invalid`;
}

// ── The plan ──────────────────────────────────────────────────────────────────

export const CLOSURE_ACTIONS = ['ANONYMISE', 'REMOVE', 'PRESERVE'] as const;
export type ClosureAction = (typeof CLOSURE_ACTIONS)[number];

/** One table's fate in a closure run. */
export interface ClosureStep {
  /**
   * The table this step acts on. Also the key it counts under in
   * `deletion_requests.counts`, so a completed run's record names real tables.
   */
  readonly table: string;
  readonly action: ClosureAction;
  /** Why this table gets this treatment. One line, and it is the argument. */
  readonly because: string;
}

/**
 * Closing a person.
 *
 * Read the `PRESERVE` rows first: they are the half of the promise that cannot be
 * kept, written down so nobody has to reverse-engineer it from the executor.
 */
export const PERSONAL_CLOSURE_PLAN: readonly ClosureStep[] = [
  {
    table: 'users',
    action: 'ANONYMISE',
    because:
      'The row survives because every preserved evidence row points at it — and `time_logs.logged_by_user_id` is `not null` regardless, so there is no version of this that deletes it. Name, email, avatar, password, Google link and platform-staff flag all go; `anonymized_at` is what refuses the next sign-in.',
  },
  {
    table: 'memberships',
    action: 'REMOVE',
    because:
      "Every membership goes, which ends access and stops the person counting against a seat their employer is billed for. The company does not lose the record of them working there: the hours, expenses and audit rows are all preserved and still attributed. A membership left in place would be a ghost in the member list and a line on an invoice for somebody who is gone.",
  },
  {
    table: 'auth_sessions',
    action: 'REMOVE',
    because:
      'A device list is personal data — "Chrome on Windows", last seen, the shape of somebody\'s week. Removed rather than revoked, because a revoked session still names the device.',
  },
  {
    table: 'refresh_tokens',
    action: 'REMOVE',
    because: 'Credentials. Nothing may still be exchangeable for a token on this account.',
  },
  {
    table: 'auth_factors',
    action: 'REMOVE',
    because:
      'A TOTP secret is a credential, and this schema stores it in plain text as a stated decision (0019). It cannot outlive the account.',
  },
  {
    table: 'auth_recovery_codes',
    action: 'REMOVE',
    because: 'Credentials, including the spent ones — a used code is still a hash of a secret.',
  },
  {
    table: 'auth_attempts',
    action: 'REMOVE',
    because:
      "Sign-in attempts are keyed on the address, not the account, so they survive the anonymisation unless removed by hand — and a row saying somebody tried to sign in as sam@example.com eleven times is a record about a person whose account no longer exists. Rows for the old address only; the hashed source counters of everybody else stay.",
  },
  {
    table: 'push_tokens',
    action: 'REMOVE',
    because:
      'A device token is both personal and live: leaving one behind means a future notification for preserved work would ring on a phone belonging to somebody who left.',
  },
  {
    table: 'notification_preferences',
    action: 'REMOVE',
    because: "Quiet hours and a time zone describe a person's day.",
  },
  {
    table: 'invites',
    action: 'REMOVE',
    because:
      "**Pending invites addressed to this person, and this step is not obvious.** An invite is keyed on an email address, and a closure releases the address — it is overwritten rather than retained, deliberately. Leaving one pending would mean whoever registers that address next inherits a seat in a company that invited somebody else. Pending only: an accepted invite is the history of how somebody joined.",
  },
  {
    table: 'notifications',
    action: 'REMOVE',
    because:
      "Messages addressed to this person, composed about their work. Their channel deliveries go with them by cascade. The one exception is written after this step: the notice that the closure is done, which needs an inbox row to be a durable, retryable send.",
  },
  {
    table: 'time_logs',
    action: 'PRESERVE',
    because:
      "**This is the promise that cannot be kept in full, and the assertion that proves the policy.** The hours are the employer's payroll record and the hiring company's proof of an invoiced hour. They still price, total and invoice to the cent — attributed to a withdrawn person rather than to nobody.",
  },
  {
    table: 'expenses',
    action: 'PRESERVE',
    because: 'Money already claimed and approved against a project somebody else is paying for.',
  },
  {
    table: 'project_submissions',
    action: 'PRESERVE',
    because: 'A period of work submitted and decided — the counterparty\'s record of an approval.',
  },
  {
    table: 'audit_logs',
    action: 'PRESERVE',
    because:
      "The company's own evidence of who did what, subject to its own retention rather than to this run. Removing an actor's rows would leave a trail with holes exactly where somebody left, which is the shape of a cover-up.",
  },
  {
    table: 'line_item_notes',
    action: 'PRESERVE',
    because:
      'A note on an invoice line is half of a conversation the counterparty had and read. Deleting one side of it rewrites their record.',
  },
  {
    table: 'data_exports',
    action: 'PRESERVE',
    because:
      "The record that a concentrated disclosure happened. 0021 already made this `on delete set null` rather than cascade for the same reason: a disclosure record that vanishes with the account is exactly the one you would want after the account is gone.",
  },
  {
    table: 'company_creation_allowances',
    action: 'PRESERVE',
    because:
      "§3.1.1's permanently ledgered first-company allowance. Removing it would make erasure the way to re-earn a free company — and the ledger row names a user id, not a person.",
  },
  {
    table: 'trial_grants',
    action: 'PRESERVE',
    because:
      '§3.1.1(5) again: closing an account may not reset trial eligibility. Same reasoning as the allowance.',
  },
];

/**
 * Closing a company — and it is a closure, not an erasure. The difference is the
 * whole design and it is said out loud on the confirmation screen.
 *
 * A person's name goes because it identifies a human with an erasure right. A
 * company's name stays because it is *the counterparty's* record of who they traded
 * with, and §10 is unconditional: one tenant's deletion may never remove another
 * tenant's record of a shared fact. Renaming Northgate to "Withdrawn company"
 * would leave every client holding invoices from nobody — privacy for a legal
 * person bought with the falsification of somebody else's books.
 *
 * So what a company gets is: access ends, billing stops, its own private
 * commercial configuration goes, and everything a counterparty is party to stays
 * theirs.
 */
export const COMPANY_CLOSURE_PLAN: readonly ClosureStep[] = [
  {
    table: 'companies',
    action: 'ANONYMISE',
    because:
      "`closed_at` is set and nothing else moves. The name, country and registration id stay because they are the counterparty's record of who they traded with — see above. The word ANONYMISE is kept for the shape of the run rather than for what it does to the name.",
  },
  {
    table: 'memberships',
    action: 'REMOVE',
    because:
      'Nobody may act as a closed company. Removing the memberships is what enforces that everywhere at once, because the auth middleware resolves the active company from this table on every request.',
  },
  {
    table: 'invites',
    action: 'REMOVE',
    because:
      'A pending invite into a closed company is a door left open. Only pending ones: an accepted invite is the history of how somebody joined.',
  },
  {
    table: 'company_subscriptions',
    action: 'ANONYMISE',
    because:
      "Cancelled rather than deleted. The billing record is the platform's, and a company that closed on a paid plan is a fact somebody will ask about; what must stop is the renewal.",
  },
  {
    table: 'company_entitlement_overrides',
    action: 'REMOVE',
    because: 'Support decisions about a tenant that no longer operates.',
  },
  {
    table: 'audit_settings',
    action: 'REMOVE',
    because: "Per-engagement portal settings — this company's own configuration, read by nobody now.",
  },
  {
    table: 'rate_card_templates',
    action: 'REMOVE',
    because:
      "The company's own private timeframe and label rules. Nothing references a template, so this is the one piece of commercial configuration that can actually go.",
  },
  {
    table: 'invoices',
    action: 'REMOVE',
    because:
      "**Drafts only, and the distinction is the point: an unissued invoice was never shown to anybody.** An issued one is the counterparty's claim and stays. Items go by cascade.",
  },
  {
    table: 'notifications',
    action: 'REMOVE',
    because: "Messages about this company's work, to people who no longer have access to it.",
  },
  {
    table: 'rate_cards',
    action: 'PRESERVE',
    because:
      "Wanted gone and cannot be: a counterparty's rate-proposal history references these rows (`rate_proposal_lines.replaces_rate_card_id`), so deleting them would delete the provenance of the other side's negotiation. Unreadable in practice — no member is left to resolve a rate — but honestly still here.",
  },
  {
    table: 'role_catalog',
    action: 'PRESERVE',
    because:
      'A role is the label on preserved evidence: `time_logs.role_id` points at it and is `not null`. Deleting the catalog would make the counterparty\'s hours read as hours of nothing.',
  },
  {
    table: 'engagements',
    action: 'PRESERVE',
    because:
      'A trading relationship is jointly held by definition. It must be ENDED before the run proceeds, which is what the live-engagement precondition is for — but ended is not deleted.',
  },
  {
    table: 'projects',
    action: 'PRESERVE',
    because: "The work. The client's record of what was done for them, and the provider's of what they did.",
  },
  {
    table: 'time_logs',
    action: 'PRESERVE',
    because: 'Hours already approved and invoiced across a company boundary. §10, without exception.',
  },
  {
    table: 'expenses',
    action: 'PRESERVE',
    because: 'Costs already claimed and decided on somebody else\'s project.',
  },
  {
    table: 'audit_logs',
    action: 'PRESERVE',
    because:
      "Left to expire under the company's own `audit_retention_days` rather than purged now, because the client-visible slice of this trail is what a counterparty reads in the portal.",
  },
  {
    table: 'data_exports',
    action: 'PRESERVE',
    because: 'The record that somebody extracted the whole company, which outlives the company.',
  },
  {
    table: 'trial_grants',
    action: 'PRESERVE',
    because:
      '§3.1.1(5): closing a company may not reset trial eligibility. 0011 already refused to cascade this for exactly the loophole being closed here.',
  },
];

export const CLOSURE_PLANS: Readonly<Record<DeletionScope, readonly ClosureStep[]>> = {
  PERSONAL: PERSONAL_CLOSURE_PLAN,
  COMPANY: COMPANY_CLOSURE_PLAN,
};

/**
 * Substrings that may never appear in a `REMOVE` step, in either scope.
 *
 * A canary over the plan rather than a second mechanism, the same shape
 * `data-export.ts` uses and for the same reason: the way a hand-written list fails
 * is somebody adding one plausible line to it, and `time_logs` in a column of
 * twenty table names does not look wrong at a glance. Every entry here is a table
 * that is jointly held — one tenant's closure may never remove another tenant's
 * record of a shared fact (§10) — so a future edit that reaches for one fails the
 * build.
 */
export const NEVER_REMOVED_TABLES: readonly string[] = [
  'time_logs',
  'expenses',
  'project_submissions',
  'projects',
  'engagements',
  'project_assignments',
  'audit_logs',
  'platform_audit_logs',
  'invoice_items',
  'line_item_notes',
  'record_revisions',
  'data_exports',
  'company_creation_allowances',
  'trial_grants',
];

// ── What must be said before the button ───────────────────────────────────────

/**
 * The sentences the confirmation screen has to carry.
 *
 * Here rather than in a component, and asserted by a test, because §13.1 committed
 * the product to saying a specific thing *before* the button rather than after it —
 * and the place that commitment gets quietly lost is a dialog that says "this
 * cannot be undone" and nothing else. "Cannot be undone" is true of both a promise
 * kept and a promise broken; it tells the reader nothing about which they are
 * getting.
 */
export const PERSONAL_CLOSURE_PROMISES: readonly string[] = [
  'Your name, email address and sign-in are removed, and you will not be able to sign in again.',
  'The hours you logged remain, without your name on them. Companies you worked for keep their own record of work they have already approved and invoiced.',
  `Nothing happens for ${DELETION_COOLING_OFF_DAYS} days. We email you now and again a day before, and you can cancel until the moment it runs.`,
  'Download your data first if you want a copy — afterwards there is no account to download it from.',
];

export const COMPANY_CLOSURE_PROMISES: readonly string[] = [
  'Everyone loses access to this company and the subscription is cancelled. This is not reversible.',
  'The projects, hours and invoices your clients and subcontractors are party to remain theirs, under this company\'s name — we cannot remove somebody else\'s record of who they traded with.',
  'Live engagements must be ended first. Your counterparties are told now that the relationship is ending, so they can settle or hand over before the deadline.',
  `Nothing happens for ${DELETION_COOLING_OFF_DAYS} days, and every owner and admin is told. Any of them can cancel until it runs.`,
];

// ── Preconditions ─────────────────────────────────────────────────────────────

/**
 * Facts about a person that decide whether their closure may proceed.
 *
 * Counted rather than listed for the block message, except the company names,
 * which are the only actionable part: "you are the only owner of Northgate" tells
 * somebody what to do and "you are the only owner of 1 company" does not.
 */
export interface PersonalClosureFacts {
  /** Companies where this person is the only ACTIVE owner. */
  readonly soleOwnerOf: readonly string[];
}

/**
 * Why a person's closure cannot proceed, in sentences they can act on.
 *
 * **One reason, and it is not "you have evidence".** §13.1 called refusing
 * deletion while any evidence exists indefensible for a person, and it is — it
 * makes "you may not leave" the answer to somebody who logged one hour eighteen
 * months ago. This is a different thing: an office that must be handed over. A
 * company whose only owner has vanished cannot be administered, its subscription
 * cannot be cancelled and its members cannot be managed, and the remedy is entirely
 * in the person's own hands — promote somebody, or close the company too.
 *
 * Checked at request time so the answer is immediate and actionable, and again at
 * execution, because somebody can be made a sole owner during the seven days.
 */
export function personalClosureBlocks(facts: PersonalClosureFacts): string[] {
  if (facts.soleOwnerOf.length === 0) return [];
  const names = facts.soleOwnerOf.join(', ');
  return [
    `You are the only owner of ${names}. Make somebody else an owner, or close the company first — a company with no owner cannot be administered or unsubscribed by anyone.`,
  ];
}

export interface CompanyClosureFacts {
  /** Engagements not yet ENDED, in either direction. */
  readonly liveEngagements: number;
  /** Issued invoices not yet paid or voided, in either direction. */
  readonly unsettledInvoices: number;
}

/**
 * Why a company's closure cannot run yet — the "settle or hand over" half of
 * §13.1's answer.
 *
 * **These do not refuse the request, only the run**, and that ordering is a real
 * decision rather than laxity. §6 requires every counterparty with a live
 * engagement to be told when a company starts closing itself, precisely so they can
 * settle or hand over; refusing the request while an engagement is live would mean
 * that notice could never be sent, and the customer would be told "end your
 * engagements" with no mechanism to tell the other side why. So the request is
 * accepted, the counterparties are told, and the cooling-off window is the time in
 * which the settling happens. If it has not happened by the deadline the run is
 * blocked with these reasons on the record and on the screen — visibly waiting
 * rather than quietly never happening.
 */
export function companyClosureBlocks(facts: CompanyClosureFacts): string[] {
  const blocks: string[] = [];
  if (facts.liveEngagements > 0) {
    blocks.push(
      `${facts.liveEngagements} engagement${facts.liveEngagements === 1 ? '' : 's'} ${
        facts.liveEngagements === 1 ? 'is' : 'are'
      } still live. End them — a closure may not take a counterparty's live relationship with it.`
    );
  }
  if (facts.unsettledInvoices > 0) {
    blocks.push(
      `${facts.unsettledInvoices} issued invoice${facts.unsettledInvoices === 1 ? '' : 's'} ${
        facts.unsettledInvoices === 1 ? 'is' : 'are'
      } neither paid nor voided. Settle or void them before the company goes.`
    );
  }
  return blocks;
}

// ── Wire contracts ────────────────────────────────────────────────────────────

/**
 * Requesting a closure.
 *
 * `confirm` is the literal name of the subject, typed by the requester — the
 * company's name, or the person's own email address. Deliberately not a checkbox:
 * a checkbox is one click away from an accident on the most irreversible screen in
 * the product, and typing the name is the cheapest possible proof that the person
 * knows *which* thing they are closing. It is checked server-side, because a
 * client-side confirmation is a suggestion.
 *
 * `password` / `googleIdToken` are the step-up re-authentication §4 requires for a
 * company closure and this product also requires for a personal one: an access
 * token is re-minted by refresh without anybody re-proving anything, so its age is
 * not evidence that a human is still at the keyboard.
 */
export const requestDeletionSchema = z.object({
  confirm: z.string().min(1).max(200),
  reason: z.string().max(1000).optional(),
  password: z.string().min(1).max(200).optional(),
  googleIdToken: z.string().min(1).optional(),
});
export type RequestDeletion = z.infer<typeof requestDeletionSchema>;

export const cancelDeletionSchema = z.object({
  reason: z.string().max(1000).optional(),
});
export type CancelDeletion = z.infer<typeof cancelDeletionSchema>;

/**
 * What a requester is shown about their own pending closure.
 *
 * No counts and no contents: this view is read by somebody who may be about to
 * cancel, and everything they need is the deadline and whether anything is in the
 * way. The counts belong to the completed record, which nobody with an account
 * reads.
 */
export const deletionRequestViewSchema = z.object({
  id: z.string().uuid(),
  scope: deletionScopeSchema,
  status: deletionStatusSchema,
  scheduledFor: z.string(),
  requestedAt: z.string(),
  requestedByYou: z.boolean(),
  cancellable: z.boolean(),
  /** Why a due run has not proceeded, empty when nothing is in the way. */
  blockedReason: z.string().nullable(),
});
export type DeletionRequestView = z.infer<typeof deletionRequestViewSchema>;

export const deletionStatusResponseSchema = z.object({
  /** Null when nothing is pending — the ordinary case, and not an error. */
  request: deletionRequestViewSchema.nullable(),
  /** Blocks that would stop a request made right now. Shown before the button. */
  blocks: z.array(z.string()),
  promises: z.array(z.string()),
});
export type DeletionStatusResponse = z.infer<typeof deletionStatusResponseSchema>;
