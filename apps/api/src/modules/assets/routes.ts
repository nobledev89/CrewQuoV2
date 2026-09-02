import { Router } from 'express';
import {
  assetLinesRecordedEventPayload,
  createAssetSchema,
  deriveWeights,
  detectConflict,
  importAssetsSchema,
  outcomeStateSchema,
  resolveTypeCatalog,
  resolveWeightConfidence,
  updateAssetSchema,
  type CreateAsset,
  type WeightBasis,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { queryOne, withTransaction } from '../../db';
import { assertCapability, hasCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { enqueueOutboxEvent } from '../delivery/repo';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';
/*
 * Phase 9's finding 6, wired into Phase 8's writes.
 *
 * "Any write that changes what massBalance.ts would return must supersede the
 * calculations derived from it." A corrected weight or a tombstoned line that left
 * its carbon_calculations rows standing would make the mass balance and the carbon
 * roll-up — rendered side by side in the same §28 section — disagree about whether
 * the material exists, and every query would still return a plausible number.
 *
 * `recalculateAfterWrite` never throws into the caller: a misconfigured factor set
 * must not refuse the recording of something that happened on site.
 */
import { recalculateAfterWrite } from '../sustainability/engine';
import {
  findAsset,
  findAssetTypeByCode,
  findProjectDocument,
  findSerialOwner,
  findUsableAssetType,
  insertAsset,
  listAssetTypes,
  listAssets,
  toAssetView,
  tombstoneAsset,
  updateAsset,
  type AssetRow,
  type AssetScope,
  type AssetView,
} from './repo';

/**
 * Project asset lines (§25.2, §25.3) — step 2 of the Phase 8 build order in
 * `docs/operating-model/assets-materials.md` §14.
 *
 * The four checks are the four Phase 7 ran (packet §4), with two differences that
 * are worth naming because both look like mistakes until you read the reason.
 *
 * **The project owner may edit a subcontractor's asset line, and may not edit its
 * diary entry.** Phase 7 drew the opposite conclusion three months of code ago and
 * both are right. A diary entry is *a statement by a person about what they saw*;
 * editing it and leaving it attributed to them is the one thing an evidence trail
 * must never permit. An asset line is **a measurement of a shared physical fact** —
 * the chairs are the chairs, and the hiring company is the one that reports the
 * tonne and answers for it. The protection is attribution, not prohibition: every
 * edit writes a `record_revisions` row naming who changed what.
 *
 * **A failed weight-verification check saves the work.** It is the one place in the
 * phase where a failed authorization produces a *successful write of a lesser
 * claim* — see `applyWeight`.
 */

export interface ProjectAccess {
  projectId: string;
  ownerCompanyId: string;
  isOwner: boolean;
}

/*
 * Exported, and that is deliberate rather than convenient. `massBalance.ts` needs
 * the same company edge over the same key, and a second copy of the check that
 * decides whether two businesses may see each other's project is the one kind of
 * duplication worth a slightly odd import. `movementsRoutes.ts` keeps its own
 * `assetAccess` because it resolves a different key — an asset id, not a project.
 */
export async function projectAccess(projectId: string, companyId: string): Promise<ProjectAccess> {
  const row = await queryOne<{ owner_company_id: string; assigned: boolean }>(
    `select p.owner_company_id,
            exists (
              select 1 from project_assignments a
               where a.project_id = p.id and a.provider_company_id = $2
            ) as assigned
       from projects p where p.id = $1`,
    [projectId, companyId]
  );
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
  const isOwner = row.owner_company_id === companyId;
  if (!isOwner && !row.assigned) throw new AppError('NOT_FOUND', 'Project not found');
  return { projectId, ownerCompanyId: row.owner_company_id, isOwner };
}

/**
 * `asset_tracking`, asked of the **project owner** and never of the recorder.
 *
 * Precedent rather than a new decision (packet §13.3): the owner answered the
 * packaging rule on 2026-09-01 — *"capture is free, the record is the project
 * owner's entitlement"* — and `entitlements.ts` already carries it twice. A
 * subcontractor who cannot record what it removed cannot do a clearance job, and
 * the Crew plan exists so a subcontractor can work for a paying customer.
 *
 * The two messages differ because the two situations do: one is something the
 * reader can buy, the other is something they can only ask about.
 */
export async function assertAssetFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'asset_tracking'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: asset_tracking'
        : 'This project’s owner does not have asset tracking enabled',
      { feature: 'asset_tracking' }
    );
  }
}

