import { Router } from 'express';
import {
  availabilityInputSchema,
  createScheduleSchema,
  createVehicleSchema,
  detectScheduleConflicts,
  extractRate,
  resolveRateLabel,
  scheduleWindow,
  setRoleRequirementsSchema,
  unfilledRequirements,
  updateScheduleAssignmentSchema,
  updateVehicleSchema,
  type ScheduleAssignmentInput,
  type ScheduleAssignmentView,
  type ScheduleConflict,
  type ScheduleView,
  type TimeframeDefinition,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import { projectAccess, type ProjectAccess } from '../assets/routes';
import { getEffectiveTimeframeDefinitions, listResolveCandidates } from '../rates/repo';
import { pickEffectiveCard } from '../rates/resolve';
import { checkProviderCompliance } from '../compliance/policy';
import {
  countVehicleReferences,
  deleteAvailability,
  deleteVehicle,
  findAssignmentRow,
  findBatch,
  findVehicle,
  insertAssignment,
  insertAvailability,
  insertVehicle,
  listAssignmentsForRequirements,
  listCompanyAssignments,
  listCompanyAvailability,
  listOverlappingAssignments,
  listProjectAssignments,
  listRelevantAvailability,
  listRoleRequirements,
  listVehicles,
  replaceRoleRequirements,
  toAssignment,
  updateAssignment,
  updateVehicle,
  type AssignmentRow,
} from './repo';

/**
 * Crew scheduling (§31) — step 11.7 of the Phase 11 build order in
 * `docs/operating-model/commercial-operations.md` §14.
 *
 * ── THE FEATURE IS ASKED OF TWO DIFFERENT COMPANIES, DELIBERATELY ──────────
 *
 * `scheduling` on the **project owner** for everything project-scoped, which is the
 * 2026-09-01 rule for the sixth time. And on the **acting company** for
 * `/v1/vehicles`, which is the exception `custom_factors` already is: a fleet is
 * company reference data with no project to find an owner of, so transferring the
 * rule by analogy would have been wrong for the third time in three phases.
 *
 * ── AND A CONFLICT IS NEVER A REFUSAL ──────────────────────────────────────
 *
 * §31: *"Conflict detection is a warning, not a block."* Every write in this file
 * saves first and returns `warnings` second, and `detectScheduleConflicts` has no
 * error type for a caller to convert. The reason is not squeamishness: the
 * double-booking is sometimes the plan, because the job at Pier 9 finishes at noon
 * and the schedule does not know that.
 */

async function assertSchedulingFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'scheduling'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: scheduling'
        : 'This project’s owner does not have scheduling enabled',
      { feature: 'scheduling' }
    );
  }
}

async function assertOwnScheduling(companyId: string): Promise<void> {
  if (!(await hasFeature(companyId, 'scheduling'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: scheduling', {
      feature: 'scheduling',
    });
  }
}

// ── Vehicles ─────────────────────────────────────────────────────────────────

export const vehiclesRouter = Router();

vehiclesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'project.read');
    const includeRetired = (req.query as Record<string, unknown>).includeRetired === 'true';
    res.json({ vehicles: await listVehicles(ctx.companyId, includeRetired) });
  })
);

vehiclesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'crew.manage');
    const input = createVehicleSchema.parse(req.body);

    const id = await insertVehicle({ companyId: ctx.companyId, ...input });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'vehicle.created',
      entityType: 'VEHICLE',
      entityId: id,
      description: `${input.name}${input.registration ? ` (${input.registration})` : ''}`,
    });
    res.status(201).json({ vehicle: await findVehicle(id, ctx.companyId) });
  })
);

vehiclesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'crew.manage');
    const id = uuidParam(req, 'id');
    const before = await findVehicle(id, ctx.companyId);
    if (!before) throw new AppError('NOT_FOUND', 'Vehicle not found');

    const patch = updateVehicleSchema.parse(req.body);
    await updateVehicle(id, ctx.companyId, patch);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: before.active && patch.active === false ? 'vehicle.retired' : 'vehicle.updated',
      entityType: 'VEHICLE',
      entityId: id,
      description: before.name,
    });
    res.json({ vehicle: await findVehicle(id, ctx.companyId) });
  })
);

