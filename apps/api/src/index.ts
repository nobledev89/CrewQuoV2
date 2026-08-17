import { buildApp } from './app';
import { env } from './env';
import { startAuditPurgeSchedule } from './jobs/auditPurge';

const app = buildApp();

app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

if (env.AUDIT_PURGE_ENABLED) startAuditPurgeSchedule();
