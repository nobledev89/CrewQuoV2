import { Router } from 'express';
import {
  type PortalProjectDetail,
  type PortalProjectView,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { canReadPortal, type EngagementEdge } from '../../authorization/policies';
import { findEngagementByPair } from '../engagements/repo';
import { hasFeature } from '../entitlements/guards';
import { getAuditSettings } from '../audit/repo';
import { countEvidenceByCategory, listEvidence, toEvidenceView } from '../evidence/repo';
import { listDocuments, toDocumentView } from '../documents/repo';
import { documentFilterSchema, evidenceFilterSchema, refuseFilter } from '@crewquo/shared';
import { getPortalLineItems, getPortalProject, listPortalProjects } from './repo';
import { recordAudit } from '../audit/record';
import { renderStoredReport, reportFilename } from '../reports/generate';
import { findDisclosedReport, listDisclosedReports, toReportView } from '../reports/repo';
import { sendPdf, withSealCheck } from '../reports/routes';
import { currentSignoffs, toSignoffView } from '../reports/signoff';
import { buildTimeline } from '../timeline/routes';
import { listPortalVariations } from '../variations/repo';
import { timelineQuerySchema, type TimelineEventType } from '@crewquo/shared';

/**
 * Client portal (CREWQUO_V2_PLAN.md §3.6, §7). The active company here is always
 * the *client* on an engagement; the project's owner is the counterparty selling
 * the portal, so it is the owner's plan that must include `client_portal`, not
 * the client's — a client on the free Crew plan can still be shown a portal by a
 * provider who pays for one.
 */

export const portalRouter = Router();

portalRouter.get(
  '/projects',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const projects = await listPortalProjects(ctx.companyId);

    // Each project's owner may be on a different plan, so the gate is per-owner.
    // Cached per owner to keep a long project list to one entitlement read each.
    const allowedByOwner = new Map<string, boolean>();
    // Annotated rather than left to inference: an unannotated `[]` only widens
    // via TypeScript's evolving-array analysis, which needs noImplicitAny, so it
    // silently becomes never[] under a config that has drifted.
    const visible: PortalProjectView[] = [];
    for (const project of projects) {
      let allowed = allowedByOwner.get(project.providerCompanyId);
      if (allowed === undefined) {
        allowed = await hasFeature(project.providerCompanyId, 'client_portal');
        allowedByOwner.set(project.providerCompanyId, allowed);
      }
      if (allowed) visible.push(project);
    }
    res.json({ data: visible });
  })
);

portalRouter.get(
  '/projects/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    // Unpublished, or not this client's: both are "no such project" from here.
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');
    // **This destructure is the client boundary.** Everything left in `project`
    // is sent to the client verbatim, so every owner-side field the repo attaches
    // must be named here — `reportingCurrency` reached a client payload once,
    // caught by the e2e, precisely because it was not.
    const { ownerCompanyId, reportingCurrency, ...project } = found;

    const edge: EngagementEdge = {
      clientCompanyId: ctx.companyId,
      providerCompanyId: ownerCompanyId,
    };
    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge,
      providerHasClientPortal: await hasFeature(ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');

    const { lineItems, timeTotalCents, expenseTotalCents, pricingComplete } =
      await getPortalLineItems({
        id: project.id,
        ownerCompanyId,
        clientCompanyId: ctx.companyId,
        reportingCurrency,
      });

    // Comment/trail toggles live on the edge; a project without one shows defaults.
    const engagement =
      project.engagementId !== null
        ? { id: project.engagementId }
        : await findEngagementByPair(ctx.companyId, ownerCompanyId);
    const settings = engagement ? await getAuditSettings(engagement.id) : null;
    const ownerHasNotes = await hasFeature(ownerCompanyId, 'client_portal_notes');

    const body: PortalProjectDetail = {
      project,
      // The project's own unit, not the owner company's live column: a company
      // that changes currency must not restate what a client was already shown
      // for a project that has closed (§3.3 decision #5).
      currency: reportingCurrency,
      lineItems,
      timeTotalCents,
      expenseTotalCents,
      totalCents: timeTotalCents + expenseTotalCents,
      pricingComplete,
      canComment: ownerHasNotes && (settings?.clientCanComment ?? false),
      showAuditTrail: settings?.showAuditTrail ?? false,
    };
    res.json(body);
  })
);

