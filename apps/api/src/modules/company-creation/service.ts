import {
  resolveCompanyCreationDecision,
  type CreateCompanyRequest,
} from '@crewquo/shared';
import type pg from 'pg';
import { withTransaction } from '../../db';
import { AppError } from '../../http/errors';
import { findCompanyById, insertCompany, type CompanyRow } from '../companies/repo';
import { insertMembership } from '../memberships/repo';
import { recordPlatformAudit } from '../admin/platform.repo';
import { getCompanyCreationSettings } from './settings';
import {
  claimAllowance,
  consumeRequest,
  findAllowance,
  findCompanyByIdempotencyKey,
  findConsumableApproval,
} from './repo';

/**
 * The one place a real company comes into existence (§3.1.1).
 *
 * Registration, the customer endpoint and (later) the billing webhook all come
 * through here, so the ledger cannot be bypassed by adding a route. Placeholder
 * companies deliberately do **not**: a placeholder is a stub for a party who is
 * not on CrewQuo, owned by nobody, with no membership — it is not a tenant
 * anybody created for themselves, and charging it against an allowance would let
 * a contractor exhaust their own by inviting subcontractors.
 */

export type CreationPath = 'REGISTRATION' | 'ALLOWANCE' | 'APPROVAL';

export interface CreateCompanyResult {
  company: CompanyRow;
  path: CreationPath;
  /** True when this call created it; false when an idempotent retry found it. */
  created: boolean;
  requestId: string | null;
}

/**
 * Insert the company, its OWNER membership and both trails, inside a transaction
 * the caller already owns.
 *
 * Everything a new tenant gets is created here and nothing is copied from any
 * company the user already has (§3.1.1(4)): no subscription — it resolves to the
 * free plan like any unsubscribed company — no settings, no rate cards, no
 * catalog, no engagements. §44's "separate subscription/data boundaries" is
 * therefore true by construction rather than by a check.
 */
async function insertOwnedCompany(
  client: pg.PoolClient,
  input: {
    userId: string;
    name: string;
    currency: string;
    country?: string | null;
    registrationId?: string | null;
    path: CreationPath;
    requestId?: string | null;
  }
): Promise<CompanyRow> {
  const company = await insertCompany(
    {
      name: input.name,
      currency: input.currency,
      country: input.country ?? null,
      registrationId: input.registrationId ?? null,
    },
    client
  );
  await insertMembership({ userId: input.userId, companyId: company.id, role: 'OWNER' }, client);

  /**
   * The durable record is the **platform** trail, and deliberately the only one.
   *
   * `recordAudit` would resolve the new company's entitlements to read its
   * `audit_retention_days` — and at the instant of creation a company has no
   * subscription, so it resolves to the free plan, whose retention is `0`. The
   * row could therefore never be written, whatever the company later pays for.
   * Calling it anyway had one real effect: `resolveEntitlements` memoises for 60
   * seconds, so creating a company and immediately putting it on a plan left the
   * API serving free-plan entitlements to a paying tenant until the TTL lapsed.
   * Found by the e2e suite on 2026-08-18, one migration after this was written.
   *
   * `platform_audit_logs` has no retention rule and no cache, which is what a
   * creation decision needs.
   */
  await recordPlatformAudit(
    {
      actorUserId: input.userId,
      action: 'company.created',
      entityType: 'COMPANY',
      entityId: company.id,
      changes: {
        name: company.name,
        currency: company.currency,
        country: company.country ?? null,
        path: input.path,
        requestId: input.requestId ?? null,
      },
      description: `${company.name} was created via ${input.path.toLowerCase()}`,
    },
    client
  );

  return company;
}

/**
 * Registration's company, created in the same transaction as the user.
 *
 * The allowance is claimed rather than checked: a brand-new user cannot already
 * have one, and claiming makes the ledger true for every company that exists
 * rather than for the ones that happened to come through the customer endpoint.
 */
