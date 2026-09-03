import { Router } from 'express';
import {
  approveVariationSchema,
  createVariationSchema,
  detectConflict,
  findVariationTransition,
  /*
   * The one arithmetic in this module, imported rather than reimplemented: the
   * check constraint on `variation_lines` computes the same expression in exact
   * decimal, and this is the only implementation that agrees with it at the
   * half-cent boundary. See its header.
   */
  lineTotalCents as lineTotal,
  rejectVariationSchema,
  updateVariationSchema,
  variationEditRefusal,
  variationIsEditable,
  variationTimesheetOverlapNotice,
  type AuditAction,
  type CreateVariation,
  type UpdateVariation,
  type VariationLineInput,
  type VariationStatus,
  type VariationView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx, type Ctx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withIdempotency } from '../../http/idempotency';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { recordRevision } from '../revisions/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import { projectAccess, type ProjectAccess } from '../assets/routes';
import { referencedFileIsReadable } from '../storage/references';
import {
  approvedTimeLogsNearVariation,
  deleteVariationLines,
  findVariation,
  findVariationRow,
  insertVariation,
  insertVariationLine,
  listProjectVariations,
  recalculateVariationTotals,
  tombstoneVariation,
  transitionVariation,
  updateVariationFields,
} from './repo';
import { getEffectiveTimeframeDefinitions, priceVariationLine } from './pricing';

/**
 * Variations / extra works (§30.1) — step 11.4 of the Phase 11 build order in
 * `docs/operating-model/commercial-operations.md` §14.
 *
 * ── THE FOUR CHECKS, AND WHOSE PLAN IS ASKED ────────────────────────────────
 *
 * **The feature is `variations` on the PROJECT OWNER**, which is the 2026-09-01
 * rule for the fifth time and the same reasoning transferred word for word: Femi
 * with a phone and a free Crew account, capturing the extra doors on the day the
 * client asked for them, is the whole point. The owner is who invoices the
 * variation and answers for it; gating the recorder would reproduce the failure the
 * free tier was invented to prevent.
 *
 * **The capabilities are two, and separating them is why §37 exists.** A supervisor
 * holds `variation.create` and not `variation.approve` — the person who captures
 * the price on site is not the person who agrees to charge it — and the acceptance
 * script asserts exactly that refusal.
 *
 * **A counterparty's variation answers 404, not 403**, which is
 * `movementsRoutes.ts`'s shape: a 403 confirms the id exists.
 */

async function assertVariationFeature(access: ProjectAccess): Promise<void> {
  if (!(await hasFeature(access.ownerCompanyId, 'variations'))) {
    throw new AppError(
      'FORBIDDEN',
      access.isOwner
        ? 'Your plan does not include: variations'
        : 'This project’s owner does not have variations enabled',
      { feature: 'variations' }
    );
  }
}

interface ProjectPricingContext {
  ownerCompanyId: string;
  clientCompanyId: string | null;
  engagementId: string | null;
}

async function pricingContext(
  projectId: string,
  runner?: Queryable
): Promise<ProjectPricingContext> {
  const row = await queryOne<{
    owner_company_id: string;
    client_company_id: string | null;
    engagement_id: string | null;
  }>(
    `select owner_company_id, client_company_id, engagement_id from projects where id = $1`,
    [projectId],
    runner
  );
  /* c8 ignore next -- projectAccess has already proved the project exists. */
  if (!row) throw new AppError('NOT_FOUND', 'Project not found');
  return {
    ownerCompanyId: row.owner_company_id,
    clientCompanyId: row.client_company_id,
    engagementId: row.engagement_id,
  };
}

/**
 * Every id in a line, checked for **reachability by this caller** rather than for
 * existence — the rule `activities.ts` and `movementsRoutes.ts` both state, and the
 * attack it closes is the same one: without it a subcontractor attaches an
 * arbitrary id to its own row and reads the record back through the expanded
 * response.
 */
