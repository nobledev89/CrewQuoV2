import {
  effectiveCompanyRequestStatus,
  normalizeCompanyName,
  type AdminCompanyCreationRequest,
  type CompanyApprovalRoute,
  type CompanyCreationRequestView,
  type CompanyIdentityCandidate,
  type CompanyRequestStatus,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

/**
 * Data access for the company ownership & creation safeguard (§3.1.1).
 * Operating-model packet: docs/operating-model/company-creation.md
 *
 * Two rules run through every function here:
 *
 *  1. **Every decision is a conditional write naming the state it leaves.**
 *     Nothing reads-then-writes, so two racing callers produce one winner and one
 *     honest refusal without a lock or an isolation level.
 *  2. **Expiry is materialised on read**, never by a timer. `EXPIRED` is derived
 *     from `expires_at` at the moment somebody looks, which keeps this domain off
 *     the process-local-timer list Phase 6 is already committed to clearing.
 */

export interface CompanyRequestRow {
  id: string;
  user_id: string;
  status: CompanyRequestStatus;
  legal_name: string;
  display_name: string;
  country: string;
  registration_id: string | null;
  registration_id_normalized: string | null;
  intended_plan_id: string | null;
  requested_currency: string;
  approval_route: CompanyApprovalRoute;
  checkout_reference: string | null;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  expires_at: Date;
  company_id: string | null;
  consumed_at: Date | null;
  idempotency_key: string | null;
  created_at: Date;
}

const REQUEST_COLUMNS = `id, user_id, status, legal_name, display_name, country,
  registration_id, registration_id_normalized, intended_plan_id, requested_currency,
  approval_route, checkout_reference, decided_by_user_id, decided_at, decision_reason,
  expires_at, company_id, consumed_at, idempotency_key, created_at`;

export function toRequestView(row: CompanyRequestRow, now = new Date()): CompanyCreationRequestView {
  return {
    id: row.id,
    // Derived, not read: a row whose date has passed reads as EXPIRED even though
    // no writer has been near it.
    status: effectiveCompanyRequestStatus(row.status, row.expires_at, now),
    legalName: row.legal_name,
    displayName: row.display_name,
    country: row.country,
    registrationId: row.registration_id,
    intendedPlanId: row.intended_plan_id,
    currency: row.requested_currency,
    approvalRoute: row.approval_route,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
    companyId: row.company_id,
    createdAt: row.created_at.toISOString(),
  };
}

// ── The allowance ledger ──────────────────────────────────────────────────────

export interface AllowanceRow {
  user_id: string;
  company_id: string | null;
  source: string;
  idempotency_key: string | null;
  consumed_at: Date;
}

export function findAllowance(userId: string, runner?: Queryable): Promise<AllowanceRow | null> {
  return queryOne<AllowanceRow>(
    `select user_id, company_id, source, idempotency_key, consumed_at
       from company_creation_allowances where user_id = $1`,
    [userId],
    runner
  );
}

/**
 * Claim the once-per-identity allowance.
 *
 * `on conflict do nothing returning` is the entire concurrency story: the primary
 * key decides, so two simultaneous first-company creates cannot both win and the
 * loser gets `null` rather than a second company. §44's "works exactly once under
 * concurrency" is therefore a database guarantee, not a checked-then-acted one.
 */
export async function claimAllowance(
  input: {
    userId: string;
    companyId: string;
    source: 'REGISTRATION' | 'SELF_SERVE';
    idempotencyKey?: string | null;
  },
  runner: Queryable
): Promise<AllowanceRow | null> {
  const rows = await query<AllowanceRow>(
    `insert into company_creation_allowances (user_id, company_id, source, idempotency_key)
     values ($1, $2, $3, $4)
     on conflict (user_id) do nothing
     returning user_id, company_id, source, idempotency_key, consumed_at`,
    [input.userId, input.companyId, input.source, input.idempotencyKey ?? null],
    runner
  );
  return rows[0] ?? null;
}

/**
 * A company already created under this exact idempotency key, if any.
 *
 * Looked up across both ledgers because a retry does not know which authority
 * created the company the first time.
 */
export async function findCompanyByIdempotencyKey(
  userId: string,
  key: string
): Promise<string | null> {
  const row = await queryOne<{ company_id: string | null }>(
    `select company_id from company_creation_allowances
      where user_id = $1 and idempotency_key = $2
      union all
     select company_id from company_creation_requests
      where user_id = $1 and idempotency_key = $2 and company_id is not null
      limit 1`,
    [userId, key]
  );
  return row?.company_id ?? null;
}

// ── Requests ──────────────────────────────────────────────────────────────────

export function findRequestById(
  id: string,
  runner?: Queryable
): Promise<CompanyRequestRow | null> {
  return queryOne<CompanyRequestRow>(
    `select ${REQUEST_COLUMNS} from company_creation_requests where id = $1`,
    [id],
    runner
  );
}

/**
 * Scoped by `user_id` deliberately: a valid uuid belonging to somebody else must
 * be a 404, not a 403, or the endpoint becomes an existence oracle (packet §10).
 */
export function findOwnRequest(
  id: string,
  userId: string,
  runner?: Queryable
): Promise<CompanyRequestRow | null> {
  return queryOne<CompanyRequestRow>(
    `select ${REQUEST_COLUMNS} from company_creation_requests where id = $1 and user_id = $2`,
    [id, userId],
    runner
  );
}

export function listOwnRequests(userId: string): Promise<CompanyRequestRow[]> {
  return query<CompanyRequestRow>(
    `select ${REQUEST_COLUMNS} from company_creation_requests
      where user_id = $1 order by created_at desc limit 20`,
    [userId]
  );
}

/** The caller's single unconsumed request, whatever state it is in. */
export function findOpenRequest(
  userId: string,
  runner?: Queryable
): Promise<CompanyRequestRow | null> {
  return queryOne<CompanyRequestRow>(
    `select ${REQUEST_COLUMNS} from company_creation_requests
      where user_id = $1 and status in ('PENDING_CHECKOUT','PENDING_REVIEW','APPROVED')`,
    [userId],
    runner
  );
}

/**
 * The approval a create may consume: approved, unexpired, and — when the caller
 * named one — that exact request.
 *
 * `for update` because the row is about to be the mutex for the create.
 */
export function findConsumableApproval(
  userId: string,
  requestId: string | undefined,
  runner: Queryable
): Promise<CompanyRequestRow | null> {
  return queryOne<CompanyRequestRow>(
    `select ${REQUEST_COLUMNS} from company_creation_requests
      where user_id = $1 and status = 'APPROVED'
        and ($2::uuid is null or id = $2::uuid)
      for update`,
    [userId, requestId ?? null],
    runner
  );
}

export async function insertRequest(
  input: {
    userId: string;
    status: CompanyRequestStatus;
    legalName: string;
    displayName: string;
    country: string;
    registrationId: string | null;
    intendedPlanId: string | null;
    currency: string;
    attestationText: string;
    approvalRoute: CompanyApprovalRoute;
    expiresAt: Date;
  },
  runner: Queryable
): Promise<CompanyRequestRow> {
  const rows = await query<CompanyRequestRow>(
    `insert into company_creation_requests
       (user_id, status, legal_name, display_name, country, registration_id,
        intended_plan_id, requested_currency, attestation_text, attested_at,
        approval_route, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11)
     returning ${REQUEST_COLUMNS}`,
    [
      input.userId,
      input.status,
      input.legalName,
      input.displayName,
      input.country,
      input.registrationId,
      input.intendedPlanId,
      input.currency,
      input.attestationText,
      input.approvalRoute,
      input.expiresAt,
    ],
    runner
  );
  return rows[0]!;
}

/**
 * Delete a pending request. Returns false when somebody decided it first, which
 * the route turns into a 409 naming the decision rather than a silent no-op.
 */
export async function deletePendingRequest(
  id: string,
  userId: string,
  runner: Queryable
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `delete from company_creation_requests
      where id = $1 and user_id = $2 and status in ('PENDING_CHECKOUT','PENDING_REVIEW')
      returning id`,
    [id, userId],
    runner
  );
  return rows.length > 0;
}

