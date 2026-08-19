# Operating-model packet — notifications & the Action Centre

**Domain:** how a person is told that something happened, and where the things
they still have to *do* live — the durable per-recipient projection, its channel
deliveries (in-product, email, push), per-user preferences, quiet hours and
digests, and the retry/dead-letter path when a channel fails.
**Phase:** 6 · **Status:** adopted · **Last updated:** 2026-08-19
**Plan refs:** §3.4/§3.6 (the events worth telling someone about), §5 (Resend for
verify/reset), §9.2 (the three workspace views this inbox is read through), §19.5
(this packet), §36 (revisions), §42 (the Phase 6 bullet), §44 (the test list).
**Depends on:** `docs/operating-model/durable-delivery.md`, whose §6 deliberately
parked every question below rather than answering them at the substrate level.

---

**The distinction this whole domain rests on:** a **notification** is a message
about something that happened. An **Action Centre item** is a thing somebody still
has to do. They are not the same, and the product has neither today — what exists
is seven `void notifyCompanyManagers(...)` calls that fire an Expo push and forget
it. If the push fails, or the device is offline, or the user has no app installed,
**the fact is gone**. There is no record that anyone was told, no way to see what
is outstanding, and no second attempt.

> **One table, not two.** The plan's wording is *"one durable task projection for
> approvals, exceptions and failed operations; later phases add their own task
> kinds rather than their own inbox architecture."* So the Action Centre is not a
> second system beside notifications — it is the **actionable subset** of the same
> per-recipient projection, distinguished by `requires_action` and resolved by
> `resolved_at`. A later phase adding "compliance document expiring" adds a *kind*,
> not a table. Building two inboxes now would guarantee they disagree about what is
> outstanding, which is the one thing an inbox exists to answer.

## 1. Persona / job

| Persona | Job | Device / connectivity |
|---|---|---|
| **Contractor approver** | "What is waiting on me right now?" — submitted time, rate proposals, expenses. | Desktop web mostly; phone in the field. Wants a list, not an archaeology dig through email. |
| **Subcontractor** | "Did they approve my hours, and if not, why?" | Phone first, often on site with poor signal. |
| **Anyone at 11pm** | "Do not wake me up for something that can wait until Monday." | Push is the intrusive channel; this persona is why quiet hours exist. |
| **Platform operator** | "This customer says they never got the email. Did we send it, and what did the provider say?" | Platform console. Needs delivery history, not a log grep. |
| **A person who left** | Their tasks must not vanish or become invisible when their membership is suspended. | n/a — see §7. |

## 2. Resource responsibility

| Resource | Creator | Owner | Reader | Reviewer | Publisher | Corrector | Exporter | Retention owner |
|---|---|---|---|---|---|---|---|---|
| `notifications` row | the outbox consumer, from a domain event | the recipient user | **only that recipient**, plus platform support for delivery diagnosis | — | — | the recipient (read / resolve / dismiss) | the recipient | company (follows the company it belongs to) |
| `notification_deliveries` row | the delivery worker | the platform | platform operators; the recipient sees only "sent", never the provider payload | — | — | **nobody** — a delivery attempt is evidence; a retry is a new row | platform | platform |
| `notification_preferences` | the user, lazily on first change | that user | that user | — | — | that user | that user | user |

**A notification is never edited into a different notification.** Its text is
frozen at write time from the facts as they were: "Dana approved 8h on Pier 9"
must keep saying that even after the approval is reversed, because it is a record
of what the recipient was told. A reversal is a *new* notification.

## 3. State machine

`PENDING → SENT` on the delivery side, and independently `UNREAD → READ` plus, for
actionable items, `→ RESOLVED | DISMISSED` on the recipient side.

| Transition | Actor | Rule |
|---|---|---|
| created `UNREAD` | the outbox consumer | idempotent on `dedupe_key`; a replayed event produces the same one row |
| `UNREAD → READ` | the recipient | non-actionable items stop here — read is the terminal state |
| `UNREAD/READ → RESOLVED` | the recipient, **or the system** | an actionable item can be resolved by somebody else doing the work: if a colleague approves the time log, the task is done and must close itself rather than sit there lying |
| `UNREAD/READ → DISMISSED` | the recipient only | "I have seen this and I am not acting on it" — kept, not deleted, so it does not reappear on the next projection |
| any → any | **nobody re-opens** | a resolved task that recurs is a new row with a new `dedupe_key`; reopening would lose when it was first raised |

**The concurrency rule:** two approvers racing to resolve the same task both
succeed — `update ... where resolved_at is null returning` decides who is recorded
as the resolver, and the loser gets the already-resolved row rather than an error.
An inbox that throws a conflict at the second person to click is worse than one
that quietly agrees.

## 4. Permission + scope matrix

