'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_CATEGORY_LABELS,
  EVIDENCE_TIMESTAMP_PROVENANCE,
  compareEvidence,
  disclosureNotice,
  groupByEvidenceDate,
  type EvidenceCategory,
  type EvidenceView,
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
  Textarea,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { formatBytes, uploadFiles, type UploadFailure } from '@/lib/upload';
import { formatDate } from '@/lib/format';

/**
 * Photos & evidence (§22) — the gallery, the filters and the batch upload.
 *
 * **The screen renders decisions this app did not make.** Ordering,
 * day-grouping, the category counts, the filter contract and the publish
 * confirmation wording are all in `@crewquo/shared` and tested there, because a
 * gallery that sorted photographs its own way would disagree with the report and
 * the export that read the same rows. What is genuinely this file's is the *shape*
 * of the interaction: what you can drop, what a partial failure looks like, and
 * which of the three timestamps is shown where.
 *
 * Three rules from the packet that decide most of what follows:
 *
 *  - **A partial batch must never lose the files that worked** (§9). Thirty-seven
 *    of forty photographs stored, three retryable, and the retry is one button.
 *  - **The batch is the unit of tagging** (§22.3). Metadata is applied to the
 *    whole selection and overridden per photograph, because tagging forty
 *    individually is the failure mode that kills evidence capture.
 *  - **Publishing belongs to the project owner alone**, and hiding withdraws
 *    nothing already downloaded. The confirmation says so in the API's own words.
 */

type ViewMode = 'gallery' | 'timeline' | 'table';

