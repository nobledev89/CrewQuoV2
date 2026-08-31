import {
  COMPANY_CLOSURE_PROMISES,
  PERSONAL_CLOSURE_PROMISES,
  canCancelDeletion,
  deletionScheduledFor,
  type DeletionRequestView,
  type DeletionScope,
  type DeletionStatusResponse,
  type RequestDeletion,
} from '@crewquo/shared';
import { withTransaction } from '../../db';
import { AppError } from '../../http/errors';
import { isUniqueViolation } from '../../http/pgErrors';
import { enqueueOutboxEvent } from '../delivery/repo';
import { recordAudit } from '../audit/record';
import { requireStepUpAuth } from '../auth/stepUp';
import { findUserById } from '../users/repo';
import { companyBlocks, personalBlocks } from './preconditions';
import {
  cancelDeletionRequest,
  findLiveRequestForCompany,
  findLiveRequestForUser,
  insertDeletionRequest,
  type DeletionRequestRow,
} from './repo';

/**
 * Asking for a closure, and stopping one.
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §3, §4, §6 and §13.1.
 *
 * The executor is elsewhere (`execute.ts`). This file is the part a person touches,
 * and its whole job is to make an irreversible action deliberate: prove a human is
 * at the keyboard, prove they know which thing they are closing, capture the address
 * the farewell will need, and tell everybody who is entitled to know **before** the
 * deadline rather than after it.
 */

export function toDeletionRequestView(
  row: DeletionRequestRow,
  viewerUserId: string
): DeletionRequestView {
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    scheduledFor: row.scheduled_for.toISOString(),
    requestedAt: row.created_at.toISOString(),
    requestedByYou: row.requested_by_user_id === viewerUserId,
    cancellable: canCancelDeletion(row.status),
    blockedReason: row.blocked_reason,
  };
}

/**
 * Everything a screen needs before the button: what is pending, what is in the way,
 * and what closing actually does.
 *
 * The promises travel with the status rather than living in the component, because
 * §13.1 committed the product to saying a specific thing *before* the button — and
 * a sentence that lives only in a React file is one an A/B test removes.
 */
export async function readPersonalDeletionStatus(
  userId: string
): Promise<DeletionStatusResponse> {
  const [request, blocks] = await Promise.all([
    findLiveRequestForUser(userId),
    personalBlocks(userId),
  ]);
  return {
    request: request ? toDeletionRequestView(request, userId) : null,
    blocks,
    promises: [...PERSONAL_CLOSURE_PROMISES],
  };
}

export async function readCompanyDeletionStatus(
  companyId: string,
  viewerUserId: string
): Promise<DeletionStatusResponse> {
  const [request, blocks] = await Promise.all([
    findLiveRequestForCompany(companyId),
    companyBlocks(companyId),
  ]);
  return {
    request: request ? toDeletionRequestView(request, viewerUserId) : null,
    blocks,
    promises: [...COMPANY_CLOSURE_PROMISES],
  };
}

/**
 * The typed confirmation.
 *
 * Compared case-insensitively and trimmed, because the requirement is that somebody
 * knows *which* thing they are closing, not that they can match whitespace. A
 * checkbox would be one click away from an accident on the most irreversible screen
 * in the product; a name is the cheapest possible proof of intent, and it is checked
 * here because a client-side confirmation is a suggestion.
 */
function requireTypedConfirmation(expected: string, given: string, subject: string): void {
  if (expected.trim().toLowerCase() !== given.trim().toLowerCase()) {
    throw new AppError('VALIDATION', `Type ${subject} exactly as it appears to confirm`);
  }
}

/**
 * A duplicate request is one request.
 *
 * The partial unique index on (subject, non-terminal status) is the concurrency
 * control, so this translates its violation rather than pre-empting it with a read
 * that two callers could both pass.
 */
function asAlreadyPending(err: unknown, subject: string): never {
  // Named, not any 23505: reporting an unrelated uniqueness bug as "a closure is
  // already scheduled" is how one gets told to a customer and never found.
  if (isUniqueViolation(err, 'deletion_requests_one_live')) {
    throw new AppError('CONFLICT', `A closure of ${subject} is already scheduled`);
  }
  throw err;
}

