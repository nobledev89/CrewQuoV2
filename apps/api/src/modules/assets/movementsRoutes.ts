import { Router } from 'express';
import {
  canContinueMovement,
  canRecordMovement,
  continueMovementSchema,
  createDestinationOrgSchema,
  createMovementSchema,
  detectConflict,
  resolveTypeCatalog,
  updateDestinationOrgSchema,
  updateMovementSchema,
  type DestinationOrgView,
  type DestinationTypeView,
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
/*
 * Phase 9's finding 6 (`sustainability.md` §0), wired into the movement ledger.
 *
 * Tombstoning a movement, correcting its quantity or continuing it out of storage
 * all change what `massBalance.ts` returns — and would leave `carbon_calculations`
 * untouched, `superseded_by` still null, still counted. The two halves of the same
 * §28 section would then disagree about whether the material exists, invisibly,
 * because every query still returns a plausible number.
 *
 * `recalculateAfterWrite` never throws into the caller: recording where material
 * went must not be refused because a factor set is misconfigured.
 */
import { recalculateAfterWrite } from '../sustainability/engine';
import {
  findDestinationOrg,
  findMovement,
  findUsableDestinationType,
  insertMovement,
  listDestinationOrgs,
  listDestinationTypes,
  listMovements,
  lockAsset,
  recomputeOutcomeState,
  toMovementView,
  toPolicyMovement,
  tombstoneMovement,
  updateMovement,
  type MovementRow,
  type MovementView,
} from './movementsRepo';

/**
 * The movement ledger (§25.4) — step 3 of the Phase 8 build order.
 *
 * **Every write in this file opens with `lockAsset` and closes with
 * `recomputeOutcomeState`, in one transaction.** That is not ceremony. Three
 * separate races live on this row and all three are about the same fact:
 *
 *  1. **The quantity ceiling.** Two clerks record two movements, each within the
 *     remainder separately and over it together — `money-boundary.md` §3's
 *     check-then-act, whose losing outcome here is a mass balance that does not
 *     balance in the table a client report reads.
 *  2. **`sequence`.** Allocating `max + 1` outside the lock makes the loser of a
 *     race an error rather than a corruption, which is the right failure and a bad
 *     one to show somebody.
 *  3. **`outcome_state`.** A derived column written by two interleaved
 *     transactions ends up disagreeing with the movements it summarises.
 *
 * The asset is the lock for all three because it is the row all three are about,
 * and holding it gives the recompute a consistent read for free.
 */

interface AssetAccess {
  assetId: string;
  projectId: string;
  /** The company that recorded the line — whose record a revision belongs to. */
  recordingCompanyId: string;
  ownerCompanyId: string;
  isOwner: boolean;
  quantity: number;
  unitWeightKg: number | null;
}

/**
 * Resolve and authorize an asset for a movement write, WITHOUT the lock.
 *
 * The four checks run before the transaction opens, deliberately: an entitlement
 * lookup and a capability resolution are two round trips, and holding a row lock
 * across them widens the window every other writer waits in for no benefit. The
 * lock is taken inside the transaction, and the asset is re-read under it — so a
 * line deleted between the two reads is caught by the lock's own `deleted_at`
 * filter rather than by this one.
 */
async function assetAccess(assetId: string, companyId: string): Promise<AssetAccess> {
  const row = await queryOne<{
    project_id: string;
    company_id: string;
    quantity: string;
    unit_weight_kg: string | null;
    owner_company_id: string;
    assigned: boolean;
  }>(
    `select a.project_id, a.company_id, a.quantity, a.unit_weight_kg,
            p.owner_company_id,
            exists (
              select 1 from project_assignments x
               where x.project_id = p.id and x.provider_company_id = $2
            ) as assigned
       from project_assets a
       join projects p on p.id = a.project_id
      where a.id = $1 and a.deleted_at is null`,
    [assetId, companyId]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Asset not found');

  const isOwner = row.owner_company_id === companyId;
  if (!isOwner && !row.assigned) throw new AppError('NOT_FOUND', 'Asset not found');
  // A counterparty's line answers as not found rather than as forbidden.
  if (!isOwner && row.company_id !== companyId) {
    throw new AppError('NOT_FOUND', 'Asset not found');
  }
  if (!(await hasFeature(row.owner_company_id, 'asset_tracking'))) {
    throw new AppError(
      'FORBIDDEN',
      isOwner
        ? 'Your plan does not include: asset_tracking'
        : 'This project’s owner does not have asset tracking enabled',
      { feature: 'asset_tracking' }
    );
  }

  return {
    assetId,
    projectId: row.project_id,
    recordingCompanyId: row.company_id,
    ownerCompanyId: row.owner_company_id,
    isOwner,
    quantity: Number(row.quantity),
    unitWeightKg: row.unit_weight_kg === null ? null : Number(row.unit_weight_kg),
  };
}

/**
 * Every foreign key a movement carries, checked for reachability BY THIS CALLER
 * rather than merely for existence.
 *
 * The document check is the one worth stating: without it a subcontractor could
 * attach an arbitrary document id to its own movement and read the document back
 * through the expanded response. Two records on one project, both readable, and
 * the join checked in the direction an attacker would use it.
 */
async function validateReferences(
  access: AssetAccess,
  companyId: string,
  input: {
    destinationTypeId?: string;
    destinationOrgId?: string | null;
    fromLocationId?: string | null;
    documentId?: string | null;
  }
): Promise<void> {
  if (input.destinationTypeId !== undefined) {
    if (!(await findUsableDestinationType(input.destinationTypeId, companyId))) {
      throw new AppError('NOT_FOUND', 'Destination type not found');
    }
  }
  if (input.destinationOrgId != null) {
    if (!(await findDestinationOrg(input.destinationOrgId, companyId))) {
      throw new AppError('NOT_FOUND', 'Destination organisation not found');
    }
  }
  if (input.fromLocationId != null) {
    const loc = await queryOne<{ id: string }>(
      `select id from project_locations
        where id = $1 and project_id = $2 and deleted_at is null`,
      [input.fromLocationId, access.projectId]
    );
    if (!loc) throw new AppError('VALIDATION', 'That location is not on this project');
  }
  if (input.documentId != null) {
    const doc = await queryOne<{ id: string }>(
      `select id from project_documents
        where id = $1 and project_id = $2 and deleted_at is null`,
      [input.documentId, access.projectId]
    );
    if (!doc) throw new AppError('VALIDATION', 'That document is not on this project');
  }
}

function refusalToError(refusal: { code: string; message: string }): AppError {
  return new AppError('CONFLICT', refusal.message, { reason: refusal.code });
}

/** What a movement write returns: the row, and the state it moved the line to. */
function movementResult(row: MovementRow, access: AssetAccess, outcomeState: string) {
  return {
    movement: toMovementView(row, { unitWeightKg: access.unitWeightKg }),
    outcomeState,
  };
}

// ── Mounted under /v1/assets ─────────────────────────────────────────────────

export const assetMovementsRouter = Router();

assetMovementsRouter.get(
  '/:id/movements',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await assetAccess(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const rows = await listMovements(access.assetId);
    res.json({
      movements: rows.map((r) => toMovementView(r, { unitWeightKg: access.unitWeightKg })),
    });
  })
);

assetMovementsRouter.post(
  '/:id/movements',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await assetAccess(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'asset.destination.set');

    const input = createMovementSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/assets/:id/movements',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        await validateReferences(access, ctx.companyId, input);

        return withTransaction(async (client) => {
          const locked = await lockAsset(access.assetId, client);
          if (!locked) throw new AppError('GONE', 'This asset line was removed.');
          const quantity = Number(locked.quantity);

          const existing = await listMovements(access.assetId, client);
          const refusal = canRecordMovement(
            { quantity, unitWeightKg: access.unitWeightKg },
            existing.map(toPolicyMovement),
            input.quantity
          );
          if (refusal) throw refusalToError(refusal);

          const row = await insertMovement(
            {
              assetId: access.assetId,
              continuesMovementId: null,
              destinationTypeId: input.destinationTypeId,
              destinationOrgId: input.destinationOrgId,
              destinationAddress: input.destinationAddress,
              fromLocationId: input.fromLocationId,
              quantity: input.quantity,
              weightKg: input.weightKg,
              movedOn: input.movedOn,
              distanceKm: input.distanceKm,
              documentId: input.documentId,
              notes: input.notes,
              recordedByUserId: ctx.userId,
            },
            client
          );
          if (!row) throw new AppError('CONFLICT', 'That movement could not be recorded.');

          const outcomeState = await recomputeOutcomeState(access.assetId, quantity, client);
          await auditMovement(client, ctx, access, row, 'asset.movement_recorded');
          const result = movementResult(row, access, outcomeState);
          await recalculateAfterWrite({
            projectId: access.projectId,
            trigger: 'MOVEMENT_RECORDED',
            triggeringId: row.id,
            actorUserId: ctx.userId,
          });
          return result;
        });
      }
    );
  })
);

