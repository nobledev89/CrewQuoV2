'use client';

import { useState } from 'react';
import {
  LOCATION_KINDS,
  LOCATION_KIND_LABELS,
  LOCATION_MAX_DEPTH,
  type LocationView,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  Row,
  Section,
  Select,
  Stack,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import type { useAsyncList } from '@/lib/useAsyncList';

/**
 * Project locations (§21) — the structure everything else in Phase 7 tags against.
 *
 * **Optional everywhere**, which is the rule that decides how this renders: a
 * single-area job never creates one, so the empty state is a normal state and not
 * a prompt to fix something. Evidence, documents and the diary all render the
 * untagged case first for the same reason.
 *
 * Two things this screen has to say out loud, because the API refuses on both and
 * a refusal a person cannot act on is a dead end:
 *
 *  - **A location that is in use is retired, not deleted.** The refusal names what
 *    is using it — "12 photos and files, 2 documents" — and the recovery is the
 *    button beside the message rather than a support ticket.
 *  - **A retired location keeps rendering on the records that already point at
 *    it.** Retiring is about what can be *chosen* next, not about erasing where
 *    last month's photographs were taken.
 */
export function LocationsPanel({
  projectId,
  locations,
  canManage,
}: {
  projectId: string;
  locations: ReturnType<typeof useAsyncList<LocationView>>;
  canManage: boolean;
}) {
  const ctx = useSessionCtx();
  const [drawer, setDrawer] = useState<{ parent: LocationView | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * Depth-first, parents before children, so the flat list reads as the tree it is.
   *
   * The API already returns `depth` and `path`; this only orders. Re-deriving depth
   * here would be a second answer to a question `locations.ts` settled, and the two
   * would disagree the first time somebody re-parents a floor.
   */
  const ordered = orderTree(locations.items);
  const canAddChild = (l: LocationView) => l.depth < LOCATION_MAX_DEPTH && l.active;

  async function retire(location: LocationView, active: boolean) {
    if (!ctx) return;
    setBusyId(location.id);
    setError(null);
    try {
      await api.updateLocation(ctx.accessToken, ctx.companyId, location.id, { active });
      locations.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update that location');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(location: LocationView) {
    if (!ctx) return;
    setBusyId(location.id);
    setError(null);
    try {
      await api.deleteLocation(ctx.accessToken, ctx.companyId, location.id);
      locations.reload();
    } catch (err) {
      /*
       * The refusal already names what is using it, and it is built by
       * `describeReferences` on the API side from the same registry every later
       * phase extends. Shown verbatim rather than rewritten here, so a phase that
       * adds a referencing table does not also have to remember to add a sentence.
       */
      setError(err instanceof ApiError ? err.message : 'Could not remove that location');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Section
      title="Locations"
      description="Where on the site work happened. Optional — a single-area job never needs one."
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setDrawer({ parent: null })}>
            Add location
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error ?? locations.error}</ErrorText>

        {locations.loading ? (
          <p className="cq-muted">Loading locations…</p>
        ) : ordered.length === 0 ? (
          <EmptyState title="No locations on this project">
            Photographs, documents and diary entries can be tagged to a floor or a room.
            {canManage ? ' Add one when the job needs it — nothing here requires it.' : ''}
          </EmptyState>
        ) : (
          <div className="cq-tree">
            {ordered.map((l) => (
              <div className="cq-tree__row" key={l.id} style={{ paddingLeft: 10 + (l.depth - 1) * 20 }}>
                <span className="cq-tree__name">
                  <span className={l.active ? undefined : 'cq-tree__retired'}>{l.name}</span>
                  <Badge>{LOCATION_KIND_LABELS[l.kind]}</Badge>
                  {l.reference ? <span className="cq-muted">{l.reference}</span> : null}
                  {!l.active ? <Badge tone="warning">Retired</Badge> : null}
                </span>
                {canManage ? (
                  <Row>
                    {canAddChild(l) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setDrawer({ parent: l })}
                      >
                        Add inside
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === l.id}
                      onClick={() => void retire(l, !l.active)}
                    >
                      {l.active ? 'Retire' : 'Bring back'}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busyId === l.id}
                      onClick={() => void remove(l)}
                    >
                      Remove
                    </Button>
                  </Row>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {ordered.some((l) => !l.active) ? (
          <Notice>
            A retired location still appears on everything already recorded against it. It is
            only removed from the lists people choose from next.
          </Notice>
        ) : null}
      </Stack>

      {drawer ? (
        <LocationDrawer
          projectId={projectId}
          parent={drawer.parent}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null);
            locations.reload();
          }}
        />
      ) : null}
    </Section>
  );
}

function LocationDrawer({
  projectId,
  parent,
  onClose,
  onSaved,
}: {
  projectId: string;
  parent: LocationView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ctx = useSessionCtx();
  const [kind, setKind] = useState<string>(parent ? 'ROOM' : 'BUILDING');
  const [name, setName] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.createLocation(ctx.accessToken, ctx.companyId, projectId, {
        kind: kind as (typeof LOCATION_KINDS)[number],
        name: name.trim(),
        parentId: parent?.id ?? null,
        reference: reference.trim() || null,
        notes: null,
        sortOrder: 0,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that location');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={parent ? `Add inside ${parent.name}` : 'Add a location'}
      description={
        parent
          ? `Level ${parent.depth + 1} of ${LOCATION_MAX_DEPTH}. A site is a tree, not a filing cabinet.`
          : 'A building, a floor, an area or a room. Nesting is optional.'
      }
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add location'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {LOCATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LOCATION_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="Floor 3"
            />
          </Field>
          <Field label="Reference" hint="A plot number, a room code — optional.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

/**
 * Parents before their own children, depth-first.
 *
 * Not a sort: a comparator cannot express "after my parent, before my parent's
 * next sibling" without already knowing the tree. Built from the parent map
 * instead, and orphans — a child whose parent is retired out of this response —
 * are appended rather than dropped, because a location nobody can see is a
 * location nobody can fix.
 */
function orderTree(items: readonly LocationView[]): LocationView[] {
  const byParent = new Map<string | null, LocationView[]>();
  for (const item of items) {
    const key = item.parentId;
    byParent.set(key, [...(byParent.get(key) ?? []), item]);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  const out: LocationView[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const item of byParent.get(parentId) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      walk(item.id);
    }
  };
  walk(null);
  for (const item of items) if (!seen.has(item.id)) out.push(item);
  return out;
}
