import { Router } from 'express';
import {
  REQUIRED_MEASURE_FOR_KIND,
  UNIT_FOR_MEASURE,
  createActivitySchema,
  detectConflict,
  updateActivitySchema,
  type ProjectActivityView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { query, queryOne, withTransaction } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';
import { projectAccess, type ProjectAccess } from '../assets/routes';
import { recalculateAfterWrite } from './engine';

/**
 * Project activities (§27.3) — step 4 of the Phase 9 build order.
 *
 * **The only table in Phase 9 a person writes by hand**, which is why it is the
 * only one under the Phase 7 sync contract and the only one that needed a new
 * capability key. Everything else in this phase is reference data imported at a
 * desk or a figure the engine derived.
 *
 * ── THE FOUR CHECKS, AND THE TWO THAT ARE NOT THE DEFAULT ───────────────────
 *
 * **The feature is `sustainability` on the PROJECT OWNER**, the 2026-09-01 rule
 * unchanged: a subcontractor recording that its van did 240 km on somebody else's
 * job consumes that owner's entitlement, because the owner is who publishes the
 * emissions figure and answers for it. Gating the recorder would make a Crew-plan
 * subcontractor unable to report its own transport on a paying customer's project,
 * which is the failure the free tier exists to prevent.
 *
 * **The capability is `sustainability.write`**, added by `0040` (packet finding 10)
 * rather than borrowed from `asset.write` — because `provider_company_id` makes
 * this write an assertion about another business, and anyone who can record a chair
 * should not thereby be able to attribute a journey to a subcontractor's van.
 */

async function assertActivityFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'sustainability'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: sustainability'
        : 'This project’s owner does not have sustainability enabled',
      { feature: 'sustainability' }
    );
  }
}