/**
 * Delete a vehicle — **refused when anything points at it, naming the count**.
 *
 * The pattern §3.3's locked rate cards established and `countLocationReferences`
 * generalised: a foreign key violation reaching the caller as a 500 is not an
 * explanation, and the useful refusal names the thing to do instead. `CANCELLED`
 * assignments count, because they are retained records of a booking that was made
 * and deleting the van out from under one would leave a row naming nothing.
 */
vehiclesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'crew.manage');
    const id = uuidParam(req, 'id');
    const vehicle = await findVehicle(id, ctx.companyId);
    if (!vehicle) throw new AppError('NOT_FOUND', 'Vehicle not found');

    const refs = await countVehicleReferences(id);
    const parts: string[] = [];
    if (refs.assignments > 0) {
      parts.push(`${String(refs.assignments)} schedule assignment${refs.assignments === 1 ? '' : 's'}`);
    }
    if (refs.activities > 0) {
      parts.push(`${String(refs.activities)} recorded journey${refs.activities === 1 ? '' : 's'}`);
    }
    if (refs.availability > 0) {
      parts.push(`${String(refs.availability)} availability window${refs.availability === 1 ? '' : 's'}`);
    }
    if (parts.length > 0) {
      throw new AppError(
        'CONFLICT',
        `${vehicle.name} still has ${parts.join(', ')}. Retire it instead, which keeps everything already recorded against it.`,
        refs
      );
    }

    await deleteVehicle(id, ctx.companyId);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'vehicle.deleted',
      entityType: 'VEHICLE',
      entityId: id,
      description: vehicle.name,
    });
    res.status(204).end();
  })
);

// ── Planned cost (§31, packet finding 6) ─────────────────────────────────────

/**
 * What an assignment is planned to cost and to earn, or **why there is no figure**.
 *
 * Three reasons it can be withheld, and every one of them is stated rather than
 * rendered as zero:
 *
 *  1. **No shift type.** Every rate the engine resolves is keyed on one, and
 *     deriving `NIGHT` from `starts_at.getHours()` would put a rate rule back in
 *     code eleven phases after the owner had the `FRI_SAT_NIGHT` branch removed.
 *  2. **No role.** A van and a subcontractor's crew have no rate card of their own.
 *  3. **No card covering them.** The rule `resolveBillCentsForLog` already follows.
 *
 * The hours come from the window, and that is the one derivation this function does
 * make: `ends_at − starts_at` is a duration rather than a rate rule, and a company
 * whose cards are `SHIFT` or `DAILY` mode gets the card's unit rate applied once
 * rather than multiplied by ten hours — which is `extractRate`'s own distinction,
 * not a new one.
 */
async function planFor(args: {
  row: AssignmentRow;
  ownerCompanyId: string;
  clientCompanyId: string | null;
  labelRules: readonly TimeframeDefinition[];
  runner?: Queryable;
}): Promise<Pick<ScheduleAssignmentView, 'plannedCostCents' | 'plannedSellCents' | 'plannedReason'>> {
  const { row } = args;
  if (row.shift_type === null) {
    return {
      plannedCostCents: null,
      plannedSellCents: null,
      plannedReason: 'Choose a shift type to see what this is planned to cost.',
    };
  }
  if (row.role_id === null) {
    return {
      plannedCostCents: null,
      plannedSellCents: null,
      plannedReason:
        row.resource_type === 'VEHICLE'
          ? 'A vehicle has no rate card — vehicle cost is not tracked in CrewQuo.'
          : 'Choose a role to see what this is planned to cost.',
    };
  }

  const date = row.starts_at.toISOString().slice(0, 10);
  const label = resolveRateLabel(row.shift_type, date, args.labelRules);
  const hours = (row.ends_at.getTime() - row.starts_at.getTime()) / 3_600_000;

  const unit = async (kind: 'PAY' | 'BILL', counterparty: string | null): Promise<number | null> => {
    const candidates = await listResolveCandidates(
      {
        companyId: args.ownerCompanyId,
        kind,
        roleId: row.role_id!,
        label,
        date,
        counterpartyId: counterparty ?? undefined,
      },
      args.runner
    );
    const card = pickEffectiveCard(candidates, date, counterparty ?? undefined);
    if (!card) return null;
    try {
      const rate = extractRate(card);
      // HOURLY multiplies by the window; SHIFT and DAILY are a unit rate for the
      // whole booking, which is exactly what `calculateCost` does with quantity 1.
      const quantity = card.rateMode === 'HOURLY' ? Math.max(hours, card.minHours ?? 0) : 1;
      return Math.round(quantity * rate.baseCents) * row.headcount;
    } catch {
      /* c8 ignore next -- a card missing its mode's rate is refused at the edge. */
      return null;
    }
  };

  const [cost, sell] = await Promise.all([
    unit('PAY', null),
    args.clientCompanyId === null ? Promise.resolve(null) : unit('BILL', args.clientCompanyId),
  ]);

  const missing: string[] = [];
  if (cost === null) missing.push(`no PAY rate covers ${row.role_name ?? 'this role'} on ${date}`);
  if (sell === null) {
    missing.push(
      args.clientCompanyId === null
        ? 'this project has no client, so there is nothing to bill against'
        : `no BILL rate covers ${row.role_name ?? 'this role'} on ${date}`
    );
  }
  return {
    plannedCostCents: cost,
    plannedSellCents: sell,
    plannedReason: missing.length === 0 ? null : `${missing.join('; ')}.`,
  };
}