function scopeFor(access: ProjectAccess, companyId: string): AssetScope {
  return access.isOwner ? { kind: 'OWNER' } : { kind: 'PROVIDER', companyId };
}

/**
 * Who may change this line: whoever recorded it, or the company that owns the
 * project. See the header for why the second half is here and is not in the diary.
 */
function assertWritable(row: AssetRow, access: ProjectAccess, companyId: string): void {
  if (access.isOwner) return;
  if (row.company_id !== companyId) {
    throw new AppError('FORBIDDEN', 'This asset line belongs to another company on this project');
  }
}

// ── Weight ───────────────────────────────────────────────────────────────────

interface ResolvedWeight {
  weightBasis: WeightBasis | null;
  unitWeightKg: number | null;
  totalWeightKg: number | null;
  weightSource: CreateAsset['weightSource'] | null;
  weightConfidence: CreateAsset['weightConfidence'] | null;
  weightDocumentId: string | null;
  weighedByUserId: string | null;
  /** Set when the requested confidence could not be honoured. Not an error. */
  notice: string | null;
}

/**
 * Turn what somebody typed into a weight with a provenance the record can defend.
 *
 * **It degrades rather than refusing, and that is deliberate.** A supervisor on a
 * phone in a stairwell who ticks "weighed and verified" without the ticket gets
 * their 16.5 kg *saved as an estimate*, with a sentence saying why. Refusing the
 * whole write would lose the measurement — the data the product exists to collect
 * — to protect a label, and it teaches people to hand the phone to whoever has the
 * bigger role, which is worse for the audit trail than the thing the check
 * protects. The capability failure and the missing-document failure take the same
 * path so the shape is identical whichever backing is absent.
 */
async function resolveWeight(
  ctx: Ctx & { companyId: string },
  projectId: string,
  input: {
    weightBasis?: WeightBasis | null;
    unitWeightKg?: number | null;
    totalWeightKg?: number | null;
    weightSource?: CreateAsset['weightSource'] | null;
    weightConfidence?: CreateAsset['weightConfidence'] | null;
    weightDocumentId?: string | null;
    weighedByUserId?: string | null;
    quantity: number;
  }
): Promise<ResolvedWeight> {
  const basis = input.weightBasis ?? null;
  const derived = deriveWeights({
    basis,
    quantity: input.quantity,
    unitWeightKg: input.unitWeightKg ?? null,
    totalWeightKg: input.totalWeightKg ?? null,
  });

  if (input.weightSource == null || derived === null) {
    // No source or no figure is a line with no weight, which §25.2 permits and
    // §28.3 counts against completeness — the correct incentive, and not an error.
    return {
      weightBasis: derived === null ? null : basis,
      unitWeightKg: derived?.unitWeightKg ?? null,
      totalWeightKg: derived?.totalWeightKg ?? null,
      weightSource: input.weightSource ?? null,
      weightConfidence: null,
      weightDocumentId: null,
      weighedByUserId: null,
      notice: null,
    };
  }

  const documentId = input.weightDocumentId ?? null;
  if (documentId !== null && !(await findProjectDocument(documentId, projectId))) {
    // Checked in the direction an attacker would use it: a document id that is
    // not on this project is not merely absent, it is somebody else's record
    // being probed through a field that expands in the response.
    throw new AppError('VALIDATION', 'That document is not on this project');
  }

  const resolved = resolveWeightConfidence({
    source: input.weightSource,
    requested: input.weightConfidence ?? undefined,
    hasDocument: documentId !== null,
    hasWeigher: (input.weighedByUserId ?? null) !== null,
    canVerify: await hasCapability(ctx, 'asset.weight.verify'),
  });

  return {
    weightBasis: basis,
    unitWeightKg: derived.unitWeightKg,
    totalWeightKg: derived.totalWeightKg,
    weightSource: input.weightSource,
    weightConfidence: resolved.confidence,
    weightDocumentId: documentId,
    weighedByUserId: input.weighedByUserId ?? null,
    notice: resolved.refusal?.message ?? null,
  };
}

/**
 * The §13.2 refusal, made useful.
 *
 * Company-wide uniqueness is the recommendation and the reason is that the
 * alternative permits the same machine to be recycled twice and reported as two
 * tonnes. What makes it liveable is that the refusal is a *route to the right
 * record* rather than a wall: it names the project the serial already sits on, so
 * the person can go and record the movement where it belongs.
 */