// ── Mounted under /v1/movements ──────────────────────────────────────────────

export const movementsRouter = Router();

/**
 * POST /v1/movements/:id/continue — the packet's §13.1, as a route.
 *
 * Material leaves the warehouse. The storage leg stops counting against the
 * ceiling and against pending mass; the new leg counts instead; the total handled
 * mass does not move by a gram. That last property is what the whole design is
 * for, and it is asserted directly in the e2e.
 *
 * A separate route rather than a field on `POST /movements`, because the guards
 * are different and the mistake is expensive: a continuation silently written as a
 * fresh movement is 12 chairs in the warehouse *and* 12 recycled, from a line of
 * 42 that also donated 30.
 */
movementsRouter.post(
  '/:id/continue',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const source = await findMovement(id);
    if (!source || source.deleted_at !== null) {
      throw new AppError('NOT_FOUND', 'Movement not found');
    }
    const access = await assetAccess(source.asset_id, ctx.companyId);
    await assertCapability(ctx, 'asset.destination.set');

    const input = continueMovementSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/movements/:id/continue',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        await validateReferences(access, ctx.companyId, input);

        return withTransaction(async (client) => {
          const locked = await lockAsset(access.assetId, client);
          if (!locked) throw new AppError('GONE', 'This asset line was removed.');
          const quantity = Number(locked.quantity);

          // Re-read under the lock: the source may have been continued by somebody
          // else between the check above and this transaction, and that is exactly
          // the race the one-successor index would otherwise turn into a raw
          // unique violation.
          const existing = await listMovements(access.assetId, client);
          const current = existing.find((m) => m.id === id);
          if (!current) throw new AppError('GONE', 'That movement was removed.');

          const refusal = canContinueMovement(
            toPolicyMovement(current),
            existing.map(toPolicyMovement),
            input.quantity
          );
          if (refusal) throw refusalToError(refusal);

          const row = await insertMovement(
            {
              assetId: access.assetId,
              continuesMovementId: id,
              destinationTypeId: input.destinationTypeId,
              destinationOrgId: input.destinationOrgId,
              destinationAddress: input.destinationAddress,
              fromLocationId: input.fromLocationId,
              quantity: input.quantity,
              weightKg: input.weightKg,
              movedOn: input.movedOn,
              distanceKm: input.distanceKm,
              documentId: input.documentId,
              notes: input.notes,
              recordedByUserId: ctx.userId,
            },
            client
          );
          if (!row) throw new AppError('CONFLICT', 'That movement could not be recorded.');

          /*
           * A PARTIAL release is two movements, not one: continuing 5 of 12 leaves
           * 7 still in the warehouse, and the remainder has to be recorded as its
           * own storage leg or it silently becomes unallocated. The API does not
           * do that for the caller — inventing a movement nobody recorded is worse
           * than leaving 7 chairs visibly pending — but it says so.
           */
          const remainder = Number(current.quantity) - input.quantity;
          const outcomeState = await recomputeOutcomeState(access.assetId, quantity, client);
          await auditMovement(client, ctx, access, row, 'asset.movement_continued');

          const result = movementResult(row, access, outcomeState);
          /*
           * The continuation half of finding 6, and the one that would be hardest to
           * spot: the storage leg stops counting toward pending mass and the new leg
           * starts counting toward its destination, so the carbon roll-up moves
           * without a single row being deleted.
           */
          await recalculateAfterWrite({
            projectId: access.projectId,
            trigger: 'CONTINUATION_RECORDED',
            triggeringId: row.id,
            actorUserId: ctx.userId,
          });
          return remainder > 0
            ? {
                ...result,
                notice: `${remainder} of these are still at the previous destination and are now unallocated. Record where they went.`,
              }
            : result;
        });
      }
    );
  })
);

movementsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const found = await findMovement(id);
    if (!found) throw new AppError('NOT_FOUND', 'Movement not found');
    const access = await assetAccess(found.asset_id, ctx.companyId);
    await assertCapability(ctx, 'asset.destination.set');

    const { expectedRevision, ...fields } = updateMovementSchema.parse(req.body);

    const conflict = detectConflict({
      expected: expectedRevision,
      actual: found.revision,
      deletedAt: found.deleted_at?.toISOString() ?? null,
    });
    if (conflict) {
      if (conflict.code === 'GONE') throw new AppError('GONE', conflict.message);
      throw new AppError('CONFLICT', conflict.message, {
        reason: 'STALE_REVISION',
        current: toMovementView(found, { unitWeightKg: access.unitWeightKg }),
      });
    }

    await validateReferences(access, ctx.companyId, fields);

    const updated = await withTransaction(async (client) => {
      const locked = await lockAsset(access.assetId, client);
      if (!locked) throw new AppError('GONE', 'This asset line was removed.');
      const quantity = Number(locked.quantity);

      const existing = await listMovements(access.assetId, client);
      const before = existing.find((m) => m.id === id);
      if (!before) throw new AppError('GONE', 'That movement was removed.');

      if (fields.quantity !== undefined) {
        /*
         * The ceiling again, with this movement taken out of the count — otherwise
         * correcting 30 to 31 is measured against a remainder that already
         * includes the 30.
         */
        const others = existing.filter((m) => m.id !== id).map(toPolicyMovement);
        const refusal = canRecordMovement(
          { quantity, unitWeightKg: access.unitWeightKg },
          others,
          fields.quantity
        );
        if (refusal) throw refusalToError(refusal);

        // And it may not shrink below what continues it: 12 went into the
        // warehouse and 12 came out, so correcting the storage leg to 5 would
        // leave a successor claiming material its source never held.
        const successor = existing.find((m) => m.continues_movement_id === id);
        if (successor && Number(successor.quantity) > fields.quantity) {
          throw new AppError(
            'CONFLICT',
            `${successor.quantity} of these have already been recorded onward from here. Correct that movement first.`,
            { reason: 'CONTINUATION_EXCEEDS_SOURCE' }
          );
        }
      }

      const row = await updateMovement(id, fields, expectedRevision, ctx.userId, client);
      if (!row) throw new AppError('CONFLICT', 'That movement changed since you loaded it.');

      const outcomeState = await recomputeOutcomeState(access.assetId, quantity, client);

      /*
       * §25.4 rule 4: corrections write `record_revisions`, never silent
       * overwrites. Against the RECORDING company — `record.ts`'s rule is "whose
       * record changed" — so a sustainability lead correcting a subcontractor's
       * destination changes the subcontractor's row, and the hiring company's
       * trail does not claim it authored the movement.
       */
      await recordRevision(
        {
          companyId: access.recordingCompanyId,
          entityType: 'ASSET_MOVEMENT',
          entityId: id,
          action: 'UPDATE',
          before: movementFacts(toMovementView(before, { unitWeightKg: access.unitWeightKg })),
          after: movementFacts(toMovementView(row, { unitWeightKg: access.unitWeightKg })),
          changedByUserId: ctx.userId,
        },
        client
      );
      await auditMovement(client, ctx, access, row, 'asset.movement_corrected');
      return movementResult(row, access, outcomeState);
    });

    await recalculateAfterWrite({
      projectId: access.projectId,
      trigger: 'WEIGHT_CORRECTED',
      triggeringId: id,
      actorUserId: ctx.userId,
    });

    res.json(updated);
  })
);

movementsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const found = await findMovement(id);
    if (!found) throw new AppError('NOT_FOUND', 'Movement not found');
    const access = await assetAccess(found.asset_id, ctx.companyId);
    await assertCapability(ctx, 'asset.destination.set');

    await withTransaction(async (client) => {
      const locked = await lockAsset(access.assetId, client);
      if (!locked) throw new AppError('GONE', 'This asset line was removed.');

      const existing = await listMovements(access.assetId, client);
      const before = existing.find((m) => m.id === id);
      if (!before) throw new AppError('GONE', 'This movement was already removed.');

      /*
       * A continued movement may not be deleted. Removing the storage leg out from
       * under its recycling leg orphans the chain and silently re-opens 12 chairs
       * of pending mass on a line that reads FINAL — and the person who did it
       * sees a successful delete.
       */
      const successor = existing.find((m) => m.continues_movement_id === id);
      if (successor) {
        throw new AppError(
          'CONFLICT',
          'Material was recorded onward from this movement. Remove that one first.',
          { reason: 'HAS_CONTINUATION', movementId: successor.id }
        );
      }

      const row = await tombstoneMovement(id, client);
      if (!row) throw new AppError('GONE', 'This movement was already removed.');

      await recomputeOutcomeState(access.assetId, Number(locked.quantity), client);
      await recordRevision(
        {
          companyId: access.recordingCompanyId,
          entityType: 'ASSET_MOVEMENT',
          entityId: id,
          action: 'DELETE',
          before: movementFacts(toMovementView(before, { unitWeightKg: access.unitWeightKg })),
          after: null,
          changedByUserId: ctx.userId,
        },
        client
      );
      await auditMovement(client, ctx, access, row, 'asset.movement_removed');
    });

    /*
     * Step 12 of the §12 acceptance script, and the one no other step would catch:
     * the project's emissions figure must FALL when a movement is deleted, and the
     * carbon roll-up must agree with the mass balance afterwards.
     */
    await recalculateAfterWrite({
      projectId: access.projectId,
      trigger: 'MOVEMENT_TOMBSTONED',
      triggeringId: id,
      actorUserId: ctx.userId,
    });

    res.status(204).end();
  })
);

