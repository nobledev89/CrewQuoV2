import { Router } from 'express';
import {
  buildLocationTree,
  createLocationSchema,
  describeReferences,
  detectConflict,
  updateLocationSchema,
  validateParent,
  type LocationLike,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { queryOne } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { recordAudit } from '../audit/record';
import {
  countLocationReferences,
  findLocation,
  insertLocation,
  listLocations,
  tombstoneLocation,
  updateLocation,
} from './repo';

/**
 * Project locations (§21) — the tree, and the four rules that keep it a tree.
 *
 * **No feature entitlement, and that is a deliberate departure from this
 * domain's own packet §4**, which pencilled in `project_evidence`. A location is
 * structure, not content: it is consumed by evidence, documents, the diary,
 * assets and the schedule, each of which carries its own gate. Gating the
 * structure as well would mean a company whose plan includes *scheduling* but not
 * *evidence* cannot lay out the floors its schedule refers to — one feature key
 * deciding another feature's usability. The packet has been corrected rather than
 * the code bent to it.
 */

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectLocationsRouter = Router();

/**
 * The project this request is about, and whether the caller may see it.
 *
 * Reading is open to both hops — a subcontractor tagging a photo to Floor 3 has
 * to be able to see that Floor 3 exists — while writing is the project owner's
 * alone. Two different questions, so two functions rather than one with a flag.
 */
async function readableProject(projectId: string, companyId: string): Promise<{ ownerCompanyId: string }> {
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
  if (row.owner_company_id !== companyId && !row.assigned) {
    throw new AppError('NOT_FOUND', 'Project not found');
  }
  return { ownerCompanyId: row.owner_company_id };
}

async function writableProject(projectId: string, companyId: string): Promise<void> {
  const { ownerCompanyId } = await readableProject(projectId, companyId);
  if (ownerCompanyId !== companyId) {
    // The provider can see the tree and cannot shape it. The site belongs to
    // whoever owns the job, and a subcontractor renaming a client's floors is a
    // change the client would discover from their own evidence.
    throw new AppError('FORBIDDEN', 'Only the company that owns this project can change its locations');
  }
}

projectLocationsRouter.get(
  '/:projectId/locations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projectId = uuidParam(req, 'projectId');
    await readableProject(projectId, ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const all = await listLocations(projectId);
    // Both shapes in one response. The tree is what a picker renders; the flat
    // list is what a filter and an export column need, and deriving one from the
    // other on the client is two implementations of the same ordering.
    res.json({ tree: buildLocationTree(all), locations: all });
  })
);

projectLocationsRouter.post(
  '/:projectId/locations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projectId = uuidParam(req, 'projectId');
    await writableProject(projectId, ctx.companyId);
    await assertCapability(ctx, 'project.manage');

    const input = createLocationSchema.parse(req.body);

    /*
     * The idempotency wrapper (item 7.7). A tablet that lost signal mid-request
     * and retried must not create a second Floor 3 — and, more importantly, must
     * be handed the answer it missed rather than a refusal, or it has no way to
     * learn the id of the thing it just made.
     */
    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/locations',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        const all = await listLocations(projectId);
        const refusal = validateParent({
          all: all as LocationLike[],
          id: null,
          parentId: input.parentId,
        });
        if (refusal) throw new AppError('VALIDATION', refusal.message, { reason: refusal.code });

        const created = await insertLocation(projectId, input);
        await recordAudit({
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'location.created',
          entityType: 'LOCATION',
          entityId: created.id,
          changes: { name: created.name, kind: created.kind, parentId: created.parentId },
          description: `Location added: ${created.name}`,
        });
        return { location: created };
      }
    );
  })
);

// ── Mounted under /v1/locations ──────────────────────────────────────────────

export const locationsRouter = Router();

locationsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const existing = await findLocation(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Location not found');
    await writableProject(existing.projectId, ctx.companyId);
    await assertCapability(ctx, 'project.manage');

    const patch = updateLocationSchema.parse(req.body);

    /*
     * The optimistic-concurrency check (item 7.7). It runs *after* authorization
     * and before anything else, so a conflict is only ever reported to somebody
     * who was entitled to see the record — and the 409 carries the current
     * version, so the client can show a real difference instead of "try again".
     *
     * A caller that sends no `expectedRevision` is not making a claim about what
     * it read, and last-write-wins applies. That is the browser-form case, where
     * the person is looking at the thing they are changing.
     */
    const conflict = detectConflict({
      expected: patch.expectedRevision,
      actual: existing.revision,
      deletedAt: existing.deletedAt,
    });
    if (conflict) {
      // 410 for a write against a tombstone and 409 for a stale one, because the
      // client's next move differs: a queued edit for a deleted record should be
      // abandoned, while a stale one should be re-composed against what came back.
      if (conflict.code === 'GONE') {
        throw new AppError('GONE', conflict.message, {
          reason: conflict.code,
          tombstone: { id: existing.id, deletedAt: existing.deletedAt, revision: existing.revision },
        });
      }
      throw new AppError('CONFLICT', conflict.message, {
        reason: conflict.code,
        currentRevision: existing.revision,
        current: existing,
      });
    }

    if ('parentId' in patch) {
      const all = await listLocations(existing.projectId);
      /*
       * The check is against the height of the whole subtree, not the position of
       * the node being moved. §21 caps depth at 4 and forbids a descendant as a
       * parent — and neither catches the case that actually breaks the cap:
       * moving a floor *with rooms in it* under a deeper parent, where the floor
       * lands at 3 and its rooms at 5.
       */
      const refusal = validateParent({
        all: all as LocationLike[],
        id,
        parentId: patch.parentId ?? null,
      });
      if (refusal) throw new AppError('VALIDATION', refusal.message, { reason: refusal.code });
    }

    const updated = await updateLocation(id, patch);
    if (!updated) {
      /*
       * The statement matched nothing, and only the row knows why. The check
       * above passed against the version read a moment ago; between then and the
       * write, somebody else's commit can land — which is precisely the race the
       * live suite caught when the comparison lived only up there. Re-read and
       * report the same three answers, so a loser is told rather than silently
       * overwritten.
       */
      const now = await findLocation(id);
      if (!now) throw new AppError('NOT_FOUND', 'Location not found');
      if (now.deletedAt !== null) {
        throw new AppError('GONE', 'This was deleted. Your change was not applied.', {
          reason: 'GONE',
          tombstone: { id: now.id, deletedAt: now.deletedAt, revision: now.revision },
        });
      }
      throw new AppError('CONFLICT', 'Somebody else changed this while you were away.', {
        reason: 'STALE_REVISION',
        currentRevision: now.revision,
        current: now,
      });
    }

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'location.updated',
      entityType: 'LOCATION',
      entityId: id,
      // Both sides of every field that moved, so the trail answers "what did it
      // used to be" without a second lookup.
      changes: Object.fromEntries(
        Object.keys(patch).map((key) => [
          key,
          {
            from: (existing as unknown as Record<string, unknown>)[key] ?? null,
            to: (updated as unknown as Record<string, unknown>)[key] ?? null,
          },
        ])
      ),
      description:
        patch.active === false
          ? `Location retired: ${updated.name}`
          : `Location updated: ${updated.name}`,
    });
    res.json({ location: updated });
  })
);

/**
 * Delete, which §21 mostly refuses.
 *
 * Retirement is the path for a location that has been used, and the refusal has
 * to say **what** is using it and offer that path — a bare "cannot delete" sends
 * somebody hunting through a project for the thing they cannot see.
 */
locationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const existing = await findLocation(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Location not found');
    await writableProject(existing.projectId, ctx.companyId);
    await assertCapability(ctx, 'project.manage');

    const references = await countLocationReferences(id);
    const explanation = describeReferences(references);
    if (explanation) {
      throw new AppError('CONFLICT', explanation, {
        references: references.filter((r) => r.count > 0),
      });
    }

    await tombstoneLocation(id);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'location.deleted',
      entityType: 'LOCATION',
      entityId: id,
      changes: { name: existing.name, kind: existing.kind },
      description: `Location deleted: ${existing.name}`,
    });
    res.status(204).end();
  })
);

/**
 * GET one location, which is where a tombstone is actually useful.
 *
 * A client coming back from offline asks about the record it holds. Three
 * answers, and the whole contract is that they are distinguishable:
 *
 *  - **200** — here it is, at this revision.
 *  - **410** — it existed and is gone. Stop queueing edits for it.
 *  - **404** — no such thing, *or* not yours. Deliberately still one answer,
 *    because separating them would make this endpoint an oracle for ids in other
 *    tenants. The tombstone is disclosed only to a caller who could have read the
 *    live row, which is checked before it is mentioned.
 */
locationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const existing = await findLocation(uuidParam(req, 'id'));
    if (!existing) throw new AppError('NOT_FOUND', 'Location not found');
    // Authorization first, and unchanged. Only then does a tombstone exist to be
    // told about.
    await readableProject(existing.projectId, ctx.companyId);
    await assertCapability(ctx, 'project.read');

    if (existing.deletedAt !== null) {
      throw new AppError('GONE', 'This location was deleted.', {
        tombstone: {
          id: existing.id,
          deletedAt: existing.deletedAt,
          revision: existing.revision,
        },
      });
    }
    res.json({ location: existing });
  })
);
