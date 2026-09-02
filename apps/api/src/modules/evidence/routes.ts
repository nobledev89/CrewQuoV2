import { Router } from 'express';
import {
  applyBatchDefaults,
  bulkUpdateEvidenceSchema,
  createEvidenceBatchSchema,
  detectConflict,
  disclosureNotice,
  evidenceBatchEventPayload,
  evidenceFilterSchema,
  publishEvidenceSchema,
  refuseAttachment,
  refuseFilter,
  resolveAssetLink,
  updateEvidenceSchema,
  type EvidenceBatchRejection,
  type EvidenceView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { query, queryOne, withTransaction } from '../../db';
import { assertCapability, hasCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { enqueueOutboxEvent } from '../delivery/repo';
import { recordAudit } from '../audit/record';
import {
  bulkUpdateEvidence,
  countEvidenceByCategory,
  findAttachCandidates,
  findEvidence,
  insertEvidence,
  listEvidence,
  setClientVisible,
  toEvidenceView,
  tombstoneEvidence,
  updateEvidence,
  type EvidenceRow,
  type EvidenceScope,
} from './repo';

/**
 * Project evidence (§22) — step 4 of the Phase 7 build order.
 *
 * **Four independent checks per operation**, and the packet's §4 is blunt that a
 * row filling only one column is a hole: the *feature* the plan sells, the
 * *capability* the person holds, the *company edge* between the two businesses,
 * and the *resource scope* that puts this person on this project. A capability
 * can only ever narrow what the edge already allowed — it never widens company
 * scope, which is the mistake §37 predicts a later route will make.
 *
 * **The feature is checked against the project owner, never against the
 * uploader** (owner decision, 2026-09-01). A Crew-plan subcontractor may always
 * photograph a floor on somebody else's project and consumes that owner's
 * entitlement doing it; its *own* projects need `project_evidence` on its own
 * plan. It is the settled commercial-agreements rule with the sides swapped:
 * proposing a rate is free because the Crew plan exists so a subcontractor can
 * work for nothing, and a subcontractor who cannot photograph the floor cannot do
 * the work either.
 */

interface ProjectAccess {
  projectId: string;
  ownerCompanyId: string;
  /** True when the caller's active company owns the project. */
  isOwner: boolean;
}

/**
 * The company edge and the resource scope, in one place and before anything else.
 *
 * A provider's link to a project is its **assignment**, not
 * `projects.engagement_id` — that column is the *client* relationship, and a
 * project carries several subcontractors, each on its own engagement. Reading the
 * client edge instead is the exact bug the storage service's acceptance script
 * caught on 2026-09-01, which refused every subcontractor upload with a 404.
 */
async function projectAccess(projectId: string, companyId: string): Promise<ProjectAccess> {
  const row = await queryOne<{ owner_company_id: string; assigned: boolean }>(
    `select p.owner_company_id,
            exists (
              select 1 from project_assignments a
               where a.project_id = p.id and a.provider_company_id = $2
            ) as assigned
       from projects p where p.id = $1`,
    [projectId, companyId]
  );
  // A project in another tenant answers exactly as one that never existed.
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
  const isOwner = row.owner_company_id === companyId;
  if (!isOwner && !row.assigned) throw new AppError('NOT_FOUND', 'Project not found');
  return { projectId, ownerCompanyId: row.owner_company_id, isOwner };
}

/** The plan gate, always asked of the owner. */
async function assertEvidenceFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'project_evidence'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: project_evidence'
        : 'This project’s owner does not have evidence enabled',
      { feature: 'project_evidence' }
    );
  }
}

/**
 * What this caller may be shown (§7: private to the uploading company and the
 * project owner).
 *
 * A second subcontractor on the same project sees none of the first one's
 * photographs, which is not a courtesy — two competing trades on one floor have
 * no relationship with each other, and the project owner's engagement with each
 * is separate from the other.
 */
function scopeFor(access: ProjectAccess, companyId: string): EvidenceScope {
  return access.isOwner ? { kind: 'OWNER' } : { kind: 'PROVIDER', companyId };
}

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectEvidenceRouter = Router();

