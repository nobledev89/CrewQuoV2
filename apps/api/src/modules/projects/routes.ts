import { Router } from 'express';
import {
  acceptanceDecisionSchema,
  createAssignmentSchema,
  createProjectSchema,
  updateProjectSchema,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param, uuidParam } from '../../http/params';
import {
  canDecideAcceptance,
  canManage,
  isEngagementParticipant,
  isOwnerOrAdmin,
} from '../../authorization/policies';
import { findEngagementByPair, findEngagementEdge } from '../engagements/repo';
import {
  decideAssignmentAcceptance,
  findAssignmentForDecision,
  listPendingAssignmentsForProvider,
} from '../engagements/terms.repo';
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
import { registerExportRoutes } from '../exports/routes';
import { setProjectReportingCurrency } from './reportingCurrency';
import { computeProjectSummary } from './summary';

export const projectsRouter = Router();

// GET /v1/projects/:id/export.(pdf|xlsx) — feature-gated, owner side (§7).
registerExportRoutes(projectsRouter);

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
    const { reportingCurrency, ...patch } = updateProjectSchema.parse(req.body);

    // The reporting currency is split out of the ordinary patch on purpose. It
    // needs a stricter role than the rest of the form (OWNER/ADMIN, not any
    // manager), a pin check that must hold the project's row lock, and its own
    // audit line — none of which the generic column update can express. Money
    // boundary packet §3/§4.
    if (reportingCurrency !== undefined) {
      if (!isOwnerOrAdmin(ctx.role)) {
        throw new AppError(
          'FORBIDDEN',
          "Only an owner or admin may change a project's reporting currency"
        );
      }
      await setProjectReportingCurrency({
        ownerCompanyId: ctx.companyId,
        projectId: param(req, 'id'),
        actorUserId: ctx.userId,
        reportingCurrency,
      });
    }

    const project = await updateProject(ctx.companyId, param(req, 'id'), patch);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'project.updated',
      entityType: 'PROJECT',
      entityId: project.id,
      changes: { ...patch, ...(reportingCurrency ? { reportingCurrency } : {}) },
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

/**
 * The provider accepts or declines being put on a project.
 *
 * Addressed by assignment id and mounted here rather than under `/v1/projects/:id`
 * because the *provider* is the actor and it cannot read the hiring company's
 * projects: every other handler on this router scopes by `owner_company_id`, which
 * is the hiring company by definition. The edge is resolved from the assignment.
 *
 * Deliberately not a gate on work capture — see §9 of
 * `docs/operating-model/commercial-agreements.md`.
 */
for (const [path, accept] of [
  ['/assignments/:assignmentId/accept', true],
  ['/assignments/:assignmentId/decline', false],
] as const) {
  projectsRouter.post(
    path,
    asyncHandler(async (req, res) => {
      const ctx = getCompanyCtx(req);
      const assignmentId = uuidParam(req, 'assignmentId');
      const assignment = await findAssignmentForDecision(assignmentId);
      if (!assignment) throw new AppError('NOT_FOUND', 'Assignment not found');
      const edgeRow = await findEngagementEdge(assignment.engagementId);
      if (!edgeRow) throw new AppError('NOT_FOUND', 'Assignment not found');
      const edge = {
        clientCompanyId: edgeRow.client_company_id,
        providerCompanyId: edgeRow.provider_company_id,
      };
      // An outsider gets the same answer a forged id gets.
      if (!isEngagementParticipant(ctx.companyId, edge)) {
        throw new AppError('NOT_FOUND', 'Assignment not found');
      }
      if (!canDecideAcceptance(ctx.companyId, ctx.role, edge)) {
        throw new AppError(
          'FORBIDDEN',
          'Only a manager in the provider company may accept or decline an assignment'
        );
      }
      const { reason } = acceptanceDecisionSchema.parse(req.body ?? {});
      const updated = await decideAssignmentAcceptance({
        assignmentId,
        accept,
        reason,
        actorUserId: ctx.userId,
      });
      // Recorded against the provider — it is the provider's decision — and never
      // client-visible, for the same reason assignment.created is not: which
      // subcontractor works a project is not the end client's business.
      await recordAudit({
        companyId: ctx.companyId,
        actorUserId: ctx.userId,
        action: accept ? 'assignment.accepted' : 'assignment.declined',
        entityType: 'ASSIGNMENT',
        entityId: assignmentId,
        changes: { projectId: updated.projectId, acceptance: updated.acceptance, reason },
        description: accept
          ? `Assignment to "${updated.projectName}" accepted`
          : `Assignment to "${updated.projectName}" declined`,
      });
      res.json({ assignment: updated });
    })
  );
}

/** Assignments this provider company has been offered and not yet decided. */
projectsRouter.get(
  '/assignments/pending',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    res.json({ data: await listPendingAssignmentsForProvider(ctx.companyId) });
  })
);

// ── Summary ──────────────────────────────────────────────────────────────────────

projectsRouter.get(
  '/:id/summary',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const project = await getProject(ctx.companyId, param(req, 'id'));
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');
    const summary = await computeProjectSummary({
      id: project.id,
      ownerCompanyId: project.ownerCompanyId,
      clientCompanyId: project.clientCompanyId,
      // The project's own unit, not the owner company's live column: a company
      // that changes currency must not restate a project that has closed.
      currency: project.reportingCurrency,
    });
    res.json({ summary });
  })
);