async function assertSerialFree(
  companyId: string,
  serialNumber: string | null | undefined,
  trackingMode: string,
  selfId?: string
): Promise<void> {
  if (trackingMode !== 'ITEM' || !serialNumber) return;
  const owner = await findSerialOwner(companyId, serialNumber);
  if (!owner || owner.id === selfId) return;
  throw new AppError(
    'CONFLICT',
    `Serial ${serialNumber} is already recorded on ${owner.project_name}. Record a movement there rather than a new line here.`,
    { reason: 'SERIAL_IN_USE', projectId: owner.project_id, assetId: owner.id }
  );
}

/**
 * An import row's asset type, from a uuid or from the text somebody pasted.
 *
 * The refusal names **the text that failed**, which is the whole difference
 * between an error a person can act on and one they have to guess at: "row 34:
 * no asset type called ‘Chiar’" tells them where to look on their own
 * spreadsheet, and "row 34: not found" does not.
 */
async function resolveImportType(
  raw: { assetTypeId?: string; assetTypeCode?: string },
  companyId: string
): Promise<string> {
  if (raw.assetTypeId !== undefined) {
    await assertUsableType(raw.assetTypeId, companyId);
    return raw.assetTypeId;
  }
  const code = raw.assetTypeCode ?? '';
  const found = await findAssetTypeByCode(code, companyId);
  if (!found) throw new AppError('VALIDATION', `No asset type called “${code}”`);
  return found.id;
}

async function assertUsableType(assetTypeId: string, companyId: string): Promise<void> {
  if (!(await findUsableAssetType(assetTypeId, companyId))) {
    // Not found rather than forbidden: another company's asset type id is not
    // something a caller gets to learn the existence of.
    throw new AppError('NOT_FOUND', 'Asset type not found');
  }
}

async function assertLocation(projectId: string, locationId: string): Promise<void> {
  const row = await queryOne<{ id: string }>(
    `select id from project_locations
      where id = $1 and project_id = $2 and deleted_at is null`,
    [locationId, projectId]
  );
  if (!row) throw new AppError('VALIDATION', 'That location is not on this project');
}

// ── The catalog, mounted under /v1 ────────────────────────────────

export const assetTypesRouter = Router();

/**
 * GET /v1/asset-types — the twenty-two, plus whatever this company has added.
 *
 * `project.read` rather than `asset.write`, and the same gate `GET
 * /v1/destination-types` uses: the catalog is reference data a reader needs to
 * render *"42 × Operator chair"* at all, and gating it behind the write
 * capability would leave a Supervisor looking at a register of uuids.
 *
 * **No entitlement check, and that is deliberate.** `asset_tracking` is asked of
 * a *project*’s owner (`assertAssetFeature`), and this route has no project —
 * there is no company here to ask it of. What it returns is a fixed list of
 * furniture names, which is not what the feature key protects.
 *
 * `defaultUnitWeightKg` travels null on all 22 seeded rows and the picker must
 * render that as an empty field rather than a zero: §41.1, and §25.1’s reason
 * for it — *"a shipped default weight is an invented number that silently becomes
 * a reported tonne."*
 */
assetTypesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCapability(ctx, 'project.read');
    const rows = await listAssetTypes(ctx.companyId);
    const resolved = resolveTypeCatalog(
      rows.map((r) => ({ ...r, companyId: r.company_id, code: r.code }))
    );
    res.json({
      assetTypes: resolved
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
        .map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          category: r.category,
          isSystem: r.company_id === null,
          defaultUnitWeightKg:
            r.default_unit_weight_kg === null ? null : Number(r.default_unit_weight_kg),
          sortOrder: r.sort_order,
        })),
    });
  })
);

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectAssetsRouter = Router();

projectAssetsRouter.get(
  '/:projectId/assets',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertAssetFeature(access);
    await assertCapability(ctx, 'project.read');

    const raw = req.query as Record<string, unknown>;
    const outcomeState =
      raw.outcomeState === undefined
        ? undefined
        : (Array.isArray(raw.outcomeState) ? raw.outcomeState : [raw.outcomeState]).map((v) =>
            outcomeStateSchema.parse(v)
          );

    const rows = await listAssets(access.projectId, scopeFor(access, ctx.companyId), {
      outcomeState,
      assetTypeId: typeof raw.assetTypeId === 'string' ? raw.assetTypeId : undefined,
      locationId: typeof raw.locationId === 'string' ? raw.locationId : undefined,
      missingWeight: raw.missingWeight === 'true' ? true : undefined,
      batchClientId: typeof raw.batchClientId === 'string' ? raw.batchClientId : undefined,
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
    });
    res.json({ assets: rows.map(toAssetView) });
  })
);

