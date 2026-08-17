import { Router } from 'express';
import {
  createInvoiceItemSchema,
  createInvoiceSchema,
  updateInvoiceItemSchema,
  updateInvoiceSchema,
} from '@crewquo/shared';
import { canManage, canManageInvoice, canReadInvoice, type EngagementEdge } from '../../authorization/policies';
import { asyncHandler } from '../../http/asyncHandler';
import { getCompanyCtx } from '../../http/context';
import { AppError } from '../../http/errors';
import { param } from '../../http/params';
import { recordAudit } from '../audit/record';
import { findEngagementEdge } from '../engagements/repo';
import { hasFeature } from '../entitlements/guards';
import { getInvoice, listInvoices } from './repo';
import {
  addInvoiceItem,
  createProjectInvoice,
  editInvoice,
  editInvoiceItem,
  issueDraftInvoice,
  importApprovedInvoiceItems,
  markInvoicePaid,
  removeInvoice,
  removeInvoiceItem,
  voidIssuedInvoice,
} from './service';

export const invoicesRouter = Router();

function edgeOf(row: { client_company_id: string; provider_company_id: string }): EngagementEdge {
  return { clientCompanyId: row.client_company_id, providerCompanyId: row.provider_company_id };
}

async function loadVisible(id: string, companyId: string) {
  const invoice = await getInvoice(id);
  if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found');
  const row = await findEngagementEdge(invoice.engagementId);
  if (!row || !canReadInvoice(companyId, edgeOf(row), invoice.status)) {
    throw new AppError('NOT_FOUND', 'Invoice not found');
  }
  return { invoice, edge: edgeOf(row) };
}

async function loadEditable(id: string, ctx: ReturnType<typeof getCompanyCtx>) {
  const loaded = await loadVisible(id, ctx.companyId);
  if (!canManageInvoice(ctx.companyId, ctx.role, loaded.edge, loaded.invoice.status)) {
    throw new AppError('FORBIDDEN', 'Only issuer-side managers may edit a draft invoice');
  }
  if (!(await hasFeature(ctx.companyId, 'invoicing'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: invoicing', { feature: 'invoicing' });
  }
  return loaded.invoice;
}

async function loadIssuerAction(id: string, ctx: ReturnType<typeof getCompanyCtx>) {
  const loaded = await loadVisible(id, ctx.companyId);
  if (loaded.invoice.issuerCompanyId !== ctx.companyId || !canManage(ctx.role)) {
    throw new AppError('FORBIDDEN', 'Only issuer-side managers may manage an invoice');
  }
  if (!(await hasFeature(ctx.companyId, 'invoicing'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: invoicing', { feature: 'invoicing' });
  }
  return loaded.invoice;
}

invoicesRouter.get('/', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  res.json({ data: await listInvoices(ctx.companyId) });
}));

invoicesRouter.post('/', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  if (!canManage(ctx.role)) throw new AppError('FORBIDDEN', 'Requires a manager role');
  if (!(await hasFeature(ctx.companyId, 'invoicing'))) {
    throw new AppError('FORBIDDEN', 'Your plan does not include: invoicing', { feature: 'invoicing' });
  }
  const invoice = await createProjectInvoice(ctx.companyId, createInvoiceSchema.parse(req.body));
  await recordAudit({
    companyId: ctx.companyId, actorUserId: ctx.userId, action: 'invoice.created',
    entityType: 'INVOICE', entityId: invoice.id,
    changes: { projectId: invoice.projectId, totalCents: invoice.totalCents },
    description: 'Draft invoice created',
  });
  res.status(201).json({ invoice });
}));

invoicesRouter.get('/:id', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  res.json({ invoice: (await loadVisible(param(req, 'id'), ctx.companyId)).invoice });
}));

invoicesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const id = param(req, 'id');
  await loadEditable(id, ctx);
  const patch = updateInvoiceSchema.parse(req.body);
  const invoice = await editInvoice(id, patch);
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.updated', entityType: 'INVOICE', entityId: id,
    changes: patch, description: 'Draft invoice updated' });
  res.json({ invoice });
}));

invoicesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const id = param(req, 'id');
  await loadEditable(id, ctx);
  await removeInvoice(id);
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.deleted', entityType: 'INVOICE', entityId: id,
    description: 'Draft invoice deleted' });
  res.status(204).end();
}));

invoicesRouter.post('/:id/items', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const invoice = await loadEditable(param(req, 'id'), ctx);
  const updated = await addInvoiceItem(invoice, createInvoiceItemSchema.parse(req.body));
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.updated', entityType: 'INVOICE', entityId: invoice.id,
    changes: { itemCount: updated.items.length, totalCents: updated.totalCents },
    description: 'Invoice item added' });
  res.status(201).json({ invoice: updated });
}));

invoicesRouter.post('/:id/items/import-approved', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const invoice = await loadEditable(param(req, 'id'), ctx);
  const updated = await importApprovedInvoiceItems(invoice);
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.updated', entityType: 'INVOICE', entityId: invoice.id,
    changes: { itemCount: updated.items.length, totalCents: updated.totalCents },
    description: 'Newly approved work added to invoice' });
  res.json({ invoice: updated });
}));

invoicesRouter.patch('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const id = param(req, 'id');
  await loadEditable(id, ctx);
  const invoice = await editInvoiceItem(id, param(req, 'itemId'), updateInvoiceItemSchema.parse(req.body));
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.updated', entityType: 'INVOICE', entityId: id,
    description: 'Manual invoice item updated' });
  res.json({ invoice });
}));

invoicesRouter.delete('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const id = param(req, 'id');
  await loadEditable(id, ctx);
  const invoice = await removeInvoiceItem(id, param(req, 'itemId'));
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.updated', entityType: 'INVOICE', entityId: id,
    description: 'Invoice item removed' });
  res.json({ invoice });
}));

invoicesRouter.post('/:id/issue', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const id = param(req, 'id');
  await loadEditable(id, ctx);
  const invoice = await issueDraftInvoice(id);
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.issued', entityType: 'INVOICE', entityId: id,
    changes: { number: invoice.number, totalCents: invoice.totalCents },
    description: `Invoice ${invoice.number} issued`, visibleToClient: true });
  res.json({ invoice });
}));

invoicesRouter.post('/:id/paid', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const invoice = await loadIssuerAction(param(req, 'id'), ctx);
  const updated = await markInvoicePaid(invoice.id);
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.paid', entityType: 'INVOICE', entityId: invoice.id,
    description: `Invoice ${invoice.number} marked paid`, visibleToClient: true });
  res.json({ invoice: updated });
}));

invoicesRouter.post('/:id/void', asyncHandler(async (req, res) => {
  const ctx = getCompanyCtx(req);
  const invoice = await loadIssuerAction(param(req, 'id'), ctx);
  const updated = await voidIssuedInvoice(invoice.id);
  await recordAudit({ companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'invoice.voided', entityType: 'INVOICE', entityId: invoice.id,
    description: `Invoice ${invoice.number} voided`, visibleToClient: true });
  res.json({ invoice: updated });
}));
