import {
  describeAmendments,
  describeDiaryDay,
  describeExpiry,
  describeStorageAgeing,
  describeSupersession,
  formatMassKg,
  type DocumentCategory,
} from '@crewquo/shared';
import { PermanentDeliveryError } from '../delivery/model';
import type { DeliveryHandler } from '../delivery/worker';
import type { OutboxEvent } from '../delivery/repo';
import { capabilityRecipients, dispatchNotification, managerRecipients } from './dispatch';
import { resolveActionsForSubject } from './repo';
import { findCompanyById } from '../companies/repo';
import { companyDecisionMakers, counterpartyRecipients } from '../deletion/preconditions';
import { markImminentNoticeSent, markNoticeDispatched } from '../deletion/repo';

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
 * Closure notices (`observability-data-lifecycle.md` §6), and the one handler in
 * this file that **changes domain state as well as notifying.**
 *
 * `REQUESTED → SCHEDULED` happens here, after the notice has been written, and that
 * is a safety property rather than a convenience: the executor claims `SCHEDULED`
 * rows only, so an account whose warning never went out is an account that is never
 * erased. A permanently dead-lettered notice becomes a closure that visibly did not
 * happen instead of one that happened in silence on the seventh day.
 *
 * The ordering inside is deliberate — dispatch, then advance. A handler that died
 * between the two runs again and re-dispatches into the same dedupe key, which is a
 * no-op. The other order would advance the state on a notice that was never written.
 */