/**
 * GET /v1/portal/projects/:id/evidence — what was deliberately shared (§22.4).
 *
 * **The unpublished rows are absent from this response, not hidden in it.** The
 * scope is applied in the `where` clause, so nothing the client may not see is
 * ever serialised — which is the difference between a boundary and a rendering
 * decision, and the assertion the acceptance script makes on the payload rather
 * than on the page.
 *
 * Reading uses the same gate as the project detail above: the **owner's** plan
 * must include `client_portal`, because a client on the free Crew plan can still
 * be shown a portal by a provider who pays for one. The client's own capabilities
 * are not consulted — they are a member of their own company and this is a
 * disclosure made *to* that company, not a permission held inside it.
 */
portalRouter.get(
  '/projects/:id/evidence',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');

    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge: { clientCompanyId: ctx.companyId, providerCompanyId: found.ownerCompanyId },
      providerHasClientPortal: await hasFeature(found.ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');
    if (!(await hasFeature(found.ownerCompanyId, 'project_evidence'))) {
      // Nothing to disclose rather than a refusal: the client has done nothing
      // wrong and cannot fix the owner's plan, so an empty section is the honest
      // answer and a 403 would be a message aimed at the wrong person.
      res.json({ evidence: [], categoryCounts: {} });
      return;
    }

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
      locationId: raw.locationId,
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
    });
    const refusal = refuseFilter(filter);
    if (refusal) throw new AppError('VALIDATION', refusal);

    const [rows, categoryCounts] = await Promise.all([
      listEvidence(found.id, { kind: 'CLIENT' }, filter),
      countEvidenceByCategory(found.id, { kind: 'CLIENT' }),
    ]);

    /*
     * `uploadedByUserId` and `companyId` are stripped, and that is the same
     * boundary the project detail's destructure draws. Which of a provider's
     * people took a photograph, and which subcontractor they work for, is the
     * hiring company's business and not part of what was shared — the client was
     * given the evidence, not the supply chain behind it.
     */
    const evidence = rows.map((row) => {
      const { uploadedByUserId, companyId, batchClientId, ...visible } = toEvidenceView(row);
      void uploadedByUserId;
      void companyId;
      void batchClientId;
      return visible;
    });
    res.json({ evidence, categoryCounts });
  })
);

/**
 * GET /v1/portal/projects/:id/documents — what was deliberately shared (§24).
 *
 * The same boundary the evidence list draws, and the same reason it is drawn in
 * the `where` clause: nothing the client may not see is ever serialised.
 *
 * **Superseded versions are absent for the client, and it is not merely a default
 * here.** Internally the chain is the point — the history is why the current
 * version exists. To a client, a superseded RAMS is a document that is no longer
 * true, and showing it beside the current one invites somebody to read, print or
 * act on the wrong copy. They see what is current, and nothing else.
 */