async function validateLines(
  access: ProjectAccess,
  lines: readonly VariationLineInput[],
  runner?: Queryable
): Promise<void> {
  const roleIds = [...new Set(lines.map((l) => l.roleId).filter((x): x is string => x !== null))];
  if (roleIds.length > 0) {
    /*
     * **The PROJECT OWNER's catalog, not the recorder's**, and the precedent is
     * `assertRoleInCompany` in `work/routes.ts`: a subcontractor logs time against a
     * role in the *hiring* company's catalog, because that is whose rate cards price
     * it. A variation line resolves through the same cards, so it has to name the
     * same roles — and the subcontractor already reads that list, from
     * `/v1/work-context`, which returns `rolesByClient` for exactly this reason.
     *
     * Checking the recorder's own catalog instead is what the first draft did, and
     * it made a subcontractor's LABOUR line unpriceable by construction: the role it
     * would have had to name has no rate card anywhere.
     */
    const found = await query<{ id: string }>(
      `select id from role_catalog where id = any($1::uuid[]) and company_id = $2`,
      [roleIds, access.ownerCompanyId],
      runner
    );
    if (found.length !== roleIds.length) {
      throw new AppError(
        'VALIDATION',
        'A role on this variation is not in the project owner’s role catalog',
        { field: 'lines.roleId' }
      );
    }
  }

  const assetIds = [...new Set(lines.map((l) => l.assetId).filter((x): x is string => x !== null))];
  if (assetIds.length > 0) {
    const found = await query<{ id: string }>(
      `select pa.id from project_assets pa
        where pa.id = any($1::uuid[]) and pa.project_id = $2 and pa.deleted_at is null`,
      [assetIds, access.projectId],
      runner
    );
    if (found.length !== assetIds.length) {
      throw new AppError('VALIDATION', 'An asset on this variation is not on this project', {
        field: 'lines.assetId',
      });
    }
  }
}

/** The facts a §36 revision trail carries, and nothing derived. */
function variationFacts(view: VariationView): Record<string, unknown> {
  return {
    reference: view.reference,
    description: view.description,
    reason: view.reason,
    requestedBy: view.requestedBy,
    requestedOn: view.requestedOn,
    status: view.status,
    sellTotalCents: view.sellTotalCents,
    costTotalCents: view.costTotalCents,
    clientApprovedBy: view.clientApprovedBy,
    /*
     * The lines are in the trail, and they have to be: §36 stars variations because
     * *the numbers themselves are the evidence*, and a revision recording only that
     * the total moved from £4,000 to £4,500 cannot answer which line moved. The
     * unit prices come with them for the same reason.
     */
    lines: view.lines.map((l) => ({
      kind: l.kind,
      description: l.description,
      quantity: l.quantity,
      unitCostCents: l.unitCostCents,
      unitSellCents: l.unitSellCents,
      costCents: l.costCents,
      sellCents: l.sellCents,
      roleId: l.roleId,
      pricedFrom: l.pricedFrom,
    })),
  };
}

/** Write the lines of a variation from scratch, priced, and recompute the header. */
async function writeLines(args: {
  variationId: string;
  lines: readonly VariationLineInput[];
  context: ProjectPricingContext;
  /** Whose variation it is — decides which PAY card prices the cost side. */
  recordingCompanyId: string;
  requestedOn: string;
  runner: Queryable;
}): Promise<{ notices: string[] }> {
  await deleteVariationLines(args.variationId, args.runner);

  // Loaded once for the whole variation rather than per line — the discipline
  // `resolveBillCentsForLog` made a required argument for.
  const labelRules = await getEffectiveTimeframeDefinitions(
    args.context.ownerCompanyId,
    args.runner
  );

  const notices: string[] = [];
  for (const line of args.lines) {
    const priced = await priceVariationLine({
      line,
      ownerCompanyId: args.context.ownerCompanyId,
      clientCompanyId: args.context.clientCompanyId,
      recordingCompanyId: args.recordingCompanyId,
      date: args.requestedOn,
      labelRules,
      runner: args.runner,
    });
    if (priced.reason !== null) notices.push(`${line.description}: ${priced.reason}`);

    /*
     * An unpriced side is stored as **zero with `PARTIAL` on the row**, not
     * refused. §41.1's rule says do not print a number you do not have, and it does
     * not say refuse the record — a variation with a line the rate engine could not
     * price is still the record of what the client asked for, and losing it to
     * protect a figure would lose the data the feature exists to collect. The same
     * choice `resolveWeight` made for a supervisor in a stairwell.
     *
     * `pricedFrom` is what a screen keys on: a `PARTIAL` line shows its notice and
     * asks for a price rather than presenting the zero as agreed.
     */
    await insertVariationLine(
      {
        variationId: args.variationId,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unitCostCents: priced.unitCostCents ?? 0,
        unitSellCents: priced.unitSellCents ?? 0,
        costCents: lineTotal(line.quantity, priced.unitCostCents ?? 0),
        sellCents: lineTotal(line.quantity, priced.unitSellCents ?? 0),
        roleId: line.roleId,
        shiftType: line.shiftType,
        pricedFrom: priced.pricedFrom,
        assetId: line.assetId,
      },
      args.runner
    );
  }

  await recalculateVariationTotals(args.variationId, args.runner);
  return { notices };
}

