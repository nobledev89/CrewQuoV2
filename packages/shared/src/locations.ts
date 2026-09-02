import { z } from 'zod';

/**
 * Project locations (CREWQUO_V2_PLAN.md §21) — step 1 of the Phase 7 build order
 * in `docs/operating-model/project-evidence.md` §14.
 *
 * A commercial job is rarely one place. Locations are a per-project tree — floors
 * within a building, zones within a warehouse — and they are the spatial key that
 * evidence, assets, diary entries and schedule assignments hang off. Everything
 * that consumes them arrives in later phases; the tree lands first because
 * retro-fitting a spatial key into shipped records is the cost this ordering
 * exists to avoid.
 *
 * Pure, like the rate engine: the tree rules are arithmetic over rows the API
 * loads, so every branch below is a unit test rather than a fixture.
 */

export const LOCATION_KINDS = [
  'BUILDING',
  'FLOOR',
  'ROOM',
  'DEPARTMENT',
  'WAREHOUSE_ZONE',
  'LOADING_BAY',
  'SITE_AREA',
  'OTHER',
] as const;
export const locationKindSchema = z.enum(LOCATION_KINDS);
export type LocationKind = z.infer<typeof locationKindSchema>;

/**
 * §21's cap, counted in levels rather than in edges: a top-level location is
 * depth 1, so a room inside a floor inside a building is depth 3 and there is
 * exactly one level left.
 *
 * The cap exists because a tree nobody can hold in their head stops being a
 * spatial key and becomes a filing problem — and because every screen that
 * renders a breadcrumb has to render the deepest one.
 */
export const LOCATION_MAX_DEPTH = 4;

