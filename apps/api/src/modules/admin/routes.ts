import { Router } from 'express';
import {
  adminCompTrialSchema,
  adminCompanyListQuerySchema,
  adminOverrideCreateSchema,
  adminPlatformSettingsUpdateSchema,
  adminPlanCreateSchema,
  adminPlanPriceSchema,
  adminPlanUpdateSchema,
  adminReasonSchema,
  adminReportingQuerySchema,
  adminSetSubscriptionSchema,
  adminSetSuperAdminSchema,
  adminUserListQuerySchema,
  type AdminCompaniesResponse,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param, uuidParam } from '../../http/params';
import { clearEntitlementsCache, invalidateEntitlements } from '../entitlements/cache';
import { recordAudit } from '../audit/record';
import {
  createPlan,
  getPlan,
  listFeatureCatalog,
  listLimitCatalog,
  listPlans,
  updatePlan,
  upsertPlanPrice,
} from './repo';
import {
  assertPlanExists,
  companyExists,
  compTrial,
  deleteOverride,
  getCompanyDetail,
  getSubscription,
  insertOverride,
  listCompanies,
  setSubscription,
} from './companies.repo';
import {
  getAdminDashboard,
  getAdminOperations,
  getAdminReporting,
  getAdminUser,
  getPlatformSettings,
  listAdminUsers,
  listPlatformAudit,
  recordPlatformAudit,
  revokeAdminUserSessions,
  setUserSuperAdmin,
  updatePlatformSettings,
} from './platform.repo';

/**
 * Super-admin console API (§5B). Mounted behind requireAuth + requireSuperAdmin.
 *
 * Every write that can change what a company is allowed to do clears or
 * invalidates the entitlement cache, so a gate re-resolves on the next request
 * rather than up to 60 seconds later — a support action nobody can see take
 * effect gets performed twice.
 */
export const adminRouter = Router();

adminRouter.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    res.json(await getAdminDashboard());
  })
);

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const input = adminUserListQuerySchema.parse(req.query);
    res.json({ data: await listAdminUsers(input) });
  })
);

adminRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const user = await getAdminUser(uuidParam(req, 'id'));
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    res.json(user);
  })
);

adminRouter.post(
  '/users/:id/revoke-sessions',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const { reason } = adminReasonSchema.parse(req.body);
    const revoked = await revokeAdminUserSessions(ctx.userId, uuidParam(req, 'id'), reason);
    res.json({ revoked });
  })
);

adminRouter.post(
  '/users/:id/super-admin',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = adminSetSuperAdminSchema.parse(req.body);
    const user = await setUserSuperAdmin(
      ctx.userId,
      uuidParam(req, 'id'),
      input.enabled,
      input.reason
    );
    res.json({ user });
  })
);

adminRouter.get(
  '/reporting',
  asyncHandler(async (req, res) => {
    const { days } = adminReportingQuerySchema.parse(req.query);
    res.json(await getAdminReporting(days));
  })
);

adminRouter.get(
  '/operations',
  asyncHandler(async (_req, res) => {
    res.json(await getAdminOperations());
  })
);

adminRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(await getPlatformSettings());
  })
);

adminRouter.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const patch = adminPlatformSettingsUpdateSchema.parse(req.body);
    res.json(await updatePlatformSettings(ctx.userId, patch));
  })
);

adminRouter.get(
  '/audit',
  asyncHandler(async (_req, res) => {
    res.json({ data: await listPlatformAudit(100) });
  })
);

adminRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    res.json({ plans: await listPlans() });
  })
);

adminRouter.post(
  '/plans',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const input = adminPlanCreateSchema.parse(req.body);
    const plan = await createPlan(input);
    clearEntitlementsCache();
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'plan.created', entityType: 'PLAN', entityId: plan.id, changes: { plan }, description: `Plan ${plan.name} was created` });
    res.status(201).json({ plan });
  })
);

adminRouter.get(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const plan = await getPlan(param(req, 'id'));
    if (!plan) throw new AppError('NOT_FOUND', 'Plan not found');
    res.json({ plan });
  })
);

adminRouter.patch(
  '/plans/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const patch = adminPlanUpdateSchema.parse(req.body);
    const plan = await updatePlan(param(req, 'id'), patch);
    clearEntitlementsCache();
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'plan.updated', entityType: 'PLAN', entityId: plan.id, changes: { patch }, description: `Plan ${plan.name} was updated` });
    res.json({ plan });
  })
);

adminRouter.post(
  '/plans/:id/prices',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const price = adminPlanPriceSchema.parse(req.body);
    const planId = param(req, 'id');
    const saved = await upsertPlanPrice(planId, price);
    clearEntitlementsCache();
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'plan.price_updated', entityType: 'PLAN', entityId: planId, changes: { price: saved }, description: `A ${saved.currency} ${saved.interval.toLowerCase()} price was updated` });
    res.status(201).json({ price: saved });
  })
);

// ── Companies (§5B console: live usage, overrides, comped trials, plan changes) ──

adminRouter.get(
  '/companies',
  asyncHandler(async (req, res) => {
    const q = adminCompanyListQuerySchema.parse(req.query);
    const page = await listCompanies(q);
    const body: AdminCompaniesResponse = page;
    res.json(body);
  })
);

adminRouter.get(
  '/companies/:id',
  asyncHandler(async (req, res) => {
    const detail = await getCompanyDetail(uuidParam(req, 'id'));
    if (!detail) throw new AppError('NOT_FOUND', 'Company not found');
    res.json(detail);
  })
);

