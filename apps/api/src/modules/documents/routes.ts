import { Router } from 'express';
import {
  createDocumentSchema,
  detectConflict,
  documentFilterSchema,
  documentSupersededEventPayload,
  refuseDocumentDates,
  refuseSupersede,
  supersedeDocumentSchema,
  updateDocumentSchema,
  type DocumentView,
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
  findDocument,
  findVersionChain,
  insertDocument,
  listDocuments,
  toDocumentView,
  tombstoneDocument,
  updateDocument,
  type DocumentRow,
  type DocumentScope,
} from './repo';
import { countWeightsCiting, listDocumentCitations } from '../assets/repo';

/**
 * Project documents (§24) — step 5 of the Phase 7 build order.
 *
 * **A document is a chain, not an edit.** `PATCH` corrects metadata; new bytes go
 * through `POST /:id/versions`, which inserts a row pointing back at this one.
 * There is no route anywhere that changes `file_id`, and the absence is the
 * feature: a document whose bytes can be replaced in place is a document whose
 * history is a claim rather than a record.
 *
 * The four checks are the same four evidence runs (packet §4), and the feature is
 * asked of the **project owner** for the same reason: a Crew-plan subcontractor
 * must be able to file its insurance on a hiring company's job, and consumes that
 * owner's entitlement doing it.
 */

interface ProjectAccess {
  projectId: string;
  ownerCompanyId: string;
  isOwner: boolean;
}

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
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
  const isOwner = row.owner_company_id === companyId;
  if (!isOwner && !row.assigned) throw new AppError('NOT_FOUND', 'Project not found');
  return { projectId, ownerCompanyId: row.owner_company_id, isOwner };
}

async function assertDocumentFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'project_documents'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: project_documents'
        : 'This project’s owner does not have documents enabled',
      { feature: 'project_documents' }
    );
  }
}

function scopeFor(access: ProjectAccess, companyId: string): DocumentScope {
  return access.isOwner ? { kind: 'OWNER' } : { kind: 'PROVIDER', companyId };
}

/**
 * Who a document is *about*, when the uploader did not say.
 *
 * **A provider's upload defaults to itself, and a null default would be a
 * disclosure.** `provider_company_id is null` means project-wide — readable by
 * every company assigned to the job — so a subcontractor uploading its own
 * insurance certificate without setting the field would publish its paperwork to
 * every competitor on the floor. Nobody would choose that and everybody would
 * ship it, so the default is the safe one and widening it is the project owner's
 * deliberate act.
 */
function defaultProviderScope(
  access: ProjectAccess,
  companyId: string,
  requested: string | null | undefined
): string | null {
  if (access.isOwner) return requested ?? null;
  if (requested !== undefined && requested !== null && requested !== companyId) {
    throw new AppError(
      'FORBIDDEN',
      'A subcontractor can only file documents against itself'
    );
  }
  return companyId;
}

/**
 * `client_visible` is the project owner's alone, exactly as it is for evidence.
 *
 * A subcontractor able to set it could disclose to the hiring company's client, on
 * the hiring company's project, over the hiring company's commercial relationship.
 * Refused loudly rather than dropped silently: a document somebody believes they
 * shared and did not is worse than a refusal they can read.
 */
function resolveClientVisible(
  access: ProjectAccess,
  requested: boolean | undefined
): boolean {
  if (requested === undefined) return false;
  if (!access.isOwner && requested) {
    throw new AppError(
      'FORBIDDEN',
      'Only the company that owns this project can share documents with its client'
    );
  }
  return requested;
}

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectDocumentsRouter = Router();

projectDocumentsRouter.get(
  '/:projectId/documents',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertDocumentFeature(access);
    await assertCapability(ctx, 'project.read');

    const raw = req.query as Record<string, unknown>;
    const filter = documentFilterSchema.parse({
      category:
        raw.category === undefined
          ? undefined
          : Array.isArray(raw.category)
            ? raw.category
            : [raw.category],
      providerCompanyId: raw.providerCompanyId,
      locationId: raw.locationId,
      clientVisible: raw.clientVisible === undefined ? undefined : raw.clientVisible === 'true',
      includeSuperseded: raw.includeSuperseded === 'true',
      expiringWithinDays:
        raw.expiringWithinDays === undefined ? undefined : Number(raw.expiringWithinDays),
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
    });

    const rows = await listDocuments(access.projectId, scopeFor(access, ctx.companyId), filter);
    res.json({ documents: rows.map(toDocumentView) });
  })
);

