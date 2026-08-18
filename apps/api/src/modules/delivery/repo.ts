import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';
import { deliveryFailureState } from './model';

export type DeliveryStatus = 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'DEAD_LETTER';
export type InboxStatus = 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'DEAD_LETTER';

export interface OutboxEvent {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  companyId: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
}

interface OutboxRow {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  company_id: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
}

function toOutboxEvent(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    companyId: row.company_id,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
  };
}

/** Call with the domain transaction's client so state and event commit together. */
export async function enqueueOutboxEvent(input: {
  topic: string;
  aggregateType: string;
  aggregateId: string;
  companyId?: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}, runner: Queryable): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into delivery_outbox
       (topic, aggregate_type, aggregate_id, company_id, payload, idempotency_key)
     values ($1,$2,$3,$4,$5::jsonb,$6)
     on conflict (idempotency_key) do update
       set idempotency_key = excluded.idempotency_key
     returning id`,
    [input.topic, input.aggregateType, input.aggregateId, input.companyId ?? null,
      JSON.stringify(input.payload), input.idempotencyKey],
    runner
  );
  return row!.id;
}

/** Atomically leases due work. Multiple workers may call this concurrently. */
export async function claimOutboxEvents(
  workerId: string,
  topics: string[],
  limit = 25
): Promise<OutboxEvent[]> {
  if (topics.length === 0) return [];
  const rows = await query<OutboxRow>(
    `with picked as (
       select id from delivery_outbox
        where status = 'PENDING' and available_at <= now() and topic = any($2::text[])
        order by available_at, created_at
        for update skip locked limit $3
     )
     update delivery_outbox o
        set status = 'PROCESSING', locked_at = now(), locked_by = $1, updated_at = now()
       from picked where o.id = picked.id
     returning o.id, o.topic, o.aggregate_type, o.aggregate_id, o.company_id,
               o.payload, o.idempotency_key, o.attempts`,
    [workerId, topics, limit]
  );
  return rows.map(toOutboxEvent);
}

export async function completeOutboxEvent(id: string, workerId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update delivery_outbox
        set status = 'DELIVERED', delivered_at = now(), locked_at = null,
            locked_by = null, last_error = null, updated_at = now()
      where id = $1 and status = 'PROCESSING' and locked_by = $2 returning id`,
    [id, workerId]
  );
  return row !== null;
}

export async function failOutboxEvent(input: {
  id: string;
  workerId: string;
  currentAttempts: number;
  error: string;
  retryable: boolean;
}): Promise<DeliveryStatus> {
  const failedAttempt = input.currentAttempts + 1;
  const next = deliveryFailureState({ failedAttempt, retryable: input.retryable });
  const row = await queryOne<{ status: DeliveryStatus }>(
    `update delivery_outbox
        set status = $3, attempts = $4,
            available_at = case when $5::int is null then available_at
                                else now() + ($5 || ' seconds')::interval end,
            locked_at = null, locked_by = null, last_error = $6, updated_at = now()
      where id = $1 and status = 'PROCESSING' and locked_by = $2
      returning status`,
    [input.id, input.workerId, next.status, failedAttempt, next.delaySeconds,
      input.error.slice(0, 4000)]
  );
  if (!row) throw new AppError('CONFLICT', 'Delivery lease is no longer owned by this worker');
  return row.status;
}

/** Recover a worker that died while holding a lease. The event remains retryable. */
export async function recoverStaleOutboxClaims(staleMinutes = 15): Promise<number> {
  const rows = await query<{ id: string }>(
    `update delivery_outbox
        set status = 'PENDING', locked_at = null, locked_by = null,
            available_at = now(), last_error = 'Worker lease expired', updated_at = now()
      where status = 'PROCESSING' and locked_at < now() - ($1 || ' minutes')::interval
      returning id`,
    [String(staleMinutes)]
  );
  return rows.length;
}

export interface InboxEvent {
  id: string;
  provider: string;
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
}