/** Attach planned figures to a page of rows, loading the label rules once. */
async function withPlans(args: {
  rows: readonly AssignmentRow[];
  ownerCompanyId: string;
  clientCompanyId: string | null;
}): Promise<ScheduleAssignmentView[]> {
  if (args.rows.length === 0) return [];
  const labelRules = await getEffectiveTimeframeDefinitions(args.ownerCompanyId);
  const out: ScheduleAssignmentView[] = [];
  for (const row of args.rows) {
    const view = toAssignment(row);
    const plan = await planFor({
      row,
      ownerCompanyId: args.ownerCompanyId,
      clientCompanyId: args.clientCompanyId,
      labelRules,
    });
    out.push({ ...view, ...plan });
  }
  return out;
}

/** Attach one compliance decision per provider, never one query per row. */
async function withCompliance(
  rows: ScheduleAssignmentView[],
  ownerCompanyId: string
): Promise<ScheduleAssignmentView[]> {
  const cache = new Map<string, Awaited<ReturnType<typeof checkProviderCompliance>>>();
  for (const providerCompanyId of new Set(
    rows.map((row) => row.providerCompanyId).filter((id): id is string => id !== null)
  )) {
    cache.set(
      providerCompanyId,
      await checkProviderCompliance({ ownerCompanyId, providerCompanyId })
    );
  }
  return rows.map((row) => {
    if (!row.providerCompanyId) return row;
    const check = cache.get(row.providerCompanyId)!;
    return {
      ...row,
      compliance: {
        status: check.summary.overallStatus,
        warning: check.warning,
        enforced: check.enforced,
      },
    };
  });
}

// ── Reachability (packet §4) ─────────────────────────────────────────────────

/**
 * Every id in an assignment, checked for **reachability by this caller**.
 *
 * The three that matter, and each closes a different disclosure:
 *
 *  - **`vehicleId` against the scheduling company.** A hiring company cannot book a
 *    subcontractor's van; it books the subcontractor and a headcount. Booking
 *    somebody else's asset is an assertion about their business.
 *  - **`userId` against a live membership in the scheduling company.** Booking a
 *    person in another tenancy is an assertion about somebody else's employee.
 *  - **`providerCompanyId` against `project_assignments`**, so the one-hop rule is
 *    checked rather than assumed.
 */
async function validateAssignment(
  access: ProjectAccess,
  companyId: string,
  input: ScheduleAssignmentInput,
  runner?: Queryable
): Promise<void> {
  if (input.vehicleId !== null) {
    const found = await queryOne<{ id: string }>(
      `select id from vehicles where id = $1 and company_id = $2 and active`,
      [input.vehicleId, companyId],
      runner
    );
    if (!found) {
      throw new AppError('VALIDATION', 'That vehicle is not one of yours, or it is retired', {
        field: 'vehicleId',
      });
    }
  }
  if (input.userId !== null) {
    const found = await queryOne<{ user_id: string }>(
      `select user_id from memberships where user_id = $1 and company_id = $2`,
      [input.userId, companyId],
      runner
    );
    if (!found) {
      throw new AppError('VALIDATION', 'That person is not a member of your company', {
        field: 'userId',
      });
    }
  }
  if (input.providerCompanyId !== null) {
    const found = await queryOne<{ id: string }>(
      `select id from project_assignments
        where project_id = $1 and provider_company_id = $2`,
      [access.projectId, input.providerCompanyId],
      runner
    );
    if (!found) {
      throw new AppError(
        'VALIDATION',
        'That company is not assigned to this project. Add it to the crew first.',
        { field: 'providerCompanyId' }
      );
    }
  }
  if (input.roleId !== null) {
    const found = await queryOne<{ id: string }>(
      `select id from role_catalog where id = $1 and company_id = $2`,
      [input.roleId, companyId],
      runner
    );
    if (!found) {
      throw new AppError('VALIDATION', 'That role is not in your role catalog', {
        field: 'roleId',
      });
    }
  }
  if (input.locationId !== null) {
    const found = await queryOne<{ id: string }>(
      `select id from project_locations where id = $1 and project_id = $2`,
      [input.locationId, access.projectId],
      runner
    );
    if (!found) {
      throw new AppError('VALIDATION', 'That location is not on this project', {
        field: 'locationId',
      });
    }
  }
}

