import { describe, expect, it } from 'vitest';
import {
  LOCATION_MAX_DEPTH,
  LOCATION_REFERENCE_TABLES,
  buildLocationTree,
  createLocationSchema,
  depthOf,
  descendantsOf,
  describeReferences,
  locationPath,
  subtreeHeight,
  updateLocationSchema,
  validateParent,
  type LocationLike,
  type LocationView,
} from './locations';

/** A four-level fixture: Building A › Floor 3 › Room 3.12, plus a Loading Bay. */
const node = (id: string, parentId: string | null, name = id, sortOrder = 0): LocationLike => ({
  id,
  parentId,
  name,
  sortOrder,
});

const TREE: LocationLike[] = [
  node('building', null, 'Building A'),
  node('floor1', 'building', 'Floor 1', 1),
  node('floor3', 'building', 'Floor 3', 3),
  node('room312', 'floor3', 'Room 3.12'),
  node('bay', null, 'Loading Bay', 5),
];

const byId = new Map(TREE.map((n) => [n.id, n]));

describe('depthOf', () => {
  it('counts levels, with a top-level location at 1', () => {
    expect(depthOf('building', byId)).toBe(1);
    expect(depthOf('floor3', byId)).toBe(2);
    expect(depthOf('room312', byId)).toBe(3);
  });

  it('returns null for a location that is not there', () => {
    expect(depthOf('nowhere', byId)).toBeNull();
  });

  it('does not hang on a cycle that somehow exists', () => {
    // `validateParent` stops one being created. This stops one that got in by a
    // bad migration or a hand-written update from taking the API down when
    // somebody merely reads the tree.
    const looped = new Map<string, LocationLike>([
      ['a', node('a', 'b')],
      ['b', node('b', 'a')],
    ]);
    expect(depthOf('a', looped)).toBeNull();
  });
});

describe('descendantsOf', () => {
  it('finds every level below, not only the children', () => {
    expect(descendantsOf('building', TREE).map((n) => n.id).sort()).toEqual([
      'floor1',
      'floor3',
      'room312',
    ]);
  });

  it('excludes the node itself', () => {
    expect(descendantsOf('floor3', TREE).map((n) => n.id)).toEqual(['room312']);
  });

  it('is empty for a leaf', () => {
    expect(descendantsOf('room312', TREE)).toEqual([]);
  });
});

describe('subtreeHeight', () => {
  it('counts the levels a subtree occupies, itself included', () => {
    expect(subtreeHeight('room312', TREE)).toBe(1);
    expect(subtreeHeight('floor3', TREE)).toBe(2);
    expect(subtreeHeight('building', TREE)).toBe(3);
  });
});