/** Approve, from either pending state. The `where` clause is the state machine. */
export async function approveRequest(
  input: {
    id: string;
    decidedByUserId: string;
    reason: string;
    expiresAt: Date;
    checkoutReference?: string | null;
  },
  runner: Queryable
): Promise<CompanyRequestRow | null> {
  const rows = await query<CompanyRequestRow>(
    `update company_creation_requests set
       status = 'APPROVED',
       decided_by_user_id = $2,
       decided_at = now(),
       decision_reason = $3,
       expires_at = $4,
       checkout_reference = coalesce($5, checkout_reference),
       updated_at = now()
     where id = $1
       and status in ('PENDING_CHECKOUT','PENDING_REVIEW')
       and expires_at > now()
     returning ${REQUEST_COLUMNS}`,
    [input.id, input.decidedByUserId, input.reason, input.expiresAt, input.checkoutReference ?? null],
    runner
  );
  return rows[0] ?? null;
}

/** Reject — including an approval given in error, before it becomes a tenant. */
export async function rejectRequest(
  input: { id: string; decidedByUserId: string; reason: string },
  runner: Queryable
): Promise<CompanyRequestRow | null> {
  const rows = await query<CompanyRequestRow>(
    `update company_creation_requests set
       status = 'REJECTED',
       decided_by_user_id = $2,
       decided_at = now(),
       decision_reason = $3,
       updated_at = now()
     where id = $1 and status in ('PENDING_CHECKOUT','PENDING_REVIEW','APPROVED')
     returning ${REQUEST_COLUMNS}`,
    [input.id, input.decidedByUserId, input.reason],
    runner
  );
  return rows[0] ?? null;
}