portalRouter.get(
  '/projects/:id/documents',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');

    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge: { clientCompanyId: ctx.companyId, providerCompanyId: found.ownerCompanyId },
      providerHasClientPortal: await hasFeature(found.ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');
    if (!(await hasFeature(found.ownerCompanyId, 'project_documents'))) {
      // An empty section, not a refusal: the client has done nothing wrong and
      // cannot fix the owner's plan.
      res.json({ documents: [] });
      return;
    }

    const raw = req.query as Record<string, unknown>;
    const filter = documentFilterSchema.parse({
      category:
        raw.category === undefined
          ? undefined
          : Array.isArray(raw.category)
            ? raw.category
            : [raw.category],
      locationId: raw.locationId,
      limit: raw.limit === undefined ? undefined : Number(raw.limit),
      offset: raw.offset === undefined ? undefined : Number(raw.offset),
    });

    const rows = await listDocuments(found.id, { kind: 'CLIENT' }, filter);

    /*
     * `companyId`, `providerCompanyId` and `uploadedByUserId` are stripped — the
     * same destructure the project detail draws. The client was shown a document,
     * not the supply chain that produced it, and which subcontractor filed a
     * method statement is the hiring company's commercial business.
     */
    const documents = rows.map((row) => {
      /*
       * The chain ids go too, and that is not tidiness. `supersedesId` points at a
       * version the client has no route to read and must never be shown — it is a
       * dangling reference at best, and at worst an invitation to ask for a copy of
       * a document that is no longer true. The client is shown what is current;
       * the history is the owner's record of why it is current.
       */
      const {
        companyId,
        providerCompanyId,
        uploadedByUserId,
        supersedesId,
        supersededById,
        ...visible
      } = toDocumentView(row);
      void companyId;
      void providerCompanyId;
      void uploadedByUserId;
      void supersedesId;
      void supersededById;
      return visible;
    });
    res.json({ documents });
  })
);

/**
 * GET /v1/portal/projects/:id/reports — the documents the client was given (§29.4).
 *
 * **Three predicates, all in the `where` clause** (`repo.ts`'s
 * `listDisclosedReports`): disclosed, current, and assembled for a client. Nothing
 * the client may not see is ever serialised, which is the same property this
 * router already states about evidence and documents — a boundary rather than a
 * rendering decision.
 *
 * The **snapshot is not returned**. A client needs the list and the document; the
 * snapshot is the owner's working record of how the document was assembled, and
 * shipping it would put every internal key in front of somebody who only asked for
 * a PDF.
 */
portalRouter.get(
  '/projects/:id/reports',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');

    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge: { clientCompanyId: ctx.companyId, providerCompanyId: found.ownerCompanyId },
      providerHasClientPortal: await hasFeature(found.ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');

    const rows = await listDisclosedReports(ctx.companyId, found.id);
    res.json({ reports: rows.map(toReportView) });
  })
);

/**
 * GET /v1/portal/reports/:id/download.pdf — the client's own copy.
 *
 * Rendered from the snapshot, never from live data (§29.4, §29.5). A client
 * re-opening last quarter's statement sees the numbers they were shown, not a
 * recalculation against rate cards that have since changed — which is the whole
 * reason this download was moved out of Phase 4.
 *
 * The client's **capabilities are never consulted**: a disclosure is made to a
 * company, not to a permission held inside it.
 */
portalRouter.get(
  '/reports/:id/download.pdf',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const id = param(req, 'id');
    const row = await findDisclosedReport(id, ctx.companyId);
    // Not disclosed, not theirs, superseded or internal — all "no such report".
    if (!row) throw new AppError('NOT_FOUND', 'Report not found');
    if (!(await hasFeature(row.company_id, 'client_portal'))) {
      throw new AppError('NOT_FOUND', 'Report not found');
    }

    const bytes = await withSealCheck(() => renderStoredReport(row));
    await recordAudit({
      // The **provider's** trail, and visible to the client: this is the client
      // reading a document the provider published to them, which is a disclosure
      // event on the provider's side of the edge.
      companyId: row.company_id,
      actorUserId: null,
      action: 'project.exported',
      entityType: 'GENERATED_REPORT',
      entityId: row.id,
      changes: { kind: row.kind, bytes: bytes.byteLength },
      description: `Client downloaded "${row.title}"`,
      visibleToClient: true,
    });
    sendPdf(res, bytes, reportFilename(row));
  })
);

/**
 * GET /v1/portal/projects/:id/signoffs — what this client signed.
 *
 * Their own signatures, on their own project. `client_signoff` is checked against
 * the **owner**, and a client whose provider does not have it gets an empty list
 * rather than a refusal — they have done nothing wrong and cannot fix somebody
 * else's plan.
 */