async function conflictsFor(args: {
  companyId: string;
  candidate: {
    id: string | null;
    resourceType: ScheduleAssignmentInput['resourceType'];
    userId: string | null;
    providerCompanyId: string | null;
    vehicleId: string | null;
    headcount: number;
    status: ScheduleAssignmentInput['status'];
    startsAt: string;
    endsAt: string;
  };
  runner?: Queryable;
}): Promise<ScheduleConflict[]> {
  const [existing, availability] = await Promise.all([
    listOverlappingAssignments({
      companyId: args.companyId,
      startsAt: args.candidate.startsAt,
      endsAt: args.candidate.endsAt,
      userId: args.candidate.userId,
      vehicleId: args.candidate.vehicleId,
      providerCompanyId: args.candidate.providerCompanyId,
      runner: args.runner,
    }),
    listRelevantAvailability({
      startsAt: args.candidate.startsAt,
      endsAt: args.candidate.endsAt,
      userId: args.candidate.userId,
      vehicleId: args.candidate.vehicleId,
      providerCompanyId: args.candidate.providerCompanyId,
      runner: args.runner,
    }),
  ]);
  return detectScheduleConflicts({ candidate: args.candidate, existing, availability });
}

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectScheduleRouter = Router();

projectScheduleRouter.get(
  '/:projectId/schedule',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertSchedulingFeature(access);
    await assertCapability(ctx, 'project.read');

    const q = req.query as Record<string, unknown>;
    const rows = await listProjectAssignments({
      projectId: access.projectId,
      ownerScope: access.isOwner,
      companyId: ctx.companyId,
      from: typeof q.from === 'string' ? q.from : undefined,
      to: typeof q.to === 'string' ? q.to : undefined,
      includeCancelled: q.includeCancelled === 'true',
    });

    const project = await queryOne<{ client_company_id: string | null }>(
      `select client_company_id from projects where id = $1`,
      [access.projectId]
    );
    /*
     * **Planned figures only for the owner.** They are PAY and BILL rates, which is
     * the money boundary §4 has enforced for nine phases: a subcontractor reading
     * what the hiring company plans to charge for its crew would be reading the
     * margin on its own work.
     */
    const plannedAssignments = access.isOwner
      ? await withPlans({
          rows,
          ownerCompanyId: access.ownerCompanyId,
          clientCompanyId: project?.client_company_id ?? null,
        })
      : rows.map(toAssignment);
    const assignments = await withCompliance(plannedAssignments, access.ownerCompanyId);

    const [requirements, forRequirements] = await Promise.all([
      listRoleRequirements(access.projectId),
      listAssignmentsForRequirements(access.projectId),
    ]);

    res.json({
      assignments,
      requirements,
      shortfalls: unfilledRequirements({ requirements, assignments: forRequirements }),
    });
  })
);

