import { companyClosureBlocks, personalClosureBlocks } from '@crewquo/shared';
import { query, type Queryable } from '../../db';

/**
 * The facts the preconditions are decided from, read from the database.
 *
 * The *decisions* are pure and live in `packages/shared/src/deletion.ts`; this file
 * only counts. That split is what makes the pluralisation, the wording and the
 * "which company do I have to hand over" answer testable without a database, and it
 * is the same division `jobs.ts`/`jobRuns.ts` uses for the overdue policy.
 *
 * **Both are checked twice: when the request is made, and again when it runs.**
 * Seven days is long enough for somebody to be promoted to sole owner, or for a
 * client to open a new engagement with a company that is closing. Checking only at
 * request time would leave a company with no owner, or take a live relationship
 * away from a counterparty who started it in good faith.
 */

/**
 * Companies where this person is the only ACTIVE owner.
 *
 * Named, not counted: "you are the only owner of Northgate Interiors" tells
 * somebody what to do next and "you are the only owner of 1 company" does not.
 *
 * `is_placeholder` companies are excluded, and that matters. A placeholder is the
 * stub created when somebody is invited by email before they have an account of
 * their own (§3.1.1) — nobody administers one, nothing is billed for one, and
 * counting it would refuse a closure over a company the person has never seen.
 */
export async function soleOwnedCompanies(
  userId: string,
  runner?: Queryable
): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `select c.name
       from memberships m
       join companies c on c.id = m.company_id
      where m.user_id = $1 and m.role = 'OWNER' and m.status = 'ACTIVE'
        and not c.is_placeholder and c.closed_at is null
        and not exists (
          select 1 from memberships other
           where other.company_id = m.company_id
             and other.user_id <> m.user_id
             and other.role = 'OWNER'
             and other.status = 'ACTIVE'
        )
      order by c.name`,
    [userId],
    runner
  );
  return rows.map((r) => r.name);
}

export async function personalBlocks(userId: string, runner?: Queryable): Promise<string[]> {
  return personalClosureBlocks({ soleOwnerOf: await soleOwnedCompanies(userId, runner) });
}

/**
 * A company's "settle or hand over" facts (§13.1).
 *
 * Both directions of every count, deliberately. A closure is equally impossible
 * with a live relationship the company is the *client* of — walking away from a
 * subcontractor mid-project is the same wrong as walking away from a client — and
 * an unpaid invoice is money outstanding whichever way it points.
 *
 * `PENDING`, `ACTIVE` and `PAUSED` are all live: only `ENDED` is concluded. Paused
 * is a relationship somebody intends to resume, and reading it as settled would let
 * a company close out from under a client who paused for the winter.
 */
export async function companyBlocks(companyId: string, runner?: Queryable): Promise<string[]> {
  const rows = await query<{ live_engagements: number; unsettled_invoices: number }>(
    `select
       (select count(*)::int from engagements
         where (client_company_id = $1 or provider_company_id = $1)
           and status <> 'ENDED') as live_engagements,
       (select count(*)::int from invoices
         where (issuer_company_id = $1 or counterparty_company_id = $1)
           and status = 'ISSUED') as unsettled_invoices`,
    [companyId],
    runner
  );
  const facts = rows[0] ?? { live_engagements: 0, unsettled_invoices: 0 };
  return companyClosureBlocks({
    liveEngagements: facts.live_engagements,
    unsettledInvoices: facts.unsettled_invoices,
  });
}

/**
 * Every company with a live engagement with this one, and the people to tell.
 *
 * §6: counterparties with a live engagement are told when a company starts closing
 * itself, because their evidence is about to change shape and the alternative is a
 * client discovering it when a project view goes empty. **What they are told is that
 * the relationship is ending — never the reason**, which is the closing company's
 * business, the same line the access packet drew around an operator's internal note.
 *
 * Returns the recipient user ids directly: the notification handler has no business
 * knowing which company each of them belongs to, and passing the companies through
 * would invite a body that names them.
 */
export async function counterpartyRecipients(
  companyId: string,
  runner?: Queryable
): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `select distinct m.user_id
       from engagements e
       join memberships m
         on m.company_id = case when e.client_company_id = $1
                                then e.provider_company_id else e.client_company_id end
      where (e.client_company_id = $1 or e.provider_company_id = $1)
        and e.status <> 'ENDED'
        and m.status = 'ACTIVE' and m.role in ('OWNER', 'ADMIN', 'MANAGER')`,
    [companyId],
    runner
  );
  return rows.map((r) => r.user_id);
}

/** Owners and admins of the closing company — the people who may cancel it. */
export async function companyDecisionMakers(
  companyId: string,
  runner?: Queryable
): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `select user_id from memberships
      where company_id = $1 and status = 'ACTIVE' and role in ('OWNER', 'ADMIN')`,
    [companyId],
    runner
  );
  return rows.map((r) => r.user_id);
}
