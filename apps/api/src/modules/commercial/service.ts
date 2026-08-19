import type {
  CreateRateProposal,
  DirectRateSchedule,
  RateProposalLineInput,
  RateProposalView,
  UpdateRateProposal,
} from '@crewquo/shared';
import {
  currencyBoundaryRefusal,
  duplicateScheduleLineIndex,
  isRetroactive,
  pickFxRate,
  supersededEffectiveTo,
} from '@crewquo/shared';
import { query, withTransaction, type Queryable } from '../../db';
import { AppError } from '../../http/errors';
import { findCompanyById } from '../companies/repo';
import { listFxRateCandidates } from '../money/repo';
import { recordRevision } from '../revisions/record';
import {
  closeRateCardWindow,
  deleteProposal,
  deleteProposalLines,
  filterRoleIdsInCompany,
  findChainablePredecessor,
  findReplaceableCard,
  getRateProposal,
  insertApprovedRateCard,
  insertProposal,
  insertProposalLines,
  lockProposal,
  nextRateCardVersion,
  transitionProposal,
  updateProposalDraft,
} from './repo';

/**
 * Commercial-agreement orchestration (CREWQUO_V2_PLAN.md §3.3.1).
 *
 * The design decisions behind every refusal here are in
 * `docs/operating-model/commercial-agreements.md`. Two are load-bearing enough to
 * restate:
 *
 *  - **A schedule is atomic.** One proposal is one revision of the whole schedule
 *    for one edge, validated and applied as a unit. Editing a draft replaces its
 *    lines wholesale rather than patching them individually, because a half-applied
 *    schedule is a set of prices nobody agreed to.
 *  - **Approval is one transaction.** Revalidate everything, close superseded
 *    windows, insert the new immutable versions, record the decision. There is no
 *    intermediate state in which some roles are repriced and others are not.
 */

/** `YYYY-MM-DD` for today, in UTC — the same basis `dayOfWeek` uses (§6). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Serialize everything that touches one edge's PAY schedule. Two proposals
 * approving concurrently would otherwise interleave their window-closing and
 * version numbering, and could leave two cards live for the same (role, label,
 * date) — which `selectEffectiveCard` would then resolve by an arbitrary tiebreak.
 */
