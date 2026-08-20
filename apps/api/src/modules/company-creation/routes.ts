import { Router } from 'express';
import {
  COMPANY_CREATION_ATTESTATION,
  COMPANY_RECOVERY_ROUTES,
  COMPANY_REQUEST_PENDING_DAYS,
  COMPANY_REQUEST_RATE_LIMIT,
  COMPANY_REQUEST_RATE_WINDOW_HOURS,
  classifyDuplicateSignal,
  createCompanyCreationRequestSchema,
  isCompanyRequestPending,
  normalizeCompanyName,
  normalizeRegistrationId,
  resolveCompanyApprovalRoute,
  type CompanyCreationRequestResponse,
  type CompanyCreationState,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withTransaction } from '../../db';
import { findUserById } from '../users/repo';
import { requireStepUpAuth } from '../auth/stepUp';
import { recordPlatformAudit } from '../admin/platform.repo';
import { getCompanyCreationSettings } from './settings';
import {
  countRecentRequests,
  deletePendingRequest,
  findAllowance,
  findIdentityCandidates,
  findOpenRequest,
  findOwnRequest,
  insertRequest,
  listOwnRequests,
  planIsPaid,
  toRequestView,
} from './repo';

/**
 * Additional-company requests (CREWQUO_V2_PLAN.md §3.1.1(2), (3), (6), (7)).
 * Operating-model packet: docs/operating-model/company-creation.md
 *
 * The *first* company needs none of this — it is the automatic allowance, spent
 * by `POST /v1/me/companies`. Everything here is the advanced flow for a second
 * distinct legal business.
 */
export const companyCreationRouter = Router();

/**
 * GET /v1/company-creation-requests — everything the profile screen needs to pick
 * between the plain create form, the request form, and a filed request's status.
 *
 * This is also the domain's **durable notification**: no email or push exists yet
 * (Resend is a later bullet), so a decision has to be legible somewhere the user
 * will look. The packet's §6 says the row is that place, and this is the read.
 */
companyCreationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const [allowance, open, history, user, settings] = await Promise.all([
      findAllowance(ctx.userId),
      findOpenRequest(ctx.userId),
      listOwnRequests(ctx.userId),
      findUserById(ctx.userId),
      getCompanyCreationSettings(),
    ]);

    const now = new Date();
    const openView = open ? toRequestView(open, now) : null;
    // A request whose date passed reads as EXPIRED without a writer touching it,
    // and an expired row must not go on occupying the single open slot.
    const liveOpen = openView && openView.status !== 'EXPIRED' ? openView : null;

    let blockedReason: string | null = null;
    if (ctx.isSuperAdmin) {
      blockedReason = 'Platform staff manage companies from the CrewQuo Platform console.';
    } else if (!allowance) {
      blockedReason = 'Your included company has not been created yet.';
    } else if (!user?.email_verified_at) {
      blockedReason = 'Verify your email address before requesting another company.';
    } else if (liveOpen) {
      blockedReason = 'You already have a request in progress.';
    }

    const body: CompanyCreationState = {
      allowanceAvailable: allowance === null && !ctx.isSuperAdmin,
      allowanceCompanyId: allowance?.company_id ?? null,
      canRequest: blockedReason === null,
      blockedReason,
      attestationText: COMPANY_CREATION_ATTESTATION,
      openRequest: liveOpen,
      history: history.map((row) => toRequestView(row, now)),
    };
    // `settings` is loaded to keep this read and the create path on one source of
    // truth; the flags themselves are platform policy and are not exposed here.
    void settings;
    res.json(body);
  })
);

/**
 * POST /v1/company-creation-requests — file the advanced flow (§3.1.1(2)).
 *
 * Order of refusals is the policy: staff, then allowance, then verification, then
 * step-up, then rate limit, then duplicates. Each one is cheaper and more
 * fundamental than the next, and none of them writes anything.
 */
companyCreationRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = createCompanyCreationRequestSchema.parse(req.body);

    if (ctx.isSuperAdmin) {
      throw new AppError(
        'FORBIDDEN',
        'Platform staff do not request companies here. Use the CrewQuo Platform console.'
      );
    }

    const [allowance, user] = await Promise.all([
      findAllowance(ctx.userId),
      findUserById(ctx.userId),
    ]);

    // Nothing to request: the automatic allowance is still there, and sending
    // somebody through an approval queue for a company they can simply create
    // would be the safeguard getting in the way of the person it is not aimed at.
    if (!allowance) {
      throw new AppError(
        'CONFLICT',
        'Your included company has not been created yet — create it directly instead.',
        { requires: 'first_company' }
      );
    }

    // Unconditional here, unlike the first company: this user has had time, and a
    // verified address is what ties the ledger to a real identity.
    if (!user?.email_verified_at) {
      throw new AppError(
        'VALIDATION',
        'Verify your email address before requesting another company.',
        { requires: 'email_verification' }
      );
    }

    await requireStepUpAuth(ctx.userId, input);

    const recent = await countRecentRequests(ctx.userId, COMPANY_REQUEST_RATE_WINDOW_HOURS);
    if (recent >= COMPANY_REQUEST_RATE_LIMIT) {
      throw new AppError(
        'RATE_LIMITED',
        `You can file ${COMPANY_REQUEST_RATE_LIMIT} company requests per ${COMPANY_REQUEST_RATE_WINDOW_HOURS} hours. Try again later.`,
        { retryAfterHours: COMPANY_REQUEST_RATE_WINDOW_HOURS }
      );
    }

    const registrationIdNormalized = normalizeRegistrationId(input.registrationId);
    const candidates = await findIdentityCandidates({
      country: input.country,
      registrationIdNormalized,
      nameNormalized: normalizeCompanyName(input.legalName),
      excludeUserId: ctx.userId,
    });
    const signal = classifyDuplicateSignal(
      { country: input.country, registrationId: input.registrationId, legalName: input.legalName },
      candidates
    );
    if (signal.level === 'BLOCK') {
      // Carries a route, never a company — see the packet's §10.
      throw new AppError('CONFLICT', signal.reason!, {
        requires: 'recovery',
        routes: COMPANY_RECOVERY_ROUTES,
      });
    }

    const settings = await getCompanyCreationSettings();
    const { route, status } = resolveCompanyApprovalRoute({
      checkoutEnabled: settings.checkoutEnabled,
      intendedPlanIsPaid: await planIsPaid(input.intendedPlanId),
    });

    const expiresAt = new Date(Date.now() + COMPANY_REQUEST_PENDING_DAYS * 86_400_000);

    const request = await withTransaction(async (client) => {
      const row = await insertRequest(
        {
          userId: ctx.userId,
          status,
          legalName: input.legalName,
          displayName: input.displayName ?? input.legalName,
          country: input.country,
          registrationId: input.registrationId ?? null,
          intendedPlanId: input.intendedPlanId ?? null,
          currency: input.currency,
          attestationText: COMPANY_CREATION_ATTESTATION,
          approvalRoute: route,
          expiresAt,
        },
        client
      );
      // Inside the transaction, because this row is also what the 24-hour rate
      // limit counts. Written after the fact it could be lost, and a lost audit
      // row would silently buy the caller another attempt.
      await recordPlatformAudit(
        {
          actorUserId: ctx.userId,
          action: 'company_creation_request.created',
          entityType: 'COMPANY_CREATION_REQUEST',
          entityId: row.id,
          changes: {
            legalName: row.legal_name,
            country: row.country,
            registrationIdNormalized: row.registration_id_normalized,
            intendedPlanId: row.intended_plan_id,
            status: row.status,
            approvalRoute: row.approval_route,
            duplicateWarning: signal.level === 'WARNING' ? signal.reason : null,
          },
          description: `${row.legal_name} was requested as an additional company`,
        },
        client
      );
      return row;
    });

    const body: CompanyCreationRequestResponse = {
      request: toRequestView(request),
      warning: signal.level === 'WARNING' ? signal.reason : null,
    };
    res.status(201).json(body);
  })
);

/**
 * DELETE /v1/company-creation-requests/:id — the requester withdraws.
 *
 * The row is deleted rather than moved to a seventh state: §3.1.1 enumerates six
 * and none is "withdrawn", and inventing one would be inventing a shape (§0.3).
 * The live row is the claim; `platform_audit_logs` is insert-only, so the history
 * of the request and its withdrawal survives it.
 */
companyCreationRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const id = uuidParam(req, 'id');

    // Scoped to the caller, so somebody else's id is a 404 rather than a 403 —
    // a 403 would confirm the request exists.
    const existing = await findOwnRequest(id, ctx.userId);
    if (!existing) throw new AppError('NOT_FOUND', 'Request not found');
    if (!isCompanyRequestPending(existing.status)) {
      throw new AppError('CONFLICT', `This request is already ${existing.status.toLowerCase()}.`);
    }

    await withTransaction(async (client) => {
      const removed = await deletePendingRequest(id, ctx.userId, client);
      if (!removed) {
        // A reviewer decided it between the read above and this delete.
        throw new AppError('CONFLICT', 'This request was decided before it could be withdrawn.');
      }
      await recordPlatformAudit(
        {
          actorUserId: ctx.userId,
          action: 'company_creation_request.deleted',
          entityType: 'COMPANY_CREATION_REQUEST',
          entityId: id,
          changes: { priorStatus: existing.status, legalName: existing.legal_name },
          description: `${existing.legal_name} request was withdrawn by the requester`,
        },
        client
      );
    });

    res.status(204).end();
  })
);
