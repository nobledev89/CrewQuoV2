import type {
  AdminDashboard,
  AdminOperations,
  AdminPlatformAudit,
  AdminPlatformSettings,
  AdminPlatformSettingsUpdate,
  AdminReporting,
  AdminUserDetail,
  AdminUserListQuery,
  AdminUserSummary,
} from '@crewquo/shared';
import { query, queryOne, withTransaction, type Queryable } from '../../db';
import { env } from '../../env';
import { AppError } from '../../http/errors';
import { notificationDeliveryHealth } from '../notifications/deliveryWorker';

const DEFAULT_SETTINGS: AdminPlatformSettings = {
  platformName: 'CrewQuo Platform',
  supportEmail: '',
  registrationOpen: true,
  maintenanceMode: false,
  maintenanceMessage: '',
  requireVerifiedEmailForFirstCompany: false,
  companyCheckoutEnabled: false,
};

/**
 * `platform.company_creation` (§3.1.1) is stored under its own key rather than
 * folded into `platform.access`, because its two flags are read on a hot path by
 * the creation service and are each waiting on a different Phase 6 bullet —
 * Resend for verification, Gumroad for checkout. Keeping them separable is what
 * lets either be flipped the day its dependency lands.
 */
const SETTINGS_KEYS = ['platform.branding', 'platform.access', 'platform.company_creation'];

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  changes: Record<string, unknown>;
  description: string | null;
  created_at: Date;
}

function toAudit(row: AuditRow): AdminPlatformAudit {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    changes: row.changes,
    description: row.description,
    createdAt: row.created_at.toISOString(),
  };
}

