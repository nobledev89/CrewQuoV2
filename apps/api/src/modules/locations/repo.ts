import {
  LOCATION_REFERENCE_TABLES,
  depthOf,
  type CreateLocation,
  type LocationKind,
  type LocationReferenceCount,
  type LocationView,
  type UpdateLocation,
} from '@crewquo/shared';
import { query, queryOne, type Queryable } from '../../db';

interface LocationRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  kind: LocationKind;
  name: string;
  reference: string | null;
  notes: string | null;
  sort_order: number;
  active: boolean;
  revision: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, project_id, parent_id, kind, name, reference, notes,
  sort_order, active, revision, deleted_at, created_at, updated_at`;

/**
 * `depth` is computed here from the rows just loaded, never stored.
 *
 * A stored depth is a denormalisation that drifts on the first re-parent — and
 * the drift is silent, because nothing reads a depth column except the check that
 * would have caught it.
 */
function toView(row: LocationRow, depth: number): LocationView {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    kind: row.kind,
    name: row.name,
    reference: row.reference,
    notes: row.notes,
    sortOrder: row.sort_order,
    active: row.active,
    depth,
    revision: row.revision,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function withDepths(rows: LocationRow[]): LocationView[] {
  const byId = new Map(rows.map((r) => [r.id, { id: r.id, parentId: r.parent_id, sortOrder: r.sort_order, name: r.name }]));
  // A broken chain reads as depth 1 rather than as an error: `buildLocationTree`
  // surfaces such a row at the top, and a depth that disagreed with where it is
  // rendered would be worse than a depth that is merely optimistic.
  return rows.map((r) => toView(r, depthOf(r.id, byId) ?? 1));
}

/** Live locations only. A tombstone is never part of the tree (0029). */
export async function listLocations(projectId: string, runner?: Queryable): Promise<LocationView[]> {
  const rows = await query<LocationRow>(
    `select ${COLUMNS} from project_locations
      where project_id = $1 and deleted_at is null
      order by sort_order asc, name asc`,
    [projectId],
    runner
  );
  return withDepths(rows);
}

/**
 * One location, **tombstone included**.
 *
 * The caller decides what to do with a tombstoned row, because that decision is
 * about who is asking: a caller inside the boundary is told it is gone, and
 * everybody else still gets the 404 they would have got before tombstones
 * existed. Filtering here would take that choice away and make the contract's
 * whole point unreachable.
 */
export async function findLocation(id: string, runner?: Queryable): Promise<LocationView | null> {
  const row = await queryOne<LocationRow>(
    `select ${COLUMNS} from project_locations where id = $1`,
    [id],
    runner
  );
  if (!row) return null;
  if (row.deleted_at) return toView(row, 1);
  // Its depth needs the rest of its project, which is one more query and the only
  // honest way to answer: depth is a property of a path, not of a row.
  const siblings = await listLocations(row.project_id, runner);
  return siblings.find((s) => s.id === row.id) ?? toView(row, 1);
}

export async function insertLocation(
  projectId: string,
  input: CreateLocation,
  runner?: Queryable
): Promise<LocationView> {
  const row = await queryOne<LocationRow>(
    `insert into project_locations (project_id, parent_id, kind, name, reference, notes, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7) returning ${COLUMNS}`,
    [projectId, input.parentId, input.kind, input.name, input.reference, input.notes, input.sortOrder],
    runner
  );
  const all = await listLocations(projectId, runner);
  return all.find((l) => l.id === row?.id) ?? toView(row as LocationRow, 1);
}

/**
 * Update, with the revision check **inside the statement**.
 *
 * Reading the revision and then writing is check-then-act, and the live suite
 * caught it doing exactly what check-then-act does: two tabs composing against
 * revision 4 both passed the check and both wrote, so the second silently
 * overwrote the first and nobody was told. The comparison has to be part of the
 * `where` clause, where the row lock makes it atomic — the same shape the
 * company-creation ledger uses for its allowance and the outbox uses for its
 * lease.
 *
 * Returns null when nothing matched, which the caller resolves into a conflict, a
 * tombstone or a genuine 404 by re-reading. Null is deliberately not
 * self-describing: only one of those three answers is the truth, and the row is
 * the only thing that knows which.
 */
export async function updateLocation(
  id: string,
  patch: UpdateLocation,
  runner?: Queryable
): Promise<LocationView | null> {
  // Present-vs-absent for every optional field, the way the expense patch does:
  // clearing a reference and leaving it alone are different acts, and one JSON
  // null has to say both unless the presence of the key is what decides.
  const row = await queryOne<LocationRow>(
    `update project_locations set
       parent_id  = case when $2::boolean then $3::uuid else parent_id end,
       kind       = case when $4::boolean then $5::text else kind end,
       name       = case when $6::boolean then $7::text else name end,
       reference  = case when $8::boolean then $9::text else reference end,
       notes      = case when $10::boolean then $11::text else notes end,
       sort_order = case when $12::boolean then $13::int else sort_order end,
       active     = case when $14::boolean then $15::boolean else active end
     where id = $1 and deleted_at is null
       and ($16::int is null or revision = $16::int)
     returning ${COLUMNS}`,
    [
      id,
      'parentId' in patch, patch.parentId ?? null,
      'kind' in patch, patch.kind ?? null,
      'name' in patch, patch.name ?? null,
      'reference' in patch, patch.reference ?? null,
      'notes' in patch, patch.notes ?? null,
      'sortOrder' in patch, patch.sortOrder ?? null,
      'active' in patch, patch.active ?? null,
      patch.expectedRevision ?? null,
    ],
    runner
  );
  if (!row) return null;
  const all = await listLocations(row.project_id, runner);
  return all.find((l) => l.id === row.id) ?? toView(row, 1);
}

/**
 * Delete as a tombstone (0029), not as a `delete`.
 *
 * The row stays so a client holding a stale copy can be told the record is gone,
 * rather than inferring it from a 404 — which is indistinguishable from a
 * permission failure, and on an intermittent connection from a timeout as well.
 *
 * The revision bumps with it, through the trigger, so a queued edit composed
 * against the live version is refused with `GONE` rather than silently applied to
 * something nobody can see.
 */
export async function tombstoneLocation(id: string, runner?: Queryable): Promise<void> {
  await query(
    `update project_locations set deleted_at = now() where id = $1 and deleted_at is null`,
    [id],
    runner
  );
}

/**
 * What is still using this location, table by table, from the shared registry.
 *
 * The registry is the point (§21, and the packet's §14 step 1). Five later phases
 * each add a table that points here, and a condition written inline is one each of
 * those five people has to remember to extend — the one who forgets deletes a
 * location out from under a year of evidence.
 *
 * A table named in the registry that does not exist yet is **skipped, not
 * fatal**: the registry is allowed to describe the shape of the product ahead of
 * the migrations, and a delete that 500s because Phase 8 has not shipped would be
 * a worse failure than the one this prevents.
 */
export async function countLocationReferences(
  id: string,
  runner?: Queryable
): Promise<LocationReferenceCount[]> {
  const counts: LocationReferenceCount[] = [];
  for (const ref of LOCATION_REFERENCE_TABLES) {
    const exists = await queryOne<{ ok: boolean }>(
      `select true as ok from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = $2`,
      [ref.table, ref.column],
      runner
    );
    if (!exists) continue;
    // Identifiers cannot be bound as parameters, and these two come from a
    // constant in `@crewquo/shared` rather than from any request — but they are
    // still interpolated into SQL, so the existence check above doubles as the
    // guard: a name that is not a real column never reaches the query.
    // A tombstoned referrer does not count. Refusing to delete a location
    // because a *deleted* sub-location still points at it would make the
    // tombstone a permanent lock on its parent.
    const tombstoned = await queryOne<{ ok: boolean }>(
      `select true as ok from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = 'deleted_at'`,
      [ref.table],
      runner
    );
    const liveOnly = tombstoned ? ' and "deleted_at" is null' : '';
    const row = await queryOne<{ n: string }>(
      `select count(*)::int as n from "${ref.table}" where "${ref.column}" = $1${liveOnly}`,
      [id],
      runner
    );
    counts.push({ label: ref.label, count: Number(row?.n ?? 0) });
  }
  return counts;
}