interface ActivityRow {
  id: string;
  project_id: string;
  company_id: string;
  kind: ProjectActivityView['kind'];
  activity_date: string;
  vehicle_category: string | null;
  fuel_type: string | null;
  distance_km: string | null;
  litres: string | null;
  kwh: string | null;
  tonne_km: string | null;
  journeys: number | null;
  entered_value: string | null;
  entered_unit: ProjectActivityView['enteredUnit'];
  purpose: ProjectActivityView['purpose'];
  provider_company_id: string | null;
  provider_company_name: string | null;
  asset_movement_id: string | null;
  source: ProjectActivityView['source'];
  document_id: string | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_by_name: string | null;
  captured_at: Date | null;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `a.id, a.project_id, a.company_id, a.kind,
  to_char(a.activity_date, 'YYYY-MM-DD') as activity_date,
  a.vehicle_category, a.fuel_type,
  a.distance_km::text as distance_km, a.litres::text as litres,
  a.kwh::text as kwh, a.tonne_km::text as tonne_km, a.journeys,
  a.entered_value::text as entered_value, a.entered_unit, a.purpose,
  a.provider_company_id, pc.name as provider_company_name,
  a.asset_movement_id, a.source, a.document_id, a.notes,
  a.created_by_user_id, u.name as created_by_name,
  a.captured_at, a.revision, a.deleted_at, a.created_at, a.updated_at`;

const FROM = `from project_activities a
  left join companies pc on pc.id = a.provider_company_id
  left join users u on u.id = a.created_by_user_id`;

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function toView(row: ActivityRow): ProjectActivityView {
  return {
    id: row.id,
    projectId: row.project_id,
    companyId: row.company_id,
    kind: row.kind,
    activityDate: row.activity_date,
    vehicleCategory: row.vehicle_category,
    fuelType: row.fuel_type,
    distanceKm: num(row.distance_km),
    litres: num(row.litres),
    kwh: num(row.kwh),
    tonneKm: num(row.tonne_km),
    journeys: row.journeys,
    enteredValue: num(row.entered_value),
    enteredUnit: row.entered_unit,
    purpose: row.purpose,
    providerCompanyId: row.provider_company_id,
    providerCompanyName: row.provider_company_name,
    assetMovementId: row.asset_movement_id,
    source: row.source,
    documentId: row.document_id,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    capturedAt: row.captured_at?.toISOString() ?? null,
    revision: row.revision,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The two references an activity may carry, checked for **reachability by this
 * caller** rather than merely for existence.
 *
 * `movementsRoutes.ts` states the attack this closes: without it a subcontractor
 * could attach an arbitrary document id to its own row and read the document back
 * through the expanded response. Same join, same direction.
 *
 * **`providerCompanyId` may only ever be the acting company itself.** §4: a row
 * naming another business is an assertion that business cannot see or contest. A
 * genuine third-party haulier has no `companies` row on this project and is
 * recorded by leaving the column null and naming them in `notes`.
 */
async function validateReferences(
  access: ProjectAccess,
  companyId: string,
  input: {
    documentId?: string | null;
    assetMovementId?: string | null;
    providerCompanyId?: string | null;
  }
): Promise<void> {
  if (input.providerCompanyId != null && input.providerCompanyId !== companyId) {
    throw new AppError(
      'FORBIDDEN',
      'An activity can only be attributed to your own company. Record a third party’s journey without naming them, or ask them to record it themselves.',
      { field: 'providerCompanyId' }
    );
  }
  if (input.documentId != null) {
    const doc = await queryOne<{ id: string }>(
      `select id from project_documents
        where id = $1 and project_id = $2 and deleted_at is null`,
      [input.documentId, access.projectId]
    );
    if (!doc) throw new AppError('VALIDATION', 'That document is not on this project');
  }
  if (input.assetMovementId != null) {
    const movement = await queryOne<{ id: string }>(
      `select m.id from asset_movements m
         join project_assets pa on pa.id = m.asset_id
        where m.id = $1 and pa.project_id = $2
          and m.deleted_at is null and pa.deleted_at is null`,
      [input.assetMovementId, access.projectId]
    );
    if (!movement) throw new AppError('VALIDATION', 'That movement is not on this project');
  }
}

/**
 * What the person typed, kept beside the measure.
 *
 * §41.2's *"name your activity data"* means the number on the form, not the number
 * we converted it to: a driver who entered 150 miles and reads back 241.4 km cannot
 * check their own entry. When the caller does not say, the measure is echoed into
 * these columns so the pair is never half-populated.
 */
function enteredPair(input: {
  kind: ProjectActivityView['kind'];
  enteredValue?: number | null;
  enteredUnit?: ProjectActivityView['enteredUnit'];
  distanceKm?: number | null;
  litres?: number | null;
  kwh?: number | null;
  tonneKm?: number | null;
}): { value: number | null; unit: string | null } {
  if (input.enteredValue != null && input.enteredUnit != null) {
    return { value: input.enteredValue, unit: input.enteredUnit };
  }
  const measure = REQUIRED_MEASURE_FOR_KIND[input.kind];
  if (measure === null) return { value: null, unit: null };
  const value = input[measure];
  return value == null ? { value: null, unit: null } : { value, unit: UNIT_FOR_MEASURE[measure] };
}

/** The facts a revision trail should carry, and nothing derived. */
function activityFacts(view: ProjectActivityView): Record<string, unknown> {
  return {
    kind: view.kind,
    activityDate: view.activityDate,
    vehicleCategory: view.vehicleCategory,
    fuelType: view.fuelType,
    distanceKm: view.distanceKm,
    litres: view.litres,
    kwh: view.kwh,
    tonneKm: view.tonneKm,
    journeys: view.journeys,
    purpose: view.purpose,
    providerCompanyId: view.providerCompanyId,
    assetMovementId: view.assetMovementId,
    source: view.source,
    documentId: view.documentId,
    notes: view.notes,
  };
}

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectActivitiesRouter = Router();

/**
 * GET /v1/projects/:projectId/activities
 *
 * **A provider sees only its own rows**, unlike the mass balance one file over,
 * which shows the project's total to everybody assigned to it. The distinction is
 * `massBalance.ts`'s own: *"a total is not a row."* An activity row names a
 * subcontractor's van, its journeys and its fuel — the shape of another business's
 * operations — where a tonnage total names nothing.
 */
projectActivitiesRouter.get(
  '/:projectId/activities',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertActivityFeature(access);
    await assertCapability(ctx, 'project.read');

    const rows = await query<ActivityRow>(
      `select ${COLUMNS} ${FROM}
        where a.project_id = $1 and a.deleted_at is null
          and ($2::boolean or a.company_id = $3)
        order by a.activity_date desc, a.created_at desc`,
      [access.projectId, access.isOwner, ctx.companyId]
    );
    res.json({ activities: rows.map(toView) });
  })
);

projectActivitiesRouter.post(
  '/:projectId/activities',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertActivityFeature(access);
    await assertCapability(ctx, 'sustainability.write');

    const input = createActivitySchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/activities',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        await validateReferences(access, ctx.companyId, input);
        const entered = enteredPair(input);

        const created = await withTransaction(async (client) => {
          const row = await queryOne<{ id: string }>(
            `insert into project_activities
               (project_id, company_id, kind, activity_date, vehicle_category, fuel_type,
                distance_km, litres, kwh, tonne_km, journeys,
                entered_value, entered_unit, purpose, provider_company_id,
                asset_movement_id, source, document_id, notes,
                created_by_user_id, captured_at, client_id)
             values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::timestamptz,$22)
             returning id`,
            [
              access.projectId,
              ctx.companyId,
              input.kind,
              input.activityDate,
              input.vehicleCategory ?? null,
              input.fuelType ?? null,
              input.distanceKm ?? null,
              input.litres ?? null,
              input.kwh ?? null,
              input.tonneKm ?? null,
              input.journeys ?? null,
              entered.value,
              entered.unit,
              input.purpose ?? null,
              input.providerCompanyId ?? null,
              input.assetMovementId ?? null,
              input.source,
              input.documentId ?? null,
              input.notes ?? null,
              ctx.userId,
              input.capturedAt ?? null,
              input.clientId ?? null,
            ],
            client
          );
          /* c8 ignore next */
          if (!row) throw new AppError('CONFLICT', 'That activity could not be recorded.');

          const full = await queryOne<ActivityRow>(
            `select ${COLUMNS} ${FROM} where a.id = $1`,
            [row.id],
            client
          );
          /* c8 ignore next */
          if (!full) throw new AppError('CONFLICT', 'That activity could not be recorded.');

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'activity.recorded',
              entityType: 'PROJECT_ACTIVITY',
              entityId: row.id,
              description: `${input.kind.toLowerCase().replace(/_/g, ' ')} on ${input.activityDate}`,
            },
            client
          );
          return toView(full);
        });

        /*
         * The recalculation, after the write rather than inside it — see
         * `recalculateAfterWrite`. A misconfigured factor set must not refuse the
         * recording of something that happened.
         */
        await recalculateAfterWrite({
          projectId: access.projectId,
          trigger: 'ACTIVITY_CHANGED',
          triggeringId: created.id,
          actorUserId: ctx.userId,
        });

        return { activity: created };
      }
    );
  })
);