export async function createCompanyAtRegistration(
  client: pg.PoolClient,
  input: { userId: string; name: string; currency: string }
): Promise<CompanyRow> {
  const company = await insertOwnedCompany(client, { ...input, path: 'REGISTRATION' });
  await claimAllowance(
    { userId: input.userId, companyId: company.id, source: 'REGISTRATION' },
    client
  );
  return company;
}

/**
 * `POST /v1/me/companies` — the customer path, serving both authorities.
 *
 * The shape of this function is the safeguard: the gate is resolved from pure
 * facts, then the *authority is spent inside the same transaction that creates
 * the company*. There is no ordering in which a company exists and its allowance
 * or approval does not.
 */
export async function createCompanyForUser(input: {
  userId: string;
  isSuperAdmin: boolean;
  emailVerified: boolean;
  body: CreateCompanyRequest;
}): Promise<CreateCompanyResult> {
  const { userId, body } = input;

  // An idempotent retry must not depend on the gate: the company already exists,
  // and re-deciding whether it was allowed would refuse the second call.
  if (body.idempotencyKey) {
    const existing = await findCompanyByIdempotencyKey(userId, body.idempotencyKey);
    if (existing) {
      const company = await findCompanyById(existing);
      if (company) {
        return { company, path: 'ALLOWANCE', created: false, requestId: null };
      }
    }
  }

  const settings = await getCompanyCreationSettings();
  const allowance = await findAllowance(userId);

  return withTransaction(async (client) => {
    const approval = allowance
      ? await findConsumableApproval(userId, body.requestId, client)
      : null;

    const decision = resolveCompanyCreationDecision({
      isPlatformStaff: input.isSuperAdmin,
      emailVerified: input.emailVerified,
      requireVerifiedEmail: settings.requireVerifiedEmail,
      allowanceConsumed: allowance !== null,
      approvedRequest: approval ? { id: approval.id, expiresAt: approval.expires_at } : null,
      now: new Date(),
    });

    if (decision.kind === 'REFUSED') {
      throw new AppError(decision.code, decision.message, decision.details);
    }

    if (decision.kind === 'ALLOWANCE') {
      const company = await insertOwnedCompany(client, {
        userId,
        name: body.name,
        currency: body.currency,
        country: body.country,
        registrationId: body.registrationId,
        path: 'ALLOWANCE',
      });
      const claimed = await claimAllowance(
        {
          userId,
          companyId: company.id,
          source: 'SELF_SERVE',
          idempotencyKey: body.idempotencyKey ?? null,
        },
        client
      );
      // Lost the race with the caller's own second request. The primary key is
      // the mutex; rolling back here is what makes "exactly once" true.
      if (!claimed) {
        throw new AppError(
          'CONFLICT',
          'You have already used your included company. Creating another business needs an ' +
            'approved request first.',
          { requires: 'company_creation_request' }
        );
      }
      return { company, path: 'ALLOWANCE' as const, created: true, requestId: null };
    }

    // APPROVAL: the request row is the mutex.
    const company = await insertOwnedCompany(client, {
      userId,
      name: body.name,
      currency: body.currency,
      // The reviewed identity wins over anything the create body claims — the
      // approval was granted for *that* business, not for whatever is typed now.
      country: approval!.country,
      registrationId: approval!.registration_id,
      path: 'APPROVAL',
      requestId: decision.requestId,
    });

    const consumed = await consumeRequest(
      {
        id: decision.requestId,
        companyId: company.id,
        idempotencyKey: body.idempotencyKey ?? null,
      },
      client
    );
    if (!consumed) {
      throw new AppError('CONFLICT', 'That approval has already been used.', {
        requestId: decision.requestId,
      });
    }

    await recordPlatformAudit(
      {
        actorUserId: userId,
        action: 'company_creation_request.consumed',
        entityType: 'COMPANY_CREATION_REQUEST',
        entityId: decision.requestId,
        changes: { companyId: company.id, legalName: approval!.legal_name },
        description: `Approved request consumed by ${company.name}`,
      },
      client
    );

    return { company, path: 'APPROVAL' as const, created: true, requestId: decision.requestId };
  });
}