projectAssetsRouter.post(
  '/:projectId/assets',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertAssetFeature(access);
    await assertCapability(ctx, 'asset.write');

    const input = createAssetSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/assets',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        await assertUsableType(input.assetTypeId, ctx.companyId);
        if (input.originLocationId != null) {
          await assertLocation(access.projectId, input.originLocationId);
        }
        await assertSerialFree(ctx.companyId, input.serialNumber, input.trackingMode);
        const weight = await resolveWeight(ctx, access.projectId, {
          ...input,
          quantity: input.quantity,
        });

        const view = await withTransaction(async (client) => {
          const row = await insertAsset(
            {
              projectId: access.projectId,
              companyId: ctx.companyId,
              assetTypeId: input.assetTypeId,
              trackingMode: input.trackingMode,
              description: input.description ?? null,
              quantity: input.quantity,
              weightBasis: weight.weightBasis,
              unitWeightKg: weight.unitWeightKg,
              totalWeightKg: weight.totalWeightKg,
              weightSource: weight.weightSource ?? null,
              weightConfidence: weight.weightConfidence ?? null,
              weightDocumentId: weight.weightDocumentId,
              weighedByUserId: weight.weighedByUserId,
              manufacturer: input.manufacturer ?? null,
              model: input.model ?? null,
              serialNumber: input.serialNumber ?? null,
              assetTag: input.assetTag ?? null,
              condition: input.condition ?? null,
              originLocationId: input.originLocationId ?? null,
              notes: input.notes ?? null,
              createdByUserId: ctx.userId,
              batchClientId: input.clientId ?? null,
            },
            client
          );
          if (!row) throw new AppError('CONFLICT', 'That asset line could not be recorded.');
          const created = toAssetView(row);

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'asset.created',
              entityType: 'PROJECT_ASSET',
              entityId: row.id,
              // The type code and the quantity, never the description: a trail
              // read six months later needs to know what was recorded, and the
              // description is customer prose.
              changes: {
                assetTypeCode: created.assetTypeCode,
                quantity: created.quantity,
                totalWeightKg: created.totalWeightKg,
                weightConfidence: created.weightConfidence,
              },
              description: `Asset line recorded: ${created.quantity} × ${created.assetTypeName}`,
            },
            client
          );

          /*
           * §36 makes a weight one of the records where the numbers themselves are
           * the evidence, so the trail starts at the CREATE rather than at the
           * first correction. Without this row, "it was always 16.5" and "somebody
           * typed 16.5 on Tuesday" are indistinguishable a year later.
           */
          await recordRevision(
            {
              companyId: ctx.companyId,
              entityType: 'PROJECT_ASSET',
              entityId: row.id,
              action: 'CREATE',
              before: null,
              after: weightFacts(created),
              changedByUserId: ctx.userId,
            },
            client
          );

          await enqueueOutboxEvent(
            {
              topic: 'asset.lines_recorded',
              aggregateType: 'PROJECT_ASSET',
              aggregateId: row.id,
              companyId: access.ownerCompanyId,
              payload: assetLinesRecordedEventPayload({
                projectId: access.projectId,
                ownerCompanyId: access.ownerCompanyId,
                recordingCompanyId: ctx.companyId,
                actorUserId: ctx.userId,
                batchClientId: input.clientId ?? null,
                rows: [created],
              }),
              idempotencyKey: `asset.lines_recorded:${row.id}`,
            },
            client
          );
          return created;
        });

        await recalculateAfterWrite({
          projectId: access.projectId,
          trigger: 'WEIGHT_CORRECTED',
          triggeringId: view.id,
          actorUserId: ctx.userId,
        });

        return weight.notice ? { asset: view, notice: weight.notice } : { asset: view };
      }
    );
  })
);

