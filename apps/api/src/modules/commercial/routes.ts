import { Router } from 'express';
import {
  DEFAULT_TIME_ZONE,
  approveRateProposalSchema,
  createRateProposalSchema,
  directRateScheduleSchema,
  rateProposalTransitionRefusal,
  rejectRateProposalSchema,
  todayInZone,
  updateRateProposalSchema,
  type CommercialAgreement,
  type RateProposalVerb,
} from '@crewquo/shared';
import {
  canApproveRetroactively,
  canDraftRateProposal,
  canManage,
  canReviewRateProposal,
  engagementSide,
  type EngagementEdge,
} from '../../authorization/policies';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { recordAudit } from '../audit/record';
import { findCompanyById } from '../companies/repo';
import { findEngagementEdge } from '../engagements/repo';
import { hasFeature } from '../entitlements/guards';
import { getEngagementTerms, listCommittedInvoiceCents } from '../engagements/terms.repo';
import { getRateProposal, listLiveAgreementRates, listRateProposals } from './repo';
import {
  approveRateProposal,
  createRateProposal,
  editRateProposal,
  recordDirectSchedule,
  rejectRateProposal,
  removeRateProposal,
  submitRateProposal,
  withdrawRateProposal,
  type EdgeFacts,
} from './service';

/**
 * `/v1/rate-proposals` and `/v1/commercial-agreements` (CREWQUO_V2_PLAN.md §3.3.1).
 *
 * Two rules run through every handler:
 *
 *  - **The edge decides who may act, not a user role.** `engagementSide` resolves
 *    the acting company to `provider` or `client`; the drafting and reviewing
 *    policies are separate functions so widening one cannot widen the other.
 *  - **A company that is not an endpoint gets `NOT_FOUND`**, the same answer a
 *    forged id gets, so this surface never discloses that an engagement exists.
 */

export const rateProposalsRouter = Router();
export const commercialAgreementsRouter = Router();

function toEdge(row: { client_company_id: string; provider_company_id: string }): EngagementEdge {
  return { clientCompanyId: row.client_company_id, providerCompanyId: row.provider_company_id };
}

/** Resolve an engagement the active company is an endpoint of, or 404. */
async function loadEdge(
  engagementId: string,
  companyId: string
): Promise<{ edge: EngagementEdge; facts: EdgeFacts; side: 'client' | 'provider' }> {
  const row = await findEngagementEdge(engagementId);
  if (!row) throw new AppError('NOT_FOUND', 'Engagement not found');
  const edge = toEdge(row);
  const side = engagementSide(companyId, edge);
  if (!side) throw new AppError('NOT_FOUND', 'Engagement not found');
  return {
    edge,
    side,
    facts: {
      engagementId: row.id,
      clientCompanyId: row.client_company_id,
      providerCompanyId: row.provider_company_id,
    },
  };
}

/**
 * Load a proposal the active company may see, with its edge. A `DRAFT` is the
 * provider's alone — the hiring side has no business seeing numbers nobody has
 * decided to ask for yet, so it 404s rather than 403s.
 */
async function loadProposal(id: string, companyId: string) {
  const proposal = await getRateProposal(id, companyId);
  if (!proposal) throw new AppError('NOT_FOUND', 'Rate schedule not found');
  const loaded = await loadEdge(proposal.engagementId, companyId);
  if (proposal.status === 'DRAFT' && loaded.side !== 'provider') {
    throw new AppError('NOT_FOUND', 'Rate schedule not found');
  }
  return { proposal, ...loaded };
}

/**
 * Approving writes the *hiring* company's rate cards, so `rate_cards` is resolved
 * on the hiring company. Proposing is deliberately free: the Crew plan carries no
 * features and exists so a subcontractor can work for nothing, which would be
 * pointless if it could never ask for a raise (§5B, and §4 of the packet).
 */
async function assertHiringMayHoldRates(hiringCompanyId: string): Promise<void> {
  if (!(await hasFeature(hiringCompanyId, 'rate_cards'))) {
    throw new AppError(
      'FORBIDDEN',
      'The hiring company’s plan does not include rate cards, so it cannot hold an ' +
        'agreed schedule',
      { feature: 'rate_cards' }
    );
  }
}

/** The shared shape of a transition refusal: policy first, then state. */
function assertTransition(args: {
  verb: RateProposalVerb;
  ctx: Ctx & { role: NonNullable<Ctx['role']> };
  side: 'client' | 'provider';
  status: Parameters<typeof rateProposalTransitionRefusal>[0]['status'];
}): void {
  const refusal = rateProposalTransitionRefusal({
    verb: args.verb,
    status: args.status,
    actorSide: args.side,
    actorIsManager: canManage(args.ctx.role),
  });
  if (!refusal) return;
  // A wrong side or a wrong role is a permission problem; a wrong state is a
  // concurrency problem. They are different HTTP answers and different user fixes.
  const isStateProblem = /already|cannot be/i.test(refusal);
  throw new AppError(isStateProblem ? 'CONFLICT' : 'FORBIDDEN', refusal);
}