async function onAccountClosureScheduled(event: OutboxEvent): Promise<void> {
  const recipientUserId = required(event.payload, 'recipientUserId');
  const requestId = required(event.payload, 'requestId');
  const scheduledFor = optional(event.payload, 'scheduledFor');

  await dispatchNotification({
    kind: 'account.closure_scheduled',
    // No company. This is an event about a person's account, which may span several
    // tenants or none; hanging it on one would claim it happened inside that tenant.
    companyId: null,
    recipientUserIds: [recipientUserId],
    title: 'Your CrewQuo account is scheduled to close',
    body:
      'We will close your account' +
      (scheduledFor ? ` on ${scheduledFor.slice(0, 10)}` : ' shortly') +
      '. Your name, email address and sign-in will be removed, and the hours you ' +
      'logged will remain on the projects they belong to without your name on them. ' +
      'If you did not ask for this, cancel it now and change your password: somebody ' +
      'else has your sign-in. You can cancel at any point until it runs.',
    subjectType: 'DELETION_REQUEST',
    subjectId: requestId,
    actionUrl: '/profile',
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  await markNoticeDispatched(requestId);
}

/** The one-day-out warning. Same recipient, same cancel action, less time. */
async function onAccountClosureImminent(event: OutboxEvent): Promise<void> {
  const recipientUserId = required(event.payload, 'recipientUserId');
  const requestId = required(event.payload, 'requestId');

  await dispatchNotification({
    kind: 'account.closure_imminent',
    companyId: null,
    recipientUserIds: [recipientUserId],
    title: 'Your CrewQuo account closes tomorrow',
    body:
      'This is the last reminder. Tomorrow your name, email address and sign-in are ' +
      'removed and you will not be able to sign in again. Download your data first if ' +
      'you want a copy — afterwards there is no account to download it from. Cancel ' +
      'any time before it runs.',
    subjectType: 'DELETION_REQUEST',
    subjectId: requestId,
    actionUrl: '/profile',
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  await markImminentNoticeSent(requestId);
}

/**
 * A closure was stopped.
 *
 * Sent even when the holder cancelled it themselves, because the interesting case is
 * the one where they did not: an operator, or another owner. The task it closes
 * matters as much as the message — leaving a cancelled closure sitting in the Action
 * Centre with a live "cancel" button is an inbox that lies.
 */
async function onAccountClosureCancelled(event: OutboxEvent): Promise<void> {
  const requestId = required(event.payload, 'requestId');
  await resolveActionsForSubject({ subjectType: 'DELETION_REQUEST', subjectId: requestId });

  const recipientUserId = optional(event.payload, 'recipientUserId');
  if (!recipientUserId) return; // the task closure above still stands

  await dispatchNotification({
    kind: 'account.closure_cancelled',
    companyId: null,
    recipientUserIds: [recipientUserId],
    title: 'Your CrewQuo account will no longer be closed',
    body:
      'The scheduled closure of your account was cancelled and nothing was removed. ' +
      'Everything is exactly as it was. If you did not cancel it, somebody else has ' +
      'access to your account — change your password now.',
    subjectType: 'DELETION_REQUEST',
    subjectId: requestId,
    actionUrl: '/profile',
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A company closing itself, told to two audiences with **two different bodies** —
 * and that split is §6's rule rather than a nicety.
 *
 * Its own owners and admins get the deadline and the cancel action. Every
 * counterparty with a live engagement gets told that the relationship is ending, so
 * they can settle or hand over — and **never the reason**, which is the closing
 * company's business, the same line the access packet drew around an operator's
 * internal note. The alternative to telling them at all is a client discovering it
 * when a project view goes empty.
 */
async function onCompanyClosureScheduled(event: OutboxEvent): Promise<void> {
  const companyId = required(event.payload, 'companyId');
  const requestId = required(event.payload, 'requestId');
  const scheduledFor = optional(event.payload, 'scheduledFor');
  const on = scheduledFor ? ` on ${scheduledFor.slice(0, 10)}` : ' shortly';

  const [insiders, counterparties, company] = await Promise.all([
    companyDecisionMakers(companyId),
    counterpartyRecipients(companyId),
    findCompanyById(companyId),
  ]);
  const name = company?.name ?? 'A company you work with';

  await dispatchNotification({
    kind: 'company.closure_scheduled',
    companyId,
    recipientUserIds: insiders,
    title: `${name} is scheduled to close`,
    body:
      `An owner asked to close this company${on}. Everyone will lose access and the ` +
      'subscription will be cancelled. Live engagements must be ended and issued ' +
      'invoices settled first, and your counterparties have been told the ' +
      'relationship is ending. Any owner or admin can cancel this until it runs.',
    subjectType: 'DELETION_REQUEST',
    subjectId: requestId,
    actionUrl: '/settings',
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  /*
   * A second dispatch rather than one recipient list, because the two audiences are
   * told different things — and because the dedupe key is per recipient, so somebody
   * who is both an admin here and a manager at a counterparty (rare, and real) gets
   * the insider message once and the counterparty message once, rather than one of
   * them silently swallowing the other.
   */
  await dispatchNotification({
    kind: 'company.closure_scheduled',
    // The counterparty's own inbox, not the closing company's: they are not members
    // of it, and an inbox row hung on a tenant they do not belong to is unreadable.
    companyId: null,
    recipientUserIds: counterparties,
    title: `${name} is ending its work with you`,
    body:
      `${name} is closing its CrewQuo account${on}. Your projects, hours and invoices ` +
      'stay exactly as they are and remain yours. What ends is the working ' +
      'relationship: settle any open invoices and end the engagement before that ' +
      'date, or hand the work to another company.',
    subjectType: 'DELETION_REQUEST',
    /*
     * The real request id, not a suffixed one — for two reasons that both bite.
     *
     * `notifications.subject_id` is a `uuid` column, so `<id>:counterparty` is not a
     * value it can hold: the insert fails, the handler throws after the insiders have
     * already been told, and the outbox retries that half for ever. And the subject is
     * what `resolveActionsForSubject` closes the task by, so a suffix nothing else
     * spells would leave every counterparty's URGENT action item open after the
     * closure was cancelled.
     *
     * Nothing is lost by sharing it: the dedupe key is built from the topic, the
     * aggregate and the recipient, and the aggregate below still carries the suffix.
     */
    subjectId: requestId,
    topic: event.topic,
    // A distinct aggregate, so the two dispatches cannot collide on a dedupe key for
    // a person who is in both audiences.
    aggregateId: `${event.aggregateId}:counterparty`,
  });

  /*
   * `REQUESTED → SCHEDULED`, exactly as the personal arm does it and for the same
   * reason: the executor claims `SCHEDULED` only, so a company whose notice never
   * went out is one that is never closed rather than one closed in silence.
   *
   * Last, after **both** audiences have been written. Advancing between the two
   * dispatches would let a company be closed on the seventh day while the
   * counterparties who were promised the chance to settle or hand over had been told
   * nothing — which is the notice this state exists to guarantee.
   */
  await markNoticeDispatched(requestId);
}

/** The company closure was stopped; both audiences hear so, and the task closes. */
async function onCompanyClosureCancelled(event: OutboxEvent): Promise<void> {
  const companyId = required(event.payload, 'companyId');
  const requestId = required(event.payload, 'requestId');
  await resolveActionsForSubject({ subjectType: 'DELETION_REQUEST', subjectId: requestId });

  const [insiders, counterparties, company] = await Promise.all([
    companyDecisionMakers(companyId),
    counterpartyRecipients(companyId),
    findCompanyById(companyId),
  ]);
  const name = company?.name ?? 'A company you work with';

  await dispatchNotification({
    kind: 'company.closure_cancelled',
    companyId,
    recipientUserIds: insiders,
    title: `${name} will no longer close`,
    body: 'The scheduled closure was cancelled and nothing was removed.',
    subjectType: 'DELETION_REQUEST',
    subjectId: requestId,
    actionUrl: '/settings',
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  await dispatchNotification({
    kind: 'company.closure_cancelled',
    companyId: null,
    recipientUserIds: counterparties,
    title: `${name} is continuing to work with you`,
    body:
      `${name} cancelled the closure of its account. Nothing changed, and the ` +
      'engagement continues as before.',
    subjectType: 'DELETION_REQUEST',
    // The real request id, for the reasons given on the scheduled notice above.
    subjectId: requestId,
    topic: event.topic,
    aggregateId: `${event.aggregateId}:counterparty`,
  });
}

/**
 * A provider added photographs to the hiring company's project (§22, packet §6).
 *
 * **The batch is the unit.** The payload carries a count and a category set and
 * no prose whatsoever — no caption, no filename, no location name — because the
 * event travels to analytics as well as to an inbox, and a filename like
 * `Ridley_Redundancy_Consultation_Floor3.pdf` is a fact about somebody's job that
 * would move as an ordinary string field. The title is composed here from
 * resolved facts instead.
 */
async function onEvidenceBatchUploaded(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const projectId = required(event.payload, 'projectId');
  const actorUserId = optional(event.payload, 'actorUserId');
  const count = Number(event.payload.count ?? 0);
  if (!Number.isFinite(count) || count < 1) {
    throw new PermanentDeliveryError('count missing from payload — nothing to describe');
  }

  await dispatchNotification({
    kind: 'evidence.batch_uploaded',
    companyId: ownerCompanyId,
    // Nobody is notified about their own action, which sounds obvious and is the
    // bug that reaches production.
    recipientUserIds: without(await managerRecipients(ownerCompanyId), actorUserId),
    title: `${count} ${count === 1 ? 'file' : 'files'} added to a project`,
    body: `A subcontractor added ${count} ${count === 1 ? 'file' : 'files'} of evidence.`,
    subjectType: 'PROJECT',
    subjectId: projectId,
    actionUrl: `/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/** Evidence was deliberately shared with the client (§22.4, packet §6). */
async function onEvidencePublished(event: OutboxEvent): Promise<void> {
  const clientCompanyId = required(event.payload, 'clientCompanyId');
  const projectId = required(event.payload, 'projectId');
  const actorUserId = optional(event.payload, 'actorUserId');
  const count = Number(event.payload.count ?? 0);

  await dispatchNotification({
    kind: 'evidence.published',
    companyId: clientCompanyId,
    recipientUserIds: without(await managerRecipients(clientCompanyId), actorUserId),
    title: `${count} ${count === 1 ? 'file' : 'files'} shared with you`,
    // Deliberately does not name the sharing company. The portal's own audit rule
    // is that a visible row never names a counterparty, and the client already
    // knows whose project they are looking at.
    body: `New evidence is available on a project you are following.`,
    subjectType: 'PROJECT',
    subjectId: projectId,
    actionUrl: `/portal/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A file was refused by the scanner, and the person who uploaded it is told.
 *
 * **Told, and not left to notice.** The scan happens minutes after the upload,
 * in a worker, long after the screen that started it has moved on — so without
 * this the failure is a thing Ade discovers weeks later when a report is short of
 * a photograph. The uploader is the recipient rather than the company, because a
 * refused file is a fact about one person's attempt and not about the business.
 */
async function onFileScanFailed(event: OutboxEvent): Promise<void> {
  const uploaderUserId = required(event.payload, 'uploadedByUserId');
  const fileId = required(event.payload, 'fileId');
  const companyId = optional(event.payload, 'companyId');

  await dispatchNotification({
    kind: 'file.scan_failed',
    companyId,
    // The uploader IS the recipient here, so `without(..., actorUserId)` would
    // silence the only message that matters. The "never your own action" rule is
    // about acts a person performed; this is an outcome that happened to them.
    recipientUserIds: [uploaderUserId],
    title: 'A file could not be stored',
    // The reason class, never the filename — a filename is customer prose and
    // this body reaches an email server.
    body: optional(event.payload, 'reasonClass') === 'TYPE_MISMATCH'
      ? 'One of your uploads was not the type it claimed to be and was not stored. Re-take or re-export it and try again.'
      : 'One of your uploads could not be stored. Try uploading it again.',
    subjectType: 'STORED_FILE',
    subjectId: fileId,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A document was re-issued (§24, packet §6).
 *
 * The body is composed from the **category and the version**, never from the
 * title or the reference. §11 names both in its exclusion list, and they are the
 * two fields anybody would reach for first: a title is customer prose, and a
 * reference is a waste transfer note number — a fact about a real disposal at a
 * real site. `describeSupersession` produces "RAMS v3 replaced v2", which is §6's
 * own wording and needs neither.
 */
async function onDocumentSuperseded(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const projectId = required(event.payload, 'projectId');
  const documentId = required(event.payload, 'documentId');
  const actorUserId = optional(event.payload, 'actorUserId');
  const category = required(event.payload, 'category') as DocumentCategory;
  const version = Number(event.payload.version ?? 0);

  await dispatchNotification({
    kind: 'document.superseded',
    companyId: ownerCompanyId,
    recipientUserIds: without(await managerRecipients(ownerCompanyId), actorUserId),
    title: describeSupersession({ category, version }),
    body: 'A newer version of this document is now the current one. The previous version is kept in its history.',
    subjectType: 'PROJECT_DOCUMENT',
    subjectId: documentId,
    actionUrl: `/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  /*
   * Re-issuing closes the expiry task the old version raised. Without this, the
   * Action Centre keeps asking for a RAMS that has already been renewed — and an
   * inbox full of already-handled items is one people stop reading, which is the
   * rule `onWorkDecided` was written for and the same call it makes.
   */
  const supersededId = optional(event.payload, 'supersededId');
  if (supersededId) {
    await resolveActionsForSubject({ subjectType: 'PROJECT_DOCUMENT', subjectId: supersededId });
  }
}

/**
 * A document is approaching, or past, its expiry date (§24, packet §5).
 *
 * **The one kind in this phase that `requiresAction`**, because unlike a
 * photograph arriving there is something the recipient must actually do: re-issue
 * it. The task closes itself when a newer version supersedes this one, above.
 *
 * Phase 12 owns the escalation — who else is told at 14 days, and the portfolio
 * compliance surface. What ships here is the durable item, because
 * `notifications.md` allows no kind to exist only as an email, and a lapsing
 * insurance certificate is the least acceptable thing to lose in a spam folder.
 */
async function onDocumentExpiring(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const projectId = required(event.payload, 'projectId');
  const documentId = required(event.payload, 'documentId');
  const category = required(event.payload, 'category') as DocumentCategory;
  const daysRemaining = Number(event.payload.daysRemaining);
  if (!Number.isFinite(daysRemaining)) {
    throw new PermanentDeliveryError('daysRemaining missing from payload — nothing to describe');
  }

  /*
   * Both companies are told when the document belongs to a subcontractor, and
   * neither alone is enough. The provider is who has to renew its own insurance;
   * the hiring company is who is exposed if it does not, and who finds out
   * otherwise from an auditor. `dispatchNotification` is called twice rather than
   * with a merged recipient list because the two notifications hang off different
   * companies — an item filed under the wrong tenant is one nobody can act on.
   */
  const providerCompanyId = optional(event.payload, 'providerCompanyId');
  const title = describeExpiry({ category, daysRemaining });
  const body =
    daysRemaining <= 0
      ? 'This document has lapsed. Upload a new version to replace it.'
      : 'Upload a new version before it lapses. The current one stays in its history.';

  await dispatchNotification({
    kind: 'document.expiring',
    companyId: ownerCompanyId,
    recipientUserIds: await managerRecipients(ownerCompanyId),
    title,
    body,
    subjectType: 'PROJECT_DOCUMENT',
    subjectId: documentId,
    actionUrl: `/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  if (providerCompanyId && providerCompanyId !== ownerCompanyId) {
    await dispatchNotification({
      kind: 'document.expiring',
      companyId: providerCompanyId,
      recipientUserIds: await managerRecipients(providerCompanyId),
      title,
      body,
      subjectType: 'PROJECT_DOCUMENT',
      subjectId: documentId,
      topic: event.topic,
      // A distinct aggregate suffix, or the dedupe key would make the second
      // company's copy look like a redelivery of the first company's and silently
      // drop it — the same shape the closure notices already use.
      aggregateId: `${event.aggregateId}:provider`,
    });
  }
}

/**
 * A subcontractor closed a day on the hiring company's project (§23, packet §6).
 *
 * The title names the **day**, not the person, and the difference is what makes it
 * readable a week later: *"Tuesday 3 March closed"* is findable in an inbox and
 * *"Ade closed a day"* is not. The attendance totals ride in the body because they
 * are the one thing a hiring company checks first — they are numbers the payload
 * already carries, and §11 excludes the attendance *names* rather than the counts.
 *
 * Only the project owner is told, and only when somebody else closed it. A company
 * closing a day on its own project is telling itself.
 */
async function onDiaryClosed(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const authorCompanyId = required(event.payload, 'authorCompanyId');
  const projectId = required(event.payload, 'projectId');
  const diaryEntryId = required(event.payload, 'diaryEntryId');
  const entryDate = required(event.payload, 'entryDate');
  const actorUserId = optional(event.payload, 'actorUserId');
  if (authorCompanyId === ownerCompanyId) return;

  const workers = Number(event.payload.workersPresentCount ?? 0);
  const subs = Number(event.payload.subcontractorsPresentCount ?? 0);
  const present = workers + subs;

  await dispatchNotification({
    kind: 'diary.closed',
    companyId: ownerCompanyId,
    recipientUserIds: without(await managerRecipients(ownerCompanyId), actorUserId),
    title: `${describeDiaryDay(entryDate)} closed`,
    body:
      present > 0
        ? `A subcontractor closed their site diary for the day, with ${present} on site.`
        : 'A subcontractor closed their site diary for the day.',
    subjectType: 'SITE_DIARY_ENTRY',
    subjectId: diaryEntryId,
    actionUrl: `/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A subcontractor recorded what it took off the floor (§25, packet §6).
 *
 * **One item for the batch, whatever its size.** Sixty pasted lines is one act by
 * one person; sixty items is an inbox that teaches people to clear it without
 * reading, which is the same reason `evidence.uploaded` does not exist.
 *
 * **The body names counts, masses and nothing else.** No description, no
 * manufacturer, no serial number — a serial identifies a specific machine, usually
 * with a client's asset tag on it, and this body travels to an email provider.
 * §11's exclusion list is enforced upstream by the payload allowlist, so there is
 * nothing here to leak even by accident; what this composes from is the count, the
 * mass and the number of lines still unweighed.
 *
 * That last figure is in the body on purpose. A register that arrives with
 * "18 lines, no weights yet" is a to-do; one that says only "18 lines" reads as
 * finished, and §28.3 exists because an unweighed line is the commonest gap there
 * is.
 *
 * Only the project owner is told, and only when somebody else did the recording. A
 * company recording assets on its own project is telling itself.
 */
async function onAssetLinesRecorded(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const recordingCompanyId = required(event.payload, 'recordingCompanyId');
  const projectId = required(event.payload, 'projectId');
  const actorUserId = optional(event.payload, 'actorUserId');
  if (recordingCompanyId === ownerCompanyId) return;

  const lineCount = Number(event.payload.lineCount ?? 0);
  if (lineCount === 0) return;
  const totalWeightKg = event.payload.totalWeightKg;
  const withoutWeight = Number(event.payload.linesWithoutWeight ?? 0);

  const mass =
    typeof totalWeightKg === 'number' ? ` — ${formatMassKg(totalWeightKg)}` : '';
  const gap =
    withoutWeight > 0
      ? ` ${withoutWeight} of them ${withoutWeight === 1 ? 'has' : 'have'} no weight recorded yet.`
      : '';

  await dispatchNotification({
    kind: 'asset.lines_recorded',
    companyId: ownerCompanyId,
    recipientUserIds: without(await managerRecipients(ownerCompanyId), actorUserId),
    title: `${lineCount} asset ${lineCount === 1 ? 'line' : 'lines'} recorded`,
    body: `A subcontractor recorded what came off site${mass}.${gap}`,
    subjectType: 'PROJECT',
    subjectId: projectId,
    actionUrl: `/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * Material has been sitting in storage past the threshold (§25.4, packet §5–§6).
 *
 * **The only enforcement locked decision #18 has.** Storage counting toward no
 * rate at all is correct and completely silent, so this is the item that says so
 * out loud, once, with the mass named — *"1.34 t has been in storage 42 days.
 * Where did it go?"*
 *
 * **The one asset kind that sets `requiresAction`**, because it is the one with
 * something to do about it, and the doing closes it: recording where the material
 * went is exactly the act the item is asking for.
 *
 * **Two recipient cohorts, chosen differently, and the difference is the point.**
 * The project owner's copy goes to `sustainability.read` holders rather than to
 * managers — this is a question about a diversion figure, and a Supervisor's
 * bundle does not carry that capability while an analyst's does. The recording
 * company gets the managers' copy, because it is the party that physically moved
 * the material and knows which warehouse it is in.
 *
 * The body names no asset: no description, no serial, no destination
 * organisation. The payload allowlist enforces that upstream, so there is nothing
 * here to leak even by accident.
 */
async function onAssetStorageAgeing(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const recordingCompanyId = required(event.payload, 'recordingCompanyId');
  const projectId = required(event.payload, 'projectId');
  const assetId = required(event.payload, 'assetId');
  const days = Number(event.payload.daysInStorage);
  if (!Number.isFinite(days)) {
    throw new PermanentDeliveryError('daysInStorage missing from payload — nothing to describe');
  }
  const inStorageKg =
    typeof event.payload.inStorageKg === 'number' ? event.payload.inStorageKg : null;
  const quantity = Number(event.payload.quantity ?? 0);

  const title = describeStorageAgeing({ inStorageKg, quantity, daysInStorage: days });
  const body =
    'Material in storage counts toward no diversion rate until a final destination is recorded, so this project’s figures are currently a floor. Record where it went, or leave it — nothing is blocked either way.';

  await dispatchNotification({
    kind: 'asset.storage_ageing',
    companyId: ownerCompanyId,
    recipientUserIds: await capabilityRecipients(ownerCompanyId, 'sustainability.read'),
    title,
    body,
    subjectType: 'PROJECT_ASSET',
    subjectId: assetId,
    actionUrl: `/projects/${projectId}?section=assets`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  if (recordingCompanyId !== ownerCompanyId) {
    await dispatchNotification({
      kind: 'asset.storage_ageing',
      companyId: recordingCompanyId,
      recipientUserIds: await managerRecipients(recordingCompanyId),
      title,
      body,
      subjectType: 'PROJECT_ASSET',
      subjectId: assetId,
      actionUrl: `/projects/${projectId}?section=assets`,
      topic: event.topic,
      // A distinct aggregate suffix, or the dedupe key would make the second
      // company's copy look like a redelivery of the first company's and silently
      // drop it — the shape `document.expiring` and the closure notices use.
      aggregateId: `${event.aggregateId}:recorder`,
    });
  }
}

/**
 * A closed day was changed (§23, packet §6).
 *
 * **Both the hiring company and the authoring company's own decision-makers**, and
 * the second half is the one that looks redundant and is not: the person who
 * amended it knows, and their owner — who may have quoted the original in a report
 * — does not. §6 names both recipients for exactly that reason.
 *
 * The **reason** is in the body. It is the single piece of customer prose any
 * Phase 7 payload carries, §5 puts it there by name, and §6 writes it into the
 * item verbatim: an amendment notice that cannot say why has to be clicked to be
 * useful, which for the one kind that is never digested defeats the point of not
 * digesting it. The before and after values stay in `record_revisions`, behind the
 * same authorization as the entry.
 */
async function onDiaryAmended(event: OutboxEvent): Promise<void> {
  const ownerCompanyId = required(event.payload, 'ownerCompanyId');
  const authorCompanyId = required(event.payload, 'authorCompanyId');
  const projectId = required(event.payload, 'projectId');
  const diaryEntryId = required(event.payload, 'diaryEntryId');
  const entryDate = required(event.payload, 'entryDate');
  const reason = required(event.payload, 'reason');
  const actorUserId = optional(event.payload, 'actorUserId');
  const revision = Number(event.payload.revision ?? 0);

  const title = `${describeDiaryDay(entryDate)} amended — reason: ${reason}`;
  const body = `This day was closed and has been changed since (${
    describeAmendments(revision) ?? 'amended'
  }). The full history is on the entry.`;

  await dispatchNotification({
    kind: 'diary.amended',
    companyId: ownerCompanyId,
    recipientUserIds: without(await managerRecipients(ownerCompanyId), actorUserId),
    title,
    body,
    subjectType: 'SITE_DIARY_ENTRY',
    subjectId: diaryEntryId,
    actionUrl: `/projects/${projectId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  if (authorCompanyId !== ownerCompanyId) {
    await dispatchNotification({
      kind: 'diary.amended',
      companyId: authorCompanyId,
      recipientUserIds: without(await managerRecipients(authorCompanyId), actorUserId),
      title,
      body,
      subjectType: 'SITE_DIARY_ENTRY',
      subjectId: diaryEntryId,
      actionUrl: `/projects/${projectId}`,
      topic: event.topic,
      // A distinct aggregate suffix, or the dedupe key would make the second
      // company's copy look like a redelivery of the first company's and silently
      // drop it — the same shape the closure notices and `document.expiring` use.
      aggregateId: `${event.aggregateId}:author`,
    });
  }
}

/**
 * A factor set landed (§26.2, packet §6).
 *
 * **To the importing user only, and in-app only.** Nobody else in the company is
 * waiting for it, and an email about a spreadsheet somebody just uploaded
 * themselves is the definition of noise. The item exists so the import has a
 * durable receipt with its row counts on it — the same reason `notifications.md`
 * requires every kind to have one: email is never the only copy.
 *
 * The counts are **by category** because "1,842 rows imported" is unreadable and
 * "freight 210 · fuels 96 · waste 148" is what an operator checks a workbook
 * against. No factor values travel: §11 excludes them, and a factor value is
 * commercially sensitive third-party data even when the set is a government one.
 */
async function onFactorSetImported(event: OutboxEvent): Promise<void> {
  const companyId = required(event.payload, 'companyId');
  const actorUserId = optional(event.payload, 'actorUserId');
  if (actorUserId === null) return;

  const name = required(event.payload, 'name');
  const version = required(event.payload, 'version');
  const rowCount = Number(event.payload.rowCount ?? 0);
  const counts = event.payload.countsByCategory;
  const breakdown =
    counts !== null && typeof counts === 'object'
      ? Object.entries(counts as Record<string, number>)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([category, n]) => `${category} ${n}`)
          .join(' · ')
      : '';

  await dispatchNotification({
    kind: 'sustainability.factor_set_imported',
    companyId,
    recipientUserIds: [actorUserId],
    title: `${name} ${version} imported — ${rowCount} factor${rowCount === 1 ? '' : 's'}`,
    body: breakdown === '' ? 'The set is active and available to select.' : `${breakdown}.`,
    subjectType: 'EMISSION_FACTOR_SET',
    subjectId: event.aggregateId,
    actionUrl: `/sustainability/factors?set=${event.aggregateId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A set was deactivated **while live calculations cite it** (packet §6).
 *
 * The only factor event with a consequence somebody else has to know about: the
 * projects citing it will select a different set the next time anything
 * recalculates, and their published figures will move. So it earns an email as well
 * as an in-app item, and it goes to everyone who could have done it rather than to
 * the person who did.
 *
 * A set nothing cites raises no event at all — the enqueuing side returns early on
 * zero, which is the difference between a warning and a log line.
 */
async function onFactorSetDeactivated(event: OutboxEvent): Promise<void> {
  const companyId = required(event.payload, 'companyId');
  const name = required(event.payload, 'name');
  const version = required(event.payload, 'version');
  const cited = Number(event.payload.citedByCalculations ?? 0);

  await dispatchNotification({
    kind: 'sustainability.factor_set_deactivated',
    companyId,
    recipientUserIds: await capabilityRecipients(companyId, 'sustainability.factors.manage'),
    title: `${name} ${version} deactivated — ${cited} live calculation${cited === 1 ? '' : 's'} cite it`,
    body: 'Those figures are unchanged and still cite this set. Anything recalculated from now on will select a different one, so the numbers can move.',
    subjectType: 'EMISSION_FACTOR_SET',
    subjectId: event.aggregateId,
    actionUrl: `/sustainability/factors?set=${event.aggregateId}`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A claim that could not be made — **the one sustainability kind that earns its
 * place** (packet §5).
 *
 * Every other kind in this catalog reports something that happened; this reports
 * something that *didn't*. §41.1's "no factor, no number — say so instead" is a rule
 * about the report, and a rule about the report alone means the first time anybody
 * learns the claim is missing is when the report is generated, which is after the
 * client meeting is booked.
 *
 * **Three reasons, two recipient cohorts, because they have different fixes.** A
 * missing product factor is the factor library's problem and goes to whoever
 * curates it. An unstated displacement assumption is a decision about how this
 * organisation reports, and is resolved by somebody stating an assumption rather
 * than by adding data.
 *
 * The body names the asset type and the total quantity and nothing else: no
 * description, no serial, no destination organisation. The payload allowlist
 * enforces that upstream, so there is nothing here to leak even by accident.
 */
async function onClaimBlocked(event: OutboxEvent): Promise<void> {
  const companyId = required(event.payload, 'companyId');
  const projectId = required(event.payload, 'projectId');
  const reason = required(event.payload, 'reason');

  const subjects = Array.isArray(event.payload.subjects)
    ? (event.payload.subjects as { subject?: unknown; quantity?: unknown }[])
    : [];
  const described = subjects
    .filter((s) => typeof s.subject === 'string')
    .map((s) => `${Number(s.quantity ?? 0)} × ${String(s.subject)}`)
    .join(', ');
  if (described === '') {
    throw new PermanentDeliveryError(
      'claim_blocked payload named nothing — there is no item to raise'
    );
  }

  const copy =
    reason === 'DISPLACEMENT_UNKNOWN'
      ? {
          title: `No avoided-emissions claim for ${described} — no displacement assumption`,
          body: 'CrewQuo will not assume that reused material displaced a purchase. State a displacement assumption in sustainability settings and the claim can be made.',
          capability: 'sustainability.read' as const,
        }
      : reason === 'GENERIC_NOT_ALLOWED'
        ? {
            title: `No avoided-emissions claim for ${described} — only a generic factor is available`,
            body: 'A generic product factor exists but generic factors are switched off for this company. Add a product-specific factor, or turn generics on knowing the report will label the figure as an estimate.',
            capability: 'sustainability.factors.manage' as const,
          }
        : {
            title: `No avoided-emissions claim for ${described} — no product carbon factor`,
            body: 'Add an embodied-carbon factor for this item and the claim can be made. Until then the material is reported as reused with no carbon benefit attached.',
            capability: 'sustainability.factors.manage' as const,
          };

  await dispatchNotification({
    kind: 'sustainability.claim_blocked',
    companyId,
    recipientUserIds: await capabilityRecipients(companyId, copy.capability),
    title: copy.title,
    body: copy.body,
    subjectType: 'PROJECT',
    subjectId: projectId,
    actionUrl: `/projects/${projectId}?section=sustainability`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}


/**
 * A document reaching somebody outside the tenancy.
 *
 * The client's managers, on the client's own company — this is the moment they
 * acquire a file, and the Action Centre row is what makes it durable when the
 * email is filtered. `requiresAction: false`: reading a completion report is not a
 * task, and an item that waits for somebody to click "resolve" on a document they
 * have already read is a task with no work in it.
 */
async function onReportDisclosed(event: OutboxEvent): Promise<void> {
  const clientCompanyId = required(event.payload, 'clientCompanyId');
  const reportId = required(event.payload, 'reportId');
  const title = optional(event.payload, 'title') ?? 'A project report';

  await dispatchNotification({
    kind: 'report.disclosed',
    companyId: clientCompanyId,
    recipientUserIds: await managerRecipients(clientCompanyId),
    title: `${title} is available`,
    body: 'Your contractor has shared a completed report with you. It is available in your portal.',
    subjectType: 'GENERATED_REPORT',
    subjectId: reportId,
    actionUrl: `/portal/${optional(event.payload, 'projectId') ?? ''}?section=reports`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A document the client already holds has been restated.
 *
 * The **only** supersession that notifies, and the packet says why: if nothing was
 * ever disclosed, this is internal bookkeeping on a document only its author has
 * seen, and notifying would train the recipient to ignore the channel — which is
 * how the item that matters gets missed.
 *
 * The body names the figures that moved, computed inside the generating
 * transaction. A client told "your report changed" learns nothing; one told "the
 * diversion rate moved from 91.8% to 89.4%" knows what to do.
 */
async function onReportSuperseded(event: OutboxEvent): Promise<void> {
  const clientCompanyId = required(event.payload, 'clientCompanyId');
  const supersededById = required(event.payload, 'supersededById');
  const title = optional(event.payload, 'title') ?? 'A project report';
  const summary = optional(event.payload, 'summary');

  await dispatchNotification({
    kind: 'report.superseded',
    companyId: clientCompanyId,
    recipientUserIds: await managerRecipients(clientCompanyId),
    title: `${title} has been reissued`,
    body: summary
      ? `The figures behind a report you were given have changed. ${summary}. The earlier document is retained.`
      : 'A report you were given has been reissued from corrected records. The earlier document is retained.',
    subjectType: 'GENERATED_REPORT',
    subjectId: supersededById,
    actionUrl: `/portal/${optional(event.payload, 'projectId') ?? ''}?section=reports`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });
}

/**
 * A signature was taken on site — told to both sides of the edge.
 *
 * The contractor's `report.generate` holders, because a sign-off is what closes a
 * project and they are the people who act on that. And the client's managers,
 * because **the client's copy is the durable record that they signed** — the one
 * artefact in the product a client can point to without logging in to somebody
 * else's system.
 *
 * The actor is excluded from the contractor's half: the supervisor who held the
 * tablet does not need telling.
 */
async function onSignoffCaptured(event: OutboxEvent): Promise<void> {
  const companyId = required(event.payload, 'companyId');
  const signoffId = required(event.payload, 'signoffId');
  const projectId = required(event.payload, 'projectId');
  const signerName = optional(event.payload, 'signerName') ?? 'the client';
  const phase = optional(event.payload, 'phase');
  const clientCompanyId = optional(event.payload, 'clientCompanyId');
  const superseding = event.topic === 'signoff.superseded';
  const reason = optional(event.payload, 'reason');

  const scope = phase ? `phase "${phase}"` : 'the project';
  const title = superseding
    ? `Client sign-off for ${scope} was captured again`
    : `Client sign-off captured for ${scope}`;
  const body = superseding
    ? `${signerName} signed again${reason ? `: ${reason}` : ''}. Both signatures are retained.`
    : `${signerName} signed for completion. The signature and what it was signed for are retained.`;

  await dispatchNotification({
    kind: superseding ? 'signoff.superseded' : 'signoff.captured',
    companyId,
    recipientUserIds: await capabilityRecipients(companyId, 'report.generate'),
    title,
    body,
    subjectType: 'CLIENT_SIGNOFF',
    subjectId: signoffId,
    actionUrl: `/projects/${projectId}?section=reports`,
    topic: event.topic,
    aggregateId: event.aggregateId,
  });

  if (clientCompanyId) {
    await dispatchNotification({
      kind: superseding ? 'signoff.superseded' : 'signoff.captured',
      companyId: clientCompanyId,
      recipientUserIds: await managerRecipients(clientCompanyId),
      title: superseding ? 'A sign-off was captured again' : 'Your sign-off was recorded',
      body: superseding
        ? `A replacement sign-off was captured${reason ? `: ${reason}` : ''}. Both are retained with their signatures.`
        : `${signerName} signed for completion on your behalf. Your copy is in the portal.`,
      subjectType: 'CLIENT_SIGNOFF',
      subjectId: signoffId,
      actionUrl: `/portal/${projectId}?section=signoff`,
      topic: event.topic,
      aggregateId: `${event.aggregateId}:client`,
    });
  }
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
  ['evidence.batch_uploaded', onEvidenceBatchUploaded],
  ['evidence.published', onEvidencePublished],
  ['file.scan_failed', onFileScanFailed],
  ['document.superseded', onDocumentSuperseded],
  ['document.expiring', onDocumentExpiring],
  ['diary.closed', onDiaryClosed],
  ['diary.amended', onDiaryAmended],
  ['asset.lines_recorded', onAssetLinesRecorded],
  ['asset.storage_ageing', onAssetStorageAgeing],
  ['sustainability.factor_set_imported', onFactorSetImported],
  ['sustainability.factor_set_deactivated', onFactorSetDeactivated],
  ['sustainability.claim_blocked', onClaimBlocked],
  /*
   * Reporting and sign-off (§29, §34). `report.generated` is deliberately absent:
   * generating a report is a thing the person did on purpose two seconds ago, and
   * an item telling them so is how a channel gets ignored.
   */
  ['report.disclosed', onReportDisclosed],
  ['report.superseded', onReportSuperseded],
  ['signoff.captured', onSignoffCaptured],
  ['signoff.superseded', onSignoffCaptured],
  /*
   * `sustainability.calculations_superseded` is deliberately absent, and the absence
   * is the design (packet §6). It is the most frequent event in the domain and the
   * least actionable: it fires because somebody corrected a weight, which is a thing
   * they did on purpose and already know about. Notifying would train every
   * recipient to ignore the channel, which is how the genuinely actionable
   * `claim_blocked` item gets missed. The event still lands in the outbox and in the
   * audit trail carrying its per-bucket delta, which is where the answer to "why did
   * this number move" lives.
   */
  ['auth.token_reuse', onAuthSecurityEvent],
  ['auth.session_revoked', onAuthSecurityEvent],
  ['auth.mfa_enrolled', onAuthSecurityEvent],
  ['auth.mfa_removed', onAuthSecurityEvent],
  ['auth.mfa_reset_by_operator', onAuthSecurityEvent],
  /*
   * `account.closure_completed` is deliberately absent, and its absence is the design
   * rather than an omission. That notice is written inside the transaction that
   * anonymised the account (`deletion/execute.ts`), because every other kind is
   * enqueued so a worker can resolve its recipients later and this one's recipient has
   * stopped existing by the time a worker would look.
   */
  ['account.closure_scheduled', onAccountClosureScheduled],
  ['account.closure_imminent', onAccountClosureImminent],
  ['account.closure_cancelled', onAccountClosureCancelled],
  ['company.closure_scheduled', onCompanyClosureScheduled],
  ['company.closure_cancelled', onCompanyClosureCancelled],
]);
