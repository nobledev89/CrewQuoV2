# Operating-model packet — durable delivery

**Domain:** transactional domain events/internal jobs and signature-verified inbound webhooks
**Phase:** 6 · **Status:** adopted for the substrate; consumer adoption in progress · **Last updated:** 2026-08-18

## 1. Persona / job

Customers need a committed business action to produce its eventual side effects exactly once despite restarts or transient outages. Platform operators need to see terminal failures and replay them safely from the web console. Provider webhooks arrive server-to-server and have no interactive user.

## 2. Resource responsibility

| Resource | Creator/owner | Reader/reviewer | Corrector | Retention owner |
|---|---|---|---|---|
| Outbox event | domain transaction / CrewQuo Platform | worker; Super Admin for failures | handler code; Super Admin may replay | platform operations |
| Webhook inbox event | provider adapter after signature verification / CrewQuo Platform | provider handler; Super Admin for failures | provider retry or handler fix; Super Admin may replay | platform operations |
| Platform replay audit | replay transaction / CrewQuo Platform | Super Admin | nobody; append-only | platform operations |

## 3. State machine

Outbox: `PENDING → PROCESSING → DELIVERED`; retryable failure returns to `PENDING`, while a permanent failure or exhausted attempt budget enters `DEAD_LETTER`. Webhook inbox mirrors this as `RECEIVED → PROCESSING → PROCESSED | DEAD_LETTER`. A reason-required replay moves only `DEAD_LETTER` back to its ready state and resets attempts. Claims use `FOR UPDATE SKIP LOCKED`; worker ownership is checked when completing/failing. A stale lease is recoverable.

## 4. Permission + scope matrix

Workers use database credentials and claim only registered topics. There is no customer endpoint. Operations reads and replay require authenticated Super Admin; replay is platform-scoped and reason-required. Company IDs are metadata for correlation, never authorization input. Provider-specific adapters must verify signatures before calling `recordVerifiedWebhook`.

## 5. Domain events

Every outbox event carries topic, aggregate type/id, optional company, JSON payload and a globally unique idempotency key. It is inserted using the same transaction client as the domain mutation. `company.created` is the first adopted event with key `company.created:<companyId>`. Consumers must make their own side effect idempotent before acknowledging delivery. Replays retain the same event/idempotency key.

## 6. Notification matrix

Not applicable at substrate level. Notification and Action Centre consumers will define recipients, urgency and quiet-hour behavior in their own packet; delivery rows are infrastructure evidence, not user-facing tasks.

## 7. Data classification + retention

Payloads are platform-confidential and must contain the minimum identifiers/facts a handler requires—never passwords, authentication tokens, webhook secrets or unfiltered headers. Successful-row retention and payload redaction periods must be set before production consumers launch. Dead letters remain until repaired or an explicit future disposal policy is adopted. Replay actions are retained in the platform audit.

## 8. Offline / conflict policy

Not a client/offline resource. Producer retries reuse an idempotency key. Webhook duplicates reuse `(provider, external_event_id)` and must have the same body hash; reusing an event ID with different content is refused. Worker races are resolved by database leases.

## 9. Failure matrix

Transient handler errors use exponential backoff from 15 seconds to one hour, with eight attempts. `PermanentDeliveryError` dead-letters immediately. Exhaustion dead-letters. A crashed worker leaves a recoverable stale lease. Domain-write failure rolls back its outbox event; outbox failure rolls back the domain write. Operations displays queue counts, failure text and audited replay. There is no silent drop.

## 10. Security / threat model

Webhook signature verification uses the raw request body before parsing and occurs before persistence. External event IDs are provider-scoped. Hash mismatch on a duplicate ID is rejected. Worker IDs are leases, not identities. Payloads must not become a tenant-data bypass; handlers re-load authoritative resources where needed. Super Admin replay cannot edit payloads.

## 11. Analytics contract

Operational metrics: ready/processing/dead-letter counts, attempts, oldest-ready age, delivery latency and replay outcome by topic/provider. Customer payload contents and failure secrets are excluded from analytics.

## 12. Acceptance script

The live suite proves a company and one idempotent outbox row commit together, Operations reads the real queue, a dead letter is visible, replay requires Super Admin plus a reason, replay resets the existing row rather than cloning it, and the operator decision is written atomically to platform audit. Consumer-specific tests must additionally prove duplicate delivery has one effect, transient retry, permanent dead-lettering, stale-lease recovery, signature refusal and duplicate webhook body-hash mismatch.