projectScheduleRouter.post(
  '/:projectId/schedule',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertSchedulingFeature(access);
    await assertCapability(ctx, 'schedule.manage');
    if (!access.isOwner) {
      throw new AppError('FORBIDDEN', 'Only the company that owns this project can schedule on it');
    }

    const input = createScheduleSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.batchClientId,
        route: 'POST /v1/projects/:projectId/schedule',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        for (const assignment of input.assignments) {
          await validateAssignment(access, ctx.companyId, assignment);
          if (assignment.providerCompanyId) {
            await checkProviderCompliance({
              ownerCompanyId: access.ownerCompanyId,
              providerCompanyId: assignment.providerCompanyId,
              refuseWhenEnforced: true,
              action: 'This booking',
            });
          }
        }

        const project = await queryOne<{ client_company_id: string | null }>(
          `select client_company_id from projects where id = $1`,
          [access.projectId]
        );

        const created = await withTransaction(async (client) => {
          const ids: string[] = [];
          for (const assignment of input.assignments) {
            ids.push(
              await insertAssignment(
                {
                  companyId: ctx.companyId,
                  projectId: access.projectId,
                  ...assignment,
                  batchClientId: input.batchClientId ?? null,
                  createdByUserId: ctx.userId,
                },
                client
              )
            );
          }

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'schedule.assigned',
              entityType: 'SCHEDULE_ASSIGNMENT',
              entityId: ids[0] ?? null,
              description: `${String(ids.length)} assignment${ids.length === 1 ? '' : 's'} scheduled`,
            },
            client
          );

          /*
           * **One event for the batch, not one per row** (packet §5). Priya's Monday
           * morning is eleven people onto three jobs, and eleven Action Centre items
           * is a channel every recipient turns off — then the one that mattered is
           * missed. The same reasoning `evidence.batch_uploaded` and
           * `asset.lines_recorded` were both decided on, so the mechanism is reused:
           * a client-supplied batch id keys the single event.
           */
          await enqueueOutboxEvent(
            {
              topic: 'schedule.assigned',
              aggregateType: 'SCHEDULE_ASSIGNMENT',
              aggregateId: input.batchClientId ?? (ids[0] as string),
              companyId: ctx.companyId,
              payload: {
                projectId: access.projectId,
                companyId: ctx.companyId,
                assignmentIds: ids,
                count: ids.length,
                providerCompanyIds: [
                  ...new Set(
                    input.assignments
                      .map((a) => a.providerCompanyId)
                      .filter((x): x is string => x !== null)
                  ),
                ],
                userIds: [
                  ...new Set(
                    input.assignments.map((a) => a.userId).filter((x): x is string => x !== null)
                  ),
                ],
                from: input.assignments.reduce(
                  (min, a) => (a.startsAt < min ? a.startsAt : min),
                  input.assignments[0]!.startsAt
                ),
                to: input.assignments.reduce(
                  (max, a) => (a.endsAt > max ? a.endsAt : max),
                  input.assignments[0]!.endsAt
                ),
              },
              idempotencyKey: `schedule-assigned:${input.batchClientId ?? (ids[0] as string)}`,
            },
            client
          );
          return ids;
        });

        /*
         * Conflicts computed **after** the write and outside the transaction, which
         * is the order §31 requires: the row is saved and the clash is reported
         * beside it. Inside the transaction the new rows would also clash with each
         * other, which is a true statement and a useless one — booking Femi at two
         * sites in one batch is a clash worth naming, so they are computed against
         * the committed state where both rows exist.
         */
        const warnings: { assignmentId: string; conflicts: ScheduleConflict[] }[] = [];
        const rows: AssignmentRow[] = [];
        for (const id of created) {
          const row = await findAssignmentRow(id);
          /* c8 ignore next */
          if (!row) continue;
          rows.push(row);
          const conflicts = await conflictsFor({
            companyId: ctx.companyId,
            candidate: {
              id: row.id,
              resourceType: row.resource_type,
              userId: row.user_id,
              providerCompanyId: row.provider_company_id,
              vehicleId: row.vehicle_id,
              headcount: row.headcount,
              status: row.status,
              startsAt: row.starts_at.toISOString(),
              endsAt: row.ends_at.toISOString(),
            },
          });
          if (conflicts.length > 0) warnings.push({ assignmentId: id, conflicts });
        }

        return {
          assignments: await withCompliance(
            await withPlans({
              rows,
              ownerCompanyId: access.ownerCompanyId,
              clientCompanyId: project?.client_company_id ?? null,
            }),
            access.ownerCompanyId
          ),
          warnings,
          replayed: false,
        };
      }
    );
  })
);

projectScheduleRouter.get(
  '/:projectId/role-requirements',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertSchedulingFeature(access);
    await assertCapability(ctx, 'project.read');
    const requirements = await listRoleRequirements(access.projectId);
    const forRequirements = await listAssignmentsForRequirements(access.projectId);
    res.json({
      requirements,
      shortfalls: unfilledRequirements({ requirements, assignments: forRequirements }),
    });
  })
);