// ── Destination catalogs, mounted under /v1 ──────────────────────────────────

export const destinationTypesRouter = Router();

/**
 * GET /v1/destination-types — the waste hierarchy, as this company sees it.
 *
 * Every `counts_as_*` flag is returned rather than a computed label, because
 * decision #20 makes them a company's own assumptions and a UI that shows
 * "Recycling" without showing what the company has decided that counts as is the
 * opposite of "an org can see and adjust its own assumptions". `isSystem` says
 * which rows are the seeded semantics, so a customised hierarchy reads as a diff.
 */
destinationTypesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'project.read');
    const rows = await listDestinationTypes(ctx.companyId);
    const resolved = resolveTypeCatalog(
      rows.map((r) => ({ ...r, companyId: r.company_id, code: r.code }))
    );
    res.json({
      destinationTypes: resolved
        .sort((a, b) => {
          const at = a.hierarchy_tier ?? Number.POSITIVE_INFINITY;
          const bt = b.hierarchy_tier ?? Number.POSITIVE_INFINITY;
          return at === bt ? a.sort_order - b.sort_order : at - bt;
        })
        .map((r): DestinationTypeView => ({
          id: r.id,
          code: r.code,
          name: r.name,
          isSystem: r.company_id === null,
          hierarchyTier: r.hierarchy_tier,
          countsAsRetainedInUse: r.counts_as_retained_in_use,
          countsAsReuse: r.counts_as_reuse,
          countsAsRecycling: r.counts_as_recycling,
          countsAsRecovery: r.counts_as_recovery,
          countsAsLandfill: r.counts_as_landfill,
          countsAsDiverted: r.counts_as_diverted,
          isFinalOutcome: r.is_final_outcome,
          displacesReplacement: r.displaces_replacement,
          sortOrder: r.sort_order,
        })),
    });
  })
);

