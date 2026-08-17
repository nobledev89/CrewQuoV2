import { Router } from 'express';
import type { PortalProjectDetail } from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { canReadPortal, type EngagementEdge } from '../../authorization/policies';
import { findEngagementByPair } from '../engagements/repo';
import { findCompanyById } from '../companies/repo';
import { hasFeature } from '../entitlements/guards';
import { getAuditSettings } from '../audit/repo';
import { getPortalLineItems, getPortalProject, listPortalProjects } from './repo';

/**
 * Client portal (CREWQUO_V2_PLAN.md §3.6, §7). The active company here is always
 * the *client* on an engagement; the project's owner is the counterparty selling
 * the portal, so it is the owner's plan that must include `client_portal`, not
 * the client's — a client on the free Crew plan can still be shown a portal by a
 * provider who pays for one.
 */

export const portalRouter = Router();

portalRouter.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projects = await listPortalProjects(ctx.companyId);

    // Each project's owner may be on a different plan, so the gate is per-owner.
    // Cached per owner to keep a long project list to one entitlement read each.
    const allowedByOwner = new Map<string, boolean>();
    const visible = [];
    for (const project of projects) {
      let allowed = allowedByOwner.get(project.providerCompanyId);
      if (allowed === undefined) {
        allowed = await hasFeature(project.providerCompanyId, 'client_portal');
        allowedByOwner.set(project.providerCompanyId, allowed);
      }
      if (allowed) visible.push(project);
    }
    res.json({ data: visible });
  })
);

portalRouter.get(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    // Unpublished, or not this client's: both are "no such project" from here.
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');
    const { ownerCompanyId, ...project } = found;

    const edge: EngagementEdge = {
      clientCompanyId: ctx.companyId,
      providerCompanyId: ownerCompanyId,
    };
    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge,
      providerHasClientPortal: await hasFeature(ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');

    const { lineItems, timeTotalCents, expenseTotalCents, pricingComplete } =
      await getPortalLineItems({
        id: project.id,
        ownerCompanyId,
        clientCompanyId: ctx.companyId,
      });

    // Comment/trail toggles live on the edge; a project without one shows defaults.
    const engagement =
      project.engagementId !== null
        ? { id: project.engagementId }
        : await findEngagementByPair(ctx.companyId, ownerCompanyId);
    const settings = engagement ? await getAuditSettings(engagement.id) : null;
    const ownerHasNotes = await hasFeature(ownerCompanyId, 'client_portal_notes');
    const owner = await findCompanyById(ownerCompanyId);

    const body: PortalProjectDetail = {
      project,
      currency: owner?.currency ?? 'USD',
      lineItems,
      timeTotalCents,
      expenseTotalCents,
      totalCents: timeTotalCents + expenseTotalCents,
      pricingComplete,
      canComment: ownerHasNotes && (settings?.clientCanComment ?? false),
      showAuditTrail: settings?.showAuditTrail ?? false,
    };
    res.json(body);
  })
);