projectEvidenceRouter.get(
  '/:projectId/evidence',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertEvidenceFeature(access);
    await assertCapability(ctx, 'project.read');

    /*
     * Query strings arrive as strings, and `category` arrives as one string or as
     * an array depending on how many were selected — the classic shape that works
     * in every manual test and breaks the first time somebody picks one filter.
     */
    const raw = req.query as Record<string, unknown>;
    const filter = evidenceFilterSchema.parse({
      category:
        raw.category === undefined
          ? undefined
          : Array.isArray(raw.category)
            ? raw.category
            : [raw.category],
      from: raw.from,
      to: raw.to,
      uploadedByUserId: raw.uploadedByUserId,
      locationId: raw.locationId,
      diaryEntryId: raw.diaryEntryId,
      assetId: raw.assetId,
      assetMovementId: raw.assetMovementId,
      clientVisible:
        raw.clientVisible === undefined ? undefined : raw.clientVisible === 'true',
      batchClientId: raw.batchClientId,
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
    });
    const refusal = refuseFilter(filter);
    if (refusal) throw new AppError('VALIDATION', refusal);

    const scope = scopeFor(access, ctx.companyId);
    const [rows, counts] = await Promise.all([
      listEvidence(access.projectId, scope, filter),
      // Over the whole scoped set rather than the filtered page, because a filter
      // bar showing "BEFORE (0)" for a category you have not selected is the one
      // number that has to remain true while you are choosing.
      countEvidenceByCategory(access.projectId, scope),
    ]);
    res.json({ evidence: rows.map(toEvidenceView), categoryCounts: counts });
  })
);

/**
 * POST /v1/projects/:projectId/evidence — the batch, which is the unit.
 *
 * **A partial batch never loses the files that worked** (§9). Ade is standing in
 * a stairwell; an "upload failed" that discards thirty-seven successful
 * photographs is a product that trains him to stop using it, and he is the person
 * this phase exists for. So the response is 201 with both a `created` list and a
 * `rejected` list, and only a request that is wrong *as a whole* — no project, no
 * permission, a malformed body — is refused outright.
 */
