import { Router } from 'express';
import {
  cancelDeletionSchema,
  requestDeletionSchema,
  type DeletionStatusResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { findCompanyById } from '../companies/repo';
import {
  cancelClosure,
  readCompanyDeletionStatus,
  readPersonalDeletionStatus,
  requestCompanyClosure,
  requestPersonalClosure,
  toDeletionRequestView,
} from './service';
import { findLiveRequestForCompany, findLiveRequestForUser } from './repo';

/**
 * Closure endpoints (`docs/operating-model/observability-data-lifecycle.md` §4, §14
 * step 5).
 *
 *   `GET/POST/DELETE /v1/me/closure`            — a person's own account
 *   `GET/POST/DELETE /v1/companies/:id/closure` — a company, OWNER only
 *
 * **No entitlement check on either, and deliberately.** Leaving is not a feature. A
 * plan gate on erasure would make a legal obligation a paid add-on, and a gate on
 * closing a company would be a subscription somebody has to keep paying in order to
 * stop paying it.
 *
 * `DELETE` is the cancel, which reads oddly for exactly a moment: the resource is
 * *the pending closure*, and deleting a scheduled deletion is what stopping it is.
 * The alternative — `POST /closure/cancel` — invents a verb for something the method
 * already means.
 */
export const meClosureRouter = Router();
export const companyClosureRouter = Router();

// ── A person's own account ────────────────────────────────────────────────────

meClosureRouter.get(
  '/closure',
  asyncHandler(async (req, res) => {
    // `getCtx`, not `getCompanyCtx`: closing an account needs no active company, and
    // requiring one would refuse the screen to somebody whose last membership was
    // just removed — which is exactly when a person closes their account.
    const ctx = getCtx(req);
    const body: DeletionStatusResponse = await readPersonalDeletionStatus(ctx.userId);
    res.json(body);
  })
);

meClosureRouter.post(
  '/closure',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = requestDeletionSchema.parse(req.body);
    const request = await requestPersonalClosure(ctx.userId, input);
    res.status(201).json({ request: toDeletionRequestView(request, ctx.userId) });
  })
);

meClosureRouter.delete(
  '/closure',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const { reason } = cancelDeletionSchema.parse(req.body ?? {});
    const request = await findLiveRequestForUser(ctx.userId);
    if (!request) throw new AppError('NOT_FOUND', 'No closure is scheduled for this account');

    const cancelled = await cancelClosure({
      request,
      actorUserId: ctx.userId,
      reason: reason ?? null,
    });
    res.json({ request: toDeletionRequestView(cancelled, ctx.userId) });
  })
);

// ── A company ─────────────────────────────────────────────────────────────────

/**
 * The company must be the active one, and 404 rather than 403 for anything else —
 * matching `GET /v1/companies/:id` and the export. Whether a company id exists is
 * not this caller's business.
 */
function companyScope(req: Parameters<Parameters<typeof asyncHandler>[0]>[0]): {
  companyId: string;
  userId: string;
  role: string;
} {
  const ctx = getCompanyCtx(req);
  const id = uuidParam(req, 'id');
  if (id !== ctx.companyId) throw new AppError('NOT_FOUND', 'Company not found');
  return { companyId: id, userId: ctx.userId, role: ctx.role };
}

companyClosureRouter.get(
  '/:id/closure',
  asyncHandler(async (req, res) => {
    const { companyId, userId, role } = companyScope(req);
    /*
     * Readable by an admin, requestable only by an owner (below).
     *
     * Not the same check twice by accident: an admin who can see that a closure is
     * scheduled — and cancel it — is the protection against an owner acting alone or
     * under duress. Hiding the screen from them would leave the people best placed
     * to notice unable to.
     */
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only an owner or admin can see this');
    }
    const body: DeletionStatusResponse = await readCompanyDeletionStatus(companyId, userId);
    res.json(body);
  })
);

companyClosureRouter.post(
  '/:id/closure',
  asyncHandler(async (req, res) => {
    const { companyId, userId, role } = companyScope(req);
    /*
     * **OWNER only** (§4). An admin can be appointed in a minute and does not own the
     * subscription, the liability or the relationships this ends. Step-up
     * re-authentication is enforced in the service, next to the typed confirmation,
     * so neither can be skipped by a second route arriving later.
     */
    if (role !== 'OWNER') {
      throw new AppError('FORBIDDEN', 'Only an owner can close a company');
    }
    const input = requestDeletionSchema.parse(req.body);

    const company = await findCompanyById(companyId);
    if (!company) throw new AppError('NOT_FOUND', 'Company not found');

    const request = await requestCompanyClosure({
      companyId,
      companyName: company.name,
      actorUserId: userId,
      body: input,
    });
    res.status(201).json({ request: toDeletionRequestView(request, userId) });
  })
);

companyClosureRouter.delete(
  '/:id/closure',
  asyncHandler(async (req, res) => {
    const { companyId, userId, role } = companyScope(req);
    // Cancelling is open to an admin as well as an owner — see the GET above.
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new AppError('FORBIDDEN', 'Only an owner or admin can stop a closure');
    }
    const { reason } = cancelDeletionSchema.parse(req.body ?? {});

    const request = await findLiveRequestForCompany(companyId);
    if (!request) throw new AppError('NOT_FOUND', 'No closure is scheduled for this company');

    const cancelled = await cancelClosure({
      request,
      actorUserId: userId,
      reason: reason ?? null,
    });
    res.json({ request: toDeletionRequestView(cancelled, userId) });
  })
);