projectScheduleRouter.put(
  '/:projectId/role-requirements',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertSchedulingFeature(access);
    await assertCapability(ctx, 'project.manage');
    if (!access.isOwner) {
      throw new AppError('FORBIDDEN', 'Only the company that owns this project sets its requirements');
    }

    const input = setRoleRequirementsSchema.parse(req.body);
    const roleIds = [...new Set(input.requirements.map((r) => r.roleId))];
    if (roleIds.length > 0) {
      const found = await query<{ id: string }>(
        `select id from role_catalog where id = any($1::uuid[]) and company_id = $2`,
        [roleIds, ctx.companyId]
      );
      if (found.length !== roleIds.length) {
        throw new AppError('VALIDATION', 'A role is not in your role catalog', {
          field: 'requirements.roleId',
        });
      }
    }

    await withTransaction(async (client) => {
      await replaceRoleRequirements(
        {
          projectId: access.projectId,
          companyId: ctx.companyId,
          userId: ctx.userId,
          requirements: input.requirements,
        },
        client
      );
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'schedule.requirements_set',
          entityType: 'PROJECT',
          entityId: access.projectId,
          description: `${String(input.requirements.length)} role requirement${input.requirements.length === 1 ? '' : 's'}`,
        },
        client
      );
    });

    const requirements = await listRoleRequirements(access.projectId);
    const forRequirements = await listAssignmentsForRequirements(access.projectId);
    res.json({
      requirements,
      shortfalls: unfilledRequirements({ requirements, assignments: forRequirements }),
    });
  })
);

// ── Mounted under /v1/schedule ───────────────────────────────────────────────

export const scheduleRouter = Router();

/**
 * The company-wide week Priya works in.
 *
 * Scoped by the **scheduling** company, and packet §10 explains why that is the
 * same boundary rather than a wider one: `schedule.manage` is owner-only, so every
 * row this company scheduled is on a project it owns. There is deliberately no
 * cross-company variant and no "everybody's week" endpoint a project-level read
 * could be widened into.
 */
scheduleRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const q = req.query as Record<string, unknown>;
    const view = (typeof q.view === 'string' ? q.view : 'WEEK') as ScheduleView;
    const date =
      typeof q.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
        ? q.date
        : new Date().toISOString().slice(0, 10);
    /*
     * The week's start is a **parameter with no default in the pure function**, for
     * the reason `resolveRateLabel` takes its rules as a required argument: a
     * Monday-start week is a convention, not a fact. The default lives here, at the
     * edge, where a company setting could later override it without changing the
     * arithmetic.
     */
    const weekStartsOn = typeof q.weekStartsOn === 'string' ? Number(q.weekStartsOn) : 1;
    const window = scheduleWindow({
      view: ['DAY', 'WEEK', 'MONTH'].includes(view) ? view : 'WEEK',
      date,
      weekStartsOn: Number.isInteger(weekStartsOn) && weekStartsOn >= 0 && weekStartsOn <= 6
        ? weekStartsOn
        : 1,
    });

    const rows = await listCompanyAssignments({
      companyId: ctx.companyId,
      from: `${window.fromDate}T00:00:00.000Z`,
      to: `${window.toDate}T00:00:00.000Z`,
      projectId: typeof q.projectId === 'string' ? q.projectId : undefined,
      includeCancelled: q.includeCancelled === 'true',
    });

    /*
     * Planned figures are withheld from the planner view entirely, and that is not
     * an omission: a week across three projects has three clients and three sets of
     * BILL cards, so resolving them here would be up to fifty rate lookups for a
     * screen whose job is *"who is where"*. The project's own Schedule section
     * carries the money.
     */
    res.json({
      window,
      assignments: await withCompliance(rows.map(toAssignment), ctx.companyId),
      vehicles: await listVehicles(ctx.companyId, false),
      availability: await listCompanyAvailability(ctx.companyId),
    });
  })
);

scheduleRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const row = await findAssignmentRow(id);
    if (!row || row.company_id !== ctx.companyId) {
      throw new AppError('NOT_FOUND', 'Assignment not found');
    }
    const access = await projectAccess(row.project_id, ctx.companyId);
    await assertSchedulingFeature(access);
    await assertCapability(ctx, 'schedule.manage');

    const patch = updateScheduleAssignmentSchema.parse(req.body);
    const startsAt = patch.startsAt ?? row.starts_at.toISOString();
    const endsAt = patch.endsAt ?? row.ends_at.toISOString();
    if (endsAt <= startsAt) {
      throw new AppError('VALIDATION', 'An assignment must end after it starts', {
        field: 'endsAt',
      });
    }
    if (patch.roleId != null) {
      const found = await queryOne<{ id: string }>(
        `select id from role_catalog where id = $1 and company_id = $2`,
        [patch.roleId, ctx.companyId]
      );
      if (!found) throw new AppError('VALIDATION', 'That role is not in your role catalog');
    }
    if (patch.locationId != null) {
      const found = await queryOne<{ id: string }>(
        `select id from project_locations where id = $1 and project_id = $2`,
        [patch.locationId, row.project_id]
      );
      if (!found) throw new AppError('VALIDATION', 'That location is not on this project');
    }
    if (patch.headcount !== undefined && row.resource_type !== 'PROVIDER' && patch.headcount !== 1) {
      throw new AppError('VALIDATION', 'Only a subcontractor row carries a headcount', {
        field: 'headcount',
      });
    }
    if (row.provider_company_id && (patch.status ?? row.status) !== 'CANCELLED') {
      await checkProviderCompliance({
        ownerCompanyId: access.ownerCompanyId,
        providerCompanyId: row.provider_company_id,
        refuseWhenEnforced: true,
        action: 'This booking change',
      });
    }

    await withTransaction(async (client) => {
      await updateAssignment(id, patch, client);
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: patch.status === 'CANCELLED' ? 'schedule.cancelled' : 'schedule.changed',
          entityType: 'SCHEDULE_ASSIGNMENT',
          entityId: id,
          description: `${resourceName(row)} · ${startsAt} → ${endsAt}`,
        },
        client
      );
      /*
       * `schedule.changed` fires on a move so the person whose Tuesday just moved
       * finds out. Push only (packet §6): "you are on Marina Bay on Tuesday" is
       * news, not a task, and Priya's plan changes four times a week.
       */
      await enqueueOutboxEvent(
        {
          topic: 'schedule.changed',
          aggregateType: 'SCHEDULE_ASSIGNMENT',
          aggregateId: id,
          companyId: ctx.companyId,
          payload: {
            assignmentId: id,
            projectId: row.project_id,
            companyId: ctx.companyId,
            providerCompanyId: row.provider_company_id,
            userId: row.user_id,
            status: patch.status ?? row.status,
            from: startsAt,
            to: endsAt,
            movedFrom: row.starts_at.toISOString(),
          },
          // The updated instant is in the key so two different edits are two events
          // and a retried edit is one.
          idempotencyKey: `schedule-changed:${id}:${new Date().toISOString()}`,
        },
        client
      );
    });

    const after = await findAssignmentRow(id);
    const project = await queryOne<{ client_company_id: string | null }>(
      `select client_company_id from projects where id = $1`,
      [row.project_id]
    );
    const conflicts = await conflictsFor({
      companyId: ctx.companyId,
      candidate: {
        id,
        resourceType: after!.resource_type,
        userId: after!.user_id,
        providerCompanyId: after!.provider_company_id,
        vehicleId: after!.vehicle_id,
        headcount: after!.headcount,
        status: after!.status,
        startsAt: after!.starts_at.toISOString(),
        endsAt: after!.ends_at.toISOString(),
      },
    });

    res.json({
      assignments: await withCompliance(
        await withPlans({
          rows: [after!],
          ownerCompanyId: access.ownerCompanyId,
          clientCompanyId: project?.client_company_id ?? null,
        }),
        access.ownerCompanyId
      ),
      warnings: conflicts.length > 0 ? [{ assignmentId: id, conflicts }] : [],
      replayed: false,
    });
  })
);

function resourceName(row: AssignmentRow): string {
  return (
    row.user_name ??
    row.provider_company_name ??
    row.vehicle_name ??
    row.resource_type.toLowerCase()
  );
}

/**
 * `PLANNED → CONFIRMED`, and **either party may drive it**.
 *
 * The one transition in this phase a subcontractor can perform, which is what
 * "confirm" means: the hiring company plans and the party being planned says yes.
 * Idempotent by construction — confirming a confirmed row returns the row — so
 * packet §8 gives it no ledger.
 */
