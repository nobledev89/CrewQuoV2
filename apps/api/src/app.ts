import cors from 'cors';
import express, { type Express } from 'express';
import { healthResponseSchema } from '@crewquo/shared';
import { pingDb } from './db';
import { errorHandler, notFoundHandler } from './http/errorHandler';
import { requireAuth, requireSuperAdmin } from './http/middleware/auth';
import { authRouter } from './modules/auth/routes';
import { meRouter } from './modules/me/routes';
import { entitlementsRouter } from './modules/entitlements/routes';
import { adminRouter } from './modules/admin/routes';

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
  app.use('/v1/entitlements', requireAuth, entitlementsRouter);
  app.use('/v1/admin', requireAuth, requireSuperAdmin, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
