import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { query, queryOne } from '../db';
import { AppError } from './errors';

/**
 * The idempotency ledger (item 7.7's first primitive).
 *
 * A retry that could not tell whether its first attempt landed must be able to
 * ask, and get the answer it missed rather than a refusal. So the ledger stores
 * **the response**, and a replay returns byte-for-byte what the first attempt
 * returned — the client cannot tell which attempt it was, which is the whole
 * definition of idempotent.
 */

/**
 * A stable fingerprint of what was asked.
 *
 * Hashed, not stored: the body is customer data and this table has no business
 * holding a diary entry. Key order is normalised because two JSON encoders of the
 * same object are not required to agree on it, and a client that reordered its
 * own fields between attempts would otherwise be told it had reused an id.
 */
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

interface ReceiptRow {
  route: string;
  request_fingerprint: string;
  status_code: number;
  response: unknown;
}

/**
 * Has this exact mutation already been performed?
 *
 * Returns the stored response when it has, so the caller can return it and stop.
 *
 * **A replay whose body differs is refused, not answered.** That is a client
 * reusing an id for a second act, and handing back the first answer would
 * silently discard the second — a lost write dressed as a success, which is the
 * worst outcome this table could produce.
 */
export async function replayedResponse(args: {
  companyId: string;
  clientId: string | undefined;
  route: string;
  body: unknown;
}): Promise<{ statusCode: number; response: unknown } | null> {
  if (!args.clientId) return null;

  const existing = await queryOne<ReceiptRow>(
    `select route, request_fingerprint, status_code, response
       from mutation_receipts where company_id = $1 and client_id = $2`,
    [args.companyId, args.clientId]
  );
  if (!existing) return null;

  const asked = fingerprint(args.body);
  if (existing.route !== args.route || existing.request_fingerprint !== asked) {
    throw new AppError(
      'CONFLICT',
      'That request id has already been used for a different change. Use a new one.',
      { reason: 'CLIENT_ID_REUSED' }
    );
  }
  return { statusCode: existing.status_code, response: existing.response };
}

/** `status_code = 0` marks a claim whose handler has not finished yet. */
const IN_FLIGHT = 0;

/**
 * Claim the id before doing the work, atomically.
 *
 * **Checking for a receipt and then running is check-then-act**, and the live
 * suite caught it doing exactly what check-then-act does: two simultaneous
 * retries of one create both saw no receipt, both ran, and two rooms existed
 * where the client had asked for one. `on conflict do nothing returning` makes
 * the primary key the arbiter instead — whoever gets a row back owns the work,
 * and everybody else waits for their answer.
 */
async function claim(args: {
  companyId: string;
  clientId: string;
  route: string;
  body: unknown;
}): Promise<boolean> {
  const row = await queryOne<{ client_id: string }>(
    `insert into mutation_receipts
       (company_id, client_id, route, request_fingerprint, status_code, response)
     values ($1, $2, $3, $4, ${IN_FLIGHT}, 'null'::jsonb)
     on conflict (company_id, client_id) do nothing
     returning client_id`,
    [args.companyId, args.clientId, args.route, fingerprint(args.body)]
  );
  return row !== null;
}

async function completeClaim(args: {
  companyId: string;
  clientId: string;
  statusCode: number;
  response: unknown;
}): Promise<void> {
  try {
    await queryOne(
      `update mutation_receipts set status_code = $3, response = $4
        where company_id = $1 and client_id = $2`,
      [args.companyId, args.clientId, args.statusCode, JSON.stringify(args.response)]
    );
  } catch (err) {
    console.error('[api] failed to complete mutation receipt:', err);
  }
}

/**
 * A claim whose handler threw leaves no work behind, so the id must be released.
 *
 * Otherwise a create refused for a bad parent would burn its client id: the
 * retry, with the fault corrected, would find a receipt in flight and wait for an
 * answer that is never coming.
 */
async function releaseClaim(companyId: string, clientId: string): Promise<void> {
  try {
    await queryOne(
      `delete from mutation_receipts
        where company_id = $1 and client_id = $2 and status_code = ${IN_FLIGHT}`,
      [companyId, clientId]
    );
  } catch (err) {
    console.error('[api] failed to release mutation receipt:', err);
  }
}