/**
 * Request the closure of one's own account.
 *
 * **Blocked at request time, not only at the deadline**, and the asymmetry with the
 * company arm below is deliberate. A sole owner's remedy — promote somebody, or
 * close the company — is entirely in their own hands and needs nobody else's
 * cooperation, so refusing immediately with the company named is clearer than
 * accepting and surprising them on day seven. The company arm cannot do that: its
 * remedy requires the counterparty, and the notice that asks them to settle is only
 * sent once the request exists.
 *
 * Note what is *not* a reason to refuse: having logged hours. §13.1 called that
 * indefensible for a person, and it is — it makes "you may not leave" the answer to
 * somebody who logged one hour eighteen months ago.
 */
export async function requestPersonalClosure(
  userId: string,
  input: RequestDeletion
): Promise<DeletionRequestRow> {
  const user = await findUserById(userId);
  if (!user) throw new AppError('NOT_FOUND', 'User not found');

  // An access token is re-minted by refresh without anybody re-proving anything, so
  // its age is not evidence of a recent human (access.md §4).
  await requireStepUpAuth(userId, input, 'close your account');
  requireTypedConfirmation(user.email, input.confirm, 'your email address');

  const blocks = await personalBlocks(userId);
  if (blocks.length > 0) throw new AppError('CONFLICT', blocks.join(' '));

  const now = new Date();
  try {
    return await withTransaction(async (client) => {
      const request = await insertDeletionRequest(
        {
          scope: 'PERSONAL',
          subjectUserId: userId,
          subjectCompanyId: null,
          requestedByUserId: userId,
          // §6: the farewell has to go somewhere and the address is inside the thing
          // being deleted. Captured here, released the moment it has been used.
          contactEmail: user.email,
          contactName: user.name,
          scheduledFor: deletionScheduledFor(now),
          reason: input.reason ?? null,
        },
        client
      );

      /*
       * The notice, in the same transaction as the request.
       *
       * It is also what advances `REQUESTED → SCHEDULED` once delivered — see 0022.
       * So this event is not a courtesy: an account whose warning never went out is
       * an account the executor will not touch, which is the whole safety property
       * of a cooling-off period expressed as a state machine rather than a hope.
       */
      await enqueueOutboxEvent(
        {
          topic: 'account.closure_scheduled',
          aggregateType: 'DELETION_REQUEST',
          aggregateId: request.id,
          companyId: null,
          payload: {
            requestId: request.id,
            recipientUserId: userId,
            scheduledFor: request.scheduled_for.toISOString(),
          },
          idempotencyKey: `account.closure_scheduled:${request.id}`,
        },
        client
      );

      return request;
    });
  } catch (err) {
    return asAlreadyPending(err, 'your account');
  }
}

/**
 * Request the closure of a company.
 *
 * **OWNER only and step-up re-authenticated** (§4). An admin cannot: they can be
 * appointed in a minute and they do not own the subscription, the liability or the
 * relationships this ends.
 *
 * **Live engagements do not refuse this**, and that ordering is the finding rather
 * than laxity. §6 requires every counterparty with a live engagement to be told when
 * a company starts closing itself, precisely so they can settle or hand over — and
 * refusing the request while an engagement is live would mean that notice could never
 * be sent. The customer would be told "end your engagements" with no mechanism to
 * tell the other side why. So the request is accepted, the counterparties are told,
 * and the cooling-off window is when the settling happens. If it has not happened by
 * the deadline, the run is blocked with the reasons on the record and on the screen —
 * visibly waiting rather than quietly never happening.
 */