/**
 * Consume an approval, in the same transaction as the company insert.
 *
 * Zero rows means somebody else got there first or the clock ran out; the caller
 * aborts the whole transaction, so there is no path on which a company exists
 * without its approval having been spent.
 */
export async function consumeRequest(
  input: { id: string; companyId: string; idempotencyKey?: string | null },
  runner: Queryable
): Promise<CompanyRequestRow | null> {
  const rows = await query<CompanyRequestRow>(
    `update company_creation_requests set
       status = 'CONSUMED',
       company_id = $2,
       consumed_at = now(),
       idempotency_key = coalesce($3, idempotency_key),
       updated_at = now()
     where id = $1 and status = 'APPROVED' and expires_at > now()
     returning ${REQUEST_COLUMNS}`,
    [input.id, input.companyId, input.idempotencyKey ?? null],
    runner
  );
  return rows[0] ?? null;
}

// ── Duplicate signal (§3.1.1(6)) ──────────────────────────────────────────────

/**
 * Candidates for the duplicate check: real companies, plus other people's live
 * requests.
 *
 * Rows are narrowed to the three comparison keys *in SQL* so no company id, name
 * or owner ever reaches the caller — the classifier upstream cannot leak what it
 * was never given (packet §10).
 */
export async function findIdentityCandidates(input: {
  country: string;
  registrationIdNormalized: string | null;
  nameNormalized: string;
  excludeUserId: string;
}): Promise<CompanyIdentityCandidate[]> {
  const companies = await query<{
    country: string | null;
    registration_id_normalized: string | null;
    name: string;
  }>(
    `select country, registration_id_normalized, name
       from companies
      where not is_placeholder and claimed_by_company_id is null
        and (
          (registration_id_normalized is not null
             and registration_id_normalized = $2 and upper(country) = $1)
          or lower(name) like $3
        )
      limit 50`,
    [input.country, input.registrationIdNormalized, `%${firstWord(input.nameNormalized)}%`]
  );

  const requests = await query<{
    country: string;
    registration_id_normalized: string | null;
    legal_name: string;
  }>(
    `select country, registration_id_normalized, legal_name
       from company_creation_requests
      where status in ('PENDING_CHECKOUT','PENDING_REVIEW','APPROVED')
        and user_id <> $4
        and (
          (registration_id_normalized is not null
             and registration_id_normalized = $2 and upper(country) = $1)
          or lower(legal_name) like $3
        )
      limit 50`,
    [input.country, input.registrationIdNormalized, `%${firstWord(input.nameNormalized)}%`, input.excludeUserId]
  );

  return [
    ...companies.map((c) => ({
      kind: 'COMPANY' as const,
      country: c.country,
      registrationIdNormalized: c.registration_id_normalized,
      nameNormalized: normalizeCompanyName(c.name),
    })),
    ...requests.map((r) => ({
      kind: 'REQUEST' as const,
      country: r.country,
      registrationIdNormalized: r.registration_id_normalized,
      nameNormalized: normalizeCompanyName(r.legal_name),
    })),
  ];
}

/**
 * The SQL `like` is only a *coarse* net so the exact comparison upstream has a
 * small set to work on — the authoritative match is `normalizeCompanyName`, in
 * shared, where it is unit-tested. Matching in SQL would put the same rule in two
 * places written two ways.
 */
function firstWord(nameNormalized: string): string {
  return (nameNormalized.split(' ')[0] ?? '').replace(/[%_]/g, '');
}

// ── Rate limiting (§3.1.1(7)) ─────────────────────────────────────────────────

/**
 * Counted from `platform_audit_logs`, which is insert-only, rather than from live
 * rows — otherwise deleting a request would buy another attempt.
 */
