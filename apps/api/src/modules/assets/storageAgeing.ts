import {
  STORAGE_AGEING_AFTER_DAYS,
  STORAGE_AGEING_STOPS_AFTER_DAYS,
  daysInStorage,
  storageAgeingEventPayload,
  storageIsAgeing,
  summariseAsset,
  type MovementRow as PolicyMovement,
} from '@crewquo/shared';
import { query, withTransaction } from '../../db';
import { enqueueOutboxEvent } from '../delivery/repo';

/**
 * The storage-ageing scan (§25.4, packet §5) — step 7 of the Phase 8 build order,
 * and **the only enforcement locked decision #18 has**.
 *
 * Decision #18 says material in storage stays `PENDING` until a final destination
 * is recorded: no tier, no counts-as flag, in no rate at all. That is correct, and
 * it is completely silent. The material is off the floor, the job feels finished,
 * and the project's diversion figures under-report for as long as nobody looks —
 * so this is the thing that looks, once a night, and leaves a question in an
 * inbox with the mass named.
 *
 * **A fifth pass on the existing `work` job rather than a fifth schedule**, which
 * is the reason 7.4's document-expiry ladder is a fourth pass on it: the failure
 * mode of deferred work is not a crash, it is silence, and every new schedule is
 * one more thing that can stop without anybody noticing.
 *
 * **It blocks nothing.** §33's *"never auto-blocks unless `enforce_compliance`"*
 * is the governing instinct, and this is not even a compliance record — it is a
 * question. Nothing about the project changes because it fired.
 */

export interface StorageAgeingResult {
  /** Asset lines with at least one open non-final leg inside the window. */
  scanned: number;
  /**
   * Lines on the rung this pass — **not** how many notifications were newly
   * created.
   *
   * The same distinction `DocumentExpiryResult.onLadder` draws, and for the same
   * reason: `enqueueOutboxEvent` upserts and returns a row id either way, so it
   * cannot report whether the key was new. A line 42 days into storage appears in
   * this number every morning until somebody answers it.
   */
  ageing: number;
}

const BATCH = 500;

interface AgeingRow {
  asset_id: string;
  project_id: string;
  owner_company_id: string;
  recording_company_id: string;
  quantity: string;
  unit_weight_kg: string | null;
  /** The owner company's current date in its own zone — see the query. */
  today: string;
  oldest_moved_on: string;
}

/**
 * The lines with something sitting at a non-final destination inside the window.
 *
 * **`today` comes back from Postgres in the project owner's IANA zone**, exactly
 * as `findExpiringDocuments` resolves it, so nothing ages a day early for
 * everybody east of the server. The 30/90 window is applied twice — once here as
 * a date range so the scan reads hundreds of rows rather than every movement ever
 * recorded, and once in `storageIsAgeing` over the arithmetic that actually
 * decides. The second is the authority; this one is an index hint with a `where`
 * clause attached.
 *
 * `oldest_moved_on` is the oldest **open, non-final** leg, which is what "days in
 * storage" means for a line: material moved to a warehouse in March and topped up
 * in June has been in storage since March.
 */
function findAgeingLines(limit: number): Promise<AgeingRow[]> {
  return query<AgeingRow>(
    `select a.id as asset_id,
            a.project_id,
            p.owner_company_id,
            a.company_id as recording_company_id,
            a.quantity::text as quantity,
            a.unit_weight_kg::text as unit_weight_kg,
            to_char((now() at time zone coalesce(oc.time_zone, 'UTC'))::date, 'YYYY-MM-DD') as today,
            to_char(min(m.moved_on), 'YYYY-MM-DD') as oldest_moved_on
       from asset_movements m
       join project_assets a on a.id = m.asset_id
       join projects p on p.id = a.project_id
       join companies oc on oc.id = p.owner_company_id
       join destination_types dt on dt.id = m.destination_type_id
      where m.deleted_at is null
        and a.deleted_at is null
        and dt.is_final_outcome = false
        -- Open: nothing carries this leg onward. A continued storage leg is
        -- material that has already left, and asking where it went is the one
        -- question it does not need.
        and not exists (
          select 1 from asset_movements c
           where c.continues_movement_id = m.id and c.deleted_at is null
        )
        and m.moved_on <= (now() at time zone coalesce(oc.time_zone, 'UTC'))::date
            - ($1::int * interval '1 day')
        and m.moved_on >= (now() at time zone coalesce(oc.time_zone, 'UTC'))::date
            - ($2::int * interval '1 day')
      group by a.id, a.project_id, p.owner_company_id, a.company_id,
               a.quantity, a.unit_weight_kg, oc.time_zone
      order by min(m.moved_on) asc
      limit $3`,
    [STORAGE_AGEING_AFTER_DAYS, STORAGE_AGEING_STOPS_AFTER_DAYS, limit]
  );
}

