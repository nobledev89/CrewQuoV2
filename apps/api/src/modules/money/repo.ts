import type { CreateFxRate, FxRateFacts, FxRateView, ListFxRatesQuery } from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';
import { AppError } from '../../http/errors';

/**
 * Money-boundary persistence (CREWQUO_V2_PLAN.md §3.3 decision #5, §41.9).
 * Operating-model packet: `docs/operating-model/money-boundary.md`.
 *
 * Two things this module will not do, both on purpose:
 *
 *  - **There is no update path.** A rate is inserted, cited and superseded; a
 *    correction is a new row at a later `as_of`. The database enforces this with
 *    a trigger as well (0013), because a `PATCH` added later in good faith would
 *    otherwise silently restate every historical figure that cites the row.
 *  - **`rate` is never parsed into a JS number.** `numeric(20,10)` arrives from
 *    pg as a string and stays one all the way to `convertMinorUnits`, which does
 *    exact integer arithmetic on it. Touching it with `Number()` anywhere on this
 *    path would reintroduce the float drift the whole design avoids.
 */

interface FxRateRow {
  id: string;
  company_id: string;
  base_currency: string;
  quote_currency: string;
  rate: string;
  as_of: string;
  source: string;
  note: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  citation_count: string;
}

const FX_COLS = `id, company_id, base_currency, quote_currency, rate::text as rate,
  to_char(as_of, 'YYYY-MM-DD') as as_of, source, note, created_by_user_id, created_at`;

/**
 * How many committed figures cite a rate — the delete guard, computed rather than
 * counted into a column so it can never drift from the truth.
 *
 * A frozen PAY snapshot names the row inside `time_logs.resolved_rate`, and that
 * is currently the only citation site: an invoice never converts, so it never
 * cites a rate. Deleting a cited row would orphan every snapshot that names it,
 * turning a traceable historical figure into an unexplainable one — the outcome
 * §41.3's reproducibility rule exists to prevent.
 */
const CITATION_COUNT = `(
  select count(*) from time_logs tl
   where tl.resolved_rate -> 'fx' ->> 'fxRateId' = f.id::text
)`;

function toFacts(row: FxRateRow): FxRateFacts {
  return {
    id: row.id,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rate: row.rate,
    asOf: row.as_of,
    source: row.source,
  };
}

function toView(row: FxRateRow): FxRateView {
  return {
    id: row.id,
    companyId: row.company_id,
    baseCurrency: row.base_currency,
    quoteCurrency: row.quote_currency,
    rate: row.rate,
    asOf: row.as_of,
    source: row.source,
    note: row.note,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    citationCount: Number(row.citation_count),
  };
}

export async function listFxRates(
  companyId: string,
  filter: ListFxRatesQuery = {},
  runner?: Queryable
): Promise<FxRateView[]> {
  const rows = await query<FxRateRow>(
    `select ${FX_COLS}, ${CITATION_COUNT} as citation_count
       from fx_rates f
      where company_id = $1
        and ($2::text is null or base_currency = $2)
        and ($3::text is null or quote_currency = $3)
      order by base_currency, quote_currency, as_of desc`,
    [companyId, filter.baseCurrency ?? null, filter.quoteCurrency ?? null],
    runner
  );
  return rows.map(toView);
}

/**
 * Every rate this company holds for one pair, for the conversion path.
 *
 * Deliberately returns the whole history rather than pre-selecting the effective
 * one: a project summary prices logs across many dates in one pass, and picking
 * per date in the database would turn one query into one per log. `pickFxRate`
 * applies the as-of rule in pure code, where it is unit-tested.
 */
export async function listFxRateCandidates(
  companyId: string,
  pairs: ReadonlyArray<{ base: string; quote: string }>,
  runner?: Queryable
): Promise<FxRateFacts[]> {
  if (pairs.length === 0) return [];
  const rows = await query<FxRateRow>(
    `select ${FX_COLS} from fx_rates f
      where company_id = $1
        and (base_currency, quote_currency) in (
          select * from unnest($2::text[], $3::text[])
        )
      order by as_of desc`,
    [companyId, pairs.map((p) => p.base), pairs.map((p) => p.quote)],
    runner
  );
  return rows.map(toFacts);
}

/**
 * Every rate this company holds that converts *into* one currency.
 *
 * A project summary cannot know up front which units it will meet: the PAY
 * currency is on each frozen snapshot, but the BILL currency only appears once a
 * card has been resolved, line by line. Loading by target currency instead of by
 * pair means the answer does not depend on guessing the bases in advance — which
 * is exactly the bug the first version had, silently withholding a BILL figure
 * whose rate was on file the whole time.
 */
export async function listFxRatesQuoting(
  companyId: string,
  quoteCurrency: string,
  runner?: Queryable
): Promise<FxRateFacts[]> {
  const rows = await query<FxRateRow>(
    `select ${FX_COLS} from fx_rates f
      where company_id = $1 and quote_currency = $2
      order by as_of desc`,
    [companyId, quoteCurrency],
    runner
  );
  return rows.map(toFacts);
}

export async function getFxRate(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<FxRateView | null> {
  const row = await queryOne<FxRateRow>(
    `select ${FX_COLS}, ${CITATION_COUNT} as citation_count
       from fx_rates f where id = $1 and company_id = $2`,
    [id, companyId],
    runner
  );
  return row ? toView(row) : null;
}

/**
 * Record a rate. The unique index on `(company_id, base, quote, as_of)` is the
 * concurrency control: two people recording the same rate race to the same row
 * rather than creating two competing truths, and the loser is told the rate
 * already exists rather than silently overwriting it.
 */
export async function insertFxRate(
  input: CreateFxRate & { companyId: string; actorUserId: string },
  runner?: Queryable
): Promise<FxRateView> {
  const row = await queryOne<FxRateRow>(
    `insert into fx_rates
       (company_id, base_currency, quote_currency, rate, as_of, source, note, created_by_user_id)
     values ($1,$2,$3,$4::numeric,$5::date,$6,$7,$8)
     on conflict (company_id, base_currency, quote_currency, as_of) do nothing
     returning ${FX_COLS}, 0 as citation_count`,
    [input.companyId, input.baseCurrency, input.quoteCurrency, input.rate, input.asOf,
      input.source, input.note ?? null, input.actorUserId],
    runner
  );
  if (!row) {
    throw new AppError(
      'CONFLICT',
      `A ${input.baseCurrency} to ${input.quoteCurrency} rate is already recorded for ` +
        `${input.asOf}. Rates are never edited — record the correction at a later date.`
    );
  }
  return toView(row);
}

export async function deleteFxRate(
  id: string,
  companyId: string,
  runner?: Queryable
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `delete from fx_rates where id = $1 and company_id = $2 returning id`,
    [id, companyId],
    runner
  );
  return row !== null;
}