// ── Mounted under /v1/projects ───────────────────────────────────────────────

export const projectVariationsRouter = Router();

projectVariationsRouter.get(
  '/:projectId/variations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertVariationFeature(access);
    await assertCapability(ctx, 'project.read');

    const status = (req.query as Record<string, unknown>).status;
    const variations = await listProjectVariations({
      projectId: access.projectId,
      ownerScope: access.isOwner,
      companyId: ctx.companyId,
      status: typeof status === 'string' ? (status as VariationStatus) : undefined,
    });
    res.json({ variations });
  })
);

projectVariationsRouter.post(
  '/:projectId/variations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const access = await projectAccess(uuidParam(req, 'projectId'), ctx.companyId);
    await assertVariationFeature(access);
    await assertCapability(ctx, 'variation.create');

    const input: CreateVariation = createVariationSchema.parse(req.body);

    await withIdempotency(
      {
        res,
        companyId: ctx.companyId,
        clientId: input.clientId,
        route: 'POST /v1/projects/:projectId/variations',
        body: req.body,
        successStatus: 201,
      },
      async () => {
        const context = await pricingContext(access.projectId);
        await validateLines(access, input.lines);

        const created = await withTransaction(async (client) => {
          const id = await insertVariation(
            {
              projectId: access.projectId,
              companyId: ctx.companyId,
              engagementId: context.engagementId,
              reference: input.reference,
              description: input.description,
              reason: input.reason,
              requestedBy: input.requestedBy,
              requestedOn: input.requestedOn,
              clientId: input.clientId ?? null,
              createdByUserId: ctx.userId,
            },
            client
          );
          const { notices } = await writeLines({
            variationId: id,
            lines: input.lines,
            context,
            recordingCompanyId: ctx.companyId,
            requestedOn: input.requestedOn,
            runner: client,
          });
          const view = (await findVariation(id, client))!;

          await recordAudit(
            {
              companyId: ctx.companyId,
              actorUserId: ctx.userId,
              action: 'variation.created',
              entityType: 'VARIATION',
              entityId: id,
              description: `Variation${view.reference ? ` ${view.reference}` : ''} raised: ${view.description.slice(0, 80)}`,
            },
            client
          );
          /*
           * §36 stars variations by name — *"the records where the numbers
           * themselves are the evidence"* — so the trail starts at creation rather
           * than at the first edit. Without this, the first revision row would
           * have a `before` of nothing and read as if the variation had appeared
           * fully priced.
           */
          await recordRevision(
            {
              companyId: ctx.companyId,
              entityType: 'variation',
              entityId: id,
              action: 'CREATE',
              after: variationFacts(view),
              changedByUserId: ctx.userId,
            },
            client
          );
          return { view, notices };
        });

        /*
         * **No event on create.** A draft is a piece of thinking, and telling
         * anybody about it is telling them about a thought (packet §5). The event
         * is `variation.submitted`, which is when somebody acquires a decision.
         */
        return { variation: created.view, notices: created.notices };
      }
    );
  })
);

// ── Mounted under /v1/variations ─────────────────────────────────────────────

export const variationsRouter = Router();

/** Resolve a variation and the caller's relationship to its project. */
async function variationAccess(
  id: string,
  companyId: string
): Promise<{ view: VariationView; access: ProjectAccess }> {
  const row = await findVariationRow(id);
  if (!row) throw new AppError('NOT_FOUND', 'Variation not found');
  const access = await projectAccess(row.project_id, companyId);
  // A counterparty's row answers as not found rather than as forbidden: a 403
  // confirms the id exists.
  if (!access.isOwner && row.company_id !== companyId) {
    throw new AppError('NOT_FOUND', 'Variation not found');
  }
  const view = (await findVariation(id))!;
  return { view, access };
}

variationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const { view, access } = await variationAccess(uuidParam(req, 'id'), ctx.companyId);
    await assertVariationFeature(access);
    await assertCapability(ctx, 'project.read');

    /*
     * §13.2's notice, attached to the read the panel makes rather than to the
     * invoice: the person who needs it is looking at the variation when they decide
     * whether to bill it. Only worth computing once a variation is approved — a
     * draft has nothing to be double-billed against yet.
     */
    const overlap =
      view.status === 'APPROVED' || view.status === 'COMPLETED'
        ? variationTimesheetOverlapNotice(await approvedTimeLogsNearVariation(view.id))
        : null;

    res.json({ variation: view, billingNotice: overlap });
  })
);

/**
 * Edit — **`DRAFT` and `REJECTED` only** (packet finding 4).
 *
 * `client_approved_by` records that a named person outside the tenancy agreed a
 * figure, and a line editable past that point converts their agreement into a
 * signature on a blank cheque. The refusal names what to do instead, because a
 * refusal that does not is one somebody takes to support.
 */
variationsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { view: before, access } = await variationAccess(id, ctx.companyId);
    await assertVariationFeature(access);
    await assertCapability(ctx, 'variation.create');
    assertRecorderOrOwner(before, access, ctx);

    const { expectedRevision, ...fields }: UpdateVariation = updateVariationSchema.parse(req.body);

    const conflict = detectConflict({
      expected: expectedRevision,
      actual: before.revision,
      deletedAt: before.deletedAt,
    });
    if (conflict) {
      if (conflict.code === 'GONE') throw new AppError('GONE', conflict.message);
      /*
       * Refused rather than merged, which is packet §8: a variation is a price, and
       * field-merging two versions of a price produces a figure nobody quoted. Both
       * versions travel with the refusal so a device can offer keep-mine /
       * keep-theirs.
       */
      throw new AppError('CONFLICT', conflict.message, {
        reason: 'STALE_REVISION',
        current: before,
      });
    }

    const refusal = variationEditRefusal(before.status);
    if (refusal) throw new AppError('CONFLICT', refusal, { status: before.status });

    if (fields.lines) await validateLines(access, fields.lines);
    const context = await pricingContext(before.projectId);

    const result = await withTransaction(async (client) => {
      await updateVariationFields(id, fields, ctx.userId, client);
      let notices: string[] = [];
      if (fields.lines) {
        const written = await writeLines({
          variationId: id,
          lines: fields.lines,
          context,
          recordingCompanyId: before.companyId,
          requestedOn: fields.requestedOn ?? before.requestedOn,
          runner: client,
        });
        notices = written.notices;
      } else if (fields.requestedOn && fields.requestedOn !== before.requestedOn) {
        /*
         * Moving the date **does not re-resolve the prices**, and the omission is
         * deliberate rather than an oversight.
         *
         * A quote is priced as of the day it was quoted. Silently repricing every
         * line because somebody corrected the date from the 4th to the 5th would
         * change a figure the client may already have agreed to, without anybody
         * asking for a new price. The line keeps its rate and the panel shows the
         * date it was priced on; re-pricing is an explicit resubmission of the
         * lines.
         */
      }
      const after = (await findVariation(id, client))!;

      await recordAudit(
        {
          companyId: before.companyId,
          actorUserId: ctx.userId,
          action: 'variation.updated',
          entityType: 'VARIATION',
          entityId: id,
          description:
            before.sellTotalCents === after.sellTotalCents
              ? 'Variation details changed'
              : `Variation sell total changed from ${String(before.sellTotalCents)} to ${String(after.sellTotalCents)}`,
        },
        client
      );
      await recordRevision(
        {
          companyId: before.companyId,
          entityType: 'variation',
          entityId: id,
          action: 'UPDATE',
          before: variationFacts(before),
          after: variationFacts(after),
          changedByUserId: ctx.userId,
        },
        client
      );
      return { variation: after, notices };
    });

    res.json(result);
  })
);

/**
 * Who may edit: whoever raised it, or the project owner.
 *
 * The second half is `assets/routes.ts`'s rule rather than the diary's: a project
 * owner correcting a subcontractor's typo on a variation it is about to be invoiced
 * for is ordinary, and the trail records who changed what either way. The diary is
 * the one record class where the author's word is the whole point and nobody else
 * may touch it.
 */
