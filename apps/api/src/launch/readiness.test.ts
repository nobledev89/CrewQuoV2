import { describe, expect, it } from 'vitest';
import {
  evaluateLaunchReadiness,
  launchEvidenceSchema,
  summarizeLaunchReadiness,
  type LaunchEvidence,
  type LaunchReadinessFacts,
} from './readiness';

const READY_FACTS: LaunchReadinessFacts = {
  nodeEnvironment: 'production',
  appBaseUrl: 'https://app.crewquo.example',
  databaseHost: 'production-db.internal',
  missingMigrations: [],
  authKeyMaterialIndependent: true,
  trustedProxyConfigured: true,
  emailConfigured: true,
  emailProductionSender: true,
  apiSentryConfigured: true,
  apiSentryReleaseConfigured: true,
  webSentryConfigured: true,
  webSentryReleaseConfigured: true,
  overdueJobs: [],
  deadOutbox: 0,
  deadWebhooks: 0,
  failedNotifications: 0,
  checkoutEnabled: true,
  paddleEnvironment: 'production',
  paddleApiConfigured: true,
  paddleWebhookConfigured: true,
  paddleClientConfigured: true,
  paddleClientEnvironment: 'production',
  sellablePrices: 4,
  unmappedSellablePrices: 0,
};

const READY_EVIDENCE: LaunchEvidence = {
  legalReview: { completedAt: '2026-08-01T10:00:00.000Z', reference: 'legal/approval-42' },
  productionEmailDelivery: { completedAt: '2026-08-01T11:00:00.000Z', reference: 'ops/mail-9' },
  hostedErrorTracking: { completedAt: '2026-08-01T12:00:00.000Z', reference: 'sentry/event-4' },
  paddleSellerApproval: { completedAt: '2026-08-02T10:00:00.000Z', reference: 'paddle/account' },
  paddleLifecycle: { completedAt: '2026-08-03T10:00:00.000Z', reference: 'ops/paddle-smoke' },
  hostedRestore: { completedAt: '2026-08-04T10:00:00.000Z', reference: 'ops/restore-7' },
  statusChannel: { completedAt: '2026-08-05T10:00:00.000Z', reference: 'https://status.example' },
  realCompanyPilot: { completedAt: '2026-08-06T10:00:00.000Z', reference: 'pilot/project-1' },
};

function byId(facts: LaunchReadinessFacts, id: string) {
  return evaluateLaunchReadiness(facts, READY_EVIDENCE).find((check) => check.id === id)!;
}

describe('evaluateLaunchReadiness', () => {
  it('marks a fully evidenced production configuration ready', () => {
    const summary = summarizeLaunchReadiness(evaluateLaunchReadiness(READY_FACTS, READY_EVIDENCE));
    expect(summary).toEqual({ passed: 24, blocked: 0, manual: 0, ready: true });
  });

  it('does not accept a development runtime, local URL or local database', () => {
    const facts = {
      ...READY_FACTS,
      nodeEnvironment: 'development',
      appBaseUrl: 'https://preview.localhost',
      databaseHost: '127.20.30.40',
    };
    expect(byId(facts, 'runtime.production').status).toBe('BLOCKED');
    expect(byId(facts, 'runtime.public-url').status).toBe('BLOCKED');
    expect(byId(facts, 'database.hosted').status).toBe('BLOCKED');
  });

  it('names every migration that has not been applied', () => {
    const check = byId(
      { ...READY_FACTS, missingMigrations: ['0024_unique_provider_prices.sql', '0025_request_checkout.sql'] },
      'database.migrations'
    );
    expect(check.status).toBe('BLOCKED');
    expect(check.detail).toContain('0025_request_checkout.sql');
  });

  it('requires independent key material and the documented proxy boundary', () => {
    expect(byId({ ...READY_FACTS, authKeyMaterialIndependent: false }, 'access.key-material').status).toBe(
      'BLOCKED'
    );
    expect(byId({ ...READY_FACTS, trustedProxyConfigured: false }, 'access.proxy').status).toBe('BLOCKED');
  });

  it('requires both DSNs and immutable release names', () => {
    expect(byId({ ...READY_FACTS, apiSentryReleaseConfigured: false }, 'observability.api').status).toBe(
      'BLOCKED'
    );
    expect(byId({ ...READY_FACTS, webSentryConfigured: false }, 'observability.web').status).toBe(
      'BLOCKED'
    );
  });

  it('does not mistake Resend shared test sending for production email', () => {
    const check = byId({ ...READY_FACTS, emailProductionSender: false }, 'delivery.email');
    expect(check.status).toBe('BLOCKED');
    expect(check.detail).toContain('reaches only the account owner');
  });

  it('blocks on overdue jobs and terminal delivery failures', () => {
    expect(byId({ ...READY_FACTS, overdueJobs: ['workers'] }, 'operations.scheduler')).toMatchObject({
      status: 'BLOCKED',
      detail: expect.stringContaining('workers'),
    });
    expect(
      byId({ ...READY_FACTS, deadWebhooks: 2, failedNotifications: 1 }, 'operations.delivery')
    ).toMatchObject({ status: 'BLOCKED', detail: expect.stringContaining('2 webhook') });
  });

  it('requires the complete Paddle credential chain and matching environments', () => {
    expect(byId({ ...READY_FACTS, paddleWebhookConfigured: false }, 'billing.paddle-server').status).toBe(
      'BLOCKED'
    );
    const client = byId(
      { ...READY_FACTS, paddleClientEnvironment: 'sandbox' },
      'billing.paddle-client'
    );
    expect(client.status).toBe('BLOCKED');
    expect(client.detail).toContain('does not match');
  });

  it('does not mistake sandbox checkout for production checkout', () => {
    expect(byId({ ...READY_FACTS, paddleEnvironment: 'sandbox' }, 'billing.paddle-production').status).toBe(
      'BLOCKED'
    );
  });

  it('requires at least one sellable price and maps every sellable price', () => {
    expect(byId({ ...READY_FACTS, sellablePrices: 0 }, 'billing.price-mappings').status).toBe('BLOCKED');
    const partlyMapped = byId(
      { ...READY_FACTS, sellablePrices: 4, unmappedSellablePrices: 1 },
      'billing.price-mappings'
    );
    expect(partlyMapped.detail).toContain('1 of 4');
  });

  it('treats absent owner evidence as unresolved, not as a guessed failure or pass', () => {
    const checks = evaluateLaunchReadiness(READY_FACTS);
    const summary = summarizeLaunchReadiness(checks);
    expect(summary).toEqual({ passed: 16, blocked: 0, manual: 8, ready: false });
    expect(checks.filter((check) => check.status === 'MANUAL')).toHaveLength(8);
  });
});

describe('launchEvidenceSchema', () => {
  it('rejects undated, empty and unknown attestations', () => {
    expect(
      launchEvidenceSchema.safeParse({ legalReview: { completedAt: 'yesterday', reference: '' } }).success
    ).toBe(false);
    expect(launchEvidenceSchema.safeParse({ inventedGate: READY_EVIDENCE.legalReview }).success).toBe(false);
  });

  it('accepts the complete evidence contract', () => {
    expect(launchEvidenceSchema.parse(READY_EVIDENCE)).toEqual(READY_EVIDENCE);
  });
});
