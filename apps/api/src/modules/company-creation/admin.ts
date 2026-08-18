import { Router } from 'express';
import {
  COMPANY_REQUEST_APPROVAL_DAYS,
  adminCompanyCreationDecisionSchema,
  adminCompanyCreationRequestListQuerySchema,
  adminRecordCheckoutSchema,
  effectiveCompanyRequestStatus,
  nextCompanyRequestStatus,
  type AdminCompanyCreationRequestsResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withTransaction } from '../../db';
import { recordPlatformAudit } from '../admin/platform.repo';
import {
  approveRequest,
  findRequestById,
  listAdminRequests,
  rejectRequest,
  toRequestView,
} from './repo';

/**
 * The platform side of §3.1.1(3) — the audited super-admin approval that stands
 * in for a checkout while there is no merchant of record, and remains the
 * exceptional path for a legitimate free/Crew second company once there is.
 *
 * Mounted under `/v1/admin`, which is already behind `requireAuth` +
 * `requireSuperAdmin`.
 */
export const adminCompanyCreationRouter = Router();

adminCompanyCreationRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = adminCompanyCreationRequestListQuerySchema.parse(req.query);
    const body: AdminCompanyCreationRequestsResponse = { data: await listAdminRequests(query) };
    res.json(body);
  })
);

/**
 * Load a request and refuse the transition here rather than letting the
 * conditional write silently match nothing.
 *
 * The write still carries the same `where` clause — this is the *explanation*, so
 * a reviewer is told the request expired or was already decided instead of
 * getting a bare 409. The commercial-agreements domain settled the same question
 * the same way: refuse in the route because a constraint violation reaches a
 * caller as a 500.
 */
async function loadForTransition(
  id: string,
  event: 'ADMIN_APPROVE' | 'ADMIN_REJECT' | 'CHECKOUT_RECORDED'
) {
  const row = await findRequestById(id);
  if (!row) throw new AppError('NOT_FOUND', 'Request not found');

  const status = effectiveCompanyRequestStatus(row.status, row.expires_at, new Date());
  if (status === 'EXPIRED' && row.status !== 'EXPIRED') {
    throw new AppError('CONFLICT', 'This request expired before it was decided.');
  }
  if (!nextCompanyRequestStatus(status, event)) {
    throw new AppError('CONFLICT', `This request is already ${status.toLowerCase()}.`);
  }
  return row;
}

/** POST /v1/admin/company-creation-requests/:id/approve */
adminCompanyCreationRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const id = uuidParam(req, 'id');
    // An approval with no reason is indistinguishable from a mistake later.
    const { reason } = adminCompanyCreationDecisionSchema.parse(req.body);
    const before = await loadForTransition(id, 'ADMIN_APPROVE');

    // The clock restarts: what has to be used now is the approval, not the
    // application it was granted from.
    const expiresAt = new Date(Date.now() + COMPANY_REQUEST_APPROVAL_DAYS * 86_400_000);

    const updated = await withTransaction(async (client) => {
      const row = await approveRequest(
        { id, decidedByUserId: ctx.userId, reason, expiresAt },
        client
      );
      if (!row) throw new AppError('CONFLICT', 'This request was decided by someone else.');
      await recordPlatformAudit(
        {
          actorUserId: ctx.userId,
          action: 'company_creation_request.approved',
          entityType: 'COMPANY_CREATION_REQUEST',
          entityId: id,
          changes: {
            before: { status: before.status },
            after: { status: row.status, expiresAt: row.expires_at.toISOString() },
            route: row.approval_route,
            reason,
          },
          description: `${row.legal_name} was approved as an additional company`,
        },
        client
      );
      return row;
    });

    res.json({ request: toRequestView(updated) });
  })
);

/** POST /v1/admin/company-creation-requests/:id/reject */
adminCompanyCreationRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const id = uuidParam(req, 'id');
    const { reason } = adminCompanyCreationDecisionSchema.parse(req.body);
    const before = await loadForTransition(id, 'ADMIN_REJECT');

    const updated = await withTransaction(async (client) => {
      const row = await rejectRequest({ id, decidedByUserId: ctx.userId, reason }, client);
      if (!row) throw new AppError('CONFLICT', 'This request was decided by someone else.');
      await recordPlatformAudit(
        {
          actorUserId: ctx.userId,
          action: 'company_creation_request.rejected',
          entityType: 'COMPANY_CREATION_REQUEST',
          entityId: id,
          changes: { before: { status: before.status }, after: { status: row.status }, reason },
          description: `${row.legal_name} was rejected`,
        },
        client
      );
      return row;
    });

    res.json({ request: toRequestView(updated) });
  })
);

/**
 * POST /v1/admin/company-creation-requests/:id/record-checkout
 *
 * The `PENDING_CHECKOUT → APPROVED` edge, reachable today by an operator holding
 * a payment reference ("the customer paid, mark it") and by the Gumroad webhook
 * when that lands — the webhook will call this same transition rather than a
 * parallel one, which is the whole reason the state exists now instead of being
 * added later with billing.
 */
adminCompanyCreationRouter.post(
  '/:id/record-checkout',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const id = uuidParam(req, 'id');
    const input = adminRecordCheckoutSchema.parse(req.body);
    const before = await loadForTransition(id, 'CHECKOUT_RECORDED');

    if (before.checkout_reference && before.checkout_reference !== input.checkoutReference) {
      throw new AppError(
        'CONFLICT',
        'This request already carries a different checkout reference.'
      );
    }

    const expiresAt = new Date(Date.now() + COMPANY_REQUEST_APPROVAL_DAYS * 86_400_000);

    const updated = await withTransaction(async (client) => {
      const row = await approveRequest(
        {
          id,
          decidedByUserId: ctx.userId,
          reason: input.reason,
          expiresAt,
          checkoutReference: input.checkoutReference,
        },
        client
      );
      if (!row) throw new AppError('CONFLICT', 'This request was decided by someone else.');
      await recordPlatformAudit(
        {
          actorUserId: ctx.userId,
          action: 'company_creation_request.checkout_recorded',
          entityType: 'COMPANY_CREATION_REQUEST',
          entityId: id,
          changes: {
            checkoutReference: input.checkoutReference,
            before: { status: before.status },
            after: { status: row.status },
            reason: input.reason,
          },
          description: `${row.legal_name} was approved against a recorded checkout`,
        },
        client
      );
      return row;
    });

    res.json({ request: toRequestView(updated) });
  })
);