function assertRecorderOrOwner(
  view: VariationView,
  access: ProjectAccess,
  ctx: Ctx & { companyId: string }
): void {
  if (access.isOwner) return;
  if (view.companyId !== ctx.companyId) {
    /* c8 ignore next -- variationAccess has already 404'd this case. */
    throw new AppError('FORBIDDEN', 'This variation belongs to another company on this project');
  }
}

variationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { view, access } = await variationAccess(id, ctx.companyId);
    await assertVariationFeature(access);
    await assertCapability(ctx, 'variation.create');
    assertRecorderOrOwner(view, access, ctx);

    if (view.deletedAt !== null) throw new AppError('GONE', 'That variation is already deleted');
    /*
     * Only a draft may be withdrawn from existence. A submitted variation has been
     * put in front of somebody, and an approved one is an agreement — deleting
     * either would remove a record the counterparty acted on.
     */
    if (view.status !== 'DRAFT') {
      throw new AppError(
        'CONFLICT',
        `Only a draft variation can be deleted. This one is ${view.status.toLowerCase()} — withdraw it to draft first, or reject it.`,
        { status: view.status }
      );
    }

    await withTransaction(async (client) => {
      // A tombstone, never a hard delete: a draft removed at the desk must not be
      // resurrected by a phone that has been in a pocket since Tuesday (0029).
      await tombstoneVariation(id, ctx.userId, client);
      await recordAudit(
        {
          companyId: view.companyId,
          actorUserId: ctx.userId,
          action: 'variation.deleted',
          entityType: 'VARIATION',
          entityId: id,
          description: `Draft variation deleted: ${view.description.slice(0, 80)}`,
        },
        client
      );
      await recordRevision(
        {
          companyId: view.companyId,
          entityType: 'variation',
          entityId: id,
          action: 'DELETE',
          before: variationFacts(view),
          changedByUserId: ctx.userId,
        },
        client
      );
    });
    res.status(204).end();
  })
);

// ── Transitions ──────────────────────────────────────────────────────────────

/**
 * One handler for every state change, driven by `VARIATION_TRANSITIONS`.
 *
 * The table is the authority rather than a `switch` per route, so §44's
 * state-machine test walks the same declaration the routes obey — and a transition
 * whose actor is `SYSTEM` has no route at all, because this function refuses to
 * build one: `INVOICED` is set inside the invoice's transaction and there is
 * deliberately no endpoint for it.
 */
