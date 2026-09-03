import { Router } from 'express';
import {
  complianceListQuerySchema,
  createComplianceDocumentSchema,
  deriveComplianceStatus,
  updateComplianceDocumentSchema,
  type ComplianceOverallStatus,
} from '@crewquo/shared';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { uuidParam } from '../../http/params';
import { withTransaction, queryOne } from '../../db';
import { assertCapability } from '../capabilities/guards';
import { hasFeature } from '../entitlements/guards';
import { recordAudit } from '../audit/record';
import { findFile } from '../storage/repo';
import { ensureSettings } from '../sustainability/settings';
import {
  findReadableComplianceDocument,
  insertComplianceDocument,
  listComplianceDocuments,
  listProviderSummaries,
  todayForCompany,
  toComplianceView,
  tombstoneComplianceDocument,
  updateComplianceDocument,
} from './repo';

export const complianceDocumentsRouter = Router();
export const complianceRouter = Router();

async function assertCompliance(companyId: string): Promise<void> {
  if (!(await hasFeature(companyId, 'compliance_tracking'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: compliance_tracking', {
      feature: 'compliance_tracking',
    });
  }
}

async function subjectEdge(ownerCompanyId: string, subjectCompanyId: string, engagementId?: string | null) {
  if (ownerCompanyId === subjectCompanyId) return null;
  const edge = await queryOne<{ id: string }>(
    `select id from engagements
      where client_company_id = $1 and provider_company_id = $2
        and status in ('PENDING','ACTIVE','PAUSED')
        and ($3::uuid is null or id = $3)`,
    [ownerCompanyId, subjectCompanyId, engagementId ?? null]
  );
  if (!edge) {
    throw new AppError('VALIDATION', 'That company is not one of your direct subcontractors', {
      field: 'subjectCompanyId',
    });
  }
  return edge.id;
}

async function readyFile(fileId: string | null | undefined, ownerCompanyId: string): Promise<void> {
  if (!fileId) return;
  const file = await findFile(fileId);
  if (!file || file.company_id !== ownerCompanyId) {
    throw new AppError('VALIDATION', 'That file is not one of yours', { field: 'fileId' });
  }
  if (file.status === 'PENDING' || file.status === 'SCANNING') {
    throw new AppError('CONFLICT', 'That file is still being checked. Attach it once it is ready.');
  }
  if (file.status !== 'READY') {
    throw new AppError('VALIDATION', 'That file could not be stored and cannot be used as compliance evidence.');
  }
}

complianceDocumentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCompliance(ctx.companyId);
    await assertCapability(ctx, 'compliance.manage');
    const input = complianceListQuerySchema.parse(req.query);
    res.json({
      documents: await listComplianceDocuments({
        companyId: ctx.companyId,
        subjectCompanyId: input.subjectCompanyId,
        status: input.status,
        expiringWithinDays: input.expiringWithinDays,
        includeHistory: input.includeHistory === 'true',
      }),
    });
  })
);

complianceDocumentsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCompliance(ctx.companyId);
    await assertCapability(ctx, 'compliance.manage');
    const parsed = createComplianceDocumentSchema.parse(req.body);
    const engagementId = await subjectEdge(ctx.companyId, parsed.subjectCompanyId, parsed.engagementId);
    const input = { ...parsed, engagementId };
    await readyFile(input.fileId, ctx.companyId);

    const predecessor = input.supersedesId
      ? await findReadableComplianceDocument(input.supersedesId, ctx.companyId)
      : null;
    if (input.supersedesId) {
      if (!predecessor || predecessor.owner_company_id !== ctx.companyId) {
        throw new AppError('NOT_FOUND', 'The document being renewed was not found');
      }
      if (predecessor.subject_company_id !== input.subjectCompanyId || predecessor.kind !== input.kind) {
        throw new AppError('VALIDATION', 'A renewal must cover the same company and document kind');
      }
      if (predecessor.superseded) {
        throw new AppError('CONFLICT', 'That document already has a newer version');
      }
    }

    const today = await todayForCompany(ctx.companyId);
    if (!today) throw new AppError('NOT_FOUND', 'Company not found');
    const status = deriveComplianceStatus({
      fileId: input.fileId ?? null,
      expiresOn: input.expiresOn ?? null,
      today,
      rejected: false,
    });

    let id: string;
    try {
      id = await withTransaction(async (client) => {
        const created = await insertComplianceDocument({
          ownerCompanyId: ctx.companyId,
          userId: ctx.userId,
          input,
          status,
          runner: client,
        });
        await recordAudit(
          {
            companyId: ctx.companyId,
            actorUserId: ctx.userId,
            action: input.supersedesId ? 'compliance.renewed' : 'compliance.created',
            entityType: 'COMPLIANCE_DOCUMENT',
            entityId: created,
            changes: { subjectCompanyId: input.subjectCompanyId, kind: input.kind, status, mandatory: input.mandatory },
            description: input.title,
          },
          client
        );
        return created;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AppError('CONFLICT', 'That document was renewed by somebody else. Reload the register.');
      }
      throw error;
    }
    const created = await findReadableComplianceDocument(id, ctx.companyId);
    res.status(201).json({ document: toComplianceView(created!, ctx.companyId) });
  })
);

complianceDocumentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCompliance(ctx.companyId);
    await assertCapability(ctx, 'compliance.manage');
    const row = await findReadableComplianceDocument(uuidParam(req, 'id'), ctx.companyId);
    if (!row) throw new AppError('NOT_FOUND', 'Compliance document not found');
    res.json({ document: toComplianceView(row, ctx.companyId) });
  })
);

complianceDocumentsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCompliance(ctx.companyId);
    await assertCapability(ctx, 'compliance.manage');
    const id = uuidParam(req, 'id');
    const before = await findReadableComplianceDocument(id, ctx.companyId);
    if (!before || before.owner_company_id !== ctx.companyId) {
      throw new AppError('NOT_FOUND', 'Compliance document not found');
    }
    if (before.superseded) throw new AppError('CONFLICT', 'A superseded document cannot be edited');
    const patch = updateComplianceDocumentSchema.parse(req.body);
    const issuedOn = patch.issuedOn === undefined ? before.issued_on : patch.issuedOn;
    const expiresOn = patch.expiresOn === undefined ? before.expires_on : patch.expiresOn;
    if (issuedOn && expiresOn && expiresOn < issuedOn) {
      throw new AppError('VALIDATION', 'Expiry cannot precede issue', { field: 'expiresOn' });
    }
    const today = await todayForCompany(ctx.companyId);
    const rejected = patch.review?.decision === 'REJECT' || (!patch.review && before.status === 'REJECTED');
    const status = deriveComplianceStatus({
      fileId: before.file_id,
      expiresOn,
      today: today!,
      rejected,
    });
    const fields = {
      title: patch.title ?? before.title,
      reference: patch.reference === undefined ? before.reference : patch.reference,
      insurer: patch.insurer === undefined ? before.insurer : patch.insurer,
      coverAmountCents:
        patch.coverAmountCents === undefined
          ? before.cover_amount_cents === null
            ? null
            : Number(before.cover_amount_cents)
          : patch.coverAmountCents,
      issuedOn,
      expiresOn,
      status,
      mandatory: patch.mandatory ?? before.mandatory,
      rejectReason: rejected ? patch.review?.reason ?? before.reject_reason : null,
      verifiedByUserId: patch.review ? ctx.userId : before.verified_by_user_id,
      notes: patch.notes === undefined ? before.notes : patch.notes,
    };
    const updated = await withTransaction(async (client) => {
      const ok = await updateComplianceDocument({
        id,
        ownerCompanyId: ctx.companyId,
        expectedRevision: patch.expectedRevision,
        fields,
        runner: client,
      });
      if (!ok) return false;
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: patch.review?.decision === 'REJECT' ? 'compliance.rejected' : 'compliance.updated',
          entityType: 'COMPLIANCE_DOCUMENT',
          entityId: id,
          changes: { status, revision: patch.expectedRevision + 1 },
          description: fields.title,
        },
        client
      );
      return true;
    });
    if (!updated) throw new AppError('CONFLICT', 'This document changed. Reload it before saving.');
    const fresh = await findReadableComplianceDocument(id, ctx.companyId);
    res.json({ document: toComplianceView(fresh!, ctx.companyId) });
  })
);

complianceDocumentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCompliance(ctx.companyId);
    await assertCapability(ctx, 'compliance.manage');
    const id = uuidParam(req, 'id');
    const before = await findReadableComplianceDocument(id, ctx.companyId);
    if (!before || before.owner_company_id !== ctx.companyId) {
      throw new AppError('NOT_FOUND', 'Compliance document not found');
    }
    if (before.superseded) {
      throw new AppError('CONFLICT', 'A document in a renewal chain is retained as compliance history');
    }
    await withTransaction(async (client) => {
      await tombstoneComplianceDocument(id, ctx.companyId, client);
      await recordAudit(
        {
          companyId: ctx.companyId,
          actorUserId: ctx.userId,
          action: 'compliance.deleted',
          entityType: 'COMPLIANCE_DOCUMENT',
          entityId: id,
          description: before.title,
        },
        client
      );
    });
    res.status(204).end();
  })
);

complianceRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const ctx = getCompanyCtx(req);
    await assertCompliance(ctx.companyId);
    await assertCapability(ctx, 'compliance.manage');
    const [providers, settings] = await Promise.all([
      listProviderSummaries(ctx.companyId),
      ensureSettings(ctx.companyId),
    ]);
    const totals: Record<ComplianceOverallStatus, number> = {
      VALID: 0,
      EXPIRING: 0,
      EXPIRED: 0,
      MISSING: 0,
      REJECTED: 0,
      UNKNOWN: 0,
    };
    for (const provider of providers) totals[provider.overallStatus] += 1;
    res.json({ summary: { providers, totals, enforceCompliance: settings.enforce_compliance } });
  })
);