/**
 * Apply one entitlement override.
 *
 * Recorded against the *subject* company rather than the operator's, because the
 * trail a customer reads is their own: "your plan limit was raised to 60" belongs
 * in their history, and the operator's company has nothing to do with it. The row
 * is internal (never `visibleToClient`) — a company's counterparties have no
 * business seeing its commercial arrangements.
 */
adminRouter.post(
  '/companies/:id/overrides',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const companyId = uuidParam(req, 'id');
    const input = adminOverrideCreateSchema.parse(req.body);

    if (!(await companyExists(companyId))) throw new AppError('NOT_FOUND', 'Company not found');
    const override = await insertOverride(companyId, input);
    invalidateEntitlements(companyId);

    await recordAudit({
      companyId,
      actorUserId: ctx.userId,
      action: 'company.override_applied',
      entityType: 'ENTITLEMENT_OVERRIDE',
      entityId: override.id,
      changes: {
        ...(override.featureKey
          ? { feature: override.featureKey, enabled: override.featureEnabled }
          : { limit: override.limitKey, value: override.limitValue }),
        note: override.note,
        expiresAt: override.expiresAt,
      },
      description: override.featureKey
        ? `Feature ${override.featureKey} was ${override.featureEnabled ? 'granted' : 'withdrawn'} by CrewQuo staff`
        : `Limit ${override.limitKey} was set to ${override.limitValue === null ? 'unlimited' : override.limitValue} by CrewQuo staff`,
    });
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'company.override_applied', entityType: 'COMPANY', entityId: companyId, changes: { override }, description: `An entitlement override was applied to company ${companyId}` });

    res.status(201).json({ override });
  })
);

adminRouter.delete(
  '/companies/:id/overrides/:overrideId',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const companyId = uuidParam(req, 'id');
    const removed = await deleteOverride(companyId, uuidParam(req, 'overrideId'));
    if (!removed) throw new AppError('NOT_FOUND', 'Override not found');
    invalidateEntitlements(companyId);

    await recordAudit({
      companyId,
      actorUserId: ctx.userId,
      action: 'company.override_removed',
      entityType: 'ENTITLEMENT_OVERRIDE',
      entityId: removed.id,
      changes: removed.featureKey
        ? { feature: removed.featureKey, enabled: removed.featureEnabled }
        : { limit: removed.limitKey, value: removed.limitValue },
      description: 'An entitlement override was removed by CrewQuo staff',
    });
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'company.override_removed', entityType: 'COMPANY', entityId: companyId, changes: { overrideId: removed.id }, description: `An entitlement override was removed from company ${companyId}` });
    res.status(204).end();
  })
);

/** Force a plan or subscription status (§5B "force plan change"; §46). */
adminRouter.post(
  '/companies/:id/subscription',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const companyId = uuidParam(req, 'id');
    const input = adminSetSubscriptionSchema.parse(req.body);

    if (!(await companyExists(companyId))) throw new AppError('NOT_FOUND', 'Company not found');
    await assertPlanExists(input.planId);
    const before = await getSubscription(companyId);
    await setSubscription(companyId, input);
    invalidateEntitlements(companyId);

    await recordAudit({
      companyId,
      actorUserId: ctx.userId,
      action: 'company.plan_changed',
      entityType: 'SUBSCRIPTION',
      entityId: null,
      changes: {
        plan: { from: before?.planId ?? null, to: input.planId },
        status: { from: before?.status ?? null, to: input.status },
      },
      description: `Plan set to ${input.planId} (${input.status}) by CrewQuo staff`,
    });
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'company.plan_changed', entityType: 'COMPANY', entityId: companyId, changes: { before, after: input }, description: `Company ${companyId} was moved to ${input.planId}` });

    res.json({ company: (await getCompanyDetail(companyId))!.company });
  })
);

/** Comp or extend a trial (§7 `/comp-trial`). */
adminRouter.post(
  '/companies/:id/comp-trial',
  asyncHandler(async (req, res) => {
    const ctx = getCtx(req);
    const companyId = uuidParam(req, 'id');
    const input = adminCompTrialSchema.parse(req.body);

    if (!(await companyExists(companyId))) throw new AppError('NOT_FOUND', 'Company not found');
    await assertPlanExists(input.planId);
    const before = await getSubscription(companyId);
    const { trialEnd } = await compTrial(companyId, input.planId, input.days);
    invalidateEntitlements(companyId);

    await recordAudit({
      companyId,
      actorUserId: ctx.userId,
      action: 'company.trial_comped',
      entityType: 'SUBSCRIPTION',
      entityId: null,
      changes: {
        plan: { from: before?.planId ?? null, to: input.planId },
        trialEnd: { from: before?.trialEnd ?? null, to: trialEnd },
        days: input.days,
      },
      description: `${input.days}-day trial of ${input.planId} granted by CrewQuo staff`,
    });
    await recordPlatformAudit({ actorUserId: ctx.userId, action: 'company.trial_comped', entityType: 'COMPANY', entityId: companyId, changes: { before, planId: input.planId, days: input.days, trialEnd }, description: `A ${input.days}-day trial was granted to company ${companyId}` });

    res.json({ company: (await getCompanyDetail(companyId))!.company });
  })
);

adminRouter.get(
  '/features',
  asyncHandler(async (_req, res) => {
    res.json({ features: await listFeatureCatalog() });
  })
);

adminRouter.get(
  '/limits',
  asyncHandler(async (_req, res) => {
    res.json({ limits: await listLimitCatalog() });
  })
);
