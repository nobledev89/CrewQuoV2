import { z } from 'zod';

/**
 * The offline/sync contract (item 7.7, locked decision #22) — step 2 of the
 * Phase 7 build order in `docs/operating-model/project-evidence.md` §14.
 *
 * **Why it is settled here rather than when the phone arrives.** Client ids,
 * idempotent mutations, expected versions, conflict semantics and tombstones are
 * cheap to design into an endpoint and expensive to retrofit into a shipped one.
 * The mobile deferral of 2026-08-20 moved the *device* half to Phase 13 and left
 * this half exactly where it was, because its cost is entirely a function of when
 * it is written — the evidence, document and diary APIs are the ones that must
 * not harden without it.
 *
 * Three primitives, and each answers a different question:
 *
 *  - **`clientId`** — "have I already done this?" Idempotency for a retry that
 *    could not tell whether its first attempt landed.
 *  - **`expectedRevision`** — "is what I am changing still what I read?"
 *    Optimistic concurrency for two people editing one record.
 *  - **tombstones** — "is it gone, or am I not allowed?" Two answers a 404
 *    cannot distinguish, and on an intermittent connection a third — a timeout —
 *    looks like both.
 */

// ── The envelope ─────────────────────────────────────────────────────────────

/**
 * What a mutating request may carry beyond its own body.
 *
 * Both optional, deliberately. A browser form submitted once by a person needs
 * neither, and requiring them would make every existing caller a migration. The
 * guarantees are opt-in per request, which is also how a client can choose to be
 * careful exactly where it has been offline.
 */
export const mutationEnvelopeSchema = z.object({
  /**
   * Minted on the device, before the network is consulted. A uuid rather than
   * free text: two clients choosing `batch-1` would collide, and the collision
   * would return one of them the other's answer.
   */
  clientId: z.string().uuid().optional(),
  /** The `revision` the change was composed against. */
  expectedRevision: z.number().int().min(1).optional(),
});
export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;

/** Every synchronised record carries these, whatever else it holds. */
export const syncMetaSchema = z.object({
  /** Increments on every write. 1 on insert. */
  revision: z.number().int().min(1),
  /** Set when the row is a tombstone. */
  deletedAt: z.string().nullable(),
});
export type SyncMeta = z.infer<typeof syncMetaSchema>;

// ── Conflicts ────────────────────────────────────────────────────────────────

export type ConflictCode = 'STALE_REVISION' | 'GONE' | 'CLIENT_ID_REUSED';

export interface Conflict {
  code: ConflictCode;
  message: string;
}

/**
 * Is this write still valid against what the caller read?
 *
 * `expected` absent means the caller is not making a claim about what it read,
 * and last-write-wins applies. That is not a loophole — it is the browser form
 * case, where the person is looking at the screen they are changing. The
 * contract's guarantee is available to anyone who asks for it and imposed on
 * nobody who does not.
 */
export function detectConflict(args: {
  expected?: number;
  actual: number;
  deletedAt: string | null;
}): Conflict | null {
  if (args.deletedAt !== null) {
    return {
      code: 'GONE',
      message: 'This was deleted. Your change was not applied.',
    };
  }
  if (args.expected === undefined) return null;
  if (args.expected === args.actual) return null;
  return {
    code: 'STALE_REVISION',
    message:
      args.expected < args.actual
        ? 'Somebody else changed this while you were away.'
        : 'This change was composed against a version that does not exist here.',
  };
}

// ── Field-wise merge ─────────────────────────────────────────────────────────

export interface FieldMergeResult<T> {
  merged: Partial<T>;
  /** Fields both sides changed, to different values. The caller decides what to do. */
  conflicted: (keyof T)[];
  /** Fields taken from the incoming change. */
  applied: (keyof T)[];
}

/**
 * Merge one edit into a record that moved underneath it, field by field.
 *
 * **Reserved for the site diary's open entry, and the reason is its shape.** A
 * diary entry has fourteen independent free-text fields — delays, deliveries,
 * health and safety notes — filled in by different people through the day.
 * Whole-row last-write-wins there silently deletes a colleague's paragraph, and
 * the person who wrote it finds out weeks later in a dispute.
 *
 * Everything else **refuses** instead. A photograph's caption has no meaningful
 * merge: two people who disagree about what a picture shows have a question, not
 * a conflict a function can resolve.
 *
 * `base` is what the editor started from — loaded from `record_revisions`, which
 * §36 already stores per revision. A field the editor did not touch is not in
 * `incoming` and is never written, which is what keeps this from re-applying
 * stale values it merely happens to know.
 */
export function mergeFieldwise<T extends Record<string, unknown>>(args: {
  base: T;
  incoming: Partial<T>;
  current: T;
}): FieldMergeResult<T> {
  const merged: Partial<T> = {};
  const conflicted: (keyof T)[] = [];
  const applied: (keyof T)[] = [];

  for (const key of Object.keys(args.incoming) as (keyof T)[]) {
    const mine = args.incoming[key];
    const theirs = args.current[key];
    const was = args.base[key];

    // Nobody else touched it: the edit applies cleanly.
    if (same(was, theirs)) {
      merged[key] = mine;
      applied.push(key);
      continue;
    }
    // They changed it to exactly what I was going to change it to.
    if (same(mine, theirs)) {
      applied.push(key);
      continue;
    }
    // Both moved, and to different places. This one needs a person.
    conflicted.push(key);
  }

  return { merged, conflicted, applied };
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

// ── Tombstones ───────────────────────────────────────────────────────────────

export const tombstoneSchema = z.object({
  id: z.string().uuid(),
  deletedAt: z.string(),
  revision: z.number().int(),
});
export type Tombstone = z.infer<typeof tombstoneSchema>;

/**
 * **A tombstone is visible only inside the boundary that could already see the
 * record**, and this is the rule that keeps the whole idea from being a
 * disclosure.
 *
 * The point of a tombstone is that "gone" and "not yours" stop looking alike —
 * which means, told carelessly, it is an oracle: an outsider probing ids would
 * learn which ones ever existed. So authorization runs first and unchanged; only
 * a caller who *would have been shown the record* is shown its tombstone.
 * Everybody else still gets the 404 they would have got before this existed.
 */
export function tombstoneVisibleTo(args: {
  callerCouldHaveRead: boolean;
}): boolean {
  return args.callerCouldHaveRead;
}

// ── The three timestamps ─────────────────────────────────────────────────────

/**
 * Exactly one of these is evidence, and an offline queue is what makes the
 * difference matter.
 *
 * A photograph taken on Friday in a basement, queued, and delivered on Monday has
 * all three genuinely different — and the naive implementation stamps
 * `recordedAt` and treats the other two as decoration.
 */
export const CAPTURE_TIMESTAMPS = {
  /** Server truth. The only one the platform attests to. */
  recordedAt: 'when the server accepted it',
  /** The device's clock, which the person holding it can set. A claim. */
  capturedAt: 'when the device says it happened',
  /** A human's claim about which project day it belongs to. */
  effectiveDate: 'which project day it counts as',
} as const;
export type CaptureTimestamp = keyof typeof CAPTURE_TIMESTAMPS;

/** Which of the three the platform stands behind. Used to label them in a UI or an export. */
export function isServerAttested(which: CaptureTimestamp): boolean {
  return which === 'recordedAt';
}
