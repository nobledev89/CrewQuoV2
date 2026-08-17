import { Router } from 'express';
import {
  createLineItemNoteSchema,
  listLineItemNotesQuerySchema,
  updateLineItemNoteSchema,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import {
  canEditLineItemNoteBody,
  canResolveLineItemNote,
  canWriteLineItemNote,
  isEngagementParticipant,
  type EngagementEdge,
} from '../../authorization/policies';
import { findEngagementEdge } from '../engagements/repo';
import { hasFeature } from '../entitlements/guards';
import { getAuditSettings } from '../audit/repo';
import { recordAudit } from '../audit/record';
import {
  deleteNote,
  entityBelongsToEngagement,
  findNote,
  insertNote,
  listNotes,
  updateNote,
} from './repo';

/**
 * Line-item notes (CREWQUO_V2_PLAN.md §3.6, §7). Reading is open to either side
 * of the engagement; writing is gated on the provider's `client_portal_notes`
 * feature and, for the client side, that engagement's `client_can_comment`.
 */

export const lineItemNotesRouter = Router();

function edgeOf(row: { client_company_id: string; provider_company_id: string }): EngagementEdge {
  return { clientCompanyId: row.client_company_id, providerCompanyId: row.provider_company_id };
}

/** Load an edge the active company is actually on, or 404 as if it didn't exist. */
async function requireEdge(engagementId: string, companyId: string): Promise<EngagementEdge> {
  const row = await findEngagementEdge(engagementId);
  if (!row) throw new AppError('NOT_FOUND', 'Engagement not found');
  const edge = edgeOf(row);
  if (!isEngagementParticipant(companyId, edge)) {
    throw new AppError('NOT_FOUND', 'Engagement not found');
  }
  return edge;
}

async function assertCanWrite(
  engagementId: string,
  edge: EngagementEdge,
  ctx: { companyId: string; role: Parameters<typeof canWriteLineItemNote>[0]['role'] }
): Promise<void> {
  const settings = await getAuditSettings(engagementId);
  const allowed = canWriteLineItemNote({
    companyId: ctx.companyId,
    role: ctx.role,
    edge,
    providerHasNotes: await hasFeature(edge.providerCompanyId, 'client_portal_notes'),
    clientCanComment: settings.clientCanComment,
  });
  if (!allowed) {
    throw new AppError('FORBIDDEN', 'Commenting is not enabled on this engagement', {
      feature: 'client_portal_notes',
    });
  }
}

lineItemNotesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const q = listLineItemNotesQuerySchema.parse(req.query);
    if (!q.engagementId) {
      throw new AppError('VALIDATION', 'engagementId is required');
    }
    await requireEdge(q.engagementId, ctx.companyId);
    res.json({
      data: await listNotes({
        engagementId: q.engagementId,
        entityType: q.entityType,
        entityId: q.entityId,
      }),
    });
  })
);

lineItemNotesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = createLineItemNoteSchema.parse(req.body);
    const edge = await requireEdge(input.engagementId, ctx.companyId);
    await assertCanWrite(input.engagementId, edge, ctx);

    if (!(await entityBelongsToEngagement(input.entityType, input.entityId, input.engagementId))) {
      throw new AppError('VALIDATION', 'That item does not belong to this engagement');
    }

    const note = await insertNote({
      note: input,
      authorCompanyId: ctx.companyId,
      authorUserId: ctx.userId,
    });
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'note.created',
      entityType: 'NOTE',
      entityId: note.id,
      changes: { entityType: input.entityType, entityId: input.entityId },
      description: 'Note added',
      // The counterparty can already read the note itself; the trail row is safe.
      visibleToClient: true,
    });
    res.status(201).json({ note });
  })
);

lineItemNotesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const row = await findNote(param(req, 'id'));
    if (!row) throw new AppError('NOT_FOUND', 'Note not found');
    const edge = await requireEdge(row.engagement_id, ctx.companyId);
    const patch = updateLineItemNoteSchema.parse(req.body ?? {});

    // Body and resolved carry different rights, so check only what was sent.
    if (patch.body !== undefined) {
      if (!canEditLineItemNoteBody(ctx.userId, { authorUserId: row.author_user_id })) {
        throw new AppError('FORBIDDEN', 'Only the author may edit a note');
      }
      await assertCanWrite(row.engagement_id, edge, ctx);
    }
    if (patch.resolved !== undefined && !canResolveLineItemNote(ctx.companyId, edge)) {
      throw new AppError('FORBIDDEN', 'Not a participant on this engagement');
    }

    const note = await updateNote(row.id, patch);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'note.updated',
      entityType: 'NOTE',
      entityId: note.id,
      changes: { ...patch },
      description: patch.resolved === undefined ? 'Note edited' : `Note marked ${patch.resolved ? 'resolved' : 'open'}`,
      visibleToClient: true,
    });
    res.json({ note });
  })
);

lineItemNotesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const row = await findNote(param(req, 'id'));
    if (!row) throw new AppError('NOT_FOUND', 'Note not found');
    await requireEdge(row.engagement_id, ctx.companyId);
    if (!canEditLineItemNoteBody(ctx.userId, { authorUserId: row.author_user_id })) {
      throw new AppError('FORBIDDEN', 'Only the author may delete a note');
    }
    await deleteNote(row.id);
    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'note.deleted',
      entityType: 'NOTE',
      entityId: row.id,
      description: 'Note deleted',
      visibleToClient: true,
    });
    res.status(204).end();
  })
);