export async function countRecentRequests(userId: string, windowHours: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from platform_audit_logs
      where actor_user_id = $1
        and action = 'company_creation_request.created'
        and created_at > now() - make_interval(hours => $2)`,
    [userId, windowHours]
  );
  return row?.n ?? 0;
}

// ── Admin queue ───────────────────────────────────────────────────────────────

interface AdminRequestRow extends CompanyRequestRow {
  user_name: string;
  user_email: string;
  email_verified: boolean;
  owned_companies: number;
  decided_by_name: string | null;
  duplicate_companies: number;
}

export async function listAdminRequests(input: {
  status?: CompanyRequestStatus;
  limit: number;
}): Promise<AdminCompanyCreationRequest[]> {
  const rows = await query<AdminRequestRow>(
    `select r.id, r.user_id, r.status, r.legal_name, r.display_name, r.country,
            r.registration_id, r.registration_id_normalized, r.intended_plan_id,
            r.requested_currency, r.approval_route, r.checkout_reference,
            r.decided_by_user_id, r.decided_at, r.decision_reason, r.expires_at,
            r.company_id, r.consumed_at, r.idempotency_key, r.created_at,
            u.name as user_name, u.email as user_email,
            (u.email_verified_at is not null) as email_verified,
            d.name as decided_by_name,
            (select count(*)::int from memberships m
               join companies c on c.id = m.company_id
              where m.user_id = r.user_id and m.role = 'OWNER'
                and not c.is_placeholder and c.claimed_by_company_id is null) as owned_companies,
            (select count(*)::int from companies c
              where c.registration_id_normalized is not null
                and c.registration_id_normalized = r.registration_id_normalized
                and upper(c.country) = r.country
                and not c.is_placeholder) as duplicate_companies
       from company_creation_requests r
       join users u on u.id = r.user_id
       left join users d on d.id = r.decided_by_user_id
      where ($1::text is null or r.status = $1::text)
      order by
        case when r.status in ('PENDING_CHECKOUT','PENDING_REVIEW') then 0 else 1 end,
        r.created_at desc
      limit $2`,
    [input.status ?? null, input.limit]
  );

  const now = new Date();
  return rows.map((row) => ({
    ...toRequestView(row, now),
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    emailVerified: row.email_verified,
    ownedCompanies: row.owned_companies,
    duplicateWarning:
      row.duplicate_companies > 0
        ? 'A company with this registration identifier already exists.'
        : null,
    decidedByName: row.decided_by_name,
  }));
}

// ── Trial ledger (§3.1.1(5)) ──────────────────────────────────────────────────

export async function listCompanyOwnerIds(
  companyId: string,
  runner?: Queryable
): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `select user_id from memberships
      where company_id = $1 and role = 'OWNER' and status <> 'INVITED'`,
    [companyId],
    runner
  );
  return rows.map((r) => r.user_id);
}

export async function listPriorTrialGrants(
  userIds: string[],
  runner?: Queryable
): Promise<{ userId: string; companyId: string }[]> {
  if (userIds.length === 0) return [];
  const rows = await query<{ user_id: string; company_id: string }>(
    `select user_id, company_id from trial_grants where user_id = any($1::uuid[])`,
    [userIds],
    runner
  );
  return rows.map((r) => ({ userId: r.user_id, companyId: r.company_id }));
}

export async function insertTrialGrants(
  input: {
    userIds: string[];
    companyId: string;
    planId: string;
    days: number;
    source: 'ADMIN_COMP' | 'CHECKOUT' | 'SIGNUP';
    isRepeat: boolean;
    reason: string | null;
    grantedByUserId: string | null;
  },
  runner?: Queryable
): Promise<void> {
  if (input.userIds.length === 0) return;
  await query(
    `insert into trial_grants
       (user_id, company_id, plan_id, days, source, is_repeat, reason, granted_by_user_id)
     select unnest($1::uuid[]), $2, $3, $4, $5, $6, $7, $8`,
    [
      input.userIds,
      input.companyId,
      input.planId,
      input.days,
      input.source,
      input.isRepeat,
      input.reason,
      input.grantedByUserId,
    ],
    runner
  );
}

export async function planIsPaid(planId: string | null | undefined): Promise<boolean> {
  if (!planId) return false;
  const row = await queryOne<{ n: number }>(
    `select count(*)::int as n from plan_prices
      where plan_id = $1 and active and amount_cents > 0`,
    [planId]
  );
  return (row?.n ?? 0) > 0;
}