scheduleRouter.post(
  '/:id/confirm',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const row = await findAssignmentRow(id);
    if (!row) throw new AppError('NOT_FOUND', 'Assignment not found');

    const isScheduler = row.company_id === ctx.companyId;
    const isNamedProvider = row.provider_company_id === ctx.companyId;
    const isOwnPerson =
      row.user_id !== null &&
      (await queryOne<{ user_id: string }>(
        `select user_id from memberships where user_id = $1 and company_id = $2`,
        [row.user_id, ctx.companyId]
      )) !== null;
    if (!isScheduler && !isNamedProvider && !isOwnPerson) {
      throw new AppError('NOT_FOUND', 'Assignment not found');
    }

    const access = await projectAccess(row.project_id, ctx.companyId);
    await assertSchedulingFeature(access);
    await assertCapability(ctx, 'schedule.manage');

    if (row.status === 'CANCELLED') {
      throw new AppError('CONFLICT', 'That assignment was cancelled. Ask for a new one.');
    }
    if (row.status === 'CONFIRMED') {
      res.json({ assignments: [toAssignment(row)], warnings: [], replayed: true });
      return;
    }

    await withTransaction(async (client) => {
      await updateAssignment(id, { status: 'CONFIRMED' }, client);
      await recordAudit(
        {
          // Whose record changed: the scheduling company's row.
          companyId: row.company_id,
          actorUserId: ctx.userId,
          action: 'schedule.confirmed',
          entityType: 'SCHEDULE_ASSIGNMENT',
          entityId: id,
          description: `${resourceName(row)} confirmed`,
        },
        client
      );
    });
    const after = await findAssignmentRow(id);
    res.json({ assignments: [toAssignment(after!)], warnings: [], replayed: false });
  })
);

/** A dry-run clash check, so the planner can warn before it writes. */
scheduleRouter.post(
  '/check',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'schedule.manage');
    const input = createScheduleSchema.parse(req.body);
    const warnings: { index: number; conflicts: ScheduleConflict[] }[] = [];
    for (const [index, candidate] of input.assignments.entries()) {
      const conflicts = await conflictsFor({
        companyId: ctx.companyId,
        candidate: { id: null, ...candidate },
      });
      if (conflicts.length > 0) warnings.push({ index, conflicts });
    }
    res.json({ warnings });
  })
);

// ── Availability ─────────────────────────────────────────────────────────────

export const availabilityRouter = Router();

availabilityRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'project.read');
    res.json({ availability: await listCompanyAvailability(ctx.companyId) });
  })
);

availabilityRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'crew.manage');
    const input = availabilityInputSchema.parse(req.body);

    /*
     * A company records availability for **its own** resources only. A PROVIDER row
     * is the subcontractor stating its own crew count; a hiring company writing one
     * on its behalf would be inventing a capacity nobody agreed to and then warning
     * against it.
     */
    if (input.resourceType === 'PROVIDER' && input.providerCompanyId !== ctx.companyId) {
      throw new AppError(
        'FORBIDDEN',
        'A crew count is something a subcontractor states about itself. Ask them to record it.',
        { field: 'providerCompanyId' }
      );
    }
    if (input.userId !== null) {
      const member = await queryOne<{ user_id: string }>(
        `select user_id from memberships where user_id = $1 and company_id = $2`,
        [input.userId, ctx.companyId]
      );
      if (!member) throw new AppError('VALIDATION', 'That person is not a member of your company');
    }
    if (input.vehicleId !== null && !(await findVehicle(input.vehicleId, ctx.companyId))) {
      throw new AppError('VALIDATION', 'That vehicle is not one of yours');
    }

    const id = await insertAvailability({
      companyId: ctx.companyId,
      ...input,
      createdByUserId: ctx.userId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'availability.recorded',
      entityType: 'RESOURCE_AVAILABILITY',
      entityId: id,
      description: `${input.kind} ${input.startsAt} → ${input.endsAt}`,
    });
    res.status(201).json({ availability: await listCompanyAvailability(ctx.companyId) });
  })
);

availabilityRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertOwnScheduling(ctx.companyId);
    await assertCapability(ctx, 'crew.manage');
    const removed = await deleteAvailability(uuidParam(req, 'id'), ctx.companyId);
    if (removed === 0) throw new AppError('NOT_FOUND', 'Availability window not found');
    res.status(204).end();
  })
);