// ── Mounted under /v1/activities ─────────────────────────────────────────────

export const activitiesRouter = Router();

/** Resolve an activity and the caller's relationship to its project. */
async function activityAccess(
  id: string,
  companyId: string
): Promise<{ row: ActivityRow; access: ProjectAccess }> {
  const row = await queryOne<ActivityRow>(`select ${COLUMNS} ${FROM} where a.id = $1`, [id]);
  if (!row) throw new AppError('NOT_FOUND', 'Activity not found');
  const access = await projectAccess(row.project_id, companyId);
  // A counterparty's row answers as not found rather than as forbidden, which is
  // the shape `movementsRoutes.ts` uses: a 403 confirms the id exists.
  if (!access.isOwner && row.company_id !== companyId) {
    throw new AppError('NOT_FOUND', 'Activity not found');
  }
  return { row, access };
}

activitiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row: found, access } = await activityAccess(id, ctx.companyId);
    await assertActivityFeature(access);
    await assertCapability(ctx, 'sustainability.write');

    const { expectedRevision, ...fields } = updateActivitySchema.parse(req.body);

    const conflict = detectConflict({
      expected: expectedRevision,
      actual: found.revision,
      deletedAt: found.deleted_at?.toISOString() ?? null,
    });
    if (conflict) {
      if (conflict.code === 'GONE') throw new AppError('GONE', conflict.message);
      /*
       * Both versions travel with the refusal, which is the Phase 7 shape: the
       * device shows what is on the server beside what was captured and offers
       * *keep mine* / *keep theirs*. An activity is a small enough record that
       * field-merging two versions of it produces a journey nobody made (§8).
       */
      throw new AppError('CONFLICT', conflict.message, {
        reason: 'STALE_REVISION',
        current: toView(found),
      });
    }

    await validateReferences(access, ctx.companyId, fields);
    const before = toView(found);

    const updated = await withTransaction(async (client) => {
      const kind = fields.kind ?? found.kind;
      const entered = enteredPair({
        kind,
        enteredValue: fields.enteredValue,
        enteredUnit: fields.enteredUnit,
        distanceKm: fields.distanceKm ?? num(found.distance_km),
        litres: fields.litres ?? num(found.litres),
        kwh: fields.kwh ?? num(found.kwh),
        tonneKm: fields.tonneKm ?? num(found.tonne_km),
      });

      const row = await queryOne<{ id: string }>(
        `update project_activities set
           kind = coalesce($2, kind),
           activity_date = coalesce($3::date, activity_date),
           vehicle_category = case when $4::boolean then $5::text else vehicle_category end,
           fuel_type = case when $6::boolean then $7::text else fuel_type end,
           distance_km = case when $8::boolean then $9::numeric else distance_km end,
           litres = case when $10::boolean then $11::numeric else litres end,
           kwh = case when $12::boolean then $13::numeric else kwh end,
           tonne_km = case when $14::boolean then $15::numeric else tonne_km end,
           journeys = case when $16::boolean then $17::int else journeys end,
           entered_value = $18::numeric,
           entered_unit = $19,
           purpose = case when $20::boolean then $21::text else purpose end,
           provider_company_id = case when $22::boolean then $23::uuid else provider_company_id end,
           asset_movement_id = case when $24::boolean then $25::uuid else asset_movement_id end,
           source = coalesce($26, source),
           document_id = case when $27::boolean then $28::uuid else document_id end,
           notes = case when $29::boolean then $30::text else notes end,
           updated_by_user_id = $31,
           updated_at = now()
         where id = $1 and deleted_at is null
         returning id`,
        [
          id,
          fields.kind ?? null,
          fields.activityDate ?? null,
          fields.vehicleCategory !== undefined, fields.vehicleCategory ?? null,
          fields.fuelType !== undefined, fields.fuelType ?? null,
          fields.distanceKm !== undefined, fields.distanceKm ?? null,
          fields.litres !== undefined, fields.litres ?? null,
          fields.kwh !== undefined, fields.kwh ?? null,
          fields.tonneKm !== undefined, fields.tonneKm ?? null,
          fields.journeys !== undefined, fields.journeys ?? null,
          entered.value,
          entered.unit,
          fields.purpose !== undefined, fields.purpose ?? null,
          fields.providerCompanyId !== undefined, fields.providerCompanyId ?? null,
          fields.assetMovementId !== undefined, fields.assetMovementId ?? null,
          fields.source ?? null,
          fields.documentId !== undefined, fields.documentId ?? null,
          fields.notes !== undefined, fields.notes ?? null,
          ctx.userId,
        ],
        client
      );
      if (!row) throw new AppError('GONE', 'That activity was removed.');

      const full = await queryOne<ActivityRow>(
        `select ${COLUMNS} ${FROM} where a.id = $1`,
        [id],
        client
      );
      /* c8 ignore next */
      if (!full) throw new AppError('GONE', 'That activity was removed.');
      const after = toView(full);

      /*
       * The measure a kind is priced from is re-checked after the patch, because a
       * partial update can leave a valid row invalid: switching kind to ELECTRICITY
       * without supplying kWh would produce an activity nothing can price, and the
       * engine would file it as a gap the operator did not create.
       */
      const measure = REQUIRED_MEASURE_FOR_KIND[after.kind];
      if (measure !== null && (after[measure] == null || (after[measure] as number) <= 0)) {
        throw new AppError(
          'VALIDATION',
          `A ${after.kind.toLowerCase().replace(/_/g, ' ')} activity needs a ${measure} above zero.`,
          { field: measure }
        );
      }

      await recordRevision(
        {
          companyId: found.company_id,
          entityType: 'PROJECT_ACTIVITY',
          entityId: id,
          action: 'UPDATE',
          before: activityFacts(before),
          after: activityFacts(after),
          changedByUserId: ctx.userId,
        },
        client
      );
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'activity.updated',
          entityType: 'PROJECT_ACTIVITY',
          entityId: id,
        },
        client
      );
      return after;
    });

    await recalculateAfterWrite({
      projectId: access.projectId,
      trigger: 'ACTIVITY_CHANGED',
      triggeringId: id,
      actorUserId: ctx.userId,
    });

    res.json({ activity: updated });
  })
);