| Operation | Feature entitlement | Capability / role | Company edge | Resource scope |
|---|---|---|---|---|
| `GET /v1/notifications` | none — being told what you must do is not a paid feature | any authenticated user | scoped to the active company | **`recipient_user_id = me`, always.** There is no "read another user's inbox" path at any role |
| `PATCH /v1/notifications/:id` (read/resolve/dismiss) | none | the recipient | — | own row only; another user's id is a 404 |
| `GET`/`PUT /v1/notification-preferences` | none | the user | — | own preferences only |
| Delivery history | — | **Super Admin only** | — | platform-scoped; a customer sees "sent", never the provider response |

**No entitlement gate, and §43 adds no key** — the same argument as the money
boundary. A plan says what a company may *do*; a Crew-plan subcontractor still has
to find out their hours were rejected, and gating that would make the free tier
quietly broken rather than merely limited.

**Recipients are resolved to user ids at write time, never to a role at read
time.** A role-scoped inbox would silently change who is responsible when a
membership changes, and would make "who was told" unanswerable. The cost is that
a person invited *after* an event does not inherit its notification, which is
correct: they were not told.

## 5. Domain events

Consumed, not produced. The consumer subscribes to outbox topics and is the first
real consumer the durable-delivery substrate has had:

| Topic | Recipients | Actionable? |
|---|---|---|
| `work.submitted` | approvers at the hiring company | yes — approve or reject |
| `work.approved` / `work.rejected` | the person who logged it | no |
| `rate_proposal.submitted` | approvers at the hiring company | yes |
| `rate_proposal.decided` | the proposing company's managers | no |
| `invoice.issued` | the counterparty's managers | yes — it is a claim on them |
| `delivery.dead_lettered` | platform operators | yes — the "failed operations" arm of the Action Centre |

Each notification carries `dedupe_key = <topic>:<aggregateId>:<recipientUserId>`,
so a replayed outbox event writes one row per recipient and no more. **Handlers
must be idempotent before acknowledging**, which is the durable-delivery packet's
§5 rule; here that is a unique index rather than a promise.

## 6. Notification matrix

| Channel | What it is | Failure meaning |
|---|---|---|
| **In-product** | the `notifications` row itself. Written in the same transaction as the delivery claim | if this fails, nothing was delivered — the event retries |
| **Email** | Resend. Falls back to a logged line when no API key is configured, exactly as verify/reset already does | retryable; retried through the same outbox with backoff, then dead-lettered visibly |
| **Push** | the existing Expo path, now recorded rather than fired and forgotten | retryable, and a dead token is *permanent* — it dead-letters without retrying, because a retry cannot fix a device that is gone |

**In-product is never optional and never deferred.** Preferences and quiet hours
govern *email and push only*. This is the single most important rule in the packet:
a task the product hid because it was 11pm is a task nobody did. Quiet hours delay
the knock on the door, never the entry in the list.

**Digests** batch non-urgent email into one send per window rather than one per
event. Urgency is a property of the kind, not of the sender's mood, and exactly one
category is `URGENT` today — a dead-lettered operation — which bypasses quiet hours
because the whole point of an operator alert is to arrive when things are broken.

The four rules the implementation commits to, because each is a decision rather
than a detail:

1. **Email only.** A digest batches *messages*; a push is a knock on a device, and
   one knock standing in for six is not a summary, it is five notifications that
   never arrived. `deliveryHoldMinutes` takes the channel as an input for exactly
   this reason, so the function that would have to change to break the rule
   cannot express it.
2. **A window that has just opened closes at the next boundary.** At exactly 09:00
   an hourly digest waits the full hour, so everything raised in that hour arrives
   together at 10:00. Sending the first event of each window on its own and
   batching only the remainder is a digest that does not digest.
3. **`DAILY` goes out at the end of quiet hours, or at 08:00.** Neither the plan
   nor this packet names an hour, so this is a chosen default: a digest delivered
   at local midnight is read at 08:00 anyway, and one delivered at 08:00 is the one
   people act on. When somebody has set quiet hours, the end of their own window is
   a better statement of "I am available again" than any default.
4. **Quiet hours apply at the digest boundary, not at now.** Taking the larger of
   the two delays is the tempting shortcut and it is wrong: at 21:30 with quiet
   hours from 22:00, the hourly boundary lands *inside* the window and neither
   delay on its own catches it.

**Batching happens in the delivery worker, not only at dispatch.** Holding six
emails until 10:00 and then sending six emails at 10:00 is a delay, not a digest.
The worker groups the due email of each recipient who asked for one and makes a
single provider call, recording that one outcome against every delivery row it
covered — so "was I told?" stays answerable per notification. Grouping is bounded
by the claimed batch: a recipient with more due email than the batch limit gets
two messages rather than one, which errs toward sending and stops one person's
backlog holding up everybody else's.

## 7. Data classification + retention

A notification body is **commercial and personal**: it names amounts, projects and
people. It belongs to one recipient and one company, is never client-visible
through the portal, and never appears in an export the counterparty receives.
Delivery rows additionally hold a provider message id and error text — platform
data, never shown to a customer, because a provider error can leak an address or
an internal identifier.

