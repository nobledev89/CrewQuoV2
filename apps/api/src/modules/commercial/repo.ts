import type {
  AgreementRate,
  RateLabel,
  RateMode,
  RateProposalLineInput,
  RateProposalLineView,
  RateProposalOperation,
  RateProposalStatus,
  RateProposalView,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Commercial-agreement persistence (CREWQUO_V2_PLAN.md §3.3.1).
 *
 * `rate_cards` stays the authoritative approved surface — pending negotiation
 * never enters it. This module owns the proposal tables and the *writes* into
 * `rate_cards` that an approval performs; reading rates for resolution remains
 * `modules/rates/repo.ts`, so there is one resolver, not two.
 */

// ── Rows ──────────────────────────────────────────────────────────────────────

interface ProposalRow {
  id: string;
  engagement_id: string;
  proposed_by_company_id: string;
  provider_company_id: string;
  provider_company_name: string;
  client_company_id: string;
  client_company_name: string;
  currency: string;
  effective_from: string;
  status: RateProposalStatus;
  predecessor_proposal_id: string | null;
  note: string | null;
  submitted_at: Date | null;
  submitted_by_name: string | null;
  reviewed_at: Date | null;
  reviewed_by_name: string | null;
  decision_reason: string | null;
  retroactive_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LineRow {
  id: string;
  proposal_id: string;
  operation: RateProposalOperation;
  role_id: string;
  role_name: string;
  rate_label: RateLabel;
  rate_mode: RateMode;
  hourly_rate_cents: number | null;
  ot_hourly_rate_cents: number | null;
  shift_rate_cents: number | null;
  daily_rate_cents: number | null;
  min_hours: string | null;
  weekend_multiplier: string | null;
  night_multiplier: string | null;
  replaces_rate_card_id: string | null;
  created_at: Date;
}

const numOrNull = (value: string | null): number | null =>
  value === null ? null : Number(value);

const PROPOSAL_SELECT = `
  select p.id, p.engagement_id, p.proposed_by_company_id,
         e.provider_company_id, pc.name as provider_company_name,
         e.client_company_id, cc.name as client_company_name,
         p.currency, to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
         p.status, p.predecessor_proposal_id, p.note,
         p.submitted_at, su.name as submitted_by_name,
         p.reviewed_at, ru.name as reviewed_by_name,
         p.decision_reason, p.retroactive_reason, p.created_at, p.updated_at
    from rate_proposals p
    join engagements e on e.id = p.engagement_id
    join companies pc on pc.id = e.provider_company_id
    join companies cc on cc.id = e.client_company_id
    left join users su on su.id = p.submitted_by_user_id
    left join users ru on ru.id = p.reviewed_by_user_id`;

/**
 * Lines, each carrying the amount currently in force for its (role, label) on this
 * edge — so a reviewer sees what they are being asked to change *from* without a
 * second request, and without the web layer inventing the comparison itself.
 *
 * `current_amount_cents` reads the live PAY card by the same rules the resolver
 * applies (§6): active, window covers the proposal's effective date, a
 * counterparty-specific card beats the company default, and the latest
 * `effective_from` wins within that. A card of a different mode to the proposed line
 * is still the thing being replaced, so its own amount is the honest comparison.
 *
 * **The default (null-counterparty) card has to be included.** `pickEffectiveCard`
 * falls back to it, so excluding it here would show a reviewer "no current rate"
 * on work the engine is already pricing — the screen and the engine disagreeing
 * about money, which is the one thing this column exists to prevent.
 */
const LINE_SELECT = `
  select l.id, l.proposal_id, l.operation, l.role_id, r.name as role_name,
         l.rate_label, l.rate_mode, l.hourly_rate_cents, l.ot_hourly_rate_cents,
         l.shift_rate_cents, l.daily_rate_cents, l.min_hours,
         l.weekend_multiplier, l.night_multiplier, l.replaces_rate_card_id, l.created_at,
         (select case rc.rate_mode
                   when 'HOURLY' then rc.hourly_rate_cents
                   when 'SHIFT'  then rc.shift_rate_cents
                   when 'DAILY'  then rc.daily_rate_cents
                 end
            from rate_cards rc
           where rc.company_id = e.client_company_id
             and rc.kind = 'PAY'
             and (rc.counterparty_company_id = e.provider_company_id
                  or rc.counterparty_company_id is null)
             and rc.role_id = l.role_id
             and rc.rate_label = l.rate_label
             and rc.active
             and rc.effective_from <= p.effective_from
             and (rc.effective_to is null or rc.effective_to >= p.effective_from)
           order by (rc.counterparty_company_id is not null) desc,
                    rc.effective_from desc, rc.version desc
           limit 1) as current_amount_cents
    from rate_proposal_lines l
    join rate_proposals p on p.id = l.proposal_id
    join engagements e on e.id = p.engagement_id
    join role_catalog r on r.id = l.role_id`;

function toLineView(row: LineRow & { current_amount_cents: number | null }): RateProposalLineView {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    operation: row.operation,
    roleId: row.role_id,
    roleName: row.role_name,
    rateLabel: row.rate_label,
    rateMode: row.rate_mode,
    hourlyRateCents: row.hourly_rate_cents,
    otHourlyRateCents: row.ot_hourly_rate_cents,
    shiftRateCents: row.shift_rate_cents,
    dailyRateCents: row.daily_rate_cents,
    minHours: numOrNull(row.min_hours),
    weekendMultiplier: numOrNull(row.weekend_multiplier),
    nightMultiplier: numOrNull(row.night_multiplier),
    replacesRateCardId: row.replaces_rate_card_id,
    currentAmountCents: row.current_amount_cents,
    createdAt: row.created_at.toISOString(),
  };
}

function toProposalView(
  row: ProposalRow,
  readingCompanyId: string,
  lines: RateProposalLineView[]
): RateProposalView {
  return {
    id: row.id,
    engagementId: row.engagement_id,
    proposedByCompanyId: row.proposed_by_company_id,
    providerCompanyId: row.provider_company_id,
    providerCompanyName: row.provider_company_name,
    clientCompanyId: row.client_company_id,
    clientCompanyName: row.client_company_name,
    side: row.client_company_id === readingCompanyId ? 'client' : 'provider',
    currency: row.currency,
    effectiveFrom: row.effective_from,
    status: row.status,
    predecessorProposalId: row.predecessor_proposal_id,
    note: row.note,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    submittedByName: row.submitted_by_name,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewedByName: row.reviewed_by_name,
    decisionReason: row.decision_reason,
    retroactiveReason: row.retroactive_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lines,
  };
}

async function loadLines(
  proposalIds: readonly string[],
  runner?: Queryable
): Promise<Map<string, RateProposalLineView[]>> {
  const byProposal = new Map<string, RateProposalLineView[]>();
  if (proposalIds.length === 0) return byProposal;
  const rows = await query<LineRow & { current_amount_cents: number | null }>(
    `${LINE_SELECT} where l.proposal_id = any($1::uuid[]) order by r.name, l.rate_label`,
    [proposalIds],
    runner
  );
  for (const row of rows) {
    const list = byProposal.get(row.proposal_id) ?? [];
    list.push(toLineView(row));
    byProposal.set(row.proposal_id, list);
  }
  return byProposal;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Every proposal the active company may see. A `DRAFT` is visible only to the
 * provider that authored it — the hiring side has no business seeing numbers
 * nobody has decided to ask for yet (§7 of the packet).
 */
export async function listRateProposals(
  companyId: string,
  filter: { engagementId?: string } = {}
): Promise<RateProposalView[]> {
  const rows = await query<ProposalRow>(
    `${PROPOSAL_SELECT}
      where (e.provider_company_id = $1 or (e.client_company_id = $1 and p.status <> 'DRAFT'))
        and ($2::uuid is null or p.engagement_id = $2)
      order by p.created_at desc`,
    [companyId, filter.engagementId ?? null]
  );
  const lines = await loadLines(rows.map((row) => row.id));
  return rows.map((row) => toProposalView(row, companyId, lines.get(row.id) ?? []));
}

/** One proposal, or null. Visibility is the caller's to check against the edge. */
export async function getRateProposal(
  id: string,
  readingCompanyId: string,
  runner?: Queryable
): Promise<RateProposalView | null> {
  const row = await queryOne<ProposalRow>(`${PROPOSAL_SELECT} where p.id = $1`, [id], runner);
  if (!row) return null;
  const lines = await loadLines([row.id], runner);
  return toProposalView(row, readingCompanyId, lines.get(row.id) ?? []);
}

/**
 * The PAY schedule currently in force on one edge: the hiring company's PAY cards
 * that price this provider's work. This is the provider's *own* agreed rate, which
 * is why the provider is allowed to read it — it is not the hiring company's BILL
 * side and carries no margin (§4).
 *
 * Includes the hiring company's **default** (null-counterparty) cards, because that
 * is what the resolver falls back to (§6): a company that priced a role once for
 * everybody has an agreed rate on this engagement whether or not a
 * counterparty-specific card exists. `scope` distinguishes the two, so a screen can
 * say "inherited" and — importantly — can decline to offer a default as a REPLACE
 * target, since superseding it would reprice every other provider at once.
 */
export async function listLiveAgreementRates(
  engagementId: string,
  runner?: Queryable
): Promise<AgreementRate[]> {
  const rows = await query<{
    rate_card_id: string;
    role_id: string;
    role_name: string;
    rate_label: RateLabel;
    rate_mode: RateMode;
    amount_cents: number | null;
    ot_hourly_rate_cents: number | null;
    min_hours: string | null;
    currency: string;
    effective_from: string;
    effective_to: string | null;
    version: number;
    locked: boolean;
    scope: 'ENGAGEMENT' | 'COMPANY_DEFAULT';
  }>(
    // `distinct on (role, label, effective_from)` with counterparty-specific ordered
    // first reproduces the resolver's preference exactly: where both a specific and
    // a default card cover the same slot, the specific one is what prices the work,
    // so it is the only one worth showing. Distinct windows are kept as separate
    // rows on purpose — a raise approved for next month is a fact the reader needs.
    `select distinct on (rc.role_id, rc.rate_label, rc.effective_from)
            rc.id as rate_card_id, rc.role_id, r.name as role_name,
            rc.rate_label, rc.rate_mode,
            case rc.rate_mode
              when 'HOURLY' then rc.hourly_rate_cents
              when 'SHIFT'  then rc.shift_rate_cents
              when 'DAILY'  then rc.daily_rate_cents
            end as amount_cents,
            rc.ot_hourly_rate_cents, rc.min_hours,
            coalesce(rc.currency, cc.currency) as currency,
            to_char(rc.effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(rc.effective_to, 'YYYY-MM-DD') as effective_to,
            rc.version, rc.locked,
            case when rc.counterparty_company_id is null
                 then 'COMPANY_DEFAULT' else 'ENGAGEMENT' end as scope
       from engagements e
       join rate_cards rc on rc.company_id = e.client_company_id
                         and rc.kind = 'PAY'
                         and (rc.counterparty_company_id = e.provider_company_id
                              or rc.counterparty_company_id is null)
       join role_catalog r on r.id = rc.role_id
       join companies cc on cc.id = e.client_company_id
      where e.id = $1
        and rc.active
        and (rc.effective_to is null or rc.effective_to >= current_date)
      order by rc.role_id, rc.rate_label, rc.effective_from desc,
               (rc.counterparty_company_id is not null) desc, rc.version desc`,
    [engagementId],
    runner
  );
  return rows
    .filter((row) => row.amount_cents !== null)
    .map((row) => ({
      rateCardId: row.rate_card_id,
      roleId: row.role_id,
      roleName: row.role_name,
      rateLabel: row.rate_label,
      rateMode: row.rate_mode,
      amountCents: row.amount_cents!,
      otHourlyRateCents: row.ot_hourly_rate_cents,
      minHours: numOrNull(row.min_hours),
      currency: row.currency,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      version: row.version,
      locked: row.locked,
      scope: row.scope,
    }))
    .sort(
      (a, b) =>
        a.roleName.localeCompare(b.roleName) ||
        a.rateLabel.localeCompare(b.rateLabel) ||
        b.effectiveFrom.localeCompare(a.effectiveFrom)
    );
}

// ── Proposal writes ───────────────────────────────────────────────────────────

export async function insertProposal(
  input: {
    engagementId: string;
    proposedByCompanyId: string;
    currency: string;
    effectiveFrom: string;
    note: string | null;
    predecessorProposalId: string | null;
    createdByUserId: string;
  },
  runner: Queryable
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into rate_proposals
       (engagement_id, proposed_by_company_id, currency, effective_from, note,
        predecessor_proposal_id, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      input.engagementId,
      input.proposedByCompanyId,
      input.currency,
      input.effectiveFrom,
      input.note,
      input.predecessorProposalId,
      input.createdByUserId,
    ],
    runner
  );
  return row!.id;
}

export async function insertProposalLines(
  proposalId: string,
  lines: readonly RateProposalLineInput[],
  runner: Queryable
): Promise<void> {
  for (const line of lines) {
    await query(
      `insert into rate_proposal_lines
         (proposal_id, operation, role_id, rate_label, rate_mode, hourly_rate_cents,
          ot_hourly_rate_cents, shift_rate_cents, daily_rate_cents, min_hours,
          weekend_multiplier, night_multiplier, replaces_rate_card_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        proposalId,
        line.operation,
        line.roleId,
        line.rateLabel,
        line.rateMode,
        line.hourlyRateCents,
        line.otHourlyRateCents,
        line.shiftRateCents,
        line.dailyRateCents,
        line.minHours,
        line.weekendMultiplier,
        line.nightMultiplier,
        line.replacesRateCardId,
      ],
      runner
    );
  }
}

export async function deleteProposalLines(proposalId: string, runner: Queryable): Promise<void> {
  await query(`delete from rate_proposal_lines where proposal_id = $1`, [proposalId], runner);
}

/** Lock a proposal row for update and return the status the caller must branch on. */
export async function lockProposal(
  id: string,
  runner: Queryable
): Promise<{ status: RateProposalStatus; engagementId: string; currency: string } | null> {
  const row = await queryOne<{
    status: RateProposalStatus;
    engagement_id: string;
    currency: string;
  }>(
    `select status, engagement_id, currency from rate_proposals where id = $1 for update`,
    [id],
    runner
  );
  return row
    ? { status: row.status, engagementId: row.engagement_id, currency: row.currency }
    : null;
}

export async function updateProposalDraft(
  id: string,
  patch: { effectiveFrom?: string; note?: string | null },
  runner: Queryable
): Promise<void> {
  const row = await queryOne(
    `update rate_proposals set
       effective_from = coalesce($2, effective_from),
       note = case when $3::boolean then $4 else note end,
       updated_at = now()
     where id = $1 and status = 'DRAFT' returning id`,
    [id, patch.effectiveFrom ?? null, 'note' in patch, patch.note ?? null],
    runner
  );
  if (!row) throw new AppError('CONFLICT', 'Only a draft schedule can be edited');
}

export async function deleteProposal(id: string, runner: Queryable): Promise<void> {
  const row = await queryOne(
    `delete from rate_proposals where id = $1 and status = 'DRAFT' returning id`,
    [id],
    runner
  );
  if (!row) throw new AppError('CONFLICT', 'Only a draft schedule can be deleted');
}

/**
 * Every status change is a conditional update on the source state, so two actors
 * racing the same transition cannot both succeed: exactly one row is updated and
 * the loser is told the current status rather than silently overwriting a decision.
 */
export async function transitionProposal(
  args: {
    id: string;
    from: RateProposalStatus;
    to: RateProposalStatus;
    actorUserId: string;
    decisionReason?: string | null;
    retroactiveReason?: string | null;
  },
  runner: Queryable
): Promise<void> {
  const isSubmit = args.to === 'SUBMITTED';
  const isDecision = args.to === 'APPROVED' || args.to === 'REJECTED';
  const row = await queryOne(
    `update rate_proposals set
       status = $3,
       submitted_at = case when $4::boolean then now() else submitted_at end,
       submitted_by_user_id = case when $4::boolean then $5 else submitted_by_user_id end,
       reviewed_at = case when $6::boolean then now() else reviewed_at end,
       reviewed_by_user_id = case when $6::boolean then $5 else reviewed_by_user_id end,
       decision_reason = coalesce($7, decision_reason),
       retroactive_reason = coalesce($8, retroactive_reason),
       updated_at = now()
     where id = $1 and status = $2 returning id`,
    [
      args.id,
      args.from,
      args.to,
      isSubmit,
      args.actorUserId,
      isDecision,
      args.decisionReason ?? null,
      args.retroactiveReason ?? null,
    ],
    runner
  );
  if (!row) {
    const current = await queryOne<{ status: RateProposalStatus }>(
      `select status from rate_proposals where id = $1`,
      [args.id],
      runner
    );
    throw new AppError(
      'CONFLICT',
      current
        ? `This schedule is ${current.status.toLowerCase()} and cannot change again`
        : 'Schedule not found'
    );
  }
}

// ── Approved rate-card versions ───────────────────────────────────────────────

export interface ApprovedCardTarget {
  id: string;
  role_id: string;
  rate_label: RateLabel;
  rate_mode: RateMode;
  effective_from: string;
  effective_to: string | null;
  version: number;
  hourly_rate_cents: number | null;
  shift_rate_cents: number | null;
  daily_rate_cents: number | null;
}

/**
 * Re-validate a `REPLACE`/`END` target inside the approving transaction, against
 * the edge it must belong to. A provider names the card id in its proposal, so
 * this is the check that stops one aimed at another counterparty's card, at a BILL
 * card, or at a card belonging to a different hiring company entirely.
 */
export async function findReplaceableCard(
  args: {
    rateCardId: string;
    hiringCompanyId: string;
    providerCompanyId: string;
  },
  runner: Queryable
): Promise<ApprovedCardTarget | null> {
  return queryOne<ApprovedCardTarget>(
    `select id, role_id, rate_label, rate_mode,
            to_char(effective_from, 'YYYY-MM-DD') as effective_from,
            to_char(effective_to, 'YYYY-MM-DD') as effective_to,
            version, hourly_rate_cents, shift_rate_cents, daily_rate_cents
       from rate_cards
      where id = $1 and company_id = $2 and kind = 'PAY'
        and counterparty_company_id = $3
      for update`,
    [args.rateCardId, args.hiringCompanyId, args.providerCompanyId],
    runner
  );
}

/** Close a superseded version's window. The only mutation the trigger permits. */
export async function closeRateCardWindow(
  rateCardId: string,
  effectiveTo: string,
  actorUserId: string,
  runner: Queryable
): Promise<void> {
  await query(
    `update rate_cards
        set effective_to = $2, updated_by_user_id = $3, updated_at = now()
      where id = $1`,
    [rateCardId, effectiveTo, actorUserId],
    runner
  );
}

/**
 * The next version number for one (company, kind, counterparty, role, label) key.
 * Read inside the approving transaction, which holds an advisory lock on the edge,
 * so two approvals cannot both claim the same number.
 */
export async function nextRateCardVersion(
  args: {
    companyId: string;
    counterpartyCompanyId: string;
    roleId: string;
    rateLabel: RateLabel;
  },
  runner: Queryable
): Promise<number> {
  const row = await queryOne<{ next: number }>(
    `select coalesce(max(version), 0) + 1 as next from rate_cards
      where company_id = $1 and kind = 'PAY' and counterparty_company_id = $2
        and role_id = $3 and rate_label = $4`,
    [args.companyId, args.counterpartyCompanyId, args.roleId, args.rateLabel],
    runner
  );
  return row?.next ?? 1;
}

/**
 * Insert an immutable approved PAY version. `locked` is always true — both the
 * proposal path and the hiring company's direct-entry path create real versions,
 * never a mutable shortcut (§3.3.1).
 */
export async function insertApprovedRateCard(
  input: {
    companyId: string;
    counterpartyCompanyId: string;
    roleId: string;
    rateMode: RateMode;
    rateLabel: RateLabel;
    hourlyRateCents: number | null;
    otHourlyRateCents: number | null;
    shiftRateCents: number | null;
    dailyRateCents: number | null;
    minHours: number | null;
    weekendMultiplier: number | null;
    nightMultiplier: number | null;
    effectiveFrom: string;
    currency: string;
    version: number;
    sourceProposalId: string | null;
    supersedesRateCardId: string | null;
    actorUserId: string;
  },
  runner: Queryable
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into rate_cards
       (company_id, kind, counterparty_company_id, role_id, rate_mode, rate_label,
        hourly_rate_cents, ot_hourly_rate_cents, shift_rate_cents, daily_rate_cents,
        min_hours, weekend_multiplier, night_multiplier, effective_from, effective_to,
        active, currency, version, locked, source_proposal_id, supersedes_rate_card_id,
        created_by_user_id, updated_by_user_id)
     values ($1,'PAY',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null,true,$14,$15,true,$16,$17,$18,$18)
     returning id`,
    [
      input.companyId,
      input.counterpartyCompanyId,
      input.roleId,
      input.rateMode,
      input.rateLabel,
      input.hourlyRateCents,
      input.otHourlyRateCents,
      input.shiftRateCents,
      input.dailyRateCents,
      input.minHours,
      input.weekendMultiplier,
      input.nightMultiplier,
      input.effectiveFrom,
      input.currency,
      input.version,
      input.sourceProposalId,
      input.supersedesRateCardId,
      input.actorUserId,
    ],
    runner
  );
  return row!.id;
}

/** Role ids that are genuinely in the hiring company's catalog. */
export async function filterRoleIdsInCompany(
  companyId: string,
  roleIds: readonly string[],
  runner: Queryable
): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set();
  const rows = await query<{ id: string }>(
    `select id from role_catalog where company_id = $1 and id = any($2::uuid[])`,
    [companyId, [...new Set(roleIds)]],
    runner
  );
  return new Set(rows.map((row) => row.id));
}

/** Is this proposal a valid link in the chain — rejected, on this edge, unclaimed? */
export async function findChainablePredecessor(
  args: { id: string; engagementId: string },
  runner: Queryable
): Promise<{ status: RateProposalStatus } | null> {
  return queryOne<{ status: RateProposalStatus }>(
    `select status from rate_proposals
      where id = $1 and engagement_id = $2`,
    [args.id, args.engagementId],
    runner
  );
}
