import cors from 'cors';
import express from 'express';
import { healthResponseSchema } from '@crewquo/shared';
import { env } from './env';
import { pingDb } from './db';

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

app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});
