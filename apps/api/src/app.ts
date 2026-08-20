import cors from 'cors';
import express, { type Express } from 'express';
import { healthResponseSchema } from '@crewquo/shared';
import { pingDb } from './db';
import { env } from './env';
import { errorHandler, notFoundHandler } from './http/errorHandler';
import { requireAuth, requireSuperAdmin } from './http/middleware/auth';
import { authRouter } from './modules/auth/routes';
import { sessionsRouter } from './modules/auth/sessions.routes';
import { mfaRouter } from './modules/auth/mfa.routes';
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
import {
  notificationPreferencesRouter,
  notificationsRouter,
} from './modules/notifications/routes';
import {
  commercialAgreementsRouter,
  rateProposalsRouter,
} from './modules/commercial/routes';
import { companyCreationRouter } from './modules/company-creation/routes';

/**
 * Browser origins this API answers to (`docs/operating-model/access.md` §10.4).
 *
 * The app's own origin, plus whatever `CORS_EXTRA_ORIGINS` names. Deduplicated so
 * a deployment that repeats `APP_BASE_URL` in the extras list is not a bug.
 */
function allowedOrigins(): string[] {
  const extras = env.CORS_EXTRA_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return [...new Set([env.APP_BASE_URL, ...extras].flatMap(loopbackSiblings))];
}

/**
 * `http://localhost:3000` and `http://127.0.0.1:3000` are the same server, so
 * allowing one allows the other.
 *
 * **Not a convenience — a correctness fix for a footgun this repo has already been
 * bitten by twice.** The Playwright config binds `127.0.0.1` explicitly and says
 * why: on this platform the two names resolve differently enough to break a health
 * check while the server is perfectly fine, the same shadowing the Phase 1 Postgres
 * note recorded. Without this, the allowlist would have rejected the browser suite
 * on a spelling, and the obvious "fix" is a developer widening `CORS_EXTRA_ORIGINS`
 * by hand until it eventually gets widened too far.
 *
 * Costs nothing in security: both names address the same loopback interface, and
 * anybody able to serve a page from your loopback already owns the machine. Applies
 * only to loopback, so a production `APP_BASE_URL` generates no siblings at all.
 */
function loopbackSiblings(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost') {
      return [origin, origin.replace('//localhost', '//127.0.0.1')];
    }
    if (url.hostname === '127.0.0.1') {
      return [origin, origin.replace('//127.0.0.1', '//localhost')];
    }
    return [origin];
  } catch {
    // A malformed entry is kept verbatim rather than dropped: it will simply never
    // match, and silently discarding configuration is how a deployment ends up
    // wondering why its origin is refused.
    return [origin];
  }
}

/**
 * Headers every response carries, whatever it is.
 *
 * A JSON API is not a document, so most of these are about what a browser must
 * *refuse* to do with the response rather than how to render it. Hand-written
 * rather than pulled from `helmet`: six headers with a stated reason each is
 * easier to audit than a dependency whose defaults change between majors, and
 * nothing here needs the rest of what helmet does.
 */
function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    // No HTML is ever served, so the safest CSP is one that permits nothing at
    // all: if a response is somehow rendered as a document, it can load nothing.
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // Stops a browser second-guessing a JSON content type into something
    // executable, which is the whole content-sniffing attack class.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // An API URL can carry a project or invoice id; no referrer means no leaking
    // one to whatever a link happens to point at.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Error bodies name projects and companies. A shared cache holding one is a
    // cross-tenant leak that never touches this code.
    res.setHeader('Cache-Control', 'no-store');
    if (env.NODE_ENV === 'production') {
      // Only in production: sending HSTS from a dev server pins localhost to
      // HTTPS in the developer's browser, which is a very annoying afternoon.
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/** Build the Express app. Kept separate from listen() so tests can import it. */
export function buildApp(): Express {
  const app = express();

  // Rate limiting keys on `req.ip`, and behind a proxy every request arrives from
  // the proxy — so without this the source budget sees the entire internet as one
  // caller. Not defaulted to `true`: trusting a header nobody set lets a caller
  // forge their own source and escape the budget, so the hop count is stated per
  // deployment.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.disable('x-powered-by');
  app.use(securityHeaders());

  /*
   * **An allowlist, replacing `cors()` with no options.**
   *
   * The bare call reflects whatever `Origin` it is sent, which combined with
   * bearer tokens held in browser storage meant any page a signed-in user visited
   * could call this API as them. `credentials` stays off because CrewQuo
   * authenticates with an `Authorization` header rather than a cookie — there is
   * nothing for a browser to attach automatically, and turning it on would only
   * widen what a future cookie could do.
   *
   * A request with no `Origin` is allowed: that is every server-to-server caller,
   * the mobile app and curl, none of which a browser policy governs anyway.
   */
  const origins = allowedOrigins();
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || origins.includes(origin)),
      credentials: false,
    })
  );

  // An explicit ceiling rather than the framework default, so the limit is a
  // decision. Every payload this API accepts is a form; file content goes to
  // object storage through a presigned URL and never through here.
  app.use(express.json({ limit: '256kb' }));

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
  //
  // Sessions are mounted BEFORE `/v1/me` deliberately. Express would fall through
  // from one router to the next anyway, but "the more specific path is registered
  // first" is a property worth not relying on the fall-through for: a future
  // `/:something` route inside `meRouter` would otherwise swallow this silently.
  app.use('/v1/me/sessions', requireAuth, sessionsRouter);
  app.use('/v1/me/mfa', requireAuth, mfaRouter);
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

  // The inbox, and the Universal Action Centre as its actionable subset. Reads
  // are scoped to the calling user, never to a company role — see the router.
  app.use('/v1/notifications', requireAuth, notificationsRouter);
  app.use('/v1/notification-preferences', requireAuth, notificationPreferencesRouter);

  app.use('/v1/rate-proposals', requireAuth, rateProposalsRouter);
  app.use('/v1/commercial-agreements', requireAuth, commercialAgreementsRouter);

  app.use('/v1/admin', requireAuth, requireSuperAdmin, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