export async function requestCompanyClosure(
  input: {
    companyId: string;
    companyName: string;
    actorUserId: string;
    body: RequestDeletion;
  }
): Promise<DeletionRequestRow> {
  const user = await findUserById(input.actorUserId);
  if (!user) throw new AppError('NOT_FOUND', 'User not found');

  await requireStepUpAuth(input.actorUserId, input.body, 'close this company');
  requireTypedConfirmation(input.companyName, input.body.confirm, 'the company name');

  const now = new Date();
  try {
    return await withTransaction(async (client) => {
      const request = await insertDeletionRequest(
        {
          scope: 'COMPANY',
          subjectUserId: null,
          subjectCompanyId: input.companyId,
          requestedByUserId: input.actorUserId,
          /*
           * The requester's address, not the company's — a company has no inbox.
           * Captured for symmetry with the personal arm and for the one thing it is
           * genuinely needed for: the person who pressed the button is the person who
           * has to be told it happened, and they may have lost their own access to
           * this company by then.
           */
          contactEmail: user.email,
          contactName: user.name,
          scheduledFor: deletionScheduledFor(now),
          reason: input.body.reason ?? null,
        },
        client
      );

      await enqueueOutboxEvent(
        {
          topic: 'company.closure_scheduled',
          aggregateType: 'DELETION_REQUEST',
          aggregateId: request.id,
          companyId: input.companyId,
          payload: {
            requestId: request.id,
            companyId: input.companyId,
            actorUserId: input.actorUserId,
            scheduledFor: request.scheduled_for.toISOString(),
          },
          idempotencyKey: `company.closure_scheduled:${request.id}`,
        },
        client
      );

      /*
       * Audited on the company's own trail, unlike a personal closure, which has no
       * company whose trail it belongs in. Not client-visible: that a company is
       * winding down is its own business, and the counterparty is told the
       * relationship is ending through the notice rather than by reading a trail.
       */
      await recordAudit(
        {
          companyId: input.companyId,
          actorUserId: input.actorUserId,
          action: 'company.closure_requested',
          entityType: 'COMPANY',
          entityId: input.companyId,
          changes: { scheduledFor: request.scheduled_for.toISOString() },
          description: 'Closure of this company was requested',
        },
        client
      );

      return request;
    });
  } catch (err) {
    return asAlreadyPending(err, 'this company');
  }
}

/**
 * Stop a closure.
 *
 * Anybody who could have asked for it may cancel it — for a company, any owner or
 * admin, not only the person who requested it. That is the point of telling them all:
 * the most likely reason a closure needs stopping is that somebody else holds the
 * account, and a cancel button only the requester can press is no protection against
 * exactly that.
 */
export async function cancelClosure(input: {
  request: DeletionRequestRow;
  actorUserId: string;
  reason: string | null;
}): Promise<DeletionRequestRow> {
  if (!canCancelDeletion(input.request.status)) {
    throw new AppError(
      'CONFLICT',
      input.request.status === 'EXECUTING'
        ? 'This closure has already started and can no longer be stopped'
        : 'This closure is no longer pending'
    );
  }

  return withTransaction(async (client) => {
    const cancelled = await cancelDeletionRequest(
      { id: input.request.id, cancelledByUserId: input.actorUserId, reason: input.reason },
      client
    );
    // Lost the race against the executor's claim, or against another owner's cancel.
    if (!cancelled) throw new AppError('CONFLICT', 'This closure is no longer pending');

    const scope: DeletionScope = cancelled.scope;
    await enqueueOutboxEvent(
      {
        topic: scope === 'PERSONAL' ? 'account.closure_cancelled' : 'company.closure_cancelled',
        aggregateType: 'DELETION_REQUEST',
        aggregateId: cancelled.id,
        companyId: cancelled.subject_company_id,
        payload: {
          requestId: cancelled.id,
          recipientUserId: cancelled.subject_user_id,
          companyId: cancelled.subject_company_id,
          actorUserId: input.actorUserId,
        },
        idempotencyKey: `${scope}.closure_cancelled:${cancelled.id}`,
      },
      client
    );

    if (cancelled.subject_company_id) {
      await recordAudit(
        {
          companyId: cancelled.subject_company_id,
          actorUserId: input.actorUserId,
          action: 'company.closure_cancelled',
          entityType: 'COMPANY',
          entityId: cancelled.subject_company_id,
          changes: {},
          description: 'A pending closure of this company was cancelled',
        },
        client
      );
    }

    return cancelled;
  });
}