async function drive(args: {
  ctx: Ctx & { companyId: string };
  id: string;
  to: VariationStatus;
  reason?: string | null;
  approval?: {
    clientApprovedBy?: string | null;
    clientApprovedAt?: string | null;
    approvalEvidenceFileId?: string | null;
  };
  /*
   * Typed against the closed catalog rather than `string`, which is what caught
   * this: an action a route invents is an action `/audit-logs` cannot filter on and
   * nothing renders a label for.
   */
  auditAction: AuditAction;
}): Promise<{ variation: VariationView; billingNotice: string | null }> {
  const { view: before, access } = await variationAccess(args.id, args.ctx.companyId);
  await assertVariationFeature(access);

  const transition = findVariationTransition(before.status, args.to);
  if (!transition || transition.actor === 'SYSTEM') {
    throw new AppError(
      'CONFLICT',
      `A ${before.status.toLowerCase()} variation cannot become ${args.to.toLowerCase()}.`,
      { from: before.status, to: args.to }
    );
  }
  /* c8 ignore next -- every non-SYSTEM transition in the table names a capability. */
  if (transition.capability) await assertCapability(args.ctx, transition.capability);

  if (transition.actor === 'OWNER' && !access.isOwner) {
    throw new AppError(
      'FORBIDDEN',
      'Only the company that owns this project can decide a variation on it'
    );
  }
  if (transition.actor === 'RECORDER' && before.companyId !== args.ctx.companyId) {
    throw new AppError(
      'FORBIDDEN',
      'Only the company that raised this variation can submit or withdraw it'
    );
  }
  if (transition.reasonRequired && !args.reason) {
    /* c8 ignore next 4 -- rejectVariationSchema already requires it. */
    throw new AppError('VALIDATION', 'A reason is required', { field: 'reason' });
  }
  if (before.deletedAt !== null) throw new AppError('GONE', 'That variation is deleted');

  /*
   * The evidence file, checked for reachability before it is stored — the same
   * registry the download path consults, so a caller cannot attach a file id it
   * could not itself read and then read it back through the expanded response.
   */
  const fileId = args.approval?.approvalEvidenceFileId;
  if (fileId != null && !(await referencedFileIsReadable(fileId, args.ctx.companyId))) {
    throw new AppError('VALIDATION', 'That file is not one you can attach', {
      field: 'approvalEvidenceFileId',
    });
  }

  const result = await withTransaction(async (client) => {
    const won = await transitionVariation({
      id: args.id,
      from: before.status,
      to: args.to,
      reviewedByUserId: transition.actor === 'OWNER' ? args.ctx.userId : null,
      rejectReason: args.reason ?? null,
      clientApprovedBy: args.approval?.clientApprovedBy,
      /*
       * The pair moves together, which is what `variations_client_approval_pairing`
       * enforces: a date with no name is unattributable and a name with no date
       * cannot be placed in the sequence of events. So a caller naming the approver
       * without a time gets the server's clock rather than a null the constraint
       * would refuse.
       */
      clientApprovedAt:
        args.approval?.clientApprovedBy == null
          ? args.approval?.clientApprovedAt
          : (args.approval.clientApprovedAt ?? new Date().toISOString()),
      approvalEvidenceFileId: args.approval?.approvalEvidenceFileId,
      runner: client,
    });
    if (!won) {
      /*
       * Somebody else got there first. Packet §3: the conditional update is the
       * concurrency rule, and the loser is told the state the row is **actually**
       * in rather than being told to retry into the same race.
       */
      const now = await findVariationRow(args.id, client);
      throw new AppError(
        'CONFLICT',
        `That variation is now ${String(now?.status ?? 'changed').toLowerCase()} — somebody else decided it first.`,
        { status: now?.status ?? null }
      );
    }

    const after = (await findVariation(args.id, client))!;
    await recordAudit(
      {
        // Whose record changed, not whose session did it (§36's rule): a variation
        // belongs to the company that raised it, even when the owner approves it.
        companyId: before.companyId,
        actorUserId: args.ctx.userId,
        action: args.auditAction,
        entityType: 'VARIATION',
        entityId: args.id,
        description: `${before.status} → ${args.to}${args.reason ? `: ${args.reason}` : ''}`,
        /*
         * An approved variation is money the client agreed to pay, so the decision
         * is visible in the portal's audit trail. A rejection is not: a client
         * seeing a variation their own contractor's team refused internally is a
         * conversation the product should not start (packet §13.6).
         */
        visibleToClient: args.to === 'APPROVED' || args.to === 'COMPLETED',
      },
      client
    );
    await recordRevision(
      {
        companyId: before.companyId,
        entityType: 'variation',
        entityId: args.id,
        action: 'UPDATE',
        before: variationFacts(before),
        after: variationFacts(after),
        reason: args.reason ?? null,
        changedByUserId: args.ctx.userId,
      },
      client
    );

    if (args.to === 'SUBMITTED' || args.to === 'APPROVED' || args.to === 'REJECTED') {
      const context = await pricingContext(before.projectId, client);
      await enqueueOutboxEvent(
        {
          topic: args.to === 'SUBMITTED' ? 'variation.submitted' : 'variation.decided',
          aggregateType: 'VARIATION',
          aggregateId: args.id,
          companyId: access.ownerCompanyId,
          payload: {
            variationId: args.id,
            projectId: before.projectId,
            companyId: before.companyId,
            ownerCompanyId: access.ownerCompanyId,
            clientCompanyId: context.clientCompanyId,
            reference: after.reference,
            description: after.description,
            sellTotalCents: after.sellTotalCents,
            decision: args.to,
            reason: args.reason ?? null,
            clientApprovalRecorded: after.clientApprovalRecorded,
          },
          /*
           * Keyed on the resulting status rather than on the id alone, so
           * approve-after-reject is a second event and a replayed approve is not
           * (packet §5). The revision is in the key for `submitted` because a
           * resubmit after an edit is genuinely a new thing to look at.
           */
          idempotencyKey:
            args.to === 'SUBMITTED'
              ? `variation-submitted:${args.id}:${String(after.revision)}`
              : `variation-decided:${args.id}:${args.to}`,
        },
        client
      );
    }
    return after;
  });

  const billingNotice =
    args.to === 'APPROVED'
      ? variationTimesheetOverlapNotice(await approvedTimeLogsNearVariation(args.id))
      : null;
  return { variation: result, billingNotice };
}