Retention follows the company. A **suspended** membership keeps its notifications
and its open tasks: hiding them would make outstanding work invisible at exactly
the moment somebody needs to reassign it. Deleting a user anonymises the recipient
and keeps the row's company-side facts, so "this was raised and resolved" survives
the person leaving.

## 8. Offline / conflict policy

The inbox is read-mostly and participates in offline sync only as a **projection**:
a client may mark read/resolved offline and replay it later, and replay is
idempotent because both are set-once (`update ... where resolved_at is null`). No
tombstones — a dismissed item stays as a dismissed row, which is what stops it
reappearing when the projection is rebuilt. Nothing here is created offline: a
notification is always the server's conclusion about a server-side event.

## 9. Failure matrix

| Failure | Retryable? | What the user sees | Operator repair |
|---|---|---|---|
| Email provider 5xx / timeout | yes — outbox backoff | nothing; the item is already in their inbox | none needed; it retries |
| Email hard-bounce / invalid address | **no** — permanent | nothing | the address is a user-profile problem, surfaced in delivery history |
| Push token no longer registered | **no** — permanent, and the token is removed | nothing | none; the device re-registers on next sign-in |
| Attempts exhausted | terminal | nothing — the in-product copy still exists | dead letter visible in Platform Operations, replayable with a reason (0012) |
| Consumer throws mid-fan-out | yes | possibly a partial fan-out | the `dedupe_key` unique index makes the retry complete the rest without duplicating the ones already written |
| No API key configured | not a failure | nothing | the delivery is recorded as `SKIPPED` with the reason, so a silent dev-mode no-op is never mistaken for a send |

**`SKIPPED` is a real state, not a synonym for sent.** A row that says "we did not
send this, and here is why" is the difference between a diagnosable system and one
where absence of evidence looks like success.

## 10. Security / threat model

The inbox is the sharpest tenant boundary in the product, because it is the one
surface whose entire purpose is to hand a user facts from elsewhere. Every read
filters on `recipient_user_id = <caller>` — not on company, not on role — so a
forged id is a 404 and there is no query shape in which one user reads another's.

Notification bodies are composed server-side from resolved facts; **no caller-supplied
text ever reaches a body**, which keeps this from becoming a cross-tenant message
channel. Email rendering escapes every interpolated value, since a project name is
user-controlled and would otherwise be an HTML injection into somebody else's
mailbox. Unsubscribe applies to email and push only and can never switch off
in-product delivery — an "unsubscribe" that hid a purchase order would be a
commercial weapon, not a preference.

Provider API keys live in env and never in a payload, a notification row or a log
line. Support can read delivery *status* without reading message bodies.

## 11. Analytics contract

Activation: a user resolves their first Action Centre item. Outcome: time from
raised to resolved, per kind. Quality: the share of items resolved by somebody
other than the notified recipient (a high number means the wrong person is being
told), and the dead-letter rate per channel. Funnel: raised → delivered → read →
resolved.

**Excluded as sensitive:** message bodies, subjects, amounts, project and company
names, email addresses, push tokens and provider error text. The metrics are
counts, kinds, channels and durations.

## 12. Acceptance script

**Persona: Dana (approver, USD contractor) and Sam (subcontractor).**

1. **Empty.** A new user's inbox is empty and says so, rather than showing a spinner
   or a zero-count badge that looks like a bug.
2. **Raised.** Sam submits 8h. Dana gets one actionable item; Sam gets none — you
   are not notified of your own action.
3. **Idempotent.** The outbox event is replayed. Dana still has exactly one item.
4. **Denied.** Sam requests Dana's notification by id — 404, not 403. Sam cannot
   list it, and no role grants it.
5. **Resolved by someone else.** Dana's colleague approves the log. Dana's item
   closes itself as `RESOLVED` rather than sitting there lying, and records who
   resolved it.
6. **Told.** Sam gets a non-actionable "approved" notification whose text names the
   hours and the project, and which stays `READ`-terminal — there is nothing to
   resolve.
7. **Quiet hours.** With quiet hours set, an event at 23:00 local **still appears in
   the inbox immediately** and only the email/push is deferred to the window's end.
   Asserted both ways, because this is the rule most likely to be "optimised" away.
8. **Urgent overrides.** A dead-lettered operation reaches an operator during quiet
   hours anyway.
9. **Preference off.** With email disabled for a kind, the delivery row is `SKIPPED`
   with a reason and the in-product item is unaffected.
10. **No provider configured.** With no API key, delivery is `SKIPPED` with that
    reason recorded — never `SENT`.
11. **Retry and dead letter.** A transient channel failure retries with backoff; an
    exhausted one is visible in Platform Operations and replayable with a reason.
12. **Correction.** A dismissed item does not come back when the projection is
    rebuilt, and a genuinely recurring event arrives as a new row rather than
    reopening the old one.