projectEvidenceRouter.post(
  '/:projectId/evidence',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertEvidenceFeature(access);
    await assertCapability(ctx, 'evidence.upload');

    const input = createEvidenceBatchSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.batchClientId,
        route: 'POST /v1/projects/:projectId/evidence',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        /*
         * Every file's eligibility resolved in one query rather than forty. The
         * lookup is scoped to the caller's own company, so a file id belonging to
         * anybody else is simply absent from the result and is reported as
         * unusable — never as forbidden, which would confirm it exists.
         */
        const fileIds = input.items.map((i) => i.fileId);
        const candidates = await findAttachCandidates({
          fileIds,
          uploaderCompanyId: ctx.companyId,
        });
        const byId = new Map(candidates.map((c) => [c.id, c]));

        /*
         * The batch defaults are applied once per item, here, and every check
         * below reads this array rather than recomputing them. `applyBatchDefaults`
         * is pure, so recomputing was only ever waste — but it was waste that grew
         * a pass per referenced table, and this step adds the fourth.
         */
        const metas = input.items.map((item) => applyBatchDefaults(input.defaults, item));
        const distinct = (pick: (m: (typeof metas)[number]) => string | null): string[] => [
          ...new Set(metas.map(pick).filter((id): id is string => id !== null)),
        ];

        /*
         * Four referenced tables, validated once for the batch rather than once
         * per photograph — a selection of forty usually shares one of each — and
         * each with its own scope rule:
         *
         *  · a **location** need only be on this project (0028's composite key
         *    already refuses a cross-project parent; this is that table's edge);
         *  · a **diary day** belongs to a project AND an authoring company, so an
         *    id that is merely a real uuid could otherwise file this company's
         *    photographs under a counterparty's written-up day;
         *  · an **asset line** is scoped to what this caller may read — the owner
         *    sees the project, a provider sees its own rows;
         *  · a **movement** inherits that scope from its line, and comes back as
         *    a map rather than a set because `resolveAssetLink` fills a missing
         *    line in from it. Forty photographs of one weighbridge visit should
         *    all be findable from the chairs, and none of them names the chairs.
         */
        const [validLocations, validDiaryEntries, validAssets, movementAssets] =
          await Promise.all([
            validLocationIds(access.projectId, distinct((m) => m.locationId)),
            validDiaryEntryIds(access.projectId, ctx.companyId, distinct((m) => m.diaryEntryId)),
            validAssetIds(access, ctx.companyId, distinct((m) => m.assetId)),
            movementAssetIds(access, ctx.companyId, distinct((m) => m.assetMovementId)),
          ]);

        const created: EvidenceView[] = [];
        const rejected: EvidenceBatchRejection[] = [];

        await withTransaction(async (client) => {
          for (const [index, item] of input.items.entries()) {
            const candidate = byId.get(item.fileId);
            if (!candidate) {
              rejected.push({
                fileId: item.fileId,
                code: 'FILE_NOT_USABLE',
                message: 'That upload is not available to this company',
              });
              continue;
            }
            const refusal = refuseAttachment({
              fileStatus: candidate.status,
              fileProjectId: candidate.project_id,
              projectId: access.projectId,
              alreadyAttached: candidate.attached,
            });
            if (refusal) {
              rejected.push({ fileId: item.fileId, code: refusal.code, message: refusal.message });
              continue;
            }

            const meta = metas[index]!;
            if (meta.locationId !== null && !validLocations.has(meta.locationId)) {
              rejected.push({
                fileId: item.fileId,
                code: 'FILE_NOT_USABLE',
                message: 'That location is not on this project',
              });
              continue;
            }
            if (meta.diaryEntryId !== null && !validDiaryEntries.has(meta.diaryEntryId)) {
              rejected.push({
                fileId: item.fileId,
                code: 'FILE_NOT_USABLE',
                message: 'That diary day is not one of this company’s on this project',
              });
              continue;
            }
            if (meta.assetId !== null && !validAssets.has(meta.assetId)) {
              rejected.push({
                fileId: item.fileId,
                code: 'FILE_NOT_USABLE',
                message: 'That asset line is not one you can record evidence against',
              });
              continue;
            }
            const link = resolveAssetLink({
              assetId: meta.assetId,
              assetMovementId: meta.assetMovementId,
              movementAssetId:
                meta.assetMovementId === null
                  ? null
                  : (movementAssets.get(meta.assetMovementId) ?? null),
            });
            if (!link.ok) {
              rejected.push({
                fileId: item.fileId,
                code: 'FILE_NOT_USABLE',
                message: link.message,
              });
              continue;
            }

            const row = await insertEvidence(
              {
                projectId: access.projectId,
                companyId: ctx.companyId,
                fileId: item.fileId,
                category: meta.category,
                caption: meta.caption,
                notes: meta.notes,
                evidenceDate: meta.evidenceDate,
                capturedAt: meta.capturedAt,
                locationId: meta.locationId,
                diaryEntryId: meta.diaryEntryId,
                assetId: link.assetId,
                assetMovementId: link.assetMovementId,
                sortOrder: meta.sortOrder,
                uploadedByUserId: ctx.userId,
                batchClientId: input.batchClientId ?? null,
              },
              client
            );
            if (!row) {
              // The unique index won a race with a concurrent retry. Not an error:
              // the record the caller asked for exists, which is what it wanted.
              rejected.push({
                fileId: item.fileId,
                code: 'FILE_ALREADY_ATTACHED',
                message: 'That upload is already on this project',
              });
              continue;
            }
            created.push(toEvidenceView(row));
          }

          if (created.length > 0) {
            /*
             * One audit row and one event for the whole batch. Forty photographs
             * is one act by one person; forty events would be forty
             * notifications, forty audit rows and a projection nobody can read.
             */
            await recordAudit(
              {
                companyId: ctx.companyId,
                actorUserId: ctx.userId,
                action: 'evidence.created',
                entityType: 'EVIDENCE',
                entityId: created[0]!.id,
                changes: {
                  count: created.length,
                  categories: [...new Set(created.map((e) => e.category))].sort(),
                  batchClientId: input.batchClientId ?? null,
                  evidenceIds: created.map((e) => e.id),
                },
                description: `${created.length} evidence ${created.length === 1 ? 'file' : 'files'} added`,
              },
              client
            );

            /*
             * The uploader is never their own recipient, so a project owner
             * photographing their own site enqueues nothing. Enqueued in the same
             * transaction as the rows (§36, decision #25), so an event never
             * describes a batch that rolled back.
             */
            if (!access.isOwner) {
              await enqueueOutboxEvent(
                {
                  topic: 'evidence.batch_uploaded',
                  aggregateType: 'PROJECT_EVIDENCE',
                  aggregateId: input.batchClientId ?? created[0]!.id,
                  companyId: access.ownerCompanyId,
                  payload: evidenceBatchEventPayload({
                    projectId: access.projectId,
                    ownerCompanyId: access.ownerCompanyId,
                    uploaderCompanyId: ctx.companyId,
                    actorUserId: ctx.userId,
                    batchClientId: input.batchClientId ?? null,
                    rows: created,
                  }),
                  idempotencyKey: `evidence.batch_uploaded:${input.batchClientId ?? created[0]!.id}`,
                },
                client
              );
            }
          }
        });

        return { created, rejected };
      }
    );
  })
);