describe('validateParent', () => {
  it('accepts a new top-level location', () => {
    expect(validateParent({ all: TREE, id: null, parentId: null })).toBeNull();
  });

  it('accepts a new child of an existing location', () => {
    expect(validateParent({ all: TREE, id: null, parentId: 'floor3' })).toBeNull();
  });

  it('refuses a parent from outside the project', () => {
    // The database refuses this too, through the composite foreign key. The route
    // refuses first so the caller gets a sentence rather than a 500.
    expect(validateParent({ all: TREE, id: null, parentId: 'someone-elses' })?.code).toBe(
      'PARENT_NOT_FOUND'
    );
  });

  it('refuses a location as its own parent', () => {
    expect(validateParent({ all: TREE, id: 'floor3', parentId: 'floor3' })?.code).toBe('PARENT_IS_SELF');
  });

  it('refuses a move into its own descendant, which would orphan the whole branch', () => {
    expect(validateParent({ all: TREE, id: 'building', parentId: 'room312' })?.code).toBe(
      'PARENT_IS_DESCENDANT'
    );
  });

  it('refuses a fifth level', () => {
    // Room 3.12 is depth 3, so a desk inside it is depth 4 and legal; a drawer
    // inside the desk is the first thing over the cap. Getting this boundary
    // right in the test mattered — the first version put the new node under the
    // room and expected a refusal, which would have meant the cap was 3.
    const withDesk: LocationLike[] = [...TREE, node('desk', 'room312', 'Desk 12a')];
    const refusal = validateParent({ all: withDesk, id: null, parentId: 'desk' });
    expect(refusal?.code).toBe('TOO_DEEP');
    expect(refusal?.message).toContain(String(LOCATION_MAX_DEPTH));
  });

  it('allows the fourth level, so the cap is levels and not edges', () => {
    // Room 3.12 is depth 3. A desk inside it is depth 4, which is the last one.
    expect(validateParent({ all: TREE, id: null, parentId: 'floor3' })).toBeNull();
    const withDesk = [...TREE, node('desk', 'room312', 'Desk 12a')];
    expect(depthOf('desk', new Map(withDesk.map((n) => [n.id, n])))).toBe(LOCATION_MAX_DEPTH);
  });

  it('REFUSES a move that pushes a descendant past the cap even though the node itself fits', () => {
    /*
     * The rule §21 implies and does not state, and the one a naive check misses.
     * Moving `floor3` (which contains Room 3.12) under `floor1` puts floor3 at
     * depth 3 — legal on its own — and Room 3.12 at depth 4. Add one more level
     * and it breaks: with a desk under the room, the same move lands the desk at
     * 5.
     */
    const deeper: LocationLike[] = [...TREE, node('desk', 'room312', 'Desk 12a')];
    // The node being moved would sit at depth 3, which is fine in isolation…
    expect(depthOf('floor1', new Map(deeper.map((n) => [n.id, n])))).toBe(2);
    // …but its subtree is three levels tall, so 2 + 3 = 5.
    expect(subtreeHeight('floor3', deeper)).toBe(3);
    expect(validateParent({ all: deeper, id: 'floor3', parentId: 'floor1' })?.code).toBe('TOO_DEEP');
  });

  it('allows that same move when the subtree is short enough', () => {
    expect(validateParent({ all: TREE, id: 'floor3', parentId: 'floor1' })).toBeNull();
  });

  it('allows promoting a deep subtree to the top', () => {
    expect(validateParent({ all: TREE, id: 'floor3', parentId: null })).toBeNull();
  });

  it('refuses promoting a subtree that is itself too tall for the top', () => {
    const tall: LocationLike[] = [
      node('l1', null),
      node('l2', 'l1'),
      node('l3', 'l2'),
      node('l4', 'l3'),
      node('l5', 'l4'),
    ];
    // `l5` at depth 5 should not exist, but if it does, re-rooting `l1` must not
    // be reported as fine just because `l1` itself is already at the top.
    expect(validateParent({ all: tall, id: 'l1', parentId: null })?.code).toBe('TOO_DEEP');
  });
});

// ── Tree building ────────────────────────────────────────────────────────────

const view = (n: LocationLike, extra: Partial<LocationView> = {}): LocationView => ({
  id: n.id,
  projectId: 'p',
  parentId: n.parentId,
  kind: 'OTHER',
  name: n.name,
  reference: null,
  notes: null,
  sortOrder: n.sortOrder,
  active: true,
  depth: 1,
  revision: 1,
  deletedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra,
});