interface InboxRow {
  id: string;
  provider: string;
  external_event_id: string;
  event_type: string;
  body_sha256: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function toInboxEvent(row: InboxRow): InboxEvent {
  return {
    id: row.id,
    provider: row.provider,
    externalEventId: row.external_event_id,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
  };
}

/** Persist only after provider-specific signature verification succeeds. */
export async function recordVerifiedWebhook(input: {
  provider: string;
  externalEventId: string;
  eventType: string;
  bodySha256: string;
  payload: Record<string, unknown>;
}): Promise<{ id: string; duplicate: boolean }> {
  const inserted = await queryOne<{ id: string }>(
    `insert into webhook_inbox
       (provider, external_event_id, event_type, body_sha256, payload)
     values ($1,$2,$3,$4,$5::jsonb)
     on conflict (provider, external_event_id) do nothing returning id`,
    [input.provider, input.externalEventId, input.eventType, input.bodySha256,
      JSON.stringify(input.payload)]
  );
  if (inserted) return { id: inserted.id, duplicate: false };
  const existing = await queryOne<{ id: string; body_sha256: string }>(
    `select id, body_sha256 from webhook_inbox
      where provider = $1 and external_event_id = $2`,
    [input.provider, input.externalEventId]
  );
  if (!existing || existing.body_sha256 !== input.bodySha256) {
    throw new AppError('CONFLICT', 'Webhook event id was reused with a different payload');
  }
  return { id: existing.id, duplicate: true };
}

export async function claimInboxEvents(workerId: string, limit = 25): Promise<InboxEvent[]> {
  const rows = await query<InboxRow>(
    `with picked as (
       select id from webhook_inbox
        where status = 'RECEIVED' and available_at <= now()
        order by available_at, received_at
        for update skip locked limit $2
     )
     update webhook_inbox i
        set status = 'PROCESSING', locked_at = now(), locked_by = $1, updated_at = now()
       from picked where i.id = picked.id
     returning i.id, i.provider, i.external_event_id, i.event_type, i.body_sha256,
               i.payload, i.attempts`,
    [workerId, limit]
  );
  return rows.map(toInboxEvent);
}

export async function completeInboxEvent(id: string, workerId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `update webhook_inbox
        set status = 'PROCESSED', processed_at = now(), locked_at = null,
            locked_by = null, last_error = null, updated_at = now()
      where id = $1 and status = 'PROCESSING' and locked_by = $2 returning id`,
    [id, workerId]
  );
  return row !== null;
}

export async function failInboxEvent(input: {
  id: string;
  workerId: string;
  currentAttempts: number;
  error: string;
  retryable: boolean;
}): Promise<InboxStatus> {
  const failedAttempt = input.currentAttempts + 1;
  const next = deliveryFailureState({ failedAttempt, retryable: input.retryable });
  const inboxStatus = next.status === 'PENDING' ? 'RECEIVED' : 'DEAD_LETTER';
  const row = await queryOne<{ status: InboxStatus }>(
    `update webhook_inbox
        set status = $3, attempts = $4,
            available_at = case when $5::int is null then available_at
                                else now() + ($5 || ' seconds')::interval end,
            locked_at = null, locked_by = null, last_error = $6, updated_at = now()
      where id = $1 and status = 'PROCESSING' and locked_by = $2
      returning status`,
    [input.id, input.workerId, inboxStatus, failedAttempt, next.delaySeconds,
      input.error.slice(0, 4000)]
  );
  if (!row) throw new AppError('CONFLICT', 'Webhook lease is no longer owned by this worker');
  return row.status;
}

export async function replayDeliveryDeadLetter(
  source: 'OUTBOX' | 'WEBHOOK',
  id: string,
  runner?: Queryable
): Promise<boolean> {
  const table = source === 'OUTBOX' ? 'delivery_outbox' : 'webhook_inbox';
  const pending = source === 'OUTBOX' ? 'PENDING' : 'RECEIVED';
  const row = await queryOne<{ id: string }>(
    `update ${table}
        set status = $2, attempts = 0, available_at = now(), locked_at = null,
            locked_by = null, last_error = null, updated_at = now()
      where id = $1 and status = 'DEAD_LETTER' returning id`,
    [id, pending],
    runner
  );
  return row !== null;
}