/**
 * PATCH /v1/projects/:projectId/evidence — one edit across a selection.
 *
 * §22.3's batch metadata read backwards: re-tagging a filtered set in one pass,
 * which is the only way category and date corrections are survivable at forty
 * photographs a day.
 */
projectEvidenceRouter.patch(
  '/:projectId/evidence',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertEvidenceFeature(access);

    const input = bulkUpdateEvidenceSchema.parse(req.body);

    /*
     * The project owner may re-tag anything on their own project and needs
     * `evidence.manage` to do it; a provider may only touch its own rows, and the
     * statement is scoped rather than the ids pre-filtered — a forged id then
     * changes nothing instead of changing something.
     */
    if (access.isOwner) await assertCapability(ctx, 'evidence.manage');
    else await assertCapability(ctx, 'evidence.upload');

    if (input.patch.locationId != null) {
      const valid = await validLocationIds(access.projectId, [input.patch.locationId]);
      if (!valid.has(input.patch.locationId)) {
        throw new AppError('VALIDATION', 'That location is not on this project');
      }
    }
    if (input.patch.diaryEntryId != null) {
      const valid = await validDiaryEntryIds(access.projectId, ctx.companyId, [
        input.patch.diaryEntryId,
      ]);
      if (!valid.has(input.patch.diaryEntryId)) {
        throw new AppError('VALIDATION', 'That diary day is not one of yours on this project');
      }
    }
    /*
     * The asset link is resolved for the whole selection, which is the point of
     * doing it here: re-tagging thirty photographs onto one movement is one act,
     * and the derived line has to be written to all thirty or the asset's gallery
     * shows a different set from the movement's.
     */
    const patch = { ...input.patch };
    if (patch.assetId === null && !('assetMovementId' in patch)) {
      // Untagging the line takes the movement with it. A movement link is the
      // more specific half of one claim, and 0036 refuses it outright without a
      // line — so the alternative to clearing both is a 500 on a request whose
      // meaning ("this is not of that asset") is perfectly clear.
      patch.assetMovementId = null;
    }
    if (patch.assetId != null) {
      const valid = await validAssetIds(access, ctx.companyId, [patch.assetId]);
      if (!valid.has(patch.assetId)) {
        throw new AppError('VALIDATION', 'That asset line is not one you can tag evidence to');
      }
    }
    if (patch.assetMovementId != null) {
      const movements = await movementAssetIds(access, ctx.companyId, [patch.assetMovementId]);
      const link = resolveAssetLink({
        assetId: patch.assetId ?? null,
        assetMovementId: patch.assetMovementId,
        movementAssetId: movements.get(patch.assetMovementId) ?? null,
      });
      if (!link.ok) throw new AppError('VALIDATION', link.message);
      patch.assetId = link.assetId;
    }

    const updated = await bulkUpdateEvidence({
      projectId: access.projectId,
      ids: input.ids,
      patch,
      editableCompanyId: access.isOwner ? null : ctx.companyId,
    });

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'evidence.updated',
      entityType: 'EVIDENCE',
      entityId: updated[0]?.id ?? null,
      changes: { count: updated.length, patch, evidenceIds: updated.map((r) => r.id) },
      description: `${updated.length} evidence ${updated.length === 1 ? 'record' : 'records'} re-tagged`,
    });
    res.json({
      evidence: updated.map(toEvidenceView),
      // The count is the honest answer to a request that named ids the caller may
      // not edit: they were not changed, and saying "500 updated" would be false.
      requested: input.ids.length,
      updated: updated.length,
    });
  })
);