describe('buildLocationTree', () => {
  const rows = TREE.map((n) => view(n));

  it('nests children under their parents', () => {
    const tree = buildLocationTree(rows);
    const building = tree.find((n) => n.id === 'building');
    expect(building?.children.map((c) => c.id)).toEqual(['floor1', 'floor3']);
    expect(building?.children[1]?.children.map((c) => c.id)).toEqual(['room312']);
  });

  it('orders by sortOrder, then by name', () => {
    const tree = buildLocationTree(rows);
    expect(tree.map((n) => n.id)).toEqual(['building', 'bay']);
    const tied = buildLocationTree([
      view(node('b', null, 'Beta', 1)),
      view(node('a', null, 'Alpha', 1)),
    ]);
    expect(tied.map((n) => n.name)).toEqual(['Alpha', 'Beta']);
  });

  it('surfaces an orphan at the top rather than dropping it', () => {
    // Dropping it would make anything tagged to that location unreachable through
    // the only navigation there is — the worst response to a data problem the
    // user did not cause.
    const orphaned = [view(node('lost', 'gone', 'Lost Room'))];
    expect(buildLocationTree(orphaned).map((n) => n.id)).toEqual(['lost']);
  });

  it('returns every row exactly once', () => {
    const flatten = (nodes: ReturnType<typeof buildLocationTree>): string[] =>
      nodes.flatMap((n) => [n.id, ...flatten(n.children)]);
    expect(flatten(buildLocationTree(rows)).sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('is empty for an empty project, which is the normal case', () => {
    // §21: locations are optional everywhere. A single-area job never makes one.
    expect(buildLocationTree([])).toEqual([]);
  });
});

describe('locationPath', () => {
  const rows = TREE.map((n) => view(n));

  it('reads from the top down', () => {
    expect(locationPath('room312', rows)).toEqual(['Building A', 'Floor 3', 'Room 3.12']);
  });

  it('is a single name at the top level', () => {
    expect(locationPath('bay', rows)).toEqual(['Loading Bay']);
  });

  it('stops rather than looping on a broken chain', () => {
    expect(locationPath('lost', [view(node('lost', 'gone', 'Lost Room'))])).toEqual(['Lost Room']);
  });
});

describe('the reference registry', () => {
  it('starts with sub-locations, which are a reference like any other', () => {
    expect(LOCATION_REFERENCE_TABLES.map((t) => t.table)).toContain('project_locations');
  });

  it('names a table, a column and a human label for each entry', () => {
    // The shape is what later phases extend. A row missing its label produces a
    // refusal that says "3 undefined".
    for (const ref of LOCATION_REFERENCE_TABLES) {
      expect(ref.table.length).toBeGreaterThan(0);
      expect(ref.column.length).toBeGreaterThan(0);
      expect(ref.label.length).toBeGreaterThan(0);
    }
  });
});

describe('describeReferences', () => {
  it('says nothing when nothing references it', () => {
    expect(describeReferences([{ label: 'sub-locations', count: 0 }])).toBe('');
  });

  it('names the one thing that does', () => {
    const message = describeReferences([{ label: 'sub-locations', count: 3 }]);
    expect(message).toContain('3 sub-locations');
    // The refusal has to offer the path §21 actually wants taken.
    expect(message).toContain('Retire it instead');
  });

  it('lists several readably', () => {
    expect(
      describeReferences([
        { label: 'sub-locations', count: 2 },
        { label: 'photos', count: 40 },
        { label: 'diary entries', count: 1 },
      ])
    ).toContain('2 sub-locations, 40 photos and 1 diary entries');
  });

  it('ignores the tables that reference nothing', () => {
    const message = describeReferences([
      { label: 'sub-locations', count: 0 },
      { label: 'photos', count: 5 },
    ]);
    expect(message).toContain('5 photos');
    expect(message).not.toContain('sub-locations');
  });
});

describe('the contracts', () => {
  it('defaults a new location to the top level with no reference', () => {
    const parsed = createLocationSchema.parse({ kind: 'FLOOR', name: 'Floor 3' });
    expect(parsed).toEqual({
      parentId: null,
      kind: 'FLOOR',
      name: 'Floor 3',
      reference: null,
      notes: null,
      sortOrder: 0,
    });
  });

  it('refuses a blank name, which would render as an unclickable gap', () => {
    expect(createLocationSchema.safeParse({ kind: 'FLOOR', name: '   ' }).success).toBe(false);
  });

  it('refuses a kind outside §21\'s list', () => {
    expect(createLocationSchema.safeParse({ kind: 'MEZZANINE', name: 'x' }).success).toBe(false);
  });

  it('refuses an empty patch rather than auditing a no-op', () => {
    expect(updateLocationSchema.safeParse({}).success).toBe(false);
  });

  it('accepts retiring on its own', () => {
    expect(updateLocationSchema.safeParse({ active: false }).success).toBe(true);
  });

  it('accepts moving to the top level, which is a null parent and not an absent one', () => {
    const parsed = updateLocationSchema.safeParse({ parentId: null });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'parentId' in parsed.data).toBe(true);
  });
});
