import { Router } from 'express';
import {
  createAssignmentSchema,
  createProjectSchema,
  updateProjectSchema,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { canManage } from '../../authorization/policies';
import { findCompanyById } from '../companies/repo';
import { findEngagementByPair } from '../engagements/repo';
import { recordAudit } from '../audit/record';
import {
  createProject,
  deleteProject,
  getProject,
  insertAssignment,
  listAssignments,
  listProjects,
  updateProject,
} from './repo';
import { computeProjectSummary } from './summary';

export const projectsRouter = Router();

function assertManager(role: Parameters<typeof canManage>[0]) {
  if (!canManage(role)) throw new AppError('FORBIDDEN', 'Requires a manager role');
}

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listProjects(ctx.companyId) });
  })
);

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    assertManager(ctx.role);
    const input = createProjectSchema.parse(req.body);
    const project = await createProject(ctx.companyId, input);
    // Project rows reach the portal only for projects the client can already see.
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'project.created',
      entityType: 'PROJECT',
      entityId: project.id,
      changes: { name: project.name, status: project.status },
      description: `Project "${project.name}" created`,
      visibleToClient: project.clientVisible,
    });
    res.status(201).json({ project });
  })
);

projectsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const project = await getProject(ctx.companyId, param(req, 'id'));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    res.json({ project });
  })
);

projectsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    assertManager(ctx.role);
    const patch = updateProjectSchema.parse(req.body);
    const project = await updateProject(ctx.companyId, param(req, 'id'), patch);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'project.updated',
      entityType: 'PROJECT',
      entityId: project.id,
      changes: { ...patch },
      description: `Project "${project.name}" updated`,
      visibleToClient: project.clientVisible,
    });
    res.json({ project });
  })
);

projectsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    assertManager(ctx.role);
    const id = param(req, 'id');
    const project = await getProject(ctx.companyId, id); // captured for the trail
    await deleteProject(ctx.companyId, id);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'project.deleted',
      entityType: 'PROJECT',
      entityId: id,
      description: project ? `Project "${project.name}" deleted` : 'Project deleted',
      visibleToClient: project?.clientVisible ?? false,
    });
    res.status(204).end();
  })
);

// ── Assignments ──────────────────────────────────────────────────────────────────

projectsRouter.get(
  '/:id/assignments',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const project = await getProject(ctx.companyId, param(req, 'id'));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    res.json({ data: await listAssignments(project.id) });
  })
);

projectsRouter.post(
  '/:id/assignments',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    assertManager(ctx.role);
    const project = await getProject(ctx.companyId, param(req, 'id'));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    const input = createAssignmentSchema.parse(req.body);

    // The active company (owner) must have an engagement to the provider.
    const edge = await findEngagementByPair(ctx.companyId, input.providerCompanyId);
    if (!edge) {
      throw new AppError('VALIDATION', 'No engagement with that provider — add them first');
    }
    const assignment = await insertAssignment({
      projectId: project.id,
      providerCompanyId: input.providerCompanyId,
      engagementId: edge.id,
    });
    // Never client-visible: which subcontractor does the work is not the client's business.
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'assignment.created',
      entityType: 'ASSIGNMENT',
      entityId: assignment.id,
      changes: { projectId: project.id, providerCompanyId: input.providerCompanyId },
      description: `Provider assigned to "${project.name}"`,
    });
    res.status(201).json({ data: await listAssignments(project.id) });
  })
);

// ── Summary ──────────────────────────────────────────────────────────────────────

projectsRouter.get(
  '/:id/summary',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const project = await getProject(ctx.companyId, param(req, 'id'));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    const owner = await findCompanyById(ctx.companyId);
    const summary = await computeProjectSummary({
      id: project.id,
      ownerCompanyId: project.ownerCompanyId,
      clientCompanyId: project.clientCompanyId,
      currency: owner?.currency ?? 'USD',
    });
    res.json({ summary });
  })
);
