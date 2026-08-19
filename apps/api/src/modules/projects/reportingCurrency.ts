import { randomUUID } from 'node:crypto';
import type { ProjectView } from '@crewquo/shared';
import { reportingCurrencyPinRefusal } from '@crewquo/shared';
import { queryOne, withTransaction } from '../../db';
import { AppError } from '../../http/errors';
import { recordAudit } from '../audit/record';
import { enqueueOutboxEvent } from '../delivery/repo';
import { getProject } from './repo';

/**
 * Change the unit a project reports money in (§3.3 decision #5).
 * Operating-model packet: `docs/operating-model/money-boundary.md` §3.
 *
 * **The whole point of this function is that the check and the write are one
 * transaction.** Reading "is this project empty?" and then updating it would
 * leave a window in which the first time log is approved between the two, giving
 * a project whose history is half in each unit — the exact interleaving §8 of the
 * packet commits to preventing. The row lock is taken first, and every pin is
 * counted inside it.
 *
 * A `VOID` invoice is deliberately not a pin: it is a document that was withdrawn
 * before it became a claim, the same exclusion the PO ceiling already makes when
 * it computes a committed total.
 */
export async function setProjectReportingCurrency(args: {
  ownerCompanyId: string;
  projectId: string;
  actorUserId: string;
  reportingCurrency: string;
}): Promise<ProjectView> {
  return withTransaction(async (client) => {
    const locked = await queryOne<{ id: string; name: string; reporting_currency: string }>(
      `select id, name, reporting_currency from projects
        where id = $1 and owner_company_id = $2 for update`,
      [args.projectId, args.ownerCompanyId],
      client
    );
    if (!locked) throw new AppError('NOT_FOUND', 'Project not found');

    // A no-op change is allowed through silently rather than refused: a client
    // that PATCHes the whole form back would otherwise fail on a field the user
    // never touched.
    if (locked.reporting_currency === args.reportingCurrency) {
      return (await getProject(args.ownerCompanyId, args.projectId, client))!;
    }

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
      client
    );

    const refusal = reportingCurrencyPinRefusal({
      approvedTimeLogs: Number(pins!.approved_time_logs),
      approvedExpenses: Number(pins!.approved_expenses),
      liveInvoices: Number(pins!.live_invoices),
    });
    if (refusal) throw new AppError('CONFLICT', refusal);

    await queryOne(
      `update projects set reporting_currency = $3, updated_at = now()
        where id = $1 and owner_company_id = $2 returning id`,
      [args.projectId, args.ownerCompanyId, args.reportingCurrency],
      client
    );

    await recordAudit(
      {
        companyId: args.ownerCompanyId,
        actorUserId: args.actorUserId,
        action: 'project.reporting_currency_set',
        entityType: 'PROJECT',
        entityId: args.projectId,
        changes: {
          reportingCurrency: { from: locked.reporting_currency, to: args.reportingCurrency },
        },
        description:
          `Project "${locked.name}" now reports in ${args.reportingCurrency} ` +
          `(was ${locked.reporting_currency})`,
        // The unit a provider reports its own margin in is commercial data the
        // client side of the edge has no business reading (packet §7).
        visibleToClient: false,
      },
      client
    );

    await enqueueOutboxEvent(
      {
        topic: 'project.reporting_currency_set',
        aggregateType: 'PROJECT',
        aggregateId: args.projectId,
        companyId: args.ownerCompanyId,
        payload: {
          projectId: args.projectId,
          from: locked.reporting_currency,
          to: args.reportingCurrency,
          actorUserId: args.actorUserId,
        },
        // Per-occurrence, not per-aggregate. Unlike `company.created:<id>`, this
        // event can legitimately happen more than once for the same project — a
        // key of `<projectId>:<currency>` would silently swallow the second
        // event of a USD -> GBP -> USD sequence. Atomicity with the domain write
        // comes from the transaction; the key only has to be unique per event.
        idempotencyKey: `project.reporting_currency_set:${randomUUID()}`,
      },
      client
    );

    return (await getProject(args.ownerCompanyId, args.projectId, client))!;
  });
}
