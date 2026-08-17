import { Router, type Request } from 'express';
import { updateCompanySchema, type CompanySummary } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { isOwnerOrAdmin } from '../../authorization/policies';
import { recordAudit } from '../audit/record';
import { findCompanyById, toCompanySummary, updateCompany } from './repo';

/**
 * Company settings (CREWQUO_V2_PLAN.md §7): `GET /v1/companies/:id` and
 * `PATCH /v1/companies/:id` (OWNER/ADMIN).
 *
 * `:id` must be the active company. A company is reachable only by its own
 * members — counterparty names already arrive through `/v1/engagements`, and
 * widening this to "any company you share an edge with" would hand out a
 * lookup-by-id surface the one-hop rule (§3.2) exists to prevent.
 */
export const companiesRouter = Router();

function assertActiveCompany(req: Request): string {
  const ctx = getCompanyCtx(req);
  const id = uuidParam(req, 'id');
  if (id !== ctx.companyId) {
    // 404, not 403: whether a company id exists is not this caller's business.
    throw new AppError('NOT_FOUND', 'Company not found');
  }
  return id;
}

companiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = assertActiveCompany(req);
    const company = await findCompanyById(id);
    if (!company) throw new AppError('NOT_FOUND', 'Company not found');
    const body: { company: CompanySummary } = { company: toCompanySummary(company) };
    res.json(body);
  })
);

companiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = assertActiveCompany(req);
    if (!isOwnerOrAdmin(ctx.role)) {
      throw new AppError('FORBIDDEN', 'Requires an owner or admin role');
    }
    const patch = updateCompanySchema.parse(req.body);

    const before = await findCompanyById(id);
    if (!before) throw new AppError('NOT_FOUND', 'Company not found');
    const company = await updateCompany(id, patch);

    // Currency re-denominates every stored figure this company displays, so the
    // trail records both sides of the change. Internal — never client-visible.
    await recordAudit({
      companyId: id,
      actorUserId: ctx.userId,
      action: 'company.updated',
      entityType: 'COMPANY',
      entityId: id,
      changes: {
        ...(patch.name !== undefined ? { name: { from: before.name, to: company.name } } : {}),
        ...(patch.currency !== undefined
          ? { currency: { from: before.currency, to: company.currency } }
          : {}),
      },
      description:
        patch.currency !== undefined && patch.currency !== before.currency
          ? `Company currency changed from ${before.currency} to ${company.currency}`
          : 'Company settings updated',
    });

    res.json({ company: toCompanySummary(company) });
  })
);