projectDocumentsRouter.post(
  '/:projectId/documents',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertDocumentFeature(access);
    await assertCapability(ctx, 'document.upload');

    const input = createDocumentSchema.parse(req.body);
    const dateRefusal = refuseDocumentDates(input);
    if (dateRefusal) throw new AppError('VALIDATION', dateRefusal);

    const providerCompanyId = defaultProviderScope(access, ctx.companyId, input.providerCompanyId);
    const clientVisible = resolveClientVisible(access, input.clientVisible);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/documents',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        await assertUsableFile(input.fileId, ctx.companyId, access.projectId);
        if (input.locationId != null) await assertLocation(access.projectId, input.locationId);

        const document = await withTransaction(async (client) => {
          const row = await insertDocument(
            {
              projectId: access.projectId,
              companyId: ctx.companyId,
              fileId: input.fileId,
              category: input.category,
              title: input.title,
              reference: input.reference ?? null,
              notes: input.notes ?? null,
              issuedOn: input.issuedOn ?? null,
              expiresOn: input.expiresOn ?? null,
              providerCompanyId,
              locationId: input.locationId ?? null,
              clientVisible,
              uploadedByUserId: ctx.userId,
              version: 1,
              supersedesId: null,
            },
            client
          );
          if (!row) throw new AppError('CONFLICT', 'That document could not be filed.');

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'document.created',
              entityType: 'DOCUMENT',
              entityId: row.id,
              // The category and the reference, not the title: a trail read six
              // months later needs to know *which* waste transfer note, and the
              // reference is the number printed on it.
              changes: { category: row.category, reference: row.reference, expiresOn: row.expires_on },
              description: `Document filed: ${row.category}`,
            },
            client
          );
          return row;
        });
        return { document: toDocumentView(document) };
      }
    );
  })
);

// ── Mounted under /v1/documents ──────────────────────────────────────────────

export const documentsRouter = Router();

documentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row } = await readableDocument(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    if (row.deleted_at !== null) {
      throw new AppError('GONE', 'This document was deleted.', {
        tombstone: {
          id: row.id,
          deletedAt: row.deleted_at.toISOString(),
          revision: row.revision,
        },
      });
    }
    res.json({ document: toDocumentView(row) });
  })
);

/**
 * GET /v1/documents/:id/versions — the whole chain, oldest first.
 *
 * Tombstones are included and marked rather than dropped. A retracted version is
 * part of why the current one exists, and a history with a hole in it is the one
 * shape a document trail must never take — *"why does this jump from v1 to v3"*
 * is a question with no answer if the row is simply gone from the response.
 */
documentsRouter.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row } = await readableDocument(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const chain = await findVersionChain(row.id);
    res.json({ versions: chain.map(toDocumentView) });
  })
);

/**
 * GET /v1/documents/:id/citations — the link, read from the document's end.
 *
 * The asset side of this link needs no route: an asset line already carries its
 * `weightDocumentId`, and a movement its `documentId`. This is the other
 * direction, and it exists for one concrete moment — somebody about to delete a
 * weighbridge ticket, who is entitled to know what rests on it *before* the
 * refusal tells them. A DELETE that fails with a count and no way to see the rows
 * is a wall; this is the route out of it.
 *
 * Scoped to what the caller may read, so a provider sees its own lines and the
 * owner sees the project. The refusal that follows counts more than this lists,
 * deliberately — see `listDocumentCitations`.
 */
documentsRouter.get(
  '/:id/citations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { row, access } = await readableDocument(uuidParam(req, 'id'), ctx.companyId);
    await assertCapability(ctx, 'project.read');

    const citations = await listDocumentCitations(
      row.id,
      row.project_id,
      access.isOwner ? { kind: 'OWNER' } : { kind: 'PROVIDER', companyId: ctx.companyId }
    );
    res.json({ citations });
  })
);

