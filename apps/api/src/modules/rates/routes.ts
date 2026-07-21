import { Router } from 'express';
import {
  rateCardCreateSchema,
  rateCardUpdateSchema,
  rateCardTemplateCreateSchema,
  rateCardTemplateUpdateSchema,
  resolveRateQuerySchema,
  roleCatalogCreateSchema,
  roleCatalogUpdateSchema,
  extractRate,
  resolveRateLabel,
  type ResolveRateResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { requireRole } from '../../http/middleware/auth';
import {
  createRateCard,
  createRole,
  createTemplate,
  deleteRateCard,
  deleteRole,
  deleteTemplate,
  getRateCard,
  getRole,
  getTemplate,
  listRateCards,
  listResolveCandidates,
  listRoles,
  listTemplates,
  updateRateCard,
  updateRole,
  updateTemplate,
} from './repo';
import { pickEffectiveCard } from './resolve';

/** Managers and above may edit the catalog; any active member may read it. */
const canManage = requireRole('OWNER', 'ADMIN', 'MANAGER');

// ── /v1/role-catalog ──────────────────────────────────────────────────────────

export const roleCatalogRouter = Router();

roleCatalogRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listRoles(ctx.companyId) });
  })
);

roleCatalogRouter.post(
  '/',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = roleCatalogCreateSchema.parse(req.body);
    res.status(201).json({ role: await createRole(ctx.companyId, input) });
  })
);

roleCatalogRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const role = await getRole(ctx.companyId, param(req, 'id'));
    if (!role) throw new AppError('NOT_FOUND', 'Role not found');
    res.json({ role });
  })
);

roleCatalogRouter.patch(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const patch = roleCatalogUpdateSchema.parse(req.body);
    res.json({ role: await updateRole(ctx.companyId, param(req, 'id'), patch) });
  })
);

roleCatalogRouter.delete(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await deleteRole(ctx.companyId, param(req, 'id'));
    res.status(204).end();
  })
);

// ── /v1/rate-card-templates ────────────────────────────────────────────────────

export const rateCardTemplateRouter = Router();

rateCardTemplateRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listTemplates(ctx.companyId) });
  })
);

rateCardTemplateRouter.post(
  '/',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = rateCardTemplateCreateSchema.parse(req.body);
    res.status(201).json({ template: await createTemplate(ctx.companyId, input) });
  })
);

rateCardTemplateRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const template = await getTemplate(ctx.companyId, param(req, 'id'));
    if (!template) throw new AppError('NOT_FOUND', 'Template not found');
    res.json({ template });
  })
);

rateCardTemplateRouter.patch(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const patch = rateCardTemplateUpdateSchema.parse(req.body);
    res.json({ template: await updateTemplate(ctx.companyId, param(req, 'id'), patch) });
  })
);

rateCardTemplateRouter.delete(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await deleteTemplate(ctx.companyId, param(req, 'id'));
    res.status(204).end();
  })
);

// ── /v1/rate-cards ──────────────────────────────────────────────────────────────

export const rateCardRouter = Router();

rateCardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const kind = req.query.kind === 'PAY' || req.query.kind === 'BILL' ? req.query.kind : undefined;
    const roleId = typeof req.query.roleId === 'string' ? req.query.roleId : undefined;
    res.json({ data: await listRateCards(ctx.companyId, { kind, roleId }) });
  })
);

rateCardRouter.post(
  '/',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = rateCardCreateSchema.parse(req.body);
    res.status(201).json({ rateCard: await createRateCard(ctx.companyId, input) });
  })
);

rateCardRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const rateCard = await getRateCard(ctx.companyId, param(req, 'id'));
    if (!rateCard) throw new AppError('NOT_FOUND', 'Rate card not found');
    res.json({ rateCard });
  })
);

rateCardRouter.patch(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const patch = rateCardUpdateSchema.parse(req.body);
    res.json({ rateCard: await updateRateCard(ctx.companyId, param(req, 'id'), patch) });
  })
);

rateCardRouter.delete(
  '/:id',
  canManage,
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await deleteRateCard(ctx.companyId, param(req, 'id'));
    res.status(204).end();
  })
);

// ── /v1/rates/resolve ────────────────────────────────────────────────────────────

export const ratesRouter = Router();

// GET /v1/rates/resolve?roleId&shiftType&date&kind&counterpartyId
ratesRouter.get(
  '/resolve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const q = resolveRateQuerySchema.parse(req.query);

    // Date-sensitive label (NIGHT on Fri/Sat → FRI_SAT_NIGHT), then the effective
    // card, preferring a counterparty-specific card over the default (§6).
    const label = resolveRateLabel(q.shiftType, q.date);
    const candidates = await listResolveCandidates({
      companyId: ctx.companyId,
      kind: q.kind,
      roleId: q.roleId,
      label,
      date: q.date,
      counterpartyId: q.counterpartyId,
    });

    const card = pickEffectiveCard(candidates, q.date, q.counterpartyId);

    if (!card) throw new AppError('NOT_FOUND', 'No rate card resolves for that role/date/shift');

    const rate = extractRate(card);
    const body: ResolveRateResponse = {
      label,
      rateCardId: card.id,
      rateMode: card.rateMode,
      baseCents: rate.baseCents,
      otCents: rate.otCents,
    };
    res.json(body);
  })
);