interface MovementForSummary {
  id: string;
  continues_movement_id: string | null;
  quantity: string;
  weight_kg: string | null;
  is_final_outcome: boolean;
}

/** Every movement on one line, in the shape the pure policy takes. */
async function movementsFor(assetId: string): Promise<PolicyMovement[]> {
  const rows = await query<MovementForSummary>(
    `select m.id, m.continues_movement_id, m.quantity::text as quantity,
            m.weight_kg::text as weight_kg, dt.is_final_outcome
       from asset_movements m
       join destination_types dt on dt.id = m.destination_type_id
      where m.asset_id = $1 and m.deleted_at is null`,
    [assetId]
  );
  return rows.map((r) => ({
    id: r.id,
    continuesMovementId: r.continues_movement_id,
    quantity: Number(r.quantity),
    weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    /*
     * Only `isFinalOutcome` is read by `summariseAsset`, and the other eight flags
     * are set to `false` rather than joined. That is a real shortcut and it is
     * safe for exactly one reason worth writing down: this scan asks "how much is
     * sitting somewhere that is not an outcome", which is the one question in the
     * domain that no counts-as flag participates in. Anything that later reads a
     * rate off these rows must load them properly — `massBalance.ts` does.
     */
    destination: {
      code: '',
      hierarchyTier: null,
      countsAsRetainedInUse: false,
      countsAsReuse: false,
      countsAsRecycling: false,
      countsAsRecovery: false,
      countsAsLandfill: false,
      countsAsDiverted: false,
      isFinalOutcome: r.is_final_outcome,
      displacesReplacement: false,
    },
  }));
}

export async function runStorageAgeingBatch(): Promise<StorageAgeingResult> {
  const result: StorageAgeingResult = { scanned: 0, ageing: 0 };

  const candidates = await findAgeingLines(BATCH);
  for (const row of candidates) {
    result.scanned += 1;

    const days = daysInStorage(row.oldest_moved_on, row.today);
    if (!storageIsAgeing(days)) continue;

    /*
     * The mass comes out of `summariseAsset`, which has had exhaustive tests since
     * 8.0, rather than out of a SQL sum written for this job. `inStorageKg` is
     * already the figure this event needs — Σ mass of open movements to a
     * non-final destination — and a second implementation of it here would be a
     * second answer to a question §28 settled.
     */
    const summary = summariseAsset(
      {
        quantity: Number(row.quantity),
        unitWeightKg: row.unit_weight_kg === null ? null : Number(row.unit_weight_kg),
      },
      await movementsFor(row.asset_id)
    );
    if (summary.inStorageQuantity === 0) continue;

    await withTransaction((client) =>
      enqueueOutboxEvent(
        {
          topic: 'asset.storage_ageing',
          aggregateType: 'PROJECT_ASSET',
          aggregateId: row.asset_id,
          companyId: row.owner_company_id,
          payload: storageAgeingEventPayload({
            projectId: row.project_id,
            assetId: row.asset_id,
            ownerCompanyId: row.owner_company_id,
            recordingCompanyId: row.recording_company_id,
            daysInStorage: days,
            /*
             * Null rather than 0 when nothing on the line has a weight. The two
             * are different sentences and the composer writes a different one for
             * each; a 0 here would render as "0.0 kg has been in storage", which
             * reads as an item somebody has already dealt with.
             */
            inStorageKg: summary.hasUnknownMass && summary.inStorageKg === 0 ? null : summary.inStorageKg,
            quantity: summary.inStorageQuantity,
            onDate: row.today,
          }),
          /*
           * **Keyed on the asset and the date**, which is §5's key and is what
           * makes a nightly scan safe to run nightly: one item per asset per day
           * at most, and a second pass on the same morning enqueues nothing.
           * `delivery_outbox` refuses the duplicate on its own unique index, so
           * no column here has to remember what has already been raised — and
           * there is no weaker second copy of that fact to go wrong.
           */
          idempotencyKey: `asset.storage_ageing:${row.asset_id}:${row.today}`,
        },
        client
      )
    );
    result.ageing += 1;
  }

  return result;
}