// ── /v1/rate-proposals ────────────────────────────────────────────────────────

rateProposalsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const engagementId =
      typeof req.query.engagementId === 'string' ? req.query.engagementId : undefined;
    res.json({ data: await listRateProposals(ctx.companyId, { engagementId }) });
  })
);

rateProposalsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = createRateProposalSchema.parse(req.body);
    const { edge, facts } = await loadEdge(input.engagementId, ctx.companyId);
    if (!canDraftRateProposal(ctx.companyId, ctx.role, edge)) {
      throw new AppError(
        'FORBIDDEN',
        'Only a manager on the provider side of this engagement may propose a rate schedule'
      );
    }
    const proposal = await createRateProposal({
      input,
      edge: facts,
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.created',
      entityType: 'RATE_PROPOSAL',
      entityId: proposal.id,
      changes: { effectiveFrom: proposal.effectiveFrom, lineCount: proposal.lines.length },
      description: 'Draft rate schedule created',
    });
    res.status(201).json({ proposal });
  })
);

rateProposalsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { proposal } = await loadProposal(uuidParam(req, 'id'), ctx.companyId);
    res.json({ proposal });
  })
);

rateProposalsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const patch = updateRateProposalSchema.parse(req.body);
    const { proposal, edge, facts } = await loadProposal(id, ctx.companyId);
    if (!canDraftRateProposal(ctx.companyId, ctx.role, edge)) {
      throw new AppError('FORBIDDEN', 'Only the provider side may edit its own draft schedule');
    }
    if (proposal.status !== 'DRAFT') {
      throw new AppError(
        'CONFLICT',
        `This schedule is ${proposal.status.toLowerCase()} and its lines are frozen. ` +
          'Create a successor schedule instead.'
      );
    }
    const updated = await editRateProposal({
      proposalId: id,
      patch,
      edge: facts,
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.updated',
      entityType: 'RATE_PROPOSAL',
      entityId: id,
      changes: { fields: Object.keys(patch) },
      description: 'Draft rate schedule updated',
    });
    res.json({ proposal: updated });
  })
);

rateProposalsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { proposal, edge, facts } = await loadProposal(id, ctx.companyId);
    if (!canDraftRateProposal(ctx.companyId, ctx.role, edge)) {
      throw new AppError('FORBIDDEN', 'Only the provider side may delete its own draft schedule');
    }
    if (proposal.status !== 'DRAFT') {
      throw new AppError(
        'CONFLICT',
        `This schedule is ${proposal.status.toLowerCase()}. A submitted schedule is ` +
          'withdrawn, not deleted — the other side has already seen it.'
      );
    }
    await removeRateProposal({
      proposalId: id,
      edge: facts,
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.deleted',
      entityType: 'RATE_PROPOSAL',
      entityId: id,
      description: 'Draft rate schedule deleted',
    });
    res.status(204).end();
  })
);

rateProposalsRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { proposal, side, facts } = await loadProposal(id, ctx.companyId);
    assertTransition({ verb: 'submit', ctx, side, status: proposal.status });
    const updated = await submitRateProposal({
      proposalId: id,
      edge: facts,
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    // Client-visible: the hiring company is the audience for this event, and the
    // description names no amount, so the row leaks nothing the payload does not.
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.submitted',
      entityType: 'RATE_PROPOSAL',
      entityId: id,
      changes: { effectiveFrom: updated.effectiveFrom, lineCount: updated.lines.length },
      description: `Rate schedule submitted for approval, effective ${updated.effectiveFrom}`,
      visibleToClient: true,
    });
    res.json({ proposal: updated });
  })
);

rateProposalsRouter.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { proposal, side } = await loadProposal(id, ctx.companyId);
    assertTransition({ verb: 'withdraw', ctx, side, status: proposal.status });
    const updated = await withdrawRateProposal({
      proposalId: id,
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.withdrawn',
      entityType: 'RATE_PROPOSAL',
      entityId: id,
      description: 'Rate schedule withdrawn before a decision',
      visibleToClient: true,
    });
    res.json({ proposal: updated });
  })
);

rateProposalsRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { retroactiveReason } = approveRateProposalSchema.parse(req.body ?? {});
    const { proposal, edge, side, facts } = await loadProposal(id, ctx.companyId);
    assertTransition({ verb: 'approve', ctx, side, status: proposal.status });
    if (!canReviewRateProposal(ctx.companyId, ctx.role, edge)) {
      throw new AppError('FORBIDDEN', 'Only the hiring company may approve a rate schedule');
    }
    await assertHiringMayHoldRates(facts.clientCompanyId);

    const outcome = await approveRateProposal({
      proposalId: id,
      edge: facts,
      retroactiveReason,
      actorCanApproveRetroactively: canApproveRetroactively(ctx.role),
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.approved',
      entityType: 'RATE_PROPOSAL',
      entityId: id,
      changes: {
        effectiveFrom: outcome.proposal.effectiveFrom,
        rateCardIds: outcome.writtenCardIds,
        supersededRateCardIds: outcome.supersededCardIds,
        retroactive: outcome.proposal.retroactiveReason !== null,
      },
      description: `Rate schedule approved, effective ${outcome.proposal.effectiveFrom}`,
    });
    res.json({
      proposal: outcome.proposal,
      rateCardIds: outcome.writtenCardIds,
      supersededRateCardIds: outcome.supersededCardIds,
    });
  })
);

rateProposalsRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { reason } = rejectRateProposalSchema.parse(req.body);
    const { proposal, edge, side } = await loadProposal(id, ctx.companyId);
    assertTransition({ verb: 'reject', ctx, side, status: proposal.status });
    if (!canReviewRateProposal(ctx.companyId, ctx.role, edge)) {
      throw new AppError('FORBIDDEN', 'Only the hiring company may reject a rate schedule');
    }
    const updated = await rejectRateProposal({
      proposalId: id,
      reason,
      actorUserId: ctx.userId,
      actorCompanyId: ctx.companyId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_proposal.rejected',
      entityType: 'RATE_PROPOSAL',
      entityId: id,
      changes: { reason },
      description: 'Rate schedule returned to the provider',
    });
    res.json({ proposal: updated });
  })
);

// ── /v1/commercial-agreements ─────────────────────────────────────────────────

/**
 * One engagement's whole commercial picture — terms, the live PAY schedule, and the
 * proposal history — in a single request, because a screen that shows a proposed
 * rate without the rate in force is asking the reviewer to hold two numbers in
 * their head.
 */
commercialAgreementsRouter.get(
  '/:engagementId',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const engagementId = uuidParam(req, 'engagementId');
    const { facts, side } = await loadEdge(engagementId, ctx.companyId);

    const [terms, committedCents, liveRates, proposals, hiring, provider] = await Promise.all([
      getEngagementTerms(engagementId),
      listCommittedInvoiceCents(engagementId),
      listLiveAgreementRates(engagementId),
      listRateProposals(ctx.companyId, { engagementId }),
      findCompanyById(facts.clientCompanyId),
      findCompanyById(facts.providerCompanyId),
    ]);
    if (!terms || !hiring || !provider) throw new AppError('NOT_FOUND', 'Engagement not found');

    const agreement: CommercialAgreement = {
      engagementId,
      side,
      providerCompanyId: facts.providerCompanyId,
      providerCompanyName: provider.name,
      clientCompanyId: facts.clientCompanyId,
      clientCompanyName: hiring.name,
      currency: hiring.currency,
      // The same basis `createRateProposal`/`editRateProposal` use to decide whether
      // a schedule is back-dated, handed to the screen so it can warn about the same
      // thing the server will refuse. Read from the same row, so the two cannot
      // drift into disagreeing about whose day it is.
      hiringToday: todayInZone(hiring.time_zone ?? DEFAULT_TIME_ZONE, new Date()),
      terms: {
        paymentTermsDays: terms.paymentTermsDays,
        purchaseOrderReference: terms.purchaseOrderReference,
        purchaseOrderCeilingCents: terms.purchaseOrderCeilingCents,
        committedCents,
        termsUpdatedAt: terms.termsUpdatedAt,
      },
      acceptance: {
        status: terms.status,
        providerAcceptedAt: terms.providerAcceptedAt,
        decisionReason: terms.decisionReason,
      },
      liveRates,
      proposals,
    };
    res.json({ agreement });
  })
);

/**
 * Direct entry (§3.3.1): the hiring company records a schedule agreed outside
 * CrewQuo. Same immutable versions, same revision trail — the negotiation simply
 * happened elsewhere.
 */
commercialAgreementsRouter.post(
  '/:engagementId/schedule',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const engagementId = uuidParam(req, 'engagementId');
    const body = directRateScheduleSchema.parse({ ...req.body, engagementId });
    const { edge, facts } = await loadEdge(engagementId, ctx.companyId);
    if (!canReviewRateProposal(ctx.companyId, ctx.role, edge)) {
      throw new AppError(
        'FORBIDDEN',
        'Only a manager in the hiring company may record an agreed rate schedule'
      );
    }
    await assertHiringMayHoldRates(facts.clientCompanyId);

    const outcome = await recordDirectSchedule({
      input: body,
      edge: facts,
      actorCanApproveRetroactively: canApproveRetroactively(ctx.role),
      actorUserId: ctx.userId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'rate_schedule.recorded',
      entityType: 'RATE_CARD',
      entityId: outcome.writtenCardIds[0] ?? null,
      changes: {
        engagementId,
        effectiveFrom: body.effectiveFrom,
        rateCardIds: outcome.writtenCardIds,
        supersededRateCardIds: outcome.supersededCardIds,
      },
      description: `Rate schedule agreed outside CrewQuo recorded, effective ${body.effectiveFrom}`,
    });
    res.status(201).json({
      rateCardIds: outcome.writtenCardIds,
      supersededRateCardIds: outcome.supersededCardIds,
      currency: outcome.currency,
    });
  })
);