/**
 * POST /v1/projects/:projectId/assets/import — a pasted schedule.
 *
 * **Partial success is the design, not a compromise** (packet §8). Sixty rows
 * where four name an unknown asset type import fifty-six and return four errors by
 * row number *and by the text that failed*. Rolling back all sixty means a person
 * retypes fifty-nine rows identically, and they will get one of them wrong.
 *
 * One `clientId` covers the whole paste, so re-pasting after fixing row 34
 * re-imports nothing that already landed. One event, not sixty — sixty Action
 * Centre items is an inbox that teaches people to clear it without reading.
 */
projectAssetsRouter.post(
  '/:projectId/assets/import',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertAssetFeature(access);
    await assertCapability(ctx, 'asset.write');

    const input = importAssetsSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/assets/import',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        const imported: AssetView[] = [];
        const errors: { row: number; message: string; value?: string }[] = [];

        for (const [index, raw] of input.rows.entries()) {
          const rowNumber = index + 1;
          try {
            const assetTypeId = await resolveImportType(raw, ctx.companyId);
            if (raw.originLocationId != null) {
              await assertLocation(access.projectId, raw.originLocationId);
            }
            await assertSerialFree(ctx.companyId, raw.serialNumber, raw.trackingMode);
            const weight = await resolveWeight(ctx, access.projectId, {
              ...raw,
              quantity: raw.quantity,
            });

            const row = await insertAsset({
              projectId: access.projectId,
              companyId: ctx.companyId,
              assetTypeId,
              trackingMode: raw.trackingMode,
              description: raw.description ?? null,
              quantity: raw.quantity,
              weightBasis: weight.weightBasis,
              unitWeightKg: weight.unitWeightKg,
              totalWeightKg: weight.totalWeightKg,
              weightSource: weight.weightSource ?? null,
              weightConfidence: weight.weightConfidence ?? null,
              weightDocumentId: weight.weightDocumentId,
              weighedByUserId: weight.weighedByUserId,
              manufacturer: raw.manufacturer ?? null,
              model: raw.model ?? null,
              serialNumber: raw.serialNumber ?? null,
              assetTag: raw.assetTag ?? null,
              condition: raw.condition ?? null,
              originLocationId: raw.originLocationId ?? null,
              notes: raw.notes ?? null,
              createdByUserId: ctx.userId,
              batchClientId: input.clientId ?? null,
            });
            if (!row) throw new AppError('CONFLICT', 'This line could not be recorded.');
            imported.push(toAssetView(row));
          } catch (err) {
            /*
             * A row's failure is data about that row, not an outcome for the
             * paste. `AppError` messages are written for a person; anything else
             * is reported by shape rather than by its own text, because an
             * unexpected error's message is exactly the kind that quotes input
             * back (`scrub.ts` makes the same argument for Sentry).
             */
            errors.push({
              row: rowNumber,
              message:
                err instanceof AppError ? err.message : 'This line could not be recorded.',
              // The text that failed, so the person can find it on their own
              // paste. The type code first — an unrecognised type is the
              // commonest import failure by a wide margin.
              ...(raw.assetTypeCode
                ? { value: raw.assetTypeCode }
                : raw.serialNumber
                  ? { value: raw.serialNumber }
                  : {}),
            });
          }
        }

        if (imported.length > 0) {
          await withTransaction(async (client) => {
            await recordAudit(
              {
                companyId: ctx.companyId,
                actorUserId: ctx.userId,
                action: 'asset.imported',
                entityType: 'PROJECT',
                entityId: access.projectId,
                changes: { imported: imported.length, refused: errors.length },
                description: `${imported.length} asset lines imported`,
              },
              client
            );
            await enqueueOutboxEvent(
              {
                topic: 'asset.lines_recorded',
                aggregateType: 'PROJECT',
                aggregateId: access.projectId,
                companyId: access.ownerCompanyId,
                payload: assetLinesRecordedEventPayload({
                  projectId: access.projectId,
                  ownerCompanyId: access.ownerCompanyId,
                  recordingCompanyId: ctx.companyId,
                  actorUserId: ctx.userId,
                  batchClientId: input.clientId ?? null,
                  rows: imported,
                }),
                // Keyed on the batch, not the project: a second paste on the same
                // project is a second event, and a replay of this one is not.
                idempotencyKey: `asset.lines_recorded:batch:${
                  input.clientId ?? `${access.projectId}:${Date.now()}`
                }`,
              },
              client
            );
          });
        }

        if (imported.length > 0) {
          await recalculateAfterWrite({
            projectId: access.projectId,
            trigger: 'WEIGHT_CORRECTED',
            triggeringId: input.clientId ?? null,
            actorUserId: ctx.userId,
          });
        }

        return { imported: imported.length, assets: imported, errors };
      }
    );
  })
);