/**
 * DELETE /v1/activities/:id — a tombstone, and a recalculation.
 *
 * The activity half of packet finding 6. A deleted activity that left its
 * calculation standing would keep a journey in the project's emissions total after
 * the journey had been retracted, and every query would still return a plausible
 * number.
 */
activitiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row: found, access } = await activityAccess(id, ctx.companyId);
    await assertActivityFeature(access);
    await assertCapability(ctx, 'sustainability.write');

    if (found.deleted_at !== null) {
      throw new AppError('GONE', 'This activity was already removed.');
    }

    await withTransaction(async (client) => {
      await query(
        `update project_activities set deleted_at = now(), updated_by_user_id = $2
          where id = $1 and deleted_at is null`,
        [id, ctx.userId],
        client
      );
      await recordRevision(
        {
          companyId: found.company_id,
          entityType: 'PROJECT_ACTIVITY',
          entityId: id,
          action: 'DELETE',
          before: activityFacts(toView(found)),
          after: null,
          changedByUserId: ctx.userId,
        },
        client
      );
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'activity.removed',
          entityType: 'PROJECT_ACTIVITY',
          entityId: id,
        },
        client
      );
    });

    await recalculateAfterWrite({
      projectId: access.projectId,
      trigger: 'ACTIVITY_CHANGED',
      triggeringId: id,
      actorUserId: ctx.userId,
    });

    res.status(204).end();
  })
);