export function EvidencePanel({
  projectId,
  locations,
  canUpload,
  canManage,
  canPublish,
  isOwner,
  onCountChanged,
}: {
  projectId: string;
  locations: readonly LocationView[];
  canUpload: boolean;
  canManage: boolean;
  canPublish: boolean;
  isOwner: boolean;
  onCountChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [categories, setCategories] = useState<EvidenceCategory[]>([]);
  const [locationId, setLocationId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [view, setView] = useState<ViewMode>('gallery');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<EvidenceView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useAsyncData(
    ctx
      ? () =>
          api.listEvidence(ctx.accessToken, ctx.companyId, projectId, {
            category: categories,
            locationId: locationId || undefined,
            from: from || undefined,
            to: to || undefined,
          })
      : null,
    [ctx?.companyId, projectId, categories.join(','), locationId, from, to]
  );

  const items = useMemo(() => [...(list.data?.evidence ?? [])].sort(compareEvidence), [list.data]);
  const counts = list.data?.categoryCounts ?? {};

  /**
   * The selection survives a filter change, and that is deliberate (§22.4's
   * "sticky selection"). Picking twelve photographs across three categories means
   * changing the filter between picks; a selection that emptied itself each time
   * would make the multi-select useless for the one job it exists for.
   *
   * What it must not do is keep ids that no longer exist — a deleted row would
   * otherwise ride along into a publish. Pruned against what came back.
   */
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(items.map((e) => e.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const refresh = useCallback(() => {
    list.reload();
    onCountChanged();
  }, [list, onCountChanged]);

  async function publish(clientVisible: boolean) {
    if (!ctx || selected.size === 0) return;
    setError(null);
    try {
      const res = await api.publishEvidence(ctx.accessToken, ctx.companyId, projectId, {
        ids: [...selected],
        clientVisible,
      });
      // The API's own sentence, not a re-worded one. It is the only copy that
      // knows whether anything in this selection had *ever* been published, and
      // that is the difference between "hidden" and "withdrawn" — which this
      // product cannot do and must not imply.
      setNotice(res.notice);
      setSelected(new Set());
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change what the client sees');
    }
  }

  const empty = !list.loading && items.length === 0;
  const filtered =
    categories.length > 0 || locationId !== '' || from !== '' || to !== '';

  return (
    <Section
      title="Photos & evidence"
      description="What the site looked like, and when. The client sees only what you deliberately share."
      actions={
        <Row>
          <ViewSwitch view={view} onChange={setView} />
        </Row>
      }
    >
      <Stack>
        {canUpload ? (
          <UploadDropzone
            projectId={projectId}
            locations={locations}
            onUploaded={refresh}
          />
        ) : (
          <Notice>
            You can see this project’s evidence but not add to it. Uploading needs the
            <strong> evidence.upload</strong> permission.
          </Notice>
        )}

        <FilterBar
          categories={categories}
          counts={counts}
          onCategories={setCategories}
          locations={locations}
          locationId={locationId}
          onLocation={setLocationId}
          from={from}
          to={to}
          onFrom={setFrom}
          onTo={setTo}
        />

        {notice ? <Notice live>{notice}</Notice> : null}
        <ErrorText>{error ?? list.error}</ErrorText>

        {selected.size > 0 ? (
          <Row between>
            <span className="cq-muted">
              {selected.size} selected
              {canPublish ? '' : ' — publishing is the project owner’s decision'}
            </span>
            <Row>
              {canPublish ? (
                <>
                  <Button size="sm" onClick={() => void publish(true)}>
                    Share with client
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void publish(false)}>
                    Stop sharing
                  </Button>
                </>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </Row>
          </Row>
        ) : null}

        {list.loading ? (
          <p className="cq-muted">Loading evidence…</p>
        ) : empty ? (
          <EmptyState title={filtered ? 'Nothing matches those filters' : 'No evidence yet'}>
            {filtered
              ? 'Clear a filter to see the rest of this project’s photographs.'
              : canUpload
                ? 'Drop photographs above, or choose files. Everything you add is private to your company and this project’s owner until it is deliberately shared.'
                : 'Nothing has been added to this project yet.'}
          </EmptyState>
        ) : view === 'table' ? (
          <EvidenceTable items={items} locations={locations} onOpen={setDetail} />
        ) : view === 'timeline' ? (
          <Timeline
            items={items}
            selected={selected}
            onToggle={(id) => toggle(setSelected, id)}
            onOpen={setDetail}
          />
        ) : (
          <Gallery
            items={items}
            selected={selected}
            onToggle={(id) => toggle(setSelected, id)}
            onOpen={setDetail}
          />
        )}
      </Stack>

      {detail ? (
        <EvidenceDrawer
          evidence={detail}
          locations={locations}
          canEdit={canManage || canUpload}
          canPublish={canPublish}
          isOwner={isOwner}
          onClose={() => setDetail(null)}
          onChanged={() => {
            setDetail(null);
            refresh();
          }}
        />
      ) : null}
    </Section>
  );
}

function toggle(set: (fn: (prev: Set<string>) => Set<string>) => void, id: string) {
  set((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

// ── Upload ──────────────────────────────────────────────────────────────────────

/**
 * Drag-and-drop, and the click that does the same thing.
 *
 * **The drop zone is a `<label>` wrapping a real file input**, which is what makes
 * the pointer path and the keyboard path the same control rather than a drag
 * handler with a fallback bolted beside it. WCAG 2.2 SC 2.5.7 asks that any
 * drag-driven action have a single-pointer alternative; here the alternative is
 * not an alternative, it is the same element.
 */
function UploadDropzone({
  projectId,
  locations,
  onUploaded,
}: {
  projectId: string;
  locations: readonly LocationView[];
  onUploaded: () => void;
}) {
  const ctx = useSessionCtx();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<UploadFailure[]>([]);
  const [pending, setPending] = useState<{ fileId: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (files: File[]) => {
      if (!ctx || files.length === 0) return;
      setError(null);
      setFailures([]);
      setBusy({ done: 0, total: files.length });
      const outcome = await uploadFiles(
        { accessToken: ctx.accessToken, companyId: ctx.companyId },
        files,
        {
          kind: 'IMAGE',
          projectId,
          onProgress: (done, total) => setBusy({ done, total }),
        }
      );
      setBusy(null);
      setFailures(outcome.failed);
      // The bytes are stored; they are not evidence until a record says what they
      // show. The tagging drawer opens with whatever survived — never with the
      // whole selection, because the three that failed are not there to tag.
      if (outcome.uploaded.length > 0) {
        setPending(outcome.uploaded.map((u) => ({ fileId: u.fileId, name: u.file.name })));
      }
    },
    [ctx, projectId]
  );

  return (
    <Stack>
      <label
        className={[
          'cq-dropzone',
          over ? 'cq-dropzone--over' : '',
          busy ? 'cq-dropzone--busy' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send([...e.dataTransfer.files]);
        }}
      >
        {/*
          An explicit name, even though the wrapping `<label>` would supply one.
          The label's text changes to "Uploading 2 of 3…" while the batch is going
          up, and a control whose accessible name changes underneath somebody
          mid-operation is worse than one with a plain stable name — a screen
          reader user tabbing back to it would hear a different control.
        */}
        <input
          type="file"
          multiple
          aria-label="Choose photographs to upload"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          disabled={busy !== null}
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            // Cleared so choosing the same file twice fires `change` twice — a retry
            // after a failure is usually the same file.
            e.target.value = '';
          }}
        />
        <strong>{busy ? `Uploading ${busy.done + 1} of ${busy.total}…` : 'Drop photographs here'}</strong>
        <span className="cq-dropzone__hint">
          {busy ? 'One at a time, so a bad connection loses one file rather than all of them.' : 'or choose files — JPEG, PNG, WebP or HEIC'}
        </span>
      </label>

      <ErrorText>{error}</ErrorText>

      {failures.length > 0 ? (
        <Notice live>
          <strong>
            {failures.length} {failures.length === 1 ? 'file' : 'files'} could not be stored.
          </strong>{' '}
          Everything else was. {failures.some((f) => f.retryable) ? 'Try those again:' : ''}
          <ul>
            {failures.map((f) => (
              <li key={f.file.name}>
                {f.file.name} ({formatBytes(f.file.size)}) — {f.message}
              </li>
            ))}
          </ul>
          {failures.some((f) => f.retryable) ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void send(failures.filter((f) => f.retryable).map((f) => f.file))}
            >
              Retry {failures.filter((f) => f.retryable).length}
            </Button>
          ) : null}
        </Notice>
      ) : null}

      {pending.length > 0 ? (
        <TagBatchDrawer
          projectId={projectId}
          files={pending}
          locations={locations}
          onClose={() => setPending([])}
          onSaved={() => {
            setPending([]);
            onUploaded();
          }}
        />
      ) : null}
    </Stack>
  );
}

/**
 * Tag the whole selection at once, with a per-photograph override.
 *
 * §22.3's rule, and the one interaction decision that matters most on this screen:
 * defaults apply to everything, exceptions are per item, and an item that says
 * nothing takes the default. The API's `applyBatchDefaults` is what actually
 * merges them — including the distinction between "said nothing" and "explicitly
 * cleared" — so this form sends `undefined` for untouched fields rather than
 * filling them in.
 */
function TagBatchDrawer({
  projectId,
  files,
  locations,
  onClose,
  onSaved,
}: {
  projectId: string;
  files: { fileId: string; name: string }[];
  locations: readonly LocationView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const ctx = useSessionCtx();
  const [category, setCategory] = useState<EvidenceCategory>('DURING');
  const [evidenceDate, setEvidenceDate] = useState('');
  const [locationId, setLocationId] = useState('');
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ fileId: string; message: string }[]>([]);

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createEvidenceBatch(ctx.accessToken, ctx.companyId, projectId, {
        batchClientId: crypto.randomUUID(),
        defaults: {
          category,
          evidenceDate: evidenceDate || null,
          locationId: locationId || null,
        },
        items: files.map((f) => ({
          fileId: f.fileId,
          ...(captions[f.fileId]?.trim() ? { caption: captions[f.fileId]!.trim() } : {}),
        })),
      });
      if (res.rejected.length > 0) {
        setRejected(res.rejected.map((r) => ({ fileId: r.fileId, message: r.message })));
        if (res.created.length === 0) return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not file those photographs');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={`Tag ${files.length} ${files.length === 1 ? 'photograph' : 'photographs'}`}
      description="What is set here applies to all of them. Change any one below."
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Filing…' : `File ${files.length}`}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Category">
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as EvidenceCategory)}
            >
              {EVIDENCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {EVIDENCE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Project day"
            hint="Which day these show — not the day you uploaded them."
          >
            <Input
              type="date"
              value={evidenceDate}
              onChange={(e) => setEvidenceDate(e.target.value)}
            />
          </Field>
          <Field label="Location">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">No location</option>
              {locations
                .filter((l) => l.active)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>

        <div className="cq-fieldset">
          <span className="cq-fieldset__legend">Captions</span>
          <p className="cq-fieldset__hint">
            Optional, and per photograph. Everything else above applies to all of them.
          </p>
          {files.map((f) => (
            <Field key={f.fileId} label={f.name}>
              <Input
                value={captions[f.fileId] ?? ''}
                placeholder="North wall, before strip-out"
                onChange={(e) =>
                  setCaptions((prev) => ({ ...prev, [f.fileId]: e.target.value }))
                }
              />
            </Field>
          ))}
        </div>

        {rejected.length > 0 ? (
          <Notice>
            <strong>{rejected.length} could not be filed.</strong> The rest were.
            <ul>
              {rejected.map((r) => (
                <li key={r.fileId}>{r.message}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

// ── Filters ─────────────────────────────────────────────────────────────────────

/**
 * §22.4's filters.
 *
 * The category counts come from the API over the **whole scoped set**, not the
 * filtered page, which is what keeps "Before (12)" true while you are choosing.
 * A count computed from what is currently on screen would drop to zero the moment
 * you selected a different category — the one number that has to stay stable is
 * the one people are reading to decide.
 */
function FilterBar({
  categories,
  counts,
  onCategories,
  locations,
  locationId,
  onLocation,
  from,
  to,
  onFrom,
  onTo,
}: {
  categories: EvidenceCategory[];
  counts: Record<string, number>;
  onCategories: (next: EvidenceCategory[]) => void;
  locations: readonly LocationView[];
  locationId: string;
  onLocation: (id: string) => void;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  // Only categories that exist on this project. Fourteen chips, eleven of them
  // reading (0), is a filter bar that has to be read past rather than used.
  const present = EVIDENCE_CATEGORIES.filter((c) => (counts[c] ?? 0) > 0);

  return (
    <Stack>
      {present.length > 0 ? (
        <div className="cq-chips" role="group" aria-label="Filter by category">
          {present.map((c) => {
            const on = categories.includes(c);
            return (
              <button
                key={c}
                type="button"
                className="cq-chip"
                aria-pressed={on}
                onClick={() =>
                  onCategories(on ? categories.filter((x) => x !== c) : [...categories, c])
                }
              >
                {EVIDENCE_CATEGORY_LABELS[c]}
                <span className="cq-chip__count">{counts[c] ?? 0}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="cq-form-grid">
        <Field label="Location">
          <Select value={locationId} onChange={(e) => onLocation(e.target.value)}>
            <option value="">Anywhere</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
                {l.active ? '' : ' (retired)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From" hint="Project day, not upload day.">
          <Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
        </Field>
      </div>
    </Stack>
  );
}

function ViewSwitch({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const options: [ViewMode, string][] = [
    ['gallery', 'Gallery'],
    ['timeline', 'Timeline'],
    ['table', 'Table'],
  ];
  return (
    <div className="cq-chips" role="group" aria-label="How to show the evidence">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className="cq-chip"
          aria-pressed={view === id}
          onClick={() => onChange(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ── The three views ─────────────────────────────────────────────────────────────

function Gallery({
  items,
  selected,
  onToggle,
  onOpen,
}: {
  items: readonly EvidenceView[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (e: EvidenceView) => void;
}) {
  return (
    <div className="cq-gallery">
      {items.map((e) => (
        <Tile
          key={e.id}
          evidence={e}
          selected={selected.has(e.id)}
          onToggle={() => onToggle(e.id)}
          onOpen={() => onOpen(e)}
        />
      ))}
    </div>
  );
}

/**
 * The same tiles, grouped by the day they depict.
 *
 * `groupByEvidenceDate` is the API's own grouping, undated photographs included
 * and labelled rather than dropped: a photograph nobody dated is still evidence,
 * and hiding it in the one view organised by date is how it stops being found.
 */
function Timeline({
  items,
  selected,
  onToggle,
  onOpen,
}: {
  items: readonly EvidenceView[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (e: EvidenceView) => void;
}) {
  const groups = groupByEvidenceDate(items);
  return (
    <Stack>
      {groups.map((group) => (
        <div className="cq-daygroup" key={group.evidenceDate ?? 'undated'}>
          <div className="cq-daygroup__heading">
            <h3 className="cq-h3">
              {group.evidenceDate ? formatDate(group.evidenceDate) : 'No project day set'}
            </h3>
            <span className="cq-muted">
              {group.items.length} {group.items.length === 1 ? 'file' : 'files'}
            </span>
          </div>
          <div className="cq-gallery">
            {group.items.map((e) => (
              <Tile
                key={e.id}
                evidence={e}
                selected={selected.has(e.id)}
                onToggle={() => onToggle(e.id)}
                onOpen={() => onOpen(e)}
              />
            ))}
          </div>
        </div>
      ))}
    </Stack>
  );
}

function EvidenceTable({
  items,
  locations,
  onOpen,
}: {
  items: readonly EvidenceView[];
  locations: readonly LocationView[];
  onOpen: (e: EvidenceView) => void;
}) {
  const nameOf = (id: string | null) => locations.find((l) => l.id === id)?.name ?? '—';
  return (
    <div className="cq-table-wrap" tabIndex={0} role="region" aria-label="Evidence">
      <table className="cq-table cq-table--compact" aria-label="Evidence">
        <thead>
          <tr>
            <th>File</th>
            <th>Category</th>
            <th>Project day</th>
            <th>Location</th>
            <th>Shared</th>
            <th className="cq-numeric">Size</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>
                <button type="button" className="cq-link-button" onClick={() => onOpen(e)}>
                  {e.caption || e.originalFilename}
                </button>
              </td>
              <td>{EVIDENCE_CATEGORY_LABELS[e.category]}</td>
              <td>{e.evidenceDate ? formatDate(e.evidenceDate) : '—'}</td>
              <td>{nameOf(e.locationId)}</td>
              <td>{e.clientVisible ? <Badge tone="accent">Shared</Badge> : '—'}</td>
              <td className="cq-numeric">{formatBytes(e.byteSize)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One photograph.
 *
 * **The image is fetched through a per-file signed URL**, minted on demand rather
 * than listed: a presigned URL is a bearer capability with a URL for a body, so
 * a gallery asks for one per visible tile instead of receiving a hundred at once.
 * A file still being scanned renders its state rather than a broken image, which
 * is the case a capture product hits constantly and a demo never does.
 */
function Tile({
  evidence,
  selected,
  onToggle,
  onOpen,
}: {
  evidence: EvidenceView;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const src = useFileUrl(evidence.thumbFileId ?? (evidence.fileStatus === 'READY' ? evidence.fileId : null));

  return (
    <div className={`cq-tile${selected ? ' cq-tile--selected' : ''}`}>
      <div className="cq-tile__frame">
        <label className="cq-tile__select">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          <span className="cq-vh">Select</span>
        </label>
        <button
          type="button"
          className="cq-tile__button"
          onClick={onOpen}
          aria-label={`Open ${evidence.caption || evidence.originalFilename}`}
        >
          {src ? (
            <img src={src} alt={evidence.caption ?? ''} loading="lazy" />
          ) : (
            <span className="cq-tile__placeholder">
              {evidence.fileStatus === 'FAILED'
                ? 'Not stored'
                : evidence.fileStatus === 'READY'
                  ? 'No preview'
                  : 'Being checked…'}
            </span>
          )}
        </button>
      </div>
      <div className="cq-tile__body">
        <span className="cq-tile__caption">{evidence.caption || evidence.originalFilename}</span>
        <span className="cq-tile__meta">
          {EVIDENCE_CATEGORY_LABELS[evidence.category]}
          {evidence.evidenceDate ? ` · ${formatDate(evidence.evidenceDate)}` : ''}
        </span>
        {evidence.clientVisible || evidence.firstPublishedAt ? (
          <span className="cq-tile__flags">
            {evidence.clientVisible ? <Badge tone="accent">Shared</Badge> : null}
            {!evidence.clientVisible && evidence.firstPublishedAt ? (
              <Badge tone="warning">Was shared</Badge>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** A short-lived signed URL for one file, or null while there is nothing to show. */
function useFileUrl(fileId: string | null): string | null {
  const ctx = useSessionCtx();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx || !fileId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    api
      .fileDownloadUrl(ctx.accessToken, ctx.companyId, fileId)
      .then((res) => {
        if (!cancelled) setUrl(res.url);
      })
      .catch(() => {
        // A tile that cannot fetch its own URL shows its placeholder. Surfacing this
        // as a page-level error would fill the screen with one message per tile for
        // a condition the person can neither read nor act on.
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, fileId]);

  return url;
}

/**
 * One of the three timestamps, labelled with whether the platform stands behind it.
 *
 * The label and the attestation both come from `EVIDENCE_TIMESTAMP_PROVENANCE`
 * rather than being written here, so this screen cannot be the place where
 * `capturedAt` quietly starts reading as attested. §8: exactly one of the three is
 * evidence, and a UI that renders them as one field with three names is what makes
 * a dispute unanswerable.
 */
function Provenance({
  which,
  value,
}: {
  which: keyof typeof EVIDENCE_TIMESTAMP_PROVENANCE;
  value: string;
}) {
  const spec = EVIDENCE_TIMESTAMP_PROVENANCE[which];
  return (
    <div>
      <dt className="cq-overline">{spec.label}</dt>
      <dd className="cq-muted">
        {value} — {spec.attested ? 'recorded by CrewQuo' : 'as claimed'}
      </dd>
    </div>
  );
}

// ── One photograph, opened ──────────────────────────────────────────────────────

function EvidenceDrawer({
  evidence,
  locations,
  canEdit,
  canPublish,
  isOwner,
  onClose,
  onChanged,
}: {
  evidence: EvidenceView;
  locations: readonly LocationView[];
  canEdit: boolean;
  canPublish: boolean;
  isOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const full = useFileUrl(evidence.webFileId ?? evidence.fileId);
  const [caption, setCaption] = useState(evidence.caption ?? '');
  const [notes, setNotes] = useState(evidence.notes ?? '');
  const [category, setCategory] = useState<EvidenceCategory>(evidence.category);
  const [evidenceDate, setEvidenceDate] = useState(evidence.evidenceDate ?? '');
  const [locationId, setLocationId] = useState(evidence.locationId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateEvidence(ctx.accessToken, ctx.companyId, evidence.id, {
        caption: caption.trim() || null,
        notes: notes.trim() || null,
        category,
        evidenceDate: evidenceDate || null,
        locationId: locationId || null,
        // The version this edit was composed against (item 7.7). A stale one comes
        // back as a 409 carrying the current record, which is what lets the message
        // below say somebody else changed it rather than "try again".
        expectedRevision: evidence.revision,
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that change');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteEvidence(ctx.accessToken, ctx.companyId, evidence.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that record');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={evidence.caption || evidence.originalFilename}
      description={`${EVIDENCE_CATEGORY_LABELS[evidence.category]} · ${formatBytes(evidence.byteSize)}`}
      onClose={onClose}
      footer={
        <Row between>
          <Row>
            {canEdit ? (
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </Row>
          {canEdit ? (
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </Row>
      }
    >
      <Stack>
        {full ? (
          <img src={full} alt={evidence.caption ?? 'Evidence photograph'} style={{ width: '100%', borderRadius: 8 }} />
        ) : (
          <Notice>
            {evidence.fileStatus === 'READY'
              ? 'Loading the image…'
              : evidence.fileFailureReason ?? 'This file is still being checked.'}
          </Notice>
        )}

        {/*
          The three timestamps, side by side and labelled with which the platform
          stands behind. §8's rule: they are not interchangeable, and a UI that
          renders them as one field with three names is exactly what makes a
          dispute unanswerable.
        */}
        <div className="cq-fieldset">
          <span className="cq-fieldset__legend">When</span>
          <dl className="cq-form-grid" aria-label="When this photograph was taken and received">
            <Provenance
              which="evidenceDate"
              value={evidence.evidenceDate ? formatDate(evidence.evidenceDate) : 'Not set'}
            />
            <Provenance
              which="capturedAt"
              value={
                evidence.capturedAt
                  ? new Date(evidence.capturedAt).toLocaleString()
                  : 'Not given'
              }
            />
            <Provenance
              which="createdAt"
              value={new Date(evidence.createdAt).toLocaleString()}
            />
          </dl>
        </div>

        {canEdit ? (
          <div className="cq-form-grid cq-form-grid--drawer">
            <Field label="Caption">
              <Input value={caption} onChange={(e) => setCaption(e.target.value)} />
            </Field>
            <Field label="Category">
              <Select
                value={category}
                onChange={(e) => setCategory(e.target.value as EvidenceCategory)}
              >
                {EVIDENCE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {EVIDENCE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Project day">
              <Input
                type="date"
                value={evidenceDate}
                onChange={(e) => setEvidenceDate(e.target.value)}
              />
            </Field>
            <Field label="Location">
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">No location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.active ? '' : ' (retired)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes" wide>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        ) : null}

        {evidence.firstPublishedAt ? (
          <Notice>
            {disclosureNotice({
              count: 1,
              clientVisible: evidence.clientVisible,
              everPublished: true,
            })}
          </Notice>
        ) : null}
        {!canPublish && isOwner ? (
          <Notice>Sharing with the client needs the <strong>evidence.publish</strong> permission.</Notice>
        ) : null}

        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}