// ── Mounted under /v1/assets ─────────────────────────────────────────────────

export const assetsRouter = Router();

assetsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row } = await readableAsset(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    if (row.deleted_at !== null) {
      // A tombstone, not a 404: on an intermittent connection "gone" and "not
      // allowed" are two answers a 404 cannot tell apart, and a timeout looks
      // like both (0029).
      throw new AppError('GONE', 'This asset line was removed.', {
        tombstone: { id: row.id, deletedAt: row.deleted_at.toISOString(), revision: row.revision },
      });
    }
    res.json({ asset: toAssetView(row) });
  })
);

assetsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableAsset(id, ctx.companyId);
    assertWritable(row, access, ctx.companyId);
    await assertCapability(ctx, 'asset.write');

    const { expectedRevision, ...fields } = updateAssetSchema.parse(req.body);

    const conflict = detectConflict({
      expected: expectedRevision,
      actual: row.revision,
      deletedAt: row.deleted_at?.toISOString() ?? null,
    });
    if (conflict) throw conflictError(conflict.code === 'GONE' ? 'GONE' : 'STALE_REVISION', row);

    const before = toAssetView(row);

    if (fields.assetTypeId != null) await assertUsableType(fields.assetTypeId, ctx.companyId);
    if (fields.originLocationId != null) {
      await assertLocation(row.project_id, fields.originLocationId);
    }
    const trackingMode = fields.trackingMode ?? row.tracking_mode;
    if ('serialNumber' in fields || 'trackingMode' in fields) {
      await assertSerialFree(
        row.company_id,
        'serialNumber' in fields ? fields.serialNumber : row.serial_number,
        trackingMode,
        row.id
      );
    }

    /*
     * THE WHOLE LINE IS ONE CLAIM, so the weight is always re-resolved rather than
     * patched field by field. §25.2 derives one of quantity/unit/total from the
     * others, so a "merge" of somebody's new quantity with the stored total
     * produces a unit weight neither of them typed — and editing quantity must
     * recompute the derived side and never the entered one.
     */
    const quantity = fields.quantity ?? before.quantity;
    const weight = await resolveWeight(ctx, row.project_id, {
      quantity,
      weightBasis: 'weightBasis' in fields ? fields.weightBasis : before.weightBasis,
      unitWeightKg: 'unitWeightKg' in fields ? fields.unitWeightKg : before.unitWeightKg,
      totalWeightKg: 'totalWeightKg' in fields ? fields.totalWeightKg : before.totalWeightKg,
      weightSource: 'weightSource' in fields ? fields.weightSource : before.weightSource,
      weightConfidence:
        'weightConfidence' in fields ? fields.weightConfidence : before.weightConfidence,
      weightDocumentId:
        'weightDocumentId' in fields ? fields.weightDocumentId : before.weightDocumentId,
      weighedByUserId:
        'weighedByUserId' in fields ? fields.weighedByUserId : before.weighedByUserId,
    });

    const updated = await updateAsset(
      id,
      {
        ...fields,
        quantity,
        weightBasis: weight.weightBasis,
        unitWeightKg: weight.unitWeightKg,
        totalWeightKg: weight.totalWeightKg,
        weightSource: weight.weightSource ?? null,
        weightConfidence: weight.weightConfidence ?? null,
        weightDocumentId: weight.weightDocumentId,
        weighedByUserId: weight.weighedByUserId,
      },
      expectedRevision,
      ctx.userId
    );
    if (!updated) {
      const now = await findAsset(id);
      if (!now) throw new AppError('NOT_FOUND', 'Asset not found');
      throw conflictError(now.deleted_at !== null ? 'GONE' : 'STALE_REVISION', now);
    }

    const after = toAssetView(updated);

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'asset.updated',
      entityType: 'PROJECT_ASSET',
      entityId: id,
      changes: { quantity: after.quantity, totalWeightKg: after.totalWeightKg },
      description: `Asset line updated: ${after.quantity} × ${after.assetTypeName}`,
    });

    /*
     * §25.3: *"Every change to a weight writes a `record_revisions` row."*
     * Written against the RECORDING company, not the editing one — `record.ts`'s
     * rule is "whose record changed", and a sustainability lead correcting a
     * subcontractor's estimate changes the subcontractor's row. Recording the
     * actor's company would make the hiring company's trail claim it authored the
     * line.
     */
    const weightBefore = weightFacts(before);
    const weightAfter = weightFacts(after);
    if (JSON.stringify(weightBefore) !== JSON.stringify(weightAfter)) {
      await recordRevision({
        companyId: row.company_id,
        entityType: 'PROJECT_ASSET',
        entityId: id,
        action: 'UPDATE',
        before: weightBefore,
        after: weightAfter,
        changedByUserId: ctx.userId,
      });
    }

    await recalculateAfterWrite({
      projectId: access.projectId,
      trigger: 'WEIGHT_CORRECTED',
      triggeringId: id,
      actorUserId: ctx.userId,
    });

    res.json(weight.notice ? { asset: after, notice: weight.notice } : { asset: after });
  })
);

assetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableAsset(id, ctx.companyId);
    assertWritable(row, access, ctx.companyId);
    await assertCapability(ctx, 'asset.write');

    /*
     * A tombstone, never a hard delete. `observability-data-lifecycle.md` §13
     * settled the load-bearing version for a time log and an asset line is the
     * same shape and slightly worse: it is the hiring company's proof of a
     * DIVERTED TONNE, which may already have been reported to that company's own
     * client under a framework with a retention period attached.
     */
    const deleted = await tombstoneAsset(id);
    if (!deleted) throw new AppError('GONE', 'This asset line was already removed.');

    const before = toAssetView(row);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'asset.deleted',
      entityType: 'PROJECT_ASSET',
      entityId: id,
      changes: {
        assetTypeCode: before.assetTypeCode,
        quantity: before.quantity,
        totalWeightKg: before.totalWeightKg,
        outcomeState: before.outcomeState,
      },
      description: `Asset line removed: ${before.quantity} × ${before.assetTypeName}`,
    });
    await recordRevision({
      companyId: row.company_id,
      entityType: 'PROJECT_ASSET',
      entityId: id,
      action: 'DELETE',
      before: weightFacts(before),
      after: null,
      changedByUserId: ctx.userId,
    });

    /*
     * The line half of finding 6. A tombstoned line stops counting in the mass
     * balance the moment it is written; without this its emissions and its avoided
     * claim would still be standing, still current, still summed.
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

// ── Shared helpers ───────────────────────────────────────────────────────────

async function readableAsset(
  id: string,
  companyId: string
): Promise<{ row: AssetRow; access: ProjectAccess }> {
  const row = await findAsset(id);
  if (!row) throw new AppError('NOT_FOUND', 'Asset not found');
  const access = await projectAccess(row.project_id, companyId);
  await assertAssetFeature(access);
  if (!access.isOwner && row.company_id !== companyId) {
    // A counterparty's asset line answers as not found rather than as forbidden.
    throw new AppError('NOT_FOUND', 'Asset not found');
  }
  return { row, access };
}

/**
 * The subset of a line that §36 calls evidence: the numbers themselves.
 *
 * A revision row holding the whole view would carry the description and the serial
 * number into a table read by a different authorization path, and would fire on a
 * typo fix. These seven fields are what "why did this project's tonnage change?"
 * is answered from.
 */
function weightFacts(view: AssetView): Record<string, unknown> {
  return {
    quantity: view.quantity,
    weightBasis: view.weightBasis,
    unitWeightKg: view.unitWeightKg,
    totalWeightKg: view.totalWeightKg,
    weightSource: view.weightSource,
    weightConfidence: view.weightConfidence,
    weightDocumentId: view.weightDocumentId,
  };
}

function conflictError(code: 'GONE' | 'STALE_REVISION', row: AssetRow): AppError {
  const view = toAssetView(row);
  if (code === 'GONE') {
    return new AppError('GONE', 'This asset line was removed. Your change was not applied.', {
      tombstone: { id: view.id, deletedAt: view.deletedAt, revision: view.revision },
    });
  }
  // The current row rides along, so a client can show both sides rather than
  // asking the user to reload and find out what changed (packet §8).
  return new AppError(
    'CONFLICT',
    'This asset line changed since you loaded it. Your change was not applied.',
    { reason: 'STALE_REVISION', current: view }
  );
}
