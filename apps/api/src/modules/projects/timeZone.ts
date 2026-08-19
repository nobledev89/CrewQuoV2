import { projectTimeZonePinRefusal } from '@crewquo/shared';
import { queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Change the zone a project counts its days in (§42).
 * Operating-model packet: `docs/operating-model/time.md` §3, §4, §12 step 6.
 *
 * **Split out of the generic column update for the same three reasons the
 * reporting currency was**: it needs a stricter role than the rest of the form
 * (OWNER/ADMIN, per the packet's §4 matrix, not any manager), a pin check that
 * has to hold the project's row lock, and a refusal that explains itself. The
 * generic `update projects set …` can express none of those.
 *
 * The pin exists because of the domain's own invariant: *changing a zone changes
 * presentation and future bucketing, never a stored value*. That holds right up
 * until the project has committed work — after which re-bucketing which local day
 * an approved log falls on is exactly a restatement of history.
 *
 * Deliberately emits **no outbox event** (packet §5). Nothing downstream
 * recomputes, because no stored value moves; an event here would imply a
 * migration of past data that must never happen. Stated as a decision rather than
 * left as an omission.
 */
export async function setProjectTimeZone(args: {
  ownerCompanyId: string;
  projectId: string;
  timeZone: string | null;
  runner: Queryable;
}): Promise<{ from: string | null; to: string | null; changed: boolean }> {
  const locked = await queryOne<{ time_zone: string | null }>(
    `select time_zone from projects
      where id = $1 and owner_company_id = $2 for update`,
    [args.projectId, args.ownerCompanyId],
    args.runner
  );
  if (!locked) throw new AppError('NOT_FOUND', 'Project not found');

  // A no-op is allowed through silently: a client that PATCHes the whole form
  // back would otherwise fail on a field nobody touched — and on a pinned
  // project, that would make every other edit impossible.
  if (locked.time_zone === args.timeZone) {
    return { from: locked.time_zone, to: args.timeZone, changed: false };
  }

  // Counted *inside* the transaction that holds the row lock, so "change the
  // zone" and "approve the first log" cannot interleave into a project whose
  // days are half in each zone. Same three pins as the reporting currency, and
  // deliberately the same: they are the same committed facts.
  const pins = await queryOne<{
    approved_time_logs: string;
    approved_expenses: string;
    live_invoices: string;
  }>(
    `select
       (select count(*) from time_logs
         where project_id = $1 and status = 'APPROVED') as approved_time_logs,
       (select count(*) from expenses
         where project_id = $1 and status = 'APPROVED') as approved_expenses,
       (select count(*) from invoices
         where project_id = $1 and status <> 'VOID') as live_invoices`,
    [args.projectId],
    args.runner
  );

  const refusal = projectTimeZonePinRefusal({
    approvedTimeLogs: Number(pins!.approved_time_logs),
    approvedExpenses: Number(pins!.approved_expenses),
    liveInvoices: Number(pins!.live_invoices),
  });
  if (refusal) throw new AppError('CONFLICT', refusal);

  await queryOne(
    `update projects set time_zone = $3, updated_at = now()
      where id = $1 and owner_company_id = $2 returning id`,
    [args.projectId, args.ownerCompanyId, args.timeZone],
    args.runner
  );

  return { from: locked.time_zone, to: args.timeZone, changed: true };
}
