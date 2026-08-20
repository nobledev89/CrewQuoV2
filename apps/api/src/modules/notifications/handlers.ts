import { PermanentDeliveryError } from '../delivery/model';
import type { DeliveryHandler } from '../delivery/worker';
import type { OutboxEvent } from '../delivery/repo';
import { dispatchNotification, managerRecipients } from './dispatch';
import { resolveActionsForSubject } from './repo';

/**
 * The outbox consumers that turn domain events into inbox rows — the first real
 * consumers the durable-delivery substrate has had.
 * Operating-model packet: `docs/operating-model/notifications.md` §5.
 *
 * Two rules run through every handler:
 *
 *  - **A payload that cannot name its own recipients is a permanent failure, not
 *    a retry.** Retrying a malformed event forever produces an invisible backlog
 *    and an eventual dead letter eight attempts later; failing immediately puts
 *    it in front of an operator now. `PermanentDeliveryError` is how 0012 already
 *    expresses that.
 *  - **The actor is never their own recipient.** Approving your own submission
 *    should not tell you that you approved it, and a manager who submits work is
 *    not also the person who needs to be told it needs approving.
 */

function required(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PermanentDeliveryError(`${key} missing from payload — nobody can be notified`);
  }
  return value;
}

function optional(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function without(recipients: readonly string[], actorUserId: string | null): string[] {
  return recipients.filter((id) => id !== actorUserId);
}

/** Approvers of the hiring company owe a decision on newly submitted work. */
async function onWorkSubmitted(event: OutboxEvent): Promise<void> {
  const hiringCompanyId = required(event.payload, 'hiringCompanyId');
  const subjectId = required(event.payload, 'subjectId');
  const actorUserId = optional(event.payload, 'actorUserId');
  const recipients = without(await managerRecipients(hiringCompanyId), actorUserId);

  await dispatchNotification({
    kind:
      event.topic === 'expense.submitted'
        ? 'expense.submitted'
        : event.topic === 'submission.submitted'
          ? 'submission.submitted'
          : 'work.submitted',
    companyId: hiringCompanyId,
    recipientUserIds: recipients,
    title: optional(event.payload, 'title') ?? 'Awaiting your approval',
    body: optional(event.payload, 'body') ?? 'Work was submitted for your approval',
    subjectType: required(event.payload, 'subjectType'),
    subjectId,
    actionUrl: optional(event.payload, 'actionUrl'),
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A decision reaches the person who submitted — and closes the task it answers.
 *
 * The `resolveActionsForSubject` call is what stops the Action Centre lying: one
 * approver acting leaves every *other* approver holding a task for work that no
 * longer needs doing, and an inbox full of already-handled items is one people
 * stop reading. It runs before the fan-out so a handler that dies between the two
 * still leaves the stale tasks closed, which is the harmless ordering.
 */
async function onWorkDecided(event: OutboxEvent): Promise<void> {
  const subjectType = required(event.payload, 'subjectType');
  const subjectId = required(event.payload, 'subjectId');
  await resolveActionsForSubject({ subjectType, subjectId });

  const recipientUserId = optional(event.payload, 'recipientUserId');
  if (!recipientUserId) return; // nothing to tell; the task closure above still stands

  const kindByTopic: Record<string, 'work.approved' | 'work.rejected' | 'expense.approved' | 'expense.rejected'> = {
    'work.approved': 'work.approved',
    'work.rejected': 'work.rejected',
    'expense.approved': 'expense.approved',
    'expense.rejected': 'expense.rejected',
  };
  const kind = kindByTopic[event.topic];
  if (!kind) throw new PermanentDeliveryError(`No notification kind for topic ${event.topic}`);

  await dispatchNotification({
    kind,
    companyId: required(event.payload, 'providerCompanyId'),
    recipientUserIds: without([recipientUserId], optional(event.payload, 'actorUserId')),
    title: optional(event.payload, 'title') ?? 'Your submission was reviewed',
    body: optional(event.payload, 'body') ?? 'A decision was recorded on your submission',
    subjectType,
    subjectId,
    actionUrl: optional(event.payload, 'actionUrl'),
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/** A rate schedule needs a decision from the hiring side. */
async function onRateProposalSubmitted(event: OutboxEvent): Promise<void> {
  const hiringCompanyId = required(event.payload, 'hiringCompanyId');
  const actorUserId = optional(event.payload, 'actorUserId');
  await dispatchNotification({
    kind: 'rate_proposal.submitted',
    companyId: hiringCompanyId,
    recipientUserIds: without(await managerRecipients(hiringCompanyId), actorUserId),
    title: optional(event.payload, 'title') ?? 'A rate schedule needs your decision',
    body: optional(event.payload, 'body') ?? 'A subcontractor submitted a rate schedule',
    subjectType: 'RATE_PROPOSAL',
    subjectId: required(event.payload, 'subjectId'),
    actionUrl: optional(event.payload, 'actionUrl'),
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/** The decision goes back to the company that proposed it. */
async function onRateProposalDecided(event: OutboxEvent): Promise<void> {
  const subjectId = required(event.payload, 'subjectId');
  await resolveActionsForSubject({ subjectType: 'RATE_PROPOSAL', subjectId });

  const proposingCompanyId = required(event.payload, 'proposingCompanyId');
  const actorUserId = optional(event.payload, 'actorUserId');
  await dispatchNotification({
    kind: 'rate_proposal.decided',
    companyId: proposingCompanyId,
    recipientUserIds: without(await managerRecipients(proposingCompanyId), actorUserId),
    title: optional(event.payload, 'title') ?? 'Your rate schedule was decided',
    body: optional(event.payload, 'body') ?? 'A decision was recorded on your rate schedule',
    subjectType: 'RATE_PROPOSAL',
    subjectId,
    actionUrl: optional(event.payload, 'actionUrl'),
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/** An issued invoice is a claim on the counterparty, so it is a task for them. */
async function onInvoiceIssued(event: OutboxEvent): Promise<void> {
  const counterpartyCompanyId = required(event.payload, 'counterpartyCompanyId');
  await dispatchNotification({
    kind: 'invoice.issued',
    companyId: counterpartyCompanyId,
    recipientUserIds: await managerRecipients(counterpartyCompanyId),
    title: optional(event.payload, 'title') ?? 'An invoice was issued to you',
    body: optional(event.payload, 'body') ?? 'A counterparty issued an invoice',
    subjectType: 'INVOICE',
    subjectId: required(event.payload, 'subjectId'),
    actionUrl: optional(event.payload, 'actionUrl'),
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * Account security — the first kinds in this file whose recipient is a *person*.
 *
 * Three properties this handler has that none of the others need:
 *
 *  - **`companyId` is null.** The event happened to an account, which may span
 *    several companies or none. Hanging it on one of them would claim the event
 *    happened inside that tenant.
 *  - **The recipient is named in the payload and is never a cohort.** No
 *    `managerRecipients`, no "the actor is never their own recipient" rule: the
 *    holder is the only person who may be told, and here the actor is a stranger.
 *  - **The body is composed here, from the event, and says what to do.** A security
 *    alert whose reader cannot tell what to do next is a scare rather than a
 *    warning, so each one ends with the action that actually helps.
 */
async function onAuthSecurityEvent(event: OutboxEvent): Promise<void> {
  const recipientUserId = required(event.payload, 'recipientUserId');
  const device = optional(event.payload, 'deviceLabel');

  /*
   * The factor events (§6). Each is a sentence about something that changed on the
   * account, plus what to do if it was not you — because a security alert whose
   * reader cannot tell what to do next is a scare rather than a warning.
   */
  const factorContent: Record<string, { title: string; body: string }> = {
    'auth.mfa_enrolled': {
      title: 'An authenticator app was added to your account',
      body:
        'Two-step sign-in is now on for your CrewQuo account. If you did this, ' +
        'nothing else is needed — keep your recovery codes somewhere safe. If you ' +
        'did not, somebody else has your password: contact support, because they ' +
        'now hold the second factor as well.',
    },
    'auth.mfa_removed': {
      title: 'The authenticator app on your account was removed',
      body:
        'Two-step sign-in is off, so your password is the only thing protecting ' +
        'your CrewQuo account. If you did not do this, change your password now ' +
        'and set up an authenticator app again.',
    },
    'auth.mfa_reset_by_operator': {
      title: 'CrewQuo support reset the authenticator app on your account',
      body:
        'Platform staff removed the second factor from your account and signed out ' +
        'every device, which is the recorded path for somebody who has lost both ' +
        'their phone and their recovery codes. Sign in with your password and set ' +
        'up an authenticator app again. If you did not ask for this, contact ' +
        'support immediately.',
    },
  };

  const factor = factorContent[event.topic];
  if (factor) {
    await dispatchNotification({
      kind: event.topic as 'auth.mfa_enrolled' | 'auth.mfa_removed' | 'auth.mfa_reset_by_operator',
      companyId: null,
      recipientUserIds: [recipientUserId],
      title: factor.title,
      body: factor.body,
      subjectType: 'USER',
      subjectId: recipientUserId,
      actionUrl: '/security',
      topic: event.topic,
      // The occurrence, so a second enrolment months later is a second email
      // rather than a silent deduplication against the first.
      aggregateId: event.aggregateId,
    });
    return;
  }

  const content =
    event.topic === 'auth.token_reuse'
      ? {
          kind: 'auth.token_reuse' as const,
          // The compromised session itself, which is a real row.
          subject: { type: 'AUTH_SESSION', id: event.aggregateId },
          title: 'We signed you out: a sign-in token was used twice',
          body:
            'A refresh token that had already been replaced was presented again' +
            (device ? ` from ${device}` : '') +
            '. That has two explanations — somebody else has a copy of it, or an app ' +
            'is misbehaving — so we ended that session on every device it covered. ' +
            'Sign in again, and change your password if this was not you.',
        }
      : {
          kind: 'auth.session_revoked' as const,
          // The account, not a session: this event ended all of them, and its
          // aggregate id is a per-occurrence uuid rather than a row anybody can
          // look up. Pointing `subject_id` at it would name a session that does
          // not exist.
          subject: { type: 'USER', id: recipientUserId },
          title: 'A CrewQuo operator ended your sessions',
          body:
            'Platform staff ended the active sessions on your account, which signs ' +
            'out every device it covered. This is a support action and it is ' +
            'recorded. Sign in again, and contact support if you were not expecting ' +
            'it.',
        };

  await dispatchNotification({
    kind: content.kind,
    companyId: null,
    recipientUserIds: [recipientUserId],
    title: content.title,
    body: content.body,
    subjectType: content.subject.type,
    subjectId: content.subject.id,
    actionUrl: '/security',
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * The registered consumers. A topic with no handler here is simply not claimed by
 * this worker — `claimOutboxEvents` filters on the registered topic list, so an
 * unconsumed event waits rather than being marked delivered by a worker that did
 * nothing with it.
 */
export const NOTIFICATION_HANDLERS: ReadonlyMap<string, DeliveryHandler> = new Map<
  string,
  DeliveryHandler
>([
  ['work.submitted', onWorkSubmitted],
  ['expense.submitted', onWorkSubmitted],
  ['submission.submitted', onWorkSubmitted],
  ['work.approved', onWorkDecided],
  ['work.rejected', onWorkDecided],
  ['expense.approved', onWorkDecided],
  ['expense.rejected', onWorkDecided],
  ['rate_proposal.submitted', onRateProposalSubmitted],
  ['rate_proposal.decided', onRateProposalDecided],
  ['invoice.issued', onInvoiceIssued],
  ['auth.token_reuse', onAuthSecurityEvent],
  ['auth.session_revoked', onAuthSecurityEvent],
  ['auth.mfa_enrolled', onAuthSecurityEvent],
  ['auth.mfa_removed', onAuthSecurityEvent],
  ['auth.mfa_reset_by_operator', onAuthSecurityEvent],
]);