variationsRouter.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const view = await drive({
      ctx,
      id: uuidParam(req, 'id'),
      to: 'SUBMITTED',
      auditAction: 'variation.submitted',
    });
    res.json(view);
  })
);

variationsRouter.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const view = await drive({
      ctx,
      id: uuidParam(req, 'id'),
      to: 'DRAFT',
      auditAction: 'variation.withdrawn',
    });
    res.json(view);
  })
);

variationsRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = approveVariationSchema.parse(req.body ?? {});
    const view = await drive({
      ctx,
      id: uuidParam(req, 'id'),
      to: 'APPROVED',
      approval: {
        clientApprovedBy: input.clientApprovedBy,
        clientApprovedAt: input.clientApprovedAt,
        approvalEvidenceFileId: input.approvalEvidenceFileId,
      },
      auditAction: 'variation.approved',
    });
    res.json(view);
  })
);

variationsRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const input = rejectVariationSchema.parse(req.body);
    const view = await drive({
      ctx,
      id: uuidParam(req, 'id'),
      to: 'REJECTED',
      reason: input.reason,
      auditAction: 'variation.rejected',
    });
    res.json(view);
  })
);

variationsRouter.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const view = await drive({
      ctx,
      id: uuidParam(req, 'id'),
      to: 'COMPLETED',
      auditAction: 'variation.completed',
    });
    res.json(view);
  })
);

/**
 * Record the client's own agreement against an already-approved variation.
 *
 * The one write permitted past `APPROVED`, and it is not an exception to finding 4
 * — it changes **no figure**. Packet §3's gate is a warning rather than a block
 * precisely so the crew can work on Wednesday while the paperwork arrives on
 * Friday, and this is where Friday lands. `variationIsEditable` still refuses every
 * price, and the schema here has no field for one.
 */
variationsRouter.post(
  '/:id/client-approval',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = uuidParam(req, 'id');
    const { view: before, access } = await variationAccess(id, ctx.companyId);
    await assertVariationFeature(access);
    await assertCapability(ctx, 'variation.approve');
    if (!access.isOwner) {
      throw new AppError('FORBIDDEN', 'Only the project owner records the client’s approval');
    }
    if (variationIsEditable(before.status)) {
      throw new AppError(
        'CONFLICT',
        'Approve the variation first — a client cannot have agreed a price that is still a draft.',
        { status: before.status }
      );
    }

    const input = approveVariationSchema.parse(req.body ?? {});
    if (input.approvalEvidenceFileId != null &&
        !(await referencedFileIsReadable(input.approvalEvidenceFileId, ctx.companyId))) {
      throw new AppError('VALIDATION', 'That file is not one you can attach', {
        field: 'approvalEvidenceFileId',
      });
    }

    const after = await withTransaction(async (client) => {
      await query(
        `update variations set
           client_approved_by = coalesce($2, client_approved_by),
           client_approved_at = case
             when $2::text is null then client_approved_at
             else coalesce($3::timestamptz, now()) end,
           approval_evidence_file_id =
             case when $4::boolean then $5 else approval_evidence_file_id end,
           updated_by_user_id = $6, updated_at = now()
         where id = $1`,
        [
          id,
          input.clientApprovedBy ?? null,
          input.clientApprovedAt ?? null,
          input.approvalEvidenceFileId !== undefined,
          input.approvalEvidenceFileId ?? null,
          ctx.userId,
        ],
        client
      );
      const view = (await findVariation(id, client))!;
      await recordAudit(
        {
          companyId: before.companyId,
          actorUserId: ctx.userId,
          action: 'variation.client_approval_recorded',
          entityType: 'VARIATION',
          entityId: id,
          description: `Client approval recorded${view.clientApprovedBy ? ` by ${view.clientApprovedBy}` : ''}`,
          visibleToClient: true,
        },
        client
      );
      await recordRevision(
        {
          companyId: before.companyId,
          entityType: 'variation',
          entityId: id,
          action: 'UPDATE',
          before: variationFacts(before),
          after: variationFacts(view),
          changedByUserId: ctx.userId,
        },
        client
      );
      return view;
    });

    res.json({ variation: after });
  })
);
