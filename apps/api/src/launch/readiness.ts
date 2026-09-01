import { z } from 'zod';

export const LAUNCH_EVIDENCE_KEYS = [
  'legalReview',
  'productionEmailDelivery',
  'hostedErrorTracking',
  'paddleSellerApproval',
  'paddleLifecycle',
  'hostedRestore',
  'statusChannel',
  'realCompanyPilot',
] as const;

export type LaunchEvidenceKey = (typeof LAUNCH_EVIDENCE_KEYS)[number];

const evidenceItemSchema = z.object({
  completedAt: z.string().datetime({ offset: true }),
  reference: z.string().trim().min(1).max(500),
});

export const launchEvidenceSchema = z
  .object(Object.fromEntries(LAUNCH_EVIDENCE_KEYS.map((key) => [key, evidenceItemSchema.optional()])))
  .strict();

export type LaunchEvidence = z.infer<typeof launchEvidenceSchema>;

export type LaunchCheckStatus = 'PASS' | 'BLOCKED' | 'MANUAL';

export interface LaunchCheck {
  id: string;
  label: string;
  status: LaunchCheckStatus;
  detail: string;
}

export interface LaunchReadinessFacts {
  nodeEnvironment: string;
  appBaseUrl: string;
  databaseHost: string;
  missingMigrations: string[];
  authKeyMaterialIndependent: boolean;
  trustedProxyConfigured: boolean;
  emailConfigured: boolean;
  emailProductionSender: boolean;
  apiSentryConfigured: boolean;
  apiSentryReleaseConfigured: boolean;
  webSentryConfigured: boolean;
  webSentryReleaseConfigured: boolean;
  overdueJobs: string[];
  deadOutbox: number;
  deadWebhooks: number;
  failedNotifications: number;
  checkoutEnabled: boolean;
  paddleEnvironment: 'sandbox' | 'production';
  paddleApiConfigured: boolean;
  paddleWebhookConfigured: boolean;
  paddleClientConfigured: boolean;
  paddleClientEnvironment: string | null;
  sellablePrices: number;
  unmappedSellablePrices: number;
}

const MANUAL_CHECKS: ReadonlyArray<{
  key: LaunchEvidenceKey;
  label: string;
  missing: string;
}> = [
  {
    key: 'legalReview',
    label: 'Production legal review',
    missing: 'Contracting entity, privacy particulars, governing terms and public pages need recorded approval.',
  },
  {
    key: 'productionEmailDelivery',
    label: 'Production email receipt',
    missing: 'Record delivery to a real non-owner address from the verified production domain.',
  },
  {
    key: 'hostedErrorTracking',
    label: 'Hosted error-tracking receipt',
    missing: 'Record one scrubbed API event and one scrubbed browser event in the hosted Sentry project.',
  },
  {
    key: 'paddleSellerApproval',
    label: 'Paddle seller and payout approval',
    missing: 'Seller KYC, merchant approval and payout setup cannot be inferred from credentials.',
  },
  {
    key: 'paddleLifecycle',
    label: 'Paddle lifecycle rehearsal',
    missing: 'Record purchase, renewal, failed payment, cancellation, refund and replay evidence.',
  },
  {
    key: 'hostedRestore',
    label: 'Hosted restore rehearsal',
    missing: 'Record a restore from a provider backup plus measured RPO and RTO.',
  },
  {
    key: 'statusChannel',
    label: 'Independent status channel',
    missing: 'Record a public status channel hosted outside the application failure domain.',
  },
  {
    key: 'realCompanyPilot',
    label: 'Real-company pilot',
    missing: 'Record one real company completing one real project end to end.',
  },
];

function automated(
  id: string,
  label: string,
  passed: boolean,
  passedDetail: string,
  blockedDetail: string
): LaunchCheck {
  return {
    id,
    label,
    status: passed ? 'PASS' : 'BLOCKED',
    detail: passed ? passedDetail : blockedDetail,
  };
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.')
  );
}

function isPublicHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