export const destinationOrgsRouter = Router();

destinationOrgsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'project.read');
    const rows = await listDestinationOrgs(
      ctx.companyId,
      (req.query as Record<string, unknown>).includeInactive === 'true'
    );
    res.json({ destinationOrganisations: rows.map(toOrgView) });
  })
);

destinationOrgsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'asset.destination.set');
    const input = createDestinationOrgSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/destination-organisations',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        await assertLinkedCompany(ctx.companyId, input.linkedCompanyId ?? null);
        const row = await queryOne(
          `insert into destination_organisations
             (company_id, linked_company_id, name, kind, address, contact_name,
              contact_email, contact_phone, licence_number, licence_expires_on, notes)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           returning *`,
          [
            ctx.companyId,
            input.linkedCompanyId ?? null,
            input.name,
            input.kind,
            input.address ?? null,
            input.contactName ?? null,
            input.contactEmail ?? null,
            input.contactPhone ?? null,
            input.licenceNumber ?? null,
            input.licenceExpiresOn ?? null,
            input.notes ?? null,
          ]
        ).catch((err: unknown) => {
          // The case-insensitive name index. Two organisations with one name is a
          // duplicate somebody picks the wrong one of, and picking the wrong one
          // silently attributes a tonne to the wrong charity.
          if (String(err).includes('destination_organisations_company_name_idx')) {
            throw new AppError('CONFLICT', `You already have an organisation called ${input.name}.`);
          }
          throw err;
        });
        if (!row) throw new AppError('CONFLICT', 'That organisation could not be saved.');

        await recordAudit({
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'destination_org.created',
          entityType: 'DESTINATION_ORGANISATION',
          entityId: (row as { id: string }).id,
          changes: { kind: input.kind },
          description: `Destination organisation added: ${input.kind}`,
        });
        return { destinationOrganisation: toOrgView(row as never) };
      }
    );
  })
);

destinationOrgsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    await assertCapability(ctx, 'asset.destination.set');
    const existing = await findDestinationOrg(id, ctx.companyId);
    if (!existing) throw new AppError('NOT_FOUND', 'Destination organisation not found');

    const patch = updateDestinationOrgSchema.parse(req.body);
    if ('linkedCompanyId' in patch) {
      await assertLinkedCompany(ctx.companyId, patch.linkedCompanyId ?? null);
    }

    /*
     * **Retiring anonymises the contact and keeps the organisation.** The person
     * whose name, email and phone are here has no CrewQuo account and no way to
     * ask what is held about them, so deactivation is the moment to stop holding
     * it — while the ORGANISATION stays, because a two-year-old movement record
     * needs to name where the material went (packet §7).
     */
    const anonymise = patch.active === false && existing.active;

    const columns: Record<string, string> = {
      name: 'name',
      kind: 'kind',
      linkedCompanyId: 'linked_company_id',
      address: 'address',
      contactName: 'contact_name',
      contactEmail: 'contact_email',
      contactPhone: 'contact_phone',
      licenceNumber: 'licence_number',
      licenceExpiresOn: 'licence_expires_on',
      notes: 'notes',
      active: 'active',
    };
    const params: unknown[] = [id, ctx.companyId];
    const sets: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (anonymise) {
      sets.push('contact_name = null', 'contact_email = null', 'contact_phone = null');
    }
    sets.push('updated_at = now()');

    const row = await queryOne(
      `update destination_organisations set ${sets.join(', ')}
        where id = $1 and company_id = $2 returning *`,
      params
    );
    if (!row) throw new AppError('NOT_FOUND', 'Destination organisation not found');

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'destination_org.updated',
      entityType: 'DESTINATION_ORGANISATION',
      entityId: id,
      changes: { fields: Object.keys(patch), contactAnonymised: anonymise },
      description: anonymise
        ? 'Destination organisation retired, contact details cleared'
        : 'Destination organisation updated',
    });
    res.json({ destinationOrganisation: toOrgView(row as never) });
  })
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A `linkedCompanyId` is a claim about a third party, so it is bounded to a
 * company this one already has an engagement edge with.
 *
 * §23's `provider_company_id` got the same bound in Phase 7 for the same reason: a
 * bare foreign key to `companies` means any real id passes, and "Redstone Reuse
 * take our donations" is then an assertion about a named business in a record that
 * business cannot see and cannot contest. A genuine off-platform charity is
 * unaffected — it has no `companies` row and is recorded by `name`, which is the
 * column that exists for exactly that case.
 */