portalRouter.get(
  '/projects/:id/signoffs',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');

    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge: { clientCompanyId: ctx.companyId, providerCompanyId: found.ownerCompanyId },
      providerHasClientPortal: await hasFeature(found.ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');
    if (!(await hasFeature(found.ownerCompanyId, 'client_signoff'))) {
      res.json({ signoffs: [] });
      return;
    }

    const rows = await currentSignoffs(found.id);
    res.json({ signoffs: rows.map(toSignoffView) });
  })
);

/**
 * GET /v1/portal/projects/:id/variations — §30.1's client-facing half.
 *
 * **`APPROVED` and later, sell only** (`commercial-operations.md` §13.6). A client
 * who agreed to pay for extra works is entitled to see what they agreed to, and it
 * reaches them through `PortalVariationView` — a type with **no field a cost
 * figure, a margin or a provider name could occupy**, which is the mechanism
 * `reporting-signoff.md` finding 3 established rather than a filter a later edit
 * forgets.
 *
 * `DRAFT` and `SUBMITTED` never cross: a price the contractor is still thinking
 * about is not a disclosure. Neither does `REJECTED` — a client seeing a variation
 * their own contractor's team refused internally is a conversation the product
 * should not start.
 */
portalRouter.get(
  '/projects/:id/variations',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');

    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge: { clientCompanyId: ctx.companyId, providerCompanyId: found.ownerCompanyId },
      providerHasClientPortal: await hasFeature(found.ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');
    /*
     * An empty list rather than a refusal when the owner's plan lacks the feature —
     * the shape the sign-off route above uses, and for the same reason: the client
     * has done nothing wrong and cannot fix somebody else's plan.
     */
    if (!(await hasFeature(found.ownerCompanyId, 'variations'))) {
      res.json({ variations: [] });
      return;
    }

    res.json({ variations: await listPortalVariations(found.id) });
  })
);

/**
 * GET /v1/portal/projects/:id/timeline — §35's *"client-portal variant"*.
 *
 * A separate route rather than a parameter on the owner's one, because the client
 * is not on `project_assignments` and `projectAccess` would 404 them — which is
 * correct, and is the reason the portal has its own access check at all. Same
 * `buildTimeline`, `audience: 'CLIENT'`, so the exclusions are the ones
 * `TIMELINE_SOURCES` declares: a source marked `NEVER` has no code path into this
 * response.
 */
portalRouter.get(
  '/projects/:id/timeline',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    const found = await getPortalProject(ctx.companyId, param(req, 'id'));
    if (!found) throw new AppError('NOT_FOUND', 'Project not found');

    const allowed = canReadPortal({
      companyId: ctx.companyId,
      edge: { clientCompanyId: ctx.companyId, providerCompanyId: found.ownerCompanyId },
      providerHasClientPortal: await hasFeature(found.ownerCompanyId, 'client_portal'),
    });
    if (!allowed) throw new AppError('NOT_FOUND', 'Project not found');

    const q = req.query as Record<string, unknown>;
    const parsed = timelineQuerySchema.parse({
      from: typeof q.from === 'string' ? q.from : undefined,
      to: typeof q.to === 'string' ? q.to : undefined,
      types:
        typeof q.types === 'string'
          ? q.types.split(',').filter((t) => t !== '')
          : undefined,
      cursor: typeof q.cursor === 'string' ? q.cursor : undefined,
      limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
    });

    res.json(
      await buildTimeline({
        projectId: found.id,
        /*
         * `ownerScope: true` looks alarming and is right: the flag decides whether a
         * *recording company* filter is applied inside each clause, and a client is
         * not one of the recording companies — filtering on `company_id = <client>`
         * would return nothing at all rather than less. What keeps the client's view
         * narrow is `audience: 'CLIENT'`, which decides **which clauses exist**, plus
         * each clause's own `client_visible` condition. Two different mechanisms for
         * two different questions.
         */
        companyId: ctx.companyId,
        ownerCompanyId: found.ownerCompanyId,
        ownerScope: true,
        audience: 'CLIENT',
        from: parsed.from,
        to: parsed.to,
        types: parsed.types as TimelineEventType[] | undefined,
        cursor: parsed.cursor,
        limit: parsed.limit ?? 50,
      })
    );
  })
);