/** How long a loser waits for the winner's answer before giving up. */
const WAIT_STEPS = 20;
const WAIT_MS = 100;

async function awaitWinner(
  companyId: string,
  clientId: string
): Promise<{ statusCode: number; response: unknown } | null> {
  for (let attempt = 0; attempt < WAIT_STEPS; attempt += 1) {
    const row = await queryOne<ReceiptRow>(
      `select route, request_fingerprint, status_code, response
         from mutation_receipts where company_id = $1 and client_id = $2`,
      [companyId, clientId]
    );
    // The claim was released because the winner failed. Say nothing and let the
    // caller run: this retry is now the one doing the work.
    if (!row) return null;
    if (row.status_code !== IN_FLIGHT) {
      return { statusCode: row.status_code, response: row.response };
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
  throw new AppError(
    'CONFLICT',
    'That request is still being processed. Try again in a moment.',
    { reason: 'IN_FLIGHT' }
  );
}

/**
 * The whole cycle for one handler: claim the id, run, record — or wait for
 * whoever claimed it first and return their answer.
 *
 * Deliberately a wrapper rather than middleware. Middleware would have to buffer
 * and re-serialise every response to learn what was sent, and it would apply to
 * routes that never asked for it — whereas an endpoint opting in is an endpoint
 * whose author decided its retry semantics.
 */
export async function withIdempotency<T>(
  args: {
    res: Response;
    companyId: string;
    clientId: string | undefined;
    route: string;
    body: unknown;
    successStatus: number;
  },
  run: () => Promise<T>
): Promise<void> {
  if (!args.clientId) {
    // No id, no guarantee, no ledger row. Two deliberate creates are two records,
    // which is the honest default rather than a hole.
    args.res.status(args.successStatus).json(await run());
    return;
  }

  const replayed = await replayedResponse({
    companyId: args.companyId,
    clientId: args.clientId,
    route: args.route,
    body: args.body,
  });
  if (replayed && replayed.statusCode !== IN_FLIGHT) {
    // The header is the only way a client can tell, and it is diagnostic rather
    // than semantic: the body is identical either way, on purpose.
    args.res.setHeader('x-crewquo-replayed', 'true');
    args.res.status(replayed.statusCode).json(replayed.response);
    return;
  }

  const mine = await claim({
    companyId: args.companyId,
    clientId: args.clientId,
    route: args.route,
    body: args.body,
  });

  if (!mine) {
    const winner = await awaitWinner(args.companyId, args.clientId);
    if (winner) {
      args.res.setHeader('x-crewquo-replayed', 'true');
      args.res.status(winner.statusCode).json(winner.response);
      return;
    }
    // The first attempt failed and released its claim; this one does the work.
    args.res.status(args.successStatus).json(await run());
    return;
  }

  let result: T;
  try {
    result = await run();
  } catch (err) {
    await releaseClaim(args.companyId, args.clientId);
    throw err;
  }
  await completeClaim({
    companyId: args.companyId,
    clientId: args.clientId,
    statusCode: args.successStatus,
    response: result,
  });
  args.res.status(args.successStatus).json(result);
}

/**
 * Prune spent receipts.
 *
 * A receipt is only useful for as long as a client might still retry, which is
 * hours rather than months — and this table would otherwise be the one place a
 * response body outlives the request that produced it. Seven days is generous
 * against every retry budget in the product and short enough that nothing
 * accumulates.
 *
 * Called from the auth-retention pass rather than a job of its own, for the
 * reason §14 step 1 records: a table whose purpose is bookkeeping, pruned by a
 * job that can itself stop, is one more thing somebody has to notice had stopped.
 *
 * **An in-flight claim is pruned on a much shorter clock.** A handler that was
 * killed mid-request — a deploy, a runner timeout — leaves `status_code = 0`
 * behind, and a client retrying would wait for an answer that is never coming.
 * An hour is far longer than any request this API serves.
 */
export async function pruneMutationReceipts(): Promise<number> {
  const rows = await query<{ id: string }>(
    `delete from mutation_receipts
      where (status_code <> ${IN_FLIGHT} and created_at < now() - interval '7 days')
         or (status_code = ${IN_FLIGHT} and created_at < now() - interval '1 hour')
      returning client_id as id`
  );
  return rows.length;
}
