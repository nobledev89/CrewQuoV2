import { Router } from 'express';
import {
  buildLocationTree,
  createLocationSchema,
  describeReferences,
  updateLocationSchema,
  validateParent,
  type LocationLike,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { queryOne } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { recordAudit } from '../audit/record';
import {
  countLocationReferences,
  deleteLocation,
  findLocation,
  insertLocation,
  listLocations,
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
    const all = await listLocations(projectId);
    const refusal = validateParent({ all: all as LocationLike[], id: null, parentId: input.parentId });
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
    res.status(201).json({ location: created });
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
    if (!updated) throw new AppError('NOT_FOUND', 'Location not found');

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

    await deleteLocation(id);
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
