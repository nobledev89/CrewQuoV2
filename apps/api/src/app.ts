import cors from 'cors';
import express, { type Express } from 'express';
import { healthResponseSchema } from '@crewquo/shared';
import { pingDb } from './db';
import { errorHandler, notFoundHandler } from './http/errorHandler';
import { requireAuth, requireSuperAdmin } from './http/middleware/auth';
import { authRouter } from './modules/auth/routes';
import { meRouter } from './modules/me/routes';
import { companiesRouter } from './modules/companies/routes';
import { entitlementsRouter } from './modules/entitlements/routes';
import { adminRouter } from './modules/admin/routes';
import {
  rateCardRouter,
  rateCardTemplateRouter,
  ratesRouter,
  roleCatalogRouter,
} from './modules/rates/routes';
import {
  clientsRouter,
  engagementsRouter,
  membersRouter,
  providersRouter,
} from './modules/engagements/routes';
import { invitesRouter } from './modules/invites/routes';
import { projectsRouter } from './modules/projects/routes';
import {
  expensesRouter,
  submissionsRouter,
  timeLogsRouter,
  workContextRouter,
} from './modules/work/routes';
import { pushRouter } from './modules/push/routes';
import { auditLogsRouter, auditSettingsRouter } from './modules/audit/routes';
import { portalRouter } from './modules/portal/routes';
import { lineItemNotesRouter } from './modules/notes/routes';
import { invoicesRouter } from './modules/invoices/routes';
import { fxRatesRouter } from './modules/money/routes';
import {
  commercialAgreementsRouter,
  rateProposalsRouter,
} from './modules/commercial/routes';
import { companyCreationRouter } from './modules/company-creation/routes';

/** Build the Express app. Kept separate from listen() so tests can import it. */
export function buildApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.json({ name: 'crewquo-api', version: '0.1.0' });
  });

  app.get('/healthz', async (_req, res) => {
    const dbUp = await pingDb();
    const body = healthResponseSchema.parse({
      status: 'ok',
      db: dbUp ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    });
    res.status(dbUp ? 200 : 503).json(body);
  });

  // Public auth routes (no X-Company-Id, no bearer).
  app.use('/v1/auth', authRouter);

  // Authenticated routes.
  app.use('/v1/me', requireAuth, meRouter);
  // Additional-company requests (§3.1.1). Companyless by nature — a request
  // exists before its tenant does, so it takes no X-Company-Id.
  app.use('/v1/company-creation-requests', requireAuth, companyCreationRouter);
  app.use('/v1/companies', requireAuth, companiesRouter);
  app.use('/v1/entitlements', requireAuth, entitlementsRouter);

  // Rate engine & catalog (§6). Company-scoped — active company via X-Company-Id.
  app.use('/v1/role-catalog', requireAuth, roleCatalogRouter);
  app.use('/v1/rate-card-templates', requireAuth, rateCardTemplateRouter);
  app.use('/v1/rate-cards', requireAuth, rateCardRouter);
  app.use('/v1/rates', requireAuth, ratesRouter);

  // Core work loop (§3.2, §3.4). Public invite GET + authed accept live inside.
  app.use('/v1/engagements', requireAuth, engagementsRouter);
  app.use('/v1/providers', requireAuth, providersRouter);
  app.use('/v1/clients', requireAuth, clientsRouter);
  app.use('/v1/members', requireAuth, membersRouter);
  app.use('/v1/invites', invitesRouter);
  app.use('/v1/projects', requireAuth, projectsRouter);
  app.use('/v1/work-context', requireAuth, workContextRouter);
  app.use('/v1/time-logs', requireAuth, timeLogsRouter);
  app.use('/v1/expenses', requireAuth, expensesRouter);
  app.use('/v1/project-submissions', requireAuth, submissionsRouter);
  app.use('/v1/push', requireAuth, pushRouter);

  // Client portal & audit (§3.6).
  app.use('/v1/portal', requireAuth, portalRouter);
  app.use('/v1/line-item-notes', requireAuth, lineItemNotesRouter);
  app.use('/v1/audit-logs', requireAuth, auditLogsRouter);
  app.use('/v1/audit-settings', requireAuth, auditSettingsRouter);
  app.use('/v1/invoices', requireAuth, invoicesRouter);

  // Commercial agreements (§3.3.1): cross-company PAY schedule negotiation, and one
  // engagement's whole commercial picture (terms + live rates + proposal history).
  // Money boundary (§3.3 decision #5): the exchange rates a converted figure
  // cites. No entitlement gate — see the note in the router.
  app.use('/v1/fx-rates', requireAuth, fxRatesRouter);

  app.use('/v1/rate-proposals', requireAuth, rateProposalsRouter);
  app.use('/v1/commercial-agreements', requireAuth, commercialAgreementsRouter);

  app.use('/v1/admin', requireAuth, requireSuperAdmin, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