/**
 * POST /v1/documents/:id/versions — re-issue.
 *
 * Metadata is inherited from the predecessor where the caller does not say
 * otherwise: a renewed insurance certificate is the same document with new dates,
 * and making somebody retype its category, title and provider is how version 2
 * ends up filed as something else.
 */
documentsRouter.post(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableDocument(id, ctx.companyId);
    await assertWritable(ctx, row, access);

    const input = supersedeDocumentSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/documents/:id/versions',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        const refusal = refuseSupersede({
          deletedAt: row.deleted_at?.toISOString() ?? null,
          supersededById: row.superseded_by_id,
          currentFileId: row.file_id,
          newFileId: input.fileId,
        });
        if (refusal) {
          if (refusal.code === 'GONE') throw new AppError('GONE', refusal.message);
          throw new AppError('CONFLICT', refusal.message, { reason: refusal.code });
        }

        await assertUsableFile(input.fileId, ctx.companyId, row.project_id);
        const inherited = {
          category: input.category ?? row.category,
          title: input.title ?? row.title,
          reference: input.reference !== undefined ? input.reference : row.reference,
          notes: input.notes !== undefined ? input.notes : row.notes,
          issuedOn: input.issuedOn !== undefined ? input.issuedOn : row.issued_on,
          expiresOn: input.expiresOn !== undefined ? input.expiresOn : row.expires_on,
          locationId: input.locationId !== undefined ? input.locationId : row.location_id,
        };
        const dateRefusal = refuseDocumentDates(inherited);
        if (dateRefusal) throw new AppError('VALIDATION', dateRefusal);
        if (inherited.locationId != null) await assertLocation(row.project_id, inherited.locationId);

        /*
         * `client_visible` is NOT inherited, and this is the one field where
         * carrying the predecessor's value forward would be wrong. A new version
         * is new bytes: re-publishing them to the client automatically, because
         * the last version happened to be shared, discloses a document nobody
         * looked at. The owner re-shares deliberately, or it stays internal.
         */
        const clientVisible = resolveClientVisible(access, input.clientVisible);
        const providerCompanyId = defaultProviderScope(
          access,
          ctx.companyId,
          input.providerCompanyId !== undefined ? input.providerCompanyId : row.provider_company_id
        );

        const created = await withTransaction(async (client) => {
          const next = await insertDocument(
            {
              projectId: row.project_id,
              companyId: ctx.companyId,
              fileId: input.fileId,
              category: inherited.category,
              title: inherited.title,
              reference: inherited.reference,
              notes: inherited.notes,
              issuedOn: inherited.issuedOn,
              expiresOn: inherited.expiresOn,
              providerCompanyId,
              locationId: inherited.locationId,
              clientVisible,
              uploadedByUserId: ctx.userId,
              version: row.version + 1,
              supersedesId: row.id,
            },
            client
          );
          if (!next) {
            /*
             * The one-successor index refused it. Two people re-issued the same
             * version at once and this one lost — which is the right answer, not
             * an error to retry: a fork would leave two v2s claiming to replace
             * one v1 and "which is current" without an answer.
             */
            throw new AppError(
              'CONFLICT',
              'A newer version of this document already exists. Re-issue that one instead.',
              { reason: 'ALREADY_SUPERSEDED' }
            );
          }

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'document.superseded',
              entityType: 'DOCUMENT',
              entityId: next.id,
              changes: {
                category: next.category,
                version: next.version,
                supersededId: row.id,
                expiresOn: next.expires_on,
              },
              description: `${next.category} re-issued as v${next.version}`,
            },
            client
          );

          await enqueueOutboxEvent(
            {
              topic: 'document.superseded',
              aggregateType: 'PROJECT_DOCUMENT',
              aggregateId: next.id,
              companyId: access.ownerCompanyId,
              payload: documentSupersededEventPayload({
                documentId: next.id,
                supersededId: row.id,
                projectId: row.project_id,
                ownerCompanyId: access.ownerCompanyId,
                actorUserId: ctx.userId,
                category: next.category,
                version: next.version,
                clientVisible: next.client_visible,
              }),
              // §5's key is the new document id: one supersession, one event,
              // whatever a retry does.
              idempotencyKey: `document.superseded:${next.id}`,
            },
            client
          );
          return next;
        });
        return { document: toDocumentView(created) };
      }
    );
  })
);

documentsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableDocument(id, ctx.companyId);
    await assertWritable(ctx, row, access);

    const patch = updateDocumentSchema.parse(req.body);
    const { expectedRevision, ...fields } = patch;

    const conflict = detectConflict({
      expected: expectedRevision,
      actual: row.revision,
      deletedAt: row.deleted_at?.toISOString() ?? null,
    });
    if (conflict) throw conflictError(conflict.code === 'GONE' ? 'GONE' : 'STALE_REVISION', row);

    const dateRefusal = refuseDocumentDates({
      issuedOn: 'issuedOn' in fields ? fields.issuedOn : row.issued_on,
      expiresOn: 'expiresOn' in fields ? fields.expiresOn : row.expires_on,
    });
    if (dateRefusal) throw new AppError('VALIDATION', dateRefusal);

    if (fields.locationId != null) await assertLocation(row.project_id, fields.locationId);
    if ('clientVisible' in fields) resolveClientVisible(access, fields.clientVisible);
    if ('providerCompanyId' in fields) {
      fields.providerCompanyId = defaultProviderScope(access, ctx.companyId, fields.providerCompanyId);
    }

    const updated = await updateDocument(id, fields, expectedRevision);
    if (!updated) {
      const now = await findDocument(id);
      if (!now) throw new AppError('NOT_FOUND', 'Document not found');
      throw conflictError(now.deleted_at !== null ? 'GONE' : 'STALE_REVISION', now);
    }

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'document.updated',
      entityType: 'DOCUMENT',
      entityId: id,
      changes: Object.fromEntries(
        Object.keys(fields).map((key) => [
          key,
          {
            from: (toDocumentView(row) as unknown as Record<string, unknown>)[key] ?? null,
            to: (toDocumentView(updated) as unknown as Record<string, unknown>)[key] ?? null,
          },
        ])
      ),
      description: `Document updated: ${updated.category}`,
    });
    res.json({ document: toDocumentView(updated) });
  })
);

documentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { row, access } = await readableDocument(id, ctx.companyId);
    await assertWritable(ctx, row, access);

    /*
     * ── The one delete this phase refuses (assets-materials.md §0 finding 5) ──
     *
     * A `VERIFIED` or `DOCUMENTED` weight is a stored *label* saying a document
     * backs it. Tombstone the document and the label stays, so the asset line goes
     * on claiming a provenance that no longer exists — **an undocumented weight
     * wearing a badge**, and one nobody would ever look at again to discover.
     * Every other broken link in this codebase is disclosed rather than refused,
     * including the superseded-document case one join away; this one cannot be,
     * because the damage is to a claim rather than to a reference.
     *
     * The count is unscoped on purpose. A provider deleting its own weighbridge
     * ticket must be refused when the *project owner's* line rests on it, and
     * scoping the count to what the deleter may read is exactly how that delete
     * would succeed. What the number does not do is name whose line it is —
     * `/citations` answers that, under the caller's own scope.
     *
     * The way out is not a permission: it is to lower the weight's confidence, or
     * re-point it at the version that replaced this one. Both are edits to the
     * asset line, which is where the claim actually lives.
     */
    const citing = Number((await countWeightsCiting(id))?.n ?? '0');
    if (citing > 0) {
      throw new AppError(
        'CONFLICT',
        `This is the evidence for a documented weight on ${citing} asset ${
          citing === 1 ? 'line' : 'lines'
        }. Change the weight’s confidence or cite another document first.`,
        { citedByWeights: citing }
      );
    }

    /*
     * Deleting a version is a tombstone, and the partial unique index on
     * `supersedes_id` filters on `deleted_at is null` — so retracting a wrongly
     * issued v2 makes v1 current again and frees the slot for a correct one. That
     * is the whole reason "superseded" is derived rather than stored: a boolean on
     * v1 would still say superseded, and there would be nothing to un-set it.
     */
    const deleted = await tombstoneDocument(id);
    if (!deleted) throw new AppError('GONE', 'This document was already deleted.');

    await recordAudit({
      companyId: ctx.companyId,
      actorUserId: ctx.userId,
      action: 'document.deleted',
      entityType: 'DOCUMENT',
      entityId: id,
      changes: {
        category: row.category,
        reference: row.reference,
        version: row.version,
        wasClientVisible: row.client_visible,
      },
      description: `Document removed: ${row.category} v${row.version}`,
    });
    res.status(204).end();
  })
);

