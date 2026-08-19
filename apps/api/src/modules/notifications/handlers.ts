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
]);