export function evaluateLaunchReadiness(
  facts: LaunchReadinessFacts,
  evidence: LaunchEvidence = {}
): LaunchCheck[] {
  const paddleClientEnvironmentMatches = facts.paddleClientEnvironment === facts.paddleEnvironment;
  const deliveryFailures = facts.deadOutbox + facts.deadWebhooks + facts.failedNotifications;

  const checks: LaunchCheck[] = [
    automated(
      'runtime.production',
      'Production runtime',
      facts.nodeEnvironment === 'production',
      'NODE_ENV is production.',
      `NODE_ENV is ${facts.nodeEnvironment}; run the gate with the production deployment configuration.`
    ),
    automated(
      'runtime.public-url',
      'Public application URL',
      isPublicHttps(facts.appBaseUrl),
      `APP_BASE_URL is a public HTTPS origin (${facts.appBaseUrl}).`,
      `APP_BASE_URL must be a public HTTPS origin; received ${facts.appBaseUrl}.`
    ),
    automated(
      'database.hosted',
      'Hosted database target',
      !isLocalHost(facts.databaseHost),
      `The database target is remote (${facts.databaseHost}).`,
      `The database target is local (${facts.databaseHost}); this is not the hosted launch database.`
    ),
    automated(
      'database.migrations',
      'Database migrations',
      facts.missingMigrations.length === 0,
      'Every checked-in migration is recorded as applied.',
      `Missing migrations: ${facts.missingMigrations.join(', ')}.`
    ),
    automated(
      'access.key-material',
      'Production access key material',
      facts.authKeyMaterialIndependent,
      'Access signing, refresh signing and source hashing use three independent values.',
      'Set AUTH_SOURCE_PEPPER and keep it different from both distinct JWT signing secrets.'
    ),
    automated(
      'access.proxy',
      'Reverse-proxy trust',
      facts.trustedProxyConfigured,
      'At least one trusted proxy hop is configured for source-address rate limits.',
      'TRUST_PROXY_HOPS is 0; on the documented Render topology every caller would share the proxy address.'
    ),
    automated(
      'delivery.email',
      'Transactional email',
      facts.emailConfigured && facts.emailProductionSender,
      'Resend is configured with a production-domain from-address.',
      !facts.emailConfigured
        ? 'RESEND_API_KEY and NOTIFICATION_FROM_EMAIL must both be configured.'
        : 'The shared resend.dev sender reaches only the account owner; configure a verified production domain.'
    ),
    automated(
      'observability.api',
      'API error tracking',
      facts.apiSentryConfigured && facts.apiSentryReleaseConfigured,
      'The API Sentry DSN and release are configured.',
      'SENTRY_DSN and SENTRY_RELEASE must both be configured.'
    ),
    automated(
      'observability.web',
      'Web error tracking',
      facts.webSentryConfigured && facts.webSentryReleaseConfigured,
      'The browser Sentry DSN and release are configured.',
      'NEXT_PUBLIC_SENTRY_DSN and NEXT_PUBLIC_SENTRY_RELEASE must both be configured.'
    ),
    automated(
      'operations.scheduler',
      'Scheduled jobs',
      facts.overdueJobs.length === 0,
      'Every scheduled job has succeeded inside its overdue window.',
      `Overdue or never successful: ${facts.overdueJobs.join(', ') || 'unknown'}.`
    ),
    automated(
      'operations.delivery',
      'Delivery failure queues',
      deliveryFailures === 0,
      'No outbox, webhook or notification delivery is dead-lettered.',
      `${facts.deadOutbox} outbox, ${facts.deadWebhooks} webhook and ${facts.failedNotifications} notification failures require review.`
    ),
    automated(
      'billing.paddle-server',
      'Paddle server configuration',
      facts.paddleApiConfigured && facts.paddleWebhookConfigured,
      'The Paddle API key and webhook secret are configured.',
      'PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET must both be configured.'
    ),
    automated(
      'billing.paddle-client',
      'Paddle browser configuration',
      facts.paddleClientConfigured && paddleClientEnvironmentMatches,
      `The Paddle client token is configured for ${facts.paddleEnvironment}.`,
      !facts.paddleClientConfigured
        ? 'NEXT_PUBLIC_PADDLE_CLIENT_TOKEN must be configured.'
        : `Browser environment ${facts.paddleClientEnvironment ?? 'unset'} does not match server environment ${facts.paddleEnvironment}.`
    ),
    automated(
      'billing.paddle-production',
      'Paddle production mode',
      facts.paddleEnvironment === 'production',
      'Paddle is configured for production.',
      'PADDLE_ENVIRONMENT is sandbox; do not open public checkout against it.'
    ),
    automated(
      'billing.price-mappings',
      'Sellable price mappings',
      facts.sellablePrices > 0 && facts.unmappedSellablePrices === 0,
      `All ${facts.sellablePrices} active public paid prices have provider ids.`,
      facts.sellablePrices === 0
        ? 'No active public paid prices exist.'
        : `${facts.unmappedSellablePrices} of ${facts.sellablePrices} active public paid prices lack provider ids.`
    ),
    automated(
      'billing.checkout-enabled',
      'Public checkout switch',
      facts.checkoutEnabled,
      'The operator checkout switch is enabled.',
      'The operator checkout switch is off; customers cannot subscribe.'
    ),
  ];

  for (const item of MANUAL_CHECKS) {
    const proof = evidence[item.key];
    checks.push(
      proof
        ? {
            id: `evidence.${item.key}`,
            label: item.label,
            status: 'PASS',
            detail: `Completed ${proof.completedAt}; evidence: ${proof.reference}`,
          }
        : {
            id: `evidence.${item.key}`,
            label: item.label,
            status: 'MANUAL',
            detail: item.missing,
          }
    );
  }

  return checks;
}

export function summarizeLaunchReadiness(checks: readonly LaunchCheck[]): {
  passed: number;
  blocked: number;
  manual: number;
  ready: boolean;
} {
  const passed = checks.filter((check) => check.status === 'PASS').length;
  const blocked = checks.filter((check) => check.status === 'BLOCKED').length;
  const manual = checks.filter((check) => check.status === 'MANUAL').length;
  return { passed, blocked, manual, ready: blocked === 0 && manual === 0 };
}