/**
 * POST /v1/projects/:projectId/evidence/publish — the disclosure lever.
 *
 * **The project owner's alone, and that is not an oversight.** `client_visible`
 * decides what a third company sees. A subcontractor able to set it could
 * disclose to the hiring company's client, on the hiring company's project, over
 * the hiring company's commercial relationship. The provider's lever is
 * uploading; the disclosure lever belongs to whoever owns the client relationship
 * — the same asymmetry §4 of the plan already draws around BILL rates.
 */
projectEvidenceRouter.post(
  '/:projectId/evidence/publish',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    if (!access.isOwner) {
      throw new AppError(
        'FORBIDDEN',
        'Only the company that owns this project can share evidence with its client'
      );
    }
    await assertEvidenceFeature(access);
    if (!(await hasFeature(access.ownerCompanyId, 'client_portal'))) {
      throw new AppError('FORBIDDEN', 'Your plan does not include: client_portal', {
        feature: 'client_portal',
      });
    }
    await assertCapability(ctx, 'evidence.publish');

    const input = publishEvidenceSchema.parse(req.body);
    const everPublished = await anyEverPublished(access.projectId, input.ids);

    const changed = await withTransaction(async (client) => {
      const rows = await setClientVisible(
        { projectId: access.projectId, ids: input.ids, clientVisible: input.clientVisible },
        client
      );
      if (rows.length === 0) return rows;

      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          // Both edges are recorded, and as distinct actions. "Who shared this
          // with the client, and when" and "who stopped sharing it" are different
          // questions, and one action with a boolean in its payload makes the
          // second unanswerable without reading every row's changes.
          action: input.clientVisible ? 'evidence.published' : 'evidence.unpublished',
          entityType: 'EVIDENCE',
          entityId: rows[0]!.id,
          changes: { count: rows.length, evidenceIds: rows.map((r) => r.id) },
          description: input.clientVisible
            ? `${rows.length} evidence ${rows.length === 1 ? 'file' : 'files'} shared with the client`
            : `${rows.length} evidence ${rows.length === 1 ? 'file' : 'files'} hidden from the client`,
        },
        client
      );

      // Only publishing notifies. Hiding is not news the client can act on, and
      // telling them something has been withdrawn draws attention to a file they
      // may never have opened.
      if (input.clientVisible) {
        const engagement = await queryOne<{ id: string; client_company_id: string }>(
          `select g.id, g.client_company_id
             from projects p join engagements g on g.id = p.engagement_id
            where p.id = $1`,
          [access.projectId],
          client
        );
        if (engagement) {
          await enqueueOutboxEvent(
            {
              topic: 'evidence.published',
              aggregateType: 'PROJECT_EVIDENCE',
              aggregateId: `${access.projectId}:${rows[0]!.id}`,
              companyId: engagement.client_company_id,
              payload: {
                projectId: access.projectId,
                ownerCompanyId: access.ownerCompanyId,
                clientCompanyId: engagement.client_company_id,
                engagementId: engagement.id,
                actorUserId: ctx.userId,
                count: rows.length,
              },
              idempotencyKey: `evidence.published:${access.projectId}:${rows.map((r) => r.id).sort().join(',')}`,
            },
            client
          );
        }
      }
      return rows;
    });

    res.json({
      evidence: changed.map(toEvidenceView),
      updated: changed.length,
      // The sentence the confirmation has to carry, composed server-side so every
      // client says the same true thing about what un-publishing does and does not
      // do.
      notice: disclosureNotice({
        count: changed.length,
        clientVisible: input.clientVisible,
        everPublished,
      }),
    });
  })
);

// ── Mounted under /v1/evidence ───────────────────────────────────────────────

export const evidenceRouter = Router();