export async function recordPlatformAudit(input: {
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  changes?: Record<string, unknown>;
  description?: string | null;
}, runner?: Queryable): Promise<void> {
  await query(
    `insert into platform_audit_logs
       (actor_user_id, action, entity_type, entity_id, changes, description)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.actorUserId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.changes ?? {}),
      input.description ?? null,
    ],
    runner
  );
}

export async function listPlatformAudit(limit = 30): Promise<AdminPlatformAudit[]> {
  const rows = await query<AuditRow>(
    `select a.id, a.actor_user_id, u.name as actor_name, u.email as actor_email,
            a.action, a.entity_type, a.entity_id, a.changes, a.description, a.created_at
       from platform_audit_logs a
       left join users u on u.id = a.actor_user_id
      order by a.created_at desc, a.id desc
      limit $1`,
    [limit]
  );
  return rows.map(toAudit);
}

export async function getAdminDashboard(): Promise<AdminDashboard> {
  const [totals, attention, plans, recentUsers, recentCompanies] = await Promise.all([
    queryOne<AdminDashboard['totals']>(
      `select
        (select count(*)::int from users) as users,
        (select count(*)::int from users where email_verified_at is not null) as "verifiedUsers",
        (select count(*)::int from users where is_super_admin) as "superAdmins",
        (select count(*)::int from companies where not is_placeholder and claimed_by_company_id is null) as companies,
        (select count(*)::int from companies where is_placeholder and claimed_by_company_id is null) as placeholders,
        (select count(*)::int from company_subscriptions where status in ('ACTIVE','TRIALING') and plan_id <> 'crew') as "paidCompanies",
        (select count(*)::int from company_subscriptions where status = 'TRIALING') as "trialingCompanies",
        (select count(*)::int from projects where status = 'ACTIVE') as "activeProjects",
        ((select count(*)::int from time_logs where status = 'SUBMITTED') +
         (select count(*)::int from expenses where status = 'SUBMITTED')) as "pendingWork",
        (select count(*)::int from invoices where status = 'ISSUED') as "issuedInvoices"`
    ),
    queryOne<AdminDashboard['attention']>(
      `select
        (select count(*)::int from invites where status = 'PENDING' and expires_at > now()) as "pendingInvites",
        (select count(*)::int from company_subscriptions where status = 'PAST_DUE') as "pastDueSubscriptions",
        (select count(*)::int from company_subscriptions where status = 'TRIALING' and trial_end between now() and now() + interval '14 days') as "trialsExpiringSoon",
        (select count(*)::int from company_entitlement_overrides where expires_at between now() and now() + interval '14 days') as "overridesExpiringSoon"`
    ),
    query<{ key: string; count: number }>(
      `select coalesce(s.plan_id, 'crew') as key, count(*)::int as count
         from companies c left join company_subscriptions s on s.company_id = c.id
        where not c.is_placeholder and c.claimed_by_company_id is null
        group by coalesce(s.plan_id, 'crew') order by count desc, key`
    ),
    query<{ id: string; name: string; email: string; is_super_admin: boolean; created_at: Date }>(
      `select id, name, email, is_super_admin, created_at
         from users order by created_at desc limit 6`
    ),
    query<{
      id: string; name: string; currency: string; plan_id: string; subscription_status: AdminDashboard['recentCompanies'][number]['subscriptionStatus'];
      trial_end: Date | null; current_period_end: Date | null; member_count: number; override_count: number; created_at: Date;
    }>(
      `select c.id, c.name, c.currency, coalesce(s.plan_id, 'crew') as plan_id,
              s.status as subscription_status, s.trial_end, s.current_period_end,
              (select count(*)::int from memberships m where m.company_id = c.id and m.status = 'ACTIVE') as member_count,
              (select count(*)::int from company_entitlement_overrides o where o.company_id = c.id and (o.expires_at is null or o.expires_at > now())) as override_count,
              c.created_at
         from companies c left join company_subscriptions s on s.company_id = c.id
        where not c.is_placeholder and c.claimed_by_company_id is null
        order by c.created_at desc limit 6`
    ),
  ]);

  return {
    totals: totals!,
    attention: attention!,
    planDistribution: plans,
    recentUsers: recentUsers.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      isSuperAdmin: row.is_super_admin,
      createdAt: row.created_at.toISOString(),
    })),
    recentCompanies: recentCompanies.map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      isPlaceholder: false,
      claimedByCompanyId: null,
      planId: row.plan_id,
      subscriptionStatus: row.subscription_status,
      trialEnd: row.trial_end?.toISOString() ?? null,
      currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
      memberCount: row.member_count,
      overrideCount: row.override_count,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  is_super_admin: boolean;
  email_verified: boolean;
  membership_count: number;
  active_session_count: number;
  created_at: Date;
}

function toAdminUser(row: AdminUserRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    isSuperAdmin: row.is_super_admin,
    emailVerified: row.email_verified,
    membershipCount: row.membership_count,
    activeSessionCount: row.active_session_count,
    createdAt: row.created_at.toISOString(),
  };
}

const ADMIN_USER_SELECT = `select u.id, u.email, u.name, u.avatar_url, u.is_super_admin,
  (u.email_verified_at is not null) as email_verified,
  (select count(*)::int from memberships m where m.user_id = u.id and m.status = 'ACTIVE') as membership_count,
  -- Sessions, not tokens. One session legitimately holds two live tokens for the
  -- length of a grace window (0018), so counting tokens would show an operator two
  -- devices where the customer has one - and this number is metadata about somebody
  -- else's account, which is the one kind of number that must not be overstated.
  (select count(*)::int from auth_sessions s
    where s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as active_session_count,
  u.created_at from users u`;

export async function listAdminUsers(input: AdminUserListQuery): Promise<AdminUserSummary[]> {
  const values: unknown[] = [];
  const where: string[] = [];
  if (input.search) {
    values.push(`%${input.search}%`);
    where.push(`(u.name ilike $${values.length} or u.email ilike $${values.length})`);
  }
  if (input.access === 'SUPER_ADMIN') where.push('u.is_super_admin');
  if (input.access === 'CUSTOMER') where.push('not u.is_super_admin');
  if (input.verification === 'VERIFIED') where.push('u.email_verified_at is not null');
  if (input.verification === 'UNVERIFIED') where.push('u.email_verified_at is null');
  values.push(input.limit);
  const rows = await query<AdminUserRow>(
    `${ADMIN_USER_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''}
      order by u.created_at desc limit $${values.length}`,
    values
  );
  return rows.map(toAdminUser);
}

export async function getAdminUser(userId: string): Promise<AdminUserDetail | null> {
  const row = await queryOne<AdminUserRow>(`${ADMIN_USER_SELECT} where u.id = $1`, [userId]);
  if (!row) return null;
  const memberships = await query<AdminUserDetail['memberships'][number]>(
    `select m.id as "membershipId", c.id as "companyId", c.name as "companyName", m.role, m.status
       from memberships m join companies c on c.id = m.company_id
      where m.user_id = $1 order by c.name`,
    [userId]
  );
  return { user: toAdminUser(row), memberships };
}

export async function setUserSuperAdmin(
  actorUserId: string,
  userId: string,
  enabled: boolean,
  reason: string
): Promise<AdminUserSummary> {
  if (!enabled && actorUserId === userId) {
    throw new AppError('CONFLICT', 'You cannot remove your own super-admin access');
  }
  return withTransaction(async (client) => {
    const before = await queryOne<{ is_super_admin: boolean; email_verified: boolean }>(
      'select is_super_admin, email_verified_at is not null as email_verified from users where id = $1 for update', [userId], client
    );
    if (!before) throw new AppError('NOT_FOUND', 'User not found');
    if (enabled && !before.is_super_admin && !before.email_verified) {
      throw new AppError('CONFLICT', 'Verify this user’s email before granting super-admin access');
    }
    if (!enabled) {
      const admins = await queryOne<{ count: number }>(
        'select count(*)::int as count from users where is_super_admin', [], client
      );
      if ((admins?.count ?? 0) <= 1) throw new AppError('CONFLICT', 'At least one super admin is required');
    }
    await query('update users set is_super_admin = $2, updated_at = now() where id = $1', [userId, enabled], client);
    await recordPlatformAudit({
      actorUserId,
      action: enabled ? 'user.super_admin_granted' : 'user.super_admin_revoked',
      entityType: 'USER',
      entityId: userId,
      changes: { from: before.is_super_admin, to: enabled, reason },
      description: `Super-admin access was ${enabled ? 'granted' : 'revoked'}`,
    }, client);
    const updated = await queryOne<AdminUserRow>(`${ADMIN_USER_SELECT} where u.id = $1`, [userId], client);
    return toAdminUser(updated!);
  });
}

export async function getAdminReporting(days: number): Promise<AdminReporting> {
  const since = `${days} days`;
  const [signups, companies, plans, subscriptions, workflow] = await Promise.all([
    query<{ day: string; count: number }>(
      `select date_trunc('day', created_at)::date::text as day, count(*)::int as count
         from users where created_at >= now() - $1::interval group by 1 order by 1`, [since]
    ),
    query<{ day: string; count: number }>(
      `select date_trunc('day', created_at)::date::text as day, count(*)::int as count
         from companies where not is_placeholder and created_at >= now() - $1::interval group by 1 order by 1`, [since]
    ),
    query<{ key: string; count: number }>(
      `select coalesce(s.plan_id, 'crew') as key, count(*)::int as count
         from companies c left join company_subscriptions s on s.company_id = c.id
        where not c.is_placeholder and c.claimed_by_company_id is null group by 1 order by count desc`
    ),
    query<{ key: string; count: number }>(
      `select status as key, count(*)::int as count from company_subscriptions group by status order by count desc`
    ),
    queryOne<AdminReporting['workflow']>(
      `select
        (select count(*)::int from projects where created_at >= now() - $1::interval) as projects,
        (select count(*)::int from time_logs where created_at >= now() - $1::interval) as "timeLogs",
        (select count(*)::int from time_logs where status = 'SUBMITTED' and created_at >= now() - $1::interval) as "submittedTimeLogs",
        (select count(*)::int from invoices where created_at >= now() - $1::interval) as invoices,
        (select count(*)::int from invoices where status = 'ISSUED' and created_at >= now() - $1::interval) as "issuedInvoices",
        (select count(*)::int from engagements where status = 'ACTIVE') as "activeEngagements"`, [since]
    ),
  ]);
  return {
    days,
    signupsByDay: signups,
    companiesByDay: companies,
    planDistribution: plans,
    subscriptionDistribution: subscriptions,
    workflow: workflow!,
  };
}

export async function getAdminOperations(): Promise<AdminOperations> {
  const [invites, overrides, recentAudit, delivery, deadLetters, notifications] =
    await Promise.all([
    query<{ id: string; kind: string; email: string; company_name: string; expires_at: Date }>(
      `select i.id, i.kind, i.email, c.name as company_name, i.expires_at
         from invites i join companies c on c.id = i.target_company_id
        where i.status = 'PENDING' and i.expires_at > now()
        order by i.expires_at asc limit 25`
    ),
    query<{ id: string; company_id: string; company_name: string; subject: string; expires_at: Date }>(
      `select o.id, o.company_id, c.name as company_name,
              coalesce(o.feature_key, o.limit_key) as subject, o.expires_at
         from company_entitlement_overrides o join companies c on c.id = o.company_id
        where o.expires_at between now() and now() + interval '30 days'
        order by o.expires_at asc limit 25`
    ),
    listPlatformAudit(30),
    queryOne<AdminOperations['delivery']>(
      `select
        (select count(*)::int from delivery_outbox where status = 'PENDING') as "pendingOutbox",
        (select count(*)::int from delivery_outbox where status = 'PROCESSING') as "processingOutbox",
        (select count(*)::int from delivery_outbox where status = 'DEAD_LETTER') as "deadOutbox",
        (select count(*)::int from webhook_inbox where status = 'RECEIVED') as "receivedWebhooks",
        (select count(*)::int from webhook_inbox where status = 'PROCESSING') as "processingWebhooks",
        (select count(*)::int from webhook_inbox where status = 'DEAD_LETTER') as "deadWebhooks"`
    ),
    query<{ id: string; source: 'OUTBOX' | 'WEBHOOK'; kind: string; attempts: number; last_error: string | null; failed_at: Date }>(
      `select id, 'OUTBOX'::text as source, topic as kind, attempts, last_error, updated_at as failed_at
         from delivery_outbox where status = 'DEAD_LETTER'
       union all
       select id, 'WEBHOOK'::text as source, provider || ':' || event_type as kind,
              attempts, last_error, updated_at as failed_at
         from webhook_inbox where status = 'DEAD_LETTER'
       order by failed_at desc limit 50`
    ),
    // The notification channel queue is a second, separately-drained loop. Its
    // health was computable from day one and shown nowhere, which meant an
    // operator watching this screen could see a perfectly healthy outbox while
    // every email in the system was failing.
    notificationDeliveryHealth(),
  ]);
  return {
    delivery: delivery!,
    notifications,
    deadLetters: deadLetters.map((row) => ({
      id: row.id,
      source: row.source,
      kind: row.kind,
      attempts: row.attempts,
      lastError: row.last_error,
      failedAt: row.failed_at.toISOString(),
    })),
    pendingInvites: invites.map((row) => ({
      id: row.id, kind: row.kind, email: row.email, companyName: row.company_name,
      expiresAt: row.expires_at.toISOString(),
    })),
    expiringOverrides: overrides.map((row) => ({
      id: row.id, companyId: row.company_id, companyName: row.company_name,
      subject: row.subject, expiresAt: row.expires_at.toISOString(),
    })),
    recentAudit,
    services: [
      { name: 'API and database', status: 'HEALTHY', detail: 'The platform read model completed successfully.' },
      {
        name: 'Durable delivery',
        status: (delivery!.deadOutbox + delivery!.deadWebhooks) > 0 ? 'ATTENTION' : 'HEALTHY',
        detail: `${delivery!.pendingOutbox} outbox and ${delivery!.receivedWebhooks} webhook events ready; ${delivery!.deadOutbox + delivery!.deadWebhooks} dead-lettered.`,
      },
      {
        name: 'Notification delivery',
        status: notifications.failed > 0 ? 'ATTENTION' : 'HEALTHY',
        detail:
          `${notifications.pending} queued; ${notifications.sentLastDay} sent and ` +
          `${notifications.skippedLastDay} skipped in the last day; ` +
          `${notifications.failed} failed.`,
      },
      {
        name: 'Merchant of Record',
        status: 'NOT_CONFIGURED',
        detail: 'No merchant of record is selected; checkout is off.',
      },
      {
        name: 'Email provider',
        // Configuration, not queue health — the row above is the queue. Split
        // because "no API key" and "the provider is rejecting us" are different
        // problems with different fixes, and one row cannot say both.
        status: env.RESEND_API_KEY && env.NOTIFICATION_FROM_EMAIL ? 'HEALTHY' : 'NOT_CONFIGURED',
        detail:
          env.RESEND_API_KEY && env.NOTIFICATION_FROM_EMAIL
            ? `Resend is configured; mail is sent from ${env.NOTIFICATION_FROM_EMAIL}.`
            : 'No Resend API key or from-address, so every email is recorded as skipped.',
      },
    ],
  };
}

export async function getPlatformSettings(runner?: Queryable): Promise<AdminPlatformSettings> {
  const rows = await query<{ key: string; value: Record<string, unknown> }>(
    `select key, value from system_settings where key = any($1::text[])`,
    [SETTINGS_KEYS],
    runner
  );
  const branding = rows.find((row) => row.key === 'platform.branding')?.value ?? {};
  const access = rows.find((row) => row.key === 'platform.access')?.value ?? {};
  const creation = (rows.find((row) => row.key === 'platform.company_creation')?.value ??
    {}) as { requireVerifiedEmail?: boolean; checkoutEnabled?: boolean };
  return {
    ...DEFAULT_SETTINGS,
    ...branding,
    ...access,
    requireVerifiedEmailForFirstCompany:
      creation.requireVerifiedEmail ?? DEFAULT_SETTINGS.requireVerifiedEmailForFirstCompany,
    companyCheckoutEnabled: creation.checkoutEnabled ?? DEFAULT_SETTINGS.companyCheckoutEnabled,
  } as AdminPlatformSettings;
}

export async function updatePlatformSettings(
  actorUserId: string,
  patch: AdminPlatformSettingsUpdate
): Promise<AdminPlatformSettings> {
  return withTransaction(async (client) => {
    const before = await getPlatformSettings(client);
    const next = { ...before, ...patch };
    const branding = { platformName: next.platformName, supportEmail: next.supportEmail };
    const access = {
      registrationOpen: next.registrationOpen,
      maintenanceMode: next.maintenanceMode,
      maintenanceMessage: next.maintenanceMessage,
    };
    await query(
      `insert into system_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      ['platform.branding', JSON.stringify(branding)], client
    );
    await query(
      `insert into system_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      ['platform.access', JSON.stringify(access)], client
    );
    await query(
      `insert into system_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      ['platform.company_creation', JSON.stringify({
        requireVerifiedEmail: next.requireVerifiedEmailForFirstCompany,
        checkoutEnabled: next.companyCheckoutEnabled,
      })], client
    );
    await recordPlatformAudit({
      actorUserId,
      action: 'platform.settings_updated',
      entityType: 'PLATFORM_SETTINGS',
      entityId: 'platform',
      changes: { before, after: next },
      description: 'Platform settings were updated',
    }, client);
    return next;
  });
}