async function assertLinkedCompany(companyId: string, linkedCompanyId: string | null): Promise<void> {
  if (linkedCompanyId === null) return;
  if (linkedCompanyId === companyId) return;
  const edge = await query<{ id: string }>(
    `select id from engagements
      where (client_company_id = $1 and provider_company_id = $2)
         or (client_company_id = $2 and provider_company_id = $1)
      limit 1`,
    [companyId, linkedCompanyId]
  );
  if (edge.length === 0) {
    throw new AppError(
      'VALIDATION',
      'You can only link an organisation to a company you already work with. Record it by name instead.'
    );
  }
}

function toOrgView(row: {
  id: string;
  company_id: string;
  linked_company_id: string | null;
  name: string;
  kind: string;
  address: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  licence_number: string | null;
  licence_expires_on: string | Date | null;
  notes: string | null;
  active: boolean;
}): DestinationOrgView {
  return {
    id: row.id,
    companyId: row.company_id,
    linkedCompanyId: row.linked_company_id,
    name: row.name,
    kind: row.kind,
    address: row.address,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    licenceNumber: row.licence_number,
    licenceExpiresOn:
      row.licence_expires_on instanceof Date
        ? row.licence_expires_on.toISOString().slice(0, 10)
        : row.licence_expires_on,
    notes: row.notes,
    active: row.active,
  };
}

/**
 * The subset §36 calls evidence: quantity, destination, mass and the paperwork.
 *
 * Not the notes and not the address — a revision row holding those would fire on a
 * typo fix and carry customer prose into a table read by a different authorization
 * path. These are what "why did this project's diversion rate change?" is answered
 * from.
 */
function movementFacts(view: MovementView): Record<string, unknown> {
  return {
    quantity: view.quantity,
    destinationCode: view.destinationCode,
    destinationOrgId: view.destinationOrgId,
    weightKg: view.weightKg,
    movedOn: view.movedOn,
    documentId: view.documentId,
  };
}

async function auditMovement(
  client: Parameters<typeof recordAudit>[1],
  ctx: { companyId: string; userId: string },
  access: AssetAccess,
  row: MovementRow,
  action:
    | 'asset.movement_recorded'
    | 'asset.movement_continued'
    | 'asset.movement_corrected'
    | 'asset.movement_removed'
): Promise<void> {
  await recordAudit(
    {
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action,
      entityType: 'ASSET_MOVEMENT',
      entityId: row.id,
      // The destination code and the quantity, never the notes or the address.
      changes: {
        destinationCode: row.destination_code,
        quantity: Number(row.quantity),
        isFinalOutcome: row.is_final_outcome,
        continuesMovementId: row.continues_movement_id,
      },
      description: `${row.quantity} → ${row.destination_name}`,
    },
    client
  );
}