export const locationViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  kind: locationKindSchema,
  name: z.string(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  /** 1 for a top-level location. Derived, never stored — a stored depth drifts on every move. */
  depth: z.number().int(),
  /**
   * The sync contract's two columns (0029, item 7.7). `revision` is what an
   * `expectedRevision` is compared against; `deletedAt` is set instead of
   * removing the row, so a stale client can be told the record is gone rather
   * than inferring it from a 404.
   */
  revision: z.number().int().min(1),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocationView = z.infer<typeof locationViewSchema>;

export interface LocationNode extends LocationView {
  children: LocationNode[];
}

export const createLocationSchema = z.object({
  parentId: z.string().uuid().nullable().default(null),
  kind: locationKindSchema,
  name: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(120).nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  /** Idempotency key for a retry that could not tell whether it landed (item 7.7). */
  clientId: z.string().uuid().optional(),
});
export type CreateLocation = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({
    parentId: z.string().uuid().nullable(),
    kind: locationKindSchema,
    name: z.string().trim().min(1).max(200),
    reference: z.string().trim().max(120).nullable(),
    notes: z.string().trim().max(2000).nullable(),
    sortOrder: z.number().int().min(0).max(100000),
    /** `false` retires it (§21). The row and its history stay. */
    active: z.boolean(),
    /** The revision this edit was composed against (item 7.7). Optional by design. */
    expectedRevision: z.number().int().min(1),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type UpdateLocation = z.infer<typeof updateLocationSchema>;

// ── Tree arithmetic ──────────────────────────────────────────────────────────

/** The minimum a row needs for every rule below. */
export interface LocationLike {
  id: string;
  parentId: string | null;
  sortOrder: number;
  name: string;
}

/**
 * Depth of `id`, counting itself, or `null` when the chain is broken or loops.
 *
 * The loop guard is not defensive coding for its own sake: `validateParent`
 * below is what stops a cycle being *created*, and this is what stops a cycle
 * that somehow exists — a bad migration, a manual `update` — from hanging the
 * process that reads it. A tree read must never be the thing that takes the API
 * down.
 */
export function depthOf(id: string, byId: Map<string, LocationLike>): number | null {
  let depth = 0;
  let current: string | null = id;
  const seen = new Set<string>();
  while (current !== null) {
    if (seen.has(current)) return null;
    seen.add(current);
    const node: LocationLike | undefined = byId.get(current);
    if (!node) return null;
    depth += 1;
    if (depth > LOCATION_MAX_DEPTH * 4) return null;
    current = node.parentId;
  }
  return depth;
}

/** Every descendant of `id`, itself excluded. */
export function descendantsOf(id: string, all: readonly LocationLike[]): LocationLike[] {
  const byParent = new Map<string, LocationLike[]>();
  for (const node of all) {
    if (node.parentId === null) continue;
    const siblings = byParent.get(node.parentId) ?? [];
    siblings.push(node);
    byParent.set(node.parentId, siblings);
  }
  const out: LocationLike[] = [];
  const queue = [...(byParent.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const node = queue.shift() as LocationLike;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    queue.push(...(byParent.get(node.id) ?? []));
  }
  return out;
}

/** How many levels the subtree rooted at `id` occupies, itself counted as 1. */
export function subtreeHeight(id: string, all: readonly LocationLike[]): number {
  const byId = new Map(all.map((n) => [n.id, n]));
  const base = depthOf(id, byId);
  if (base === null) return 1;
  let deepest = base;
  for (const descendant of descendantsOf(id, all)) {
    const d = depthOf(descendant.id, byId);
    if (d !== null && d > deepest) deepest = d;
  }
  return deepest - base + 1;
}

export type ParentRefusal =
  | { code: 'PARENT_NOT_FOUND'; message: string }
  | { code: 'PARENT_IS_SELF'; message: string }
  | { code: 'PARENT_IS_DESCENDANT'; message: string }
  | { code: 'TOO_DEEP'; message: string };

/**
 * May `id` sit under `parentId`? §21's two rules, plus the one it implies.
 *
 * **The implied rule is the one worth writing down.** §21 says depth is capped at
 * 4 and a parent must not be a descendant. Both are about the node being moved —
 * and neither catches the case that actually breaks the cap: moving a node that
 * *has children* under a deeper parent. The node itself can land at depth 3 while
 * its rooms end up at depth 5. So the check is against the height of the whole
 * subtree, not the position of its root.
 *
 * `id` is null when creating, where there is no subtree yet and no cycle possible.
 */
export function validateParent(args: {
  /** Every location in the project, as it is *now*. */
  all: readonly LocationLike[];
  /** The node being moved, or null when creating a new one. */
  id: string | null;
  parentId: string | null;
}): ParentRefusal | null {
  const { all, id, parentId } = args;
  if (parentId === null) {
    // A top level node is depth 1; its subtree must still fit under the cap.
    const height = id === null ? 1 : subtreeHeight(id, all);
    return height > LOCATION_MAX_DEPTH ? tooDeep(height) : null;
  }

  const byId = new Map(all.map((n) => [n.id, n]));
  if (!byId.has(parentId)) {
    return { code: 'PARENT_NOT_FOUND', message: 'That parent location is not in this project' };
  }
  if (id !== null && parentId === id) {
    return { code: 'PARENT_IS_SELF', message: 'A location cannot be inside itself' };
  }
  if (id !== null && descendantsOf(id, all).some((d) => d.id === parentId)) {
    return {
      code: 'PARENT_IS_DESCENDANT',
      message: 'A location cannot be moved inside one of its own sub-locations',
    };
  }

  const parentDepth = depthOf(parentId, byId);
  if (parentDepth === null) {
    return { code: 'PARENT_NOT_FOUND', message: 'That parent location is not in this project' };
  }
  const height = id === null ? 1 : subtreeHeight(id, all);
  const resulting = parentDepth + height;
  return resulting > LOCATION_MAX_DEPTH ? tooDeep(resulting) : null;
}

function tooDeep(resulting: number): ParentRefusal {
  return {
    code: 'TOO_DEEP',
    message: `Locations can be nested ${LOCATION_MAX_DEPTH} levels deep; this would make ${resulting}`,
  };
}

/**
 * Rows to a tree, ordered by `sortOrder` then name.
 *
 * **An orphan is surfaced at the top rather than dropped.** A row whose parent is
 * missing is a bug somewhere, and silently omitting it from the tree makes the
 * evidence tagged to it unreachable through the only navigation there is — the
 * worst possible response to a data problem the user did not cause.
 */
export function buildLocationTree(rows: readonly LocationView[]): LocationNode[] {
  const byId = new Map<string, LocationNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: LocationNode[] = [];

  for (const node of byId.values()) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (nodes: LocationNode[]): void => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** `Building A › Floor 3 › Room 3.12`, for a screen or an export column. */
export function locationPath(id: string, all: readonly LocationView[]): string[] {
  const byId = new Map(all.map((n) => [n.id, n]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const node: LocationView | undefined = byId.get(current);
    if (!node) break;
    parts.unshift(node.name);
    current = node.parentId;
  }
  return parts;
}

/**
 * What stops a location being deleted (§21).
 *
 * A *registry*, not a hand-written `or` chain, and that shape is the point. Every
 * later phase adds a table that points here — evidence and documents in 7.3/7.4,
 * the diary in 7.5, assets in Phase 8, schedule assignments in Phase 11 — and a
 * condition written inline is one each of those five people has to remember to
 * extend. The one who forgets deletes a location out from under a year of
 * evidence.
 *
 * Children are listed here rather than special-cased for the same reason: a
 * sub-location is a reference like any other.
 */
export interface LocationReferenceTable {
  /** The table holding the reference. */
  table: string;
  /** Its column pointing at `project_locations.id`. */
  column: string;
  /** What to call it in a refusal a person reads. */
  label: string;
}

export const LOCATION_REFERENCE_TABLES: readonly LocationReferenceTable[] = [
  { table: 'project_locations', column: 'parent_id', label: 'sub-locations' },
  // 7.3, and the first entry this registry was written for. A location deleted out
  // from under a year of photographs is the failure the shape exists to prevent.
  { table: 'project_evidence', column: 'location_id', label: 'photos and files' },
  { table: 'project_documents', column: 'location_id', label: 'documents' },
  // 7.5. A diary entry names the areas a day's work happened in, and a day is the
  // one record here that can never be deleted — so a location it cites is one the
  // product has promised to keep rendering.
  { table: 'site_diary_locations', column: 'location_id', label: 'diary entries' },
  // Phase 8 adds project_assets.location_id.
  // Phase 11 adds schedule_assignments.location_id.
];

export interface LocationReferenceCount {
  label: string;
  count: number;
}

/** The sentence a refusal shows: what is using it, and how much of it. */
export function describeReferences(counts: readonly LocationReferenceCount[]): string {
  const live = counts.filter((c) => c.count > 0);
  if (live.length === 0) return '';
  const parts = live.map((c) => `${c.count} ${c.label}`);
  const listed =
    parts.length === 1
      ? (parts[0] as string)
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
  return `This location still has ${listed}. Retire it instead, which keeps everything already recorded against it.`;
}
