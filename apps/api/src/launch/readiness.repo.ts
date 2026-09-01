import { query, queryOne } from '../db';
import { env } from '../env';
import { readJobHealth } from '../jobs/jobRuns';
import { getPlatformSettings } from '../modules/admin/platform.repo';
import type { LaunchReadinessFacts } from './readiness';

interface PriceReadinessRow {
  sellable: number;
  unmapped: number;
}

interface FailureReadinessRow {
  dead_outbox: number;
  dead_webhooks: number;
  failed_notifications: number;
}

async function appliedMigrations(): Promise<Set<string>> {
  const exists = await queryOne<{ exists: boolean }>(
    `select to_regclass('public.schema_migrations') is not null as exists`
  );
  if (!exists?.exists) return new Set();
  const rows = await query<{ filename: string }>('select filename from schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

/** Read-only production facts behind the launch gate. No credential value is returned. */
export async function readLaunchReadinessFacts(
  expectedMigrations: readonly string[]
): Promise<LaunchReadinessFacts> {
  const [applied, settings, jobs, prices, failures] = await Promise.all([
    appliedMigrations(),
    getPlatformSettings(),
    readJobHealth(),
    queryOne<PriceReadinessRow>(
      `select
         count(*)::int as sellable,
         count(*) filter (where pp.provider_price_id is null)::int as unmapped
       from plan_prices pp
       join plans p on p.id = pp.plan_id
       where p.status = 'ACTIVE' and p.is_public = true
         and pp.active = true and pp.currency = 'USD' and pp.amount_cents > 0`
    ),
    queryOne<FailureReadinessRow>(
      `select
         (select count(*)::int from delivery_outbox where status = 'DEAD_LETTER') as dead_outbox,
         (select count(*)::int from webhook_inbox where status = 'DEAD_LETTER') as dead_webhooks,
         (select count(*)::int from notification_deliveries where status = 'FAILED') as failed_notifications`
    ),
  ]);

  return {
    nodeEnvironment: env.NODE_ENV,
    appBaseUrl: env.APP_BASE_URL,
    databaseHost: new URL(env.DATABASE_URL).hostname,
    missingMigrations: expectedMigrations.filter((filename) => !applied.has(filename)),
    authKeyMaterialIndependent:
      Boolean(env.AUTH_SOURCE_PEPPER) &&
      new Set([env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.AUTH_SOURCE_PEPPER]).size === 3,
    trustedProxyConfigured: env.TRUST_PROXY_HOPS > 0,
    emailConfigured: Boolean(env.RESEND_API_KEY && env.NOTIFICATION_FROM_EMAIL),
    emailProductionSender:
      Boolean(env.RESEND_API_KEY && env.NOTIFICATION_FROM_EMAIL) &&
      !env.NOTIFICATION_FROM_EMAIL?.toLowerCase().endsWith('@resend.dev'),
    apiSentryConfigured: Boolean(env.SENTRY_DSN),
    apiSentryReleaseConfigured: Boolean(env.SENTRY_RELEASE),
    webSentryConfigured: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
    webSentryReleaseConfigured: Boolean(process.env.NEXT_PUBLIC_SENTRY_RELEASE),
    overdueJobs: jobs.filter((job) => job.overdue).map((job) => job.job),
    deadOutbox: failures?.dead_outbox ?? 0,
    deadWebhooks: failures?.dead_webhooks ?? 0,
    failedNotifications: failures?.failed_notifications ?? 0,
    checkoutEnabled: settings.companyCheckoutEnabled,
    paddleEnvironment: env.PADDLE_ENVIRONMENT,
    paddleApiConfigured: Boolean(env.PADDLE_API_KEY),
    paddleWebhookConfigured: Boolean(env.PADDLE_WEBHOOK_SECRET),
    paddleClientConfigured: Boolean(process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN),
    paddleClientEnvironment: process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT ?? null,
    sellablePrices: prices?.sellable ?? 0,
    unmappedSellablePrices: prices?.unmapped ?? 0,
  };
}