/**
 * GET /v1/evidence/:id — the single record, and where a tombstone earns its keep.
 *
 * Three distinguishable answers: 200 at this revision, 410 it existed and is
 * gone, 404 no such thing *or* not yours. The last is deliberately still one
 * answer, because separating them would make this endpoint an oracle for ids in
 * other tenants — so authorization runs first, and only a caller who could have
 * read the live row is ever told about its tombstone.
 */
evidenceRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row, access } = await readableEvidence(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');
    void access;

    if (row.deleted_at !== null) {
      throw new AppError('GONE', 'This evidence was deleted.', {
        tombstone: {
          id: row.id,
          deletedAt: row.deleted_at.toISOString(),
          revision: row.revision,
        },
      });
    }
    res.json({ evidence: toEvidenceView(row) });
  })
);

evidenceRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableEvidence(id, ctx.companyId);
    await assertEditable(ctx, row, access);

    const patch = updateEvidenceSchema.parse(req.body);
    const { expectedRevision, ...fields } = patch;

    /*
     * The optimistic-concurrency check runs after authorization, so a conflict is
     * only ever reported to somebody entitled to see the record — and the 409
     * carries the current version back, so a client can show a real difference
     * rather than "try again".
     */
    const conflict = detectConflict({
      expected: expectedRevision,
      actual: row.revision,
      deletedAt: row.deleted_at?.toISOString() ?? null,
    });
    if (conflict) {
      // `detectConflict` also speaks `CLIENT_ID_REUSED`, which belongs to the
      // idempotency ledger and cannot arise from a revision check. Narrowed here
      // rather than widened in `conflictError`, so a future caller that really can
      // produce it has to decide what status it deserves instead of inheriting 409.
      throw conflictError(conflict.code === 'GONE' ? 'GONE' : 'STALE_REVISION', row);
    }

    if (fields.locationId != null) {
      const valid = await validLocationIds(row.project_id, [fields.locationId]);
      if (!valid.has(fields.locationId)) {
        throw new AppError('VALIDATION', 'That location is not on this project');
      }
    }
    if (fields.diaryEntryId != null) {
      // Scoped to the row's OWNING company rather than the caller's: the project
      // owner re-tagging a subcontractor's photograph may only file it under a day
      // that subcontractor wrote, never under one of their own.
      const valid = await validDiaryEntryIds(row.project_id, row.company_id, [
        fields.diaryEntryId,
      ]);
      if (!valid.has(fields.diaryEntryId)) {
        throw new AppError(
          'VALIDATION',
          'That diary day is not one written by the company that uploaded this'
        );
      }
    }
    /*
     * And here the two rules visibly part company. The diary check one block up
     * is scoped to `row.company_id` — the uploader — because a diary entry is that
     * company's own account of its day. The asset check is scoped to the
     * **caller**, because an asset line is a measurement of a shared physical
     * fact: 8.2 settled that the project owner may correct a subcontractor's line
     * and may not touch its diary entry, and tagging is the same question.
     */
    if (fields.assetId === null && !('assetMovementId' in fields)) {
      // Same rule as the bulk route, and 0036 is why it is a rule rather than a
      // courtesy: the movement link cannot outlive the line it is a leg of.
      fields.assetMovementId = null;
    }
    if (fields.assetId != null) {
      const valid = await validAssetIds(access, ctx.companyId, [fields.assetId]);
      if (!valid.has(fields.assetId)) {
        throw new AppError('VALIDATION', 'That asset line is not one you can tag evidence to');
      }
    }
    if (fields.assetMovementId != null) {
      const movements = await movementAssetIds(access, ctx.companyId, [fields.assetMovementId]);
      const link = resolveAssetLink({
        // The line already on the row counts as named: correcting only the
        // movement on a photograph that is already tagged to a line must not
        // silently move it to a different one.
        assetId: fields.assetId ?? row.asset_id,
        assetMovementId: fields.assetMovementId,
        movementAssetId: movements.get(fields.assetMovementId) ?? null,
      });
      if (!link.ok) throw new AppError('VALIDATION', link.message);
      fields.assetId = link.assetId;
    }

    const updated = await updateEvidence(id, fields, expectedRevision);
    if (!updated) {
      /*
       * The statement matched nothing, and only the row knows why. The check
       * above passed against a version read a moment ago; between then and the
       * write somebody else's commit can land, which is the race the locations
       * suite caught when the comparison lived only up there.
       */
      const now = await findEvidence(id);
      if (!now) throw new AppError('NOT_FOUND', 'Evidence not found');
      throw conflictError(now.deleted_at !== null ? 'GONE' : 'STALE_REVISION', now);
    }

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'evidence.updated',
      entityType: 'EVIDENCE',
      entityId: id,
      changes: Object.fromEntries(
        Object.keys(fields).map((key) => [
          key,
          {
            from: (toEvidenceView(row) as unknown as Record<string, unknown>)[key] ?? null,
            to: (toEvidenceView(updated) as unknown as Record<string, unknown>)[key] ?? null,
          },
        ])
      ),
      description: `Evidence updated: ${updated.category}`,
    });
    res.json({ evidence: toEvidenceView(updated) });
  })
);

evidenceRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableEvidence(id, ctx.companyId);
    await assertEditable(ctx, row, access);

    /*
     * A tombstone rather than a removed row (0029), and the stored file is
     * deliberately left alone. Detaching a photograph from a project is not the
     * same act as destroying it — the bytes stay under their retention rules and
     * the meter keeps counting them, which is the honest answer and also the one
     * that does not let a mis-click destroy evidence.
     */
    const deleted = await tombstoneEvidence(id);
    if (!deleted) throw new AppError('GONE', 'This evidence was already deleted.');

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'evidence.deleted',
      entityType: 'EVIDENCE',
      entityId: id,
      changes: {
        category: row.category,
        evidenceDate: row.evidence_date,
        // Recorded because deleting evidence a client has already been shown is
        // the case somebody will ask about later.
        wasClientVisible: row.client_visible,
      },
      description: `Evidence removed from the project`,
    });
    res.status(204).end();
  })
);

// ── Shared helpers ───────────────────────────────────────────────────────────

async function readableEvidence(
  id: string,
  companyId: string
): Promise<{ row: EvidenceRow; access: ProjectAccess }> {
  const row = await findEvidence(id);
  if (!row) throw new AppError('NOT_FOUND', 'Evidence not found');
  const access = await projectAccess(row.project_id, companyId);
  await assertEvidenceFeature(access);
  // §7's classification, enforced: private to the uploading company and to the
  // project owner. A second provider on the same project gets the 404 an outsider
  // would.
  if (!access.isOwner && row.company_id !== companyId) {
    throw new AppError('NOT_FOUND', 'Evidence not found');
  }
  return { row, access };
}

/**
 * May this caller change this record?
 *
 * Editing your own upload is part of uploading — a caption typed wrong is fixed
 * by the person who typed it. Editing somebody else's is `evidence.manage`, which
 * is a different job function and the reason §37's layer exists.
 */
async function assertEditable(
  ctx: Ctx & { companyId: string },
  row: EvidenceRow,
  access: ProjectAccess
): Promise<void> {
  const mine = row.company_id === ctx.companyId && row.uploaded_by_user_id === ctx.userId;
  if (mine && (await hasCapability(ctx, 'evidence.upload'))) return;
  await assertCapability(ctx, 'evidence.manage');
  if (!access.isOwner && row.company_id !== ctx.companyId) {
    throw new AppError('NOT_FOUND', 'Evidence not found');
  }
}

function conflictError(code: 'GONE' | 'STALE_REVISION', row: EvidenceRow): AppError {
  // 410 for a write against a tombstone and 409 for a stale one, because the
  // client's next move differs: a queued edit for a deleted record should be
  // abandoned, while a stale one should be re-composed against what came back.
  if (code === 'GONE') {
    return new AppError('GONE', 'This was deleted. Your change was not applied.', {
      reason: 'GONE',
      tombstone: {
        id: row.id,
        deletedAt: row.deleted_at?.toISOString() ?? null,
        revision: row.revision,
      },
    });
  }
  return new AppError('CONFLICT', 'Somebody else changed this while you were away.', {
    reason: 'STALE_REVISION',
    currentRevision: row.revision,
    current: toEvidenceView(row),
  });
}