// ── Shared helpers ───────────────────────────────────────────────────────────

async function readableDocument(
  id: string,
  companyId: string
): Promise<{ row: DocumentRow; access: ProjectAccess }> {
  const row = await findDocument(id);
  if (!row) throw new AppError('NOT_FOUND', 'Document not found');
  const access = await projectAccess(row.project_id, companyId);
  await assertDocumentFeature(access);

  if (!access.isOwner) {
    // A provider sees project-wide documents, its own uploads, and anything filed
    // against it — and a competitor's paperwork answers as not found.
    const mine =
      row.provider_company_id === null ||
      row.provider_company_id === companyId ||
      row.company_id === companyId;
    if (!mine) throw new AppError('NOT_FOUND', 'Document not found');
  }
  return { row, access };
}

/**
 * May this caller change this document?
 *
 * `document.upload` covers your own company's filings — correcting the reference
 * on a waste transfer note you filed is part of filing it. Touching somebody
 * else's needs `document.manage`, which is §37's separate job function.
 */
async function assertWritable(
  ctx: Ctx & { companyId: string },
  row: DocumentRow,
  access: ProjectAccess
): Promise<void> {
  const mine = row.company_id === ctx.companyId;
  if (mine && (await hasCapability(ctx, 'document.upload'))) return;
  await assertCapability(ctx, 'document.manage');
  if (!access.isOwner && !mine) throw new AppError('NOT_FOUND', 'Document not found');
}

/**
 * The file exists, belongs to this company, is for this project, and is not a
 * rejected upload.
 *
 * Stricter than evidence's rule, which accepts a file still being scanned. A
 * document is a claim about a fact — an insurance certificate, a weighbridge
 * ticket — and filing one whose bytes turn out to be an executable leaves a
 * compliance record pointing at nothing. Evidence tolerates it because forty
 * photographs tagged in a stairwell must not be lost to a slow PUT; a document is
 * uploaded one at a time by somebody watching the screen.
 */
async function assertUsableFile(
  fileId: string,
  companyId: string,
  projectId: string
): Promise<void> {
  const file = await queryOne<{ status: string; project_id: string | null }>(
    `select status, project_id from stored_files
      where id = $1 and company_id = $2 and variant = 'ORIGINAL'`,
    [fileId, companyId]
  );
  if (!file) throw new AppError('NOT_FOUND', 'File not found');
  if (file.project_id !== projectId) {
    throw new AppError('VALIDATION', 'That upload belongs to a different project');
  }
  if (file.status !== 'READY') {
    throw new AppError(
      'CONFLICT',
      file.status === 'SCANNING' || file.status === 'PENDING'
        ? 'That upload is still being checked. Try again in a moment.'
        : `That upload is ${file.status.toLowerCase()} and cannot be filed as a document.`
    );
  }
}

async function assertLocation(projectId: string, locationId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    `select id from project_locations
      where project_id = $1 and id = $2 and deleted_at is null`,
    [projectId, locationId]
  );
  if (rows.length === 0) throw new AppError('VALIDATION', 'That location is not on this project');
}

function conflictError(code: 'GONE' | 'STALE_REVISION', row: DocumentRow): AppError {
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
    current: toDocumentView(row) satisfies DocumentView,
  });
}