async function lockEdge(engagementId: string, runner: Queryable): Promise<void> {
  await query(
    `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`rate-proposal:${engagementId}`],
    runner
  );
}

export interface EdgeFacts {
  engagementId: string;
  clientCompanyId: string;
  providerCompanyId: string;
}

/**
 * Validate a schedule against the edge it targets: roles must be the *hiring*
 * company's, and every REPLACE/END target must be a live PAY card of this edge.
 *
 * Run both when a draft is written and again inside the approving transaction. The
 * second pass is not redundant — a role can be deleted or a card superseded between
 * the two, and the approval is the moment the numbers become real.
 */
async function validateScheduleAgainstEdge(
  args: {
    lines: readonly RateProposalLineInput[];
    edge: EdgeFacts;
    /** The date the schedule takes effect, for the "already superseded" check. */
    effectiveFrom: string;
  },
  runner: Queryable
): Promise<void> {
  const duplicate = duplicateScheduleLineIndex(args.lines);
  if (duplicate >= 0) {
    throw new AppError('VALIDATION', 'Two lines price the same role and label', {
      lineIndex: duplicate,
    });
  }

  const validRoles = await filterRoleIdsInCompany(
    args.edge.clientCompanyId,
    args.lines.map((line) => line.roleId),
    runner
  );
  for (const [index, line] of args.lines.entries()) {
    if (!validRoles.has(line.roleId)) {
      throw new AppError(
        'VALIDATION',
        'A schedule line names a role that is not in the hiring company’s catalog',
        { lineIndex: index, roleId: line.roleId }
      );
    }
  }

  for (const [index, line] of args.lines.entries()) {
    if (line.replacesRateCardId === null) continue;
    const target = await findReplaceableCard(
      {
        rateCardId: line.replacesRateCardId,
        hiringCompanyId: args.edge.clientCompanyId,
        providerCompanyId: args.edge.providerCompanyId,
      },
      runner
    );
    if (!target) {
      throw new AppError(
        'VALIDATION',
        'A schedule line supersedes a rate that is not this engagement’s PAY rate',
        { lineIndex: index, rateCardId: line.replacesRateCardId }
      );
    }
    if (target.role_id !== line.roleId || target.rate_label !== line.rateLabel) {
      throw new AppError(
        'VALIDATION',
        'A schedule line supersedes a rate for a different role or label',
        { lineIndex: index, rateCardId: line.replacesRateCardId }
      );
    }
    if (target.effective_to !== null && target.effective_to < args.effectiveFrom) {
      throw new AppError(
        'VALIDATION',
        'A schedule line supersedes a rate whose window has already closed',
        { lineIndex: index, rateCardId: line.replacesRateCardId }
      );
    }
  }
}

/**
 * Does the hiring company hold a rate that covers this schedule's start date?
 *
 * Scoped to the *hiring* company because that is whose `rate_cards` an approval
 * writes and whose margin the converted figures land in — the same "resolve on
 * the hiring side" rule the proposal permissions already follow, so a free
 * subcontractor is never blocked by rates it does not own.
 */
async function hasFxRate(args: {
  companyId: string;
  base: string;
  quote: string;
  asOf: string;
  runner?: Queryable;
}): Promise<boolean> {
  if (args.base === args.quote) return true;
  const candidates = await listFxRateCandidates(
    args.companyId,
    [{ base: args.base, quote: args.quote }],
    args.runner
  );
  return pickFxRate(candidates, args.asOf) !== null;
}

// ── Draft lifecycle ───────────────────────────────────────────────────────────

export async function createRateProposal(args: {
  input: CreateRateProposal;
  edge: EdgeFacts;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<RateProposalView> {
  return withTransaction(async (runner) => {
    await lockEdge(args.edge.engagementId, runner);

    const hiring = await findCompanyById(args.edge.clientCompanyId, runner);
    if (!hiring) throw new AppError('NOT_FOUND', 'Hiring company not found');
    // The agreement records its own currency. An unlike one is now allowed —
    // but only when the hiring company has recorded a rate that covers the day
    // the schedule starts, so every figure it produces can name where its
    // conversion came from (§3.3 decision #5).
    const currency = args.input.currency ?? hiring.currency;
    const refusal = currencyBoundaryRefusal({
      proposalCurrency: currency,
      hiringCompanyCurrency: hiring.currency,
      effectiveFrom: args.input.effectiveFrom,
      hasRate: await hasFxRate({
        companyId: hiring.id,
        base: currency,
        quote: hiring.currency,
        asOf: args.input.effectiveFrom,
        runner,
      }),
    });
    if (refusal) throw new AppError('VALIDATION', refusal);

    if (args.input.predecessorProposalId) {
      const predecessor = await findChainablePredecessor(
        { id: args.input.predecessorProposalId, engagementId: args.edge.engagementId },
        runner
      );
      if (!predecessor) {
        throw new AppError('VALIDATION', 'The schedule this one continues is not on this engagement');
      }
      // Only a closed proposal can be continued: chaining off a live one would
      // create two competing successors for the same negotiation.
      if (predecessor.status === 'DRAFT' || predecessor.status === 'SUBMITTED') {
        throw new AppError(
          'VALIDATION',
          'The schedule this one continues has not been decided yet'
        );
      }
    }

    await validateScheduleAgainstEdge(
      { lines: args.input.lines, edge: args.edge, effectiveFrom: args.input.effectiveFrom },
      runner
    );

    const id = await insertProposal(
      {
        engagementId: args.edge.engagementId,
        proposedByCompanyId: args.edge.providerCompanyId,
        currency,
        effectiveFrom: args.input.effectiveFrom,
        note: args.input.note,
        predecessorProposalId: args.input.predecessorProposalId,
        createdByUserId: args.actorUserId,
      },
      runner
    ).catch((err: unknown) => {
      // Two different unique indexes can fire here, and they mean different things to
      // the person reading the message. Naming the constraint keeps a "you already
      // have an open schedule" from being reported for "that schedule has already
      // been superseded", which would send the author looking in the wrong place.
      if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
        const constraint = (err as { constraint?: string }).constraint;
        if (constraint === 'rate_proposals_predecessor_uq') {
          throw new AppError(
            'CONFLICT',
            'That schedule has already been continued by another one. Open the successor ' +
              'instead of starting a second correction of the same rejection.'
          );
        }
        throw new AppError(
          'CONFLICT',
          'This engagement already has an open rate schedule. Submit, withdraw or delete it first.'
        );
      }
      throw err;
    });

    await insertProposalLines(id, args.input.lines, runner);
    const view = (await getRateProposal(id, args.actorCompanyId, runner))!;
    await recordRevision(
      {
        companyId: args.edge.providerCompanyId,
        entityType: 'rate_proposal',
        entityId: id,
        action: 'CREATE',
        after: scheduleSnapshot(view),
        changedByUserId: args.actorUserId,
      },
      runner
    );
    return view;
  });
}

/** The revision payload for a schedule: the numbers, not the join columns. */
function scheduleSnapshot(view: RateProposalView): Record<string, unknown> {
  return {
    status: view.status,
    currency: view.currency,
    effectiveFrom: view.effectiveFrom,
    note: view.note,
    lines: view.lines.map((line) => ({
      operation: line.operation,
      roleId: line.roleId,
      rateLabel: line.rateLabel,
      rateMode: line.rateMode,
      hourlyRateCents: line.hourlyRateCents,
      otHourlyRateCents: line.otHourlyRateCents,
      shiftRateCents: line.shiftRateCents,
      dailyRateCents: line.dailyRateCents,
      minHours: line.minHours,
      weekendMultiplier: line.weekendMultiplier,
      nightMultiplier: line.nightMultiplier,
      replacesRateCardId: line.replacesRateCardId,
    })),
  };
}

export async function editRateProposal(args: {
  proposalId: string;
  patch: UpdateRateProposal;
  edge: EdgeFacts;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<RateProposalView> {
  return withTransaction(async (runner) => {
    await lockEdge(args.edge.engagementId, runner);
    const locked = await lockProposal(args.proposalId, runner);
    if (!locked) throw new AppError('NOT_FOUND', 'Schedule not found');
    if (locked.status !== 'DRAFT') {
      throw new AppError(
        'CONFLICT',
        `This schedule is ${locked.status.toLowerCase()} and its lines are frozen`
      );
    }
    const before = (await getRateProposal(args.proposalId, args.actorCompanyId, runner))!;
    const effectiveFrom = args.patch.effectiveFrom ?? before.effectiveFrom;

    if (args.patch.lines) {
      await validateScheduleAgainstEdge(
        { lines: args.patch.lines, edge: args.edge, effectiveFrom },
        runner
      );
    }
    await updateProposalDraft(
      args.proposalId,
      {
        ...(args.patch.effectiveFrom !== undefined
          ? { effectiveFrom: args.patch.effectiveFrom }
          : {}),
        ...('note' in args.patch ? { note: args.patch.note ?? null } : {}),
      },
      runner
    );
    if (args.patch.lines) {
      // A schedule is atomic: replace it wholesale rather than diffing lines.
      await deleteProposalLines(args.proposalId, runner);
      await insertProposalLines(args.proposalId, args.patch.lines, runner);
    }

    const after = (await getRateProposal(args.proposalId, args.actorCompanyId, runner))!;
    await recordRevision(
      {
        companyId: args.edge.providerCompanyId,
        entityType: 'rate_proposal',
        entityId: args.proposalId,
        action: 'UPDATE',
        before: scheduleSnapshot(before),
        after: scheduleSnapshot(after),
        changedByUserId: args.actorUserId,
      },
      runner
    );
    return after;
  });
}

export async function removeRateProposal(args: {
  proposalId: string;
  edge: EdgeFacts;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<void> {
  await withTransaction(async (runner) => {
    const before = await getRateProposal(args.proposalId, args.actorCompanyId, runner);
    await deleteProposal(args.proposalId, runner);
    if (before) {
      await recordRevision(
        {
          companyId: args.edge.providerCompanyId,
          entityType: 'rate_proposal',
          entityId: args.proposalId,
          action: 'DELETE',
          before: scheduleSnapshot(before),
          changedByUserId: args.actorUserId,
        },
        runner
      );
    }
  });
}

export async function submitRateProposal(args: {
  proposalId: string;
  edge: EdgeFacts;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<RateProposalView> {
  return withTransaction(async (runner) => {
    await lockEdge(args.edge.engagementId, runner);
    const view = await getRateProposal(args.proposalId, args.actorCompanyId, runner);
    if (!view) throw new AppError('NOT_FOUND', 'Schedule not found');
    if (view.lines.length === 0) {
      throw new AppError('VALIDATION', 'A schedule needs at least one line before it is submitted');
    }
    // Validate at submit as well as at draft: the hiring company's catalog and its
    // live cards can both have moved since the draft was written, and submitting an
    // unapprovable schedule wastes the reviewer's time rather than the author's.
    await validateScheduleAgainstEdge(
      { lines: view.lines, edge: args.edge, effectiveFrom: view.effectiveFrom },
      runner
    );
    await transitionProposal(
      { id: args.proposalId, from: 'DRAFT', to: 'SUBMITTED', actorUserId: args.actorUserId },
      runner
    );
    return (await getRateProposal(args.proposalId, args.actorCompanyId, runner))!;
  });
}

export async function withdrawRateProposal(args: {
  proposalId: string;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<RateProposalView> {
  return withTransaction(async (runner) => {
    await transitionProposal(
      { id: args.proposalId, from: 'SUBMITTED', to: 'WITHDRAWN', actorUserId: args.actorUserId },
      runner
    );
    return (await getRateProposal(args.proposalId, args.actorCompanyId, runner))!;
  });
}

export async function rejectRateProposal(args: {
  proposalId: string;
  reason: string;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<RateProposalView> {
  return withTransaction(async (runner) => {
    await transitionProposal(
      {
        id: args.proposalId,
        from: 'SUBMITTED',
        to: 'REJECTED',
        actorUserId: args.actorUserId,
        decisionReason: args.reason,
      },
      runner
    );
    return (await getRateProposal(args.proposalId, args.actorCompanyId, runner))!;
  });
}

// ── Approval ──────────────────────────────────────────────────────────────────

export interface ApprovalOutcome {
  proposal: RateProposalView;
  /** The immutable versions this approval wrote, for the audit trail. */
  writtenCardIds: string[];
  supersededCardIds: string[];
}

/**
 * Apply one schedule as immutable approved versions. §3.3.1: *"approval is one
 * transaction: revalidate the complete schedule, close superseded effective
 * windows, insert immutable approved rate-card versions, persist decision evidence
 * and emit the durable event"*.
 *
 * Shared by the proposal path and the hiring company's direct-entry path, so the
 * two cannot drift into producing different shapes of history.
 */
async function applySchedule(
  args: {
    lines: readonly RateProposalLineInput[];
    edge: EdgeFacts;
    effectiveFrom: string;
    currency: string;
    sourceProposalId: string | null;
    actorUserId: string;
    reason: string | null;
  },
  runner: Queryable
): Promise<{ writtenCardIds: string[]; supersededCardIds: string[] }> {
  await validateScheduleAgainstEdge(
    { lines: args.lines, edge: args.edge, effectiveFrom: args.effectiveFrom },
    runner
  );

  const writtenCardIds: string[] = [];
  const supersededCardIds: string[] = [];
  const closesOn = supersededEffectiveTo(args.effectiveFrom);

  for (const line of args.lines) {
    if (line.replacesRateCardId) {
      // The window closes the day before the successor opens, never the same day —
      // a same-day overlap resolves correctly today and turns ambiguous the moment
      // a third version joins the chain.
      await closeRateCardWindow(line.replacesRateCardId, closesOn, args.actorUserId, runner);
      supersededCardIds.push(line.replacesRateCardId);
      await recordRevision(
        {
          companyId: args.edge.clientCompanyId,
          entityType: 'rate_card',
          entityId: line.replacesRateCardId,
          action: 'UPDATE',
          before: { effectiveTo: null },
          after: { effectiveTo: closesOn, supersededBySchedule: args.sourceProposalId },
          reason: args.reason ?? 'Superseded by an approved rate schedule',
          changedByUserId: args.actorUserId,
        },
        runner
      );
    }
    if (line.operation === 'END') continue; // closes a rate without opening one

    const version = await nextRateCardVersion(
      {
        companyId: args.edge.clientCompanyId,
        counterpartyCompanyId: args.edge.providerCompanyId,
        roleId: line.roleId,
        rateLabel: line.rateLabel,
      },
      runner
    );
    const cardId = await insertApprovedRateCard(
      {
        companyId: args.edge.clientCompanyId,
        counterpartyCompanyId: args.edge.providerCompanyId,
        roleId: line.roleId,
        rateMode: line.rateMode,
        rateLabel: line.rateLabel,
        hourlyRateCents: line.hourlyRateCents,
        otHourlyRateCents: line.otHourlyRateCents,
        shiftRateCents: line.shiftRateCents,
        dailyRateCents: line.dailyRateCents,
        minHours: line.minHours,
        weekendMultiplier: line.weekendMultiplier,
        nightMultiplier: line.nightMultiplier,
        effectiveFrom: args.effectiveFrom,
        currency: args.currency,
        version,
        sourceProposalId: args.sourceProposalId,
        supersedesRateCardId: line.replacesRateCardId,
        actorUserId: args.actorUserId,
      },
      runner
    );
    writtenCardIds.push(cardId);
    // §36 stars "approved time and rates" as needing a reason on every revision.
    await recordRevision(
      {
        companyId: args.edge.clientCompanyId,
        entityType: 'rate_card',
        entityId: cardId,
        action: 'CREATE',
        after: {
          version,
          roleId: line.roleId,
          rateLabel: line.rateLabel,
          rateMode: line.rateMode,
          hourlyRateCents: line.hourlyRateCents,
          otHourlyRateCents: line.otHourlyRateCents,
          shiftRateCents: line.shiftRateCents,
          dailyRateCents: line.dailyRateCents,
          minHours: line.minHours,
          effectiveFrom: args.effectiveFrom,
          currency: args.currency,
          sourceProposalId: args.sourceProposalId,
          supersedesRateCardId: line.replacesRateCardId,
        },
        reason:
          args.reason ??
          (args.sourceProposalId
            ? 'Approved cross-company rate schedule'
            : 'Rate schedule agreed outside CrewQuo, recorded directly'),
        changedByUserId: args.actorUserId,
      },
      runner
    );
  }
  return { writtenCardIds, supersededCardIds };
}

export async function approveRateProposal(args: {
  proposalId: string;
  edge: EdgeFacts;
  retroactiveReason: string | null;
  /** Whether the approving user may back-date — `canApproveRetroactively`. */
  actorCanApproveRetroactively: boolean;
  actorUserId: string;
  actorCompanyId: string;
}): Promise<ApprovalOutcome> {
  const outcome = await withTransaction(async (runner) => {
    await lockEdge(args.edge.engagementId, runner);
    const view = await getRateProposal(args.proposalId, args.actorCompanyId, runner);
    if (!view) throw new AppError('NOT_FOUND', 'Schedule not found');
    if (view.status !== 'SUBMITTED') {
      throw new AppError(
        'CONFLICT',
        `This schedule is ${view.status.toLowerCase()} and cannot be approved`
      );
    }

    const hiring = await findCompanyById(args.edge.clientCompanyId, runner);
    if (!hiring) throw new AppError('NOT_FOUND', 'Hiring company not found');
    // Re-checked at approval, not just at draft: a rate could have been deleted
    // between the two, and approval is the point the schedule becomes money.
    const currencyRefusal = currencyBoundaryRefusal({
      proposalCurrency: view.currency,
      hiringCompanyCurrency: hiring.currency,
      effectiveFrom: view.effectiveFrom,
      hasRate: await hasFxRate({
        companyId: hiring.id,
        base: view.currency,
        quote: hiring.currency,
        asOf: view.effectiveFrom,
        runner,
      }),
    });
    if (currencyRefusal) throw new AppError('VALIDATION', currencyRefusal);

    const retroactive = isRetroactive(view.effectiveFrom, todayIso());
    if (retroactive && !args.actorCanApproveRetroactively) {
      throw new AppError(
        'FORBIDDEN',
        'This schedule takes effect in the past. Approved time keeps the PAY rate frozen ' +
          'at submit, so back-dating it needs an owner to approve with a reason.',
        { requiresRole: 'OWNER', effectiveFrom: view.effectiveFrom }
      );
    }
    if (retroactive && !args.retroactiveReason) {
      throw new AppError(
        'VALIDATION',
        'Approving a schedule that takes effect in the past needs a reason on the record',
        { effectiveFrom: view.effectiveFrom }
      );
    }
    if (!retroactive && args.retroactiveReason) {
      // Recording an override that did not happen would make the trail lie.
      throw new AppError(
        'VALIDATION',
        'This schedule does not take effect in the past, so it needs no retroactive reason'
      );
    }

    const applied = await applySchedule(
      {
        lines: view.lines,
        edge: args.edge,
        effectiveFrom: view.effectiveFrom,
        currency: view.currency,
        sourceProposalId: view.id,
        actorUserId: args.actorUserId,
        reason: args.retroactiveReason,
      },
      runner
    );

    await transitionProposal(
      {
        id: args.proposalId,
        from: 'SUBMITTED',
        to: 'APPROVED',
        actorUserId: args.actorUserId,
        retroactiveReason: args.retroactiveReason,
      },
      runner
    );

    return {
      proposal: (await getRateProposal(args.proposalId, args.actorCompanyId, runner))!,
      ...applied,
    };
  });

  return outcome;
}

/**
 * Direct entry (§3.3.1): the hiring company records a schedule agreed outside
 * CrewQuo. It writes the same immutable versions the proposal path does, and is
 * audited as such — a direct-entry rate is not less real than an approved one, it
 * simply had its negotiation somewhere else.
 */
export async function recordDirectSchedule(args: {
  input: DirectRateSchedule;
  edge: EdgeFacts;
  actorCanApproveRetroactively: boolean;
  actorUserId: string;
}): Promise<{ writtenCardIds: string[]; supersededCardIds: string[]; currency: string }> {
  const outcome = await withTransaction(async (runner) => {
    await lockEdge(args.edge.engagementId, runner);
    const hiring = await findCompanyById(args.edge.clientCompanyId, runner);
    if (!hiring) throw new AppError('NOT_FOUND', 'Hiring company not found');
    const currency = args.input.currency ?? hiring.currency;
    const refusal = currencyBoundaryRefusal({
      proposalCurrency: currency,
      hiringCompanyCurrency: hiring.currency,
      effectiveFrom: args.input.effectiveFrom,
      hasRate: await hasFxRate({
        companyId: hiring.id,
        base: currency,
        quote: hiring.currency,
        asOf: args.input.effectiveFrom,
        runner,
      }),
    });
    if (refusal) throw new AppError('VALIDATION', refusal);

    const retroactive = isRetroactive(args.input.effectiveFrom, todayIso());
    if (retroactive && !args.actorCanApproveRetroactively) {
      throw new AppError(
        'FORBIDDEN',
        'This schedule takes effect in the past. Approved time keeps the PAY rate frozen ' +
          'at submit, so back-dating it needs an owner to record it with a reason.',
        { requiresRole: 'OWNER', effectiveFrom: args.input.effectiveFrom }
      );
    }
    if (retroactive && !args.input.retroactiveReason) {
      throw new AppError(
        'VALIDATION',
        'Recording a schedule that takes effect in the past needs a reason on the record',
        { effectiveFrom: args.input.effectiveFrom }
      );
    }

    const applied = await applySchedule(
      {
        lines: args.input.lines,
        edge: args.edge,
        effectiveFrom: args.input.effectiveFrom,
        currency,
        sourceProposalId: null,
        actorUserId: args.actorUserId,
        reason:
          args.input.retroactiveReason ??
          args.input.note ??
          'Rate schedule agreed outside CrewQuo, recorded directly',
      },
      runner
    );
    return { ...applied, currency };
  });
  return outcome;
}