/**
 * Which of these location ids are actually on this project and still live.
 *
 * The composite foreign key in 0028 already makes a *cross-project parent*
 * impossible, but nothing stops a caller tagging evidence with a location id from
 * another project — that is this table's edge, not that one's, and it is checked
 * here rather than trusted.
 */
async function validLocationIds(projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await query<{ id: string }>(
    `select id from project_locations
      where project_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [projectId, ids]
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * The diary days this company has written on this project (0032).
 *
 * **Scoped by company as well as project**, because §23's key is
 * `(project_id, company_id, entry_date)` and two companies keep two diaries for
 * one day. Without the second column a subcontractor could file its photographs
 * under the hiring company's written-up day — which is not a permission failure a
 * reader would ever notice, it is a photograph appearing in somebody else's
 * narrative record.
 */
async function validDiaryEntryIds(
  projectId: string,
  companyId: string,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await query<{ id: string }>(
    `select id from site_diary_entries
      where project_id = $1 and company_id = $2 and id = any($3::uuid[])`,
    [projectId, companyId, ids]
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * The asset lines this caller may tag a photograph against (0034, 0035).
 *
 * **Scoped to the caller, and deliberately not to the row's owning company —
 * which is the opposite of the rule one function up, and the difference is the
 * kind of claim each record makes.** A diary entry is *a statement by a person
 * about what they saw*, so filing a photograph under somebody else's written-up
 * day puts it inside their narrative. An asset line is *a measurement of a shared
 * physical fact* — the chairs are the chairs — which is exactly the reasoning 8.2
 * used to let a project owner correct a subcontractor's line while refusing them
 * its diary entry. So the owner curating the register may tag any photograph on
 * the project against any line on it, and a provider is held to its own rows,
 * which is `assets/repo.ts`'s `AssetScope` and §4's *"owner sees all; a provider
 * sees its own rows"* asked in the direction an attacker would use it.
 *
 * The scope is applied in the statement rather than by filtering ids afterwards,
 * so an id belonging to a rival subcontractor is simply absent from the result and
 * is reported as unusable — never as forbidden, which would confirm it exists.
 */
function assetScopeClause(
  access: ProjectAccess,
  companyId: string,
  params: unknown[],
  alias: string
): string {
  if (access.isOwner) return '';
  params.push(companyId);
  return ` and ${alias}.company_id = $${params.length}`;
}

async function validAssetIds(
  access: ProjectAccess,
  companyId: string,
  ids: string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const params: unknown[] = [access.projectId, ids];
  const scope = assetScopeClause(access, companyId, params, 'a');
  const rows = await query<{ id: string }>(
    `select a.id from project_assets a
      where a.project_id = $1 and a.id = any($2::uuid[]) and a.deleted_at is null${scope}`,
    params
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * The line each of these movements sits on, for the caller who may reach it.
 *
 * Returns a map rather than a set because `resolveAssetLink` needs the *answer*,
 * not merely permission: a movement named without a line fills its line in, and
 * the fill has to come from the same scoped read that decided the movement was
 * reachable at all. Reachability is inherited from the asset — a movement is not
 * separately owned — so the join carries the scope and the movement row carries
 * only its own tombstone.
 */
async function movementAssetIds(
  access: ProjectAccess,
  companyId: string,
  ids: string[]
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const params: unknown[] = [access.projectId, ids];
  const scope = assetScopeClause(access, companyId, params, 'a');
  const rows = await query<{ id: string; asset_id: string }>(
    `select m.id, m.asset_id from asset_movements m
       join project_assets a on a.id = m.asset_id
      where a.project_id = $1 and m.id = any($2::uuid[])
        and m.deleted_at is null and a.deleted_at is null${scope}`,
    params
  );
  return new Map(rows.map((r) => [r.id, r.asset_id]));
}

/** Has any of this selection ever been disclosed? Decides which sentence to show. */
async function anyEverPublished(projectId: string, ids: readonly string[]): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `select true as ok from project_evidence
      where project_id = $1 and id = any($2::uuid[]) and first_published_at is not null
      limit 1`,
    [projectId, ids]
  );
  return row !== null;
}
