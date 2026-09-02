'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_LABELS,
  describeExpiry,
  expiryThreshold,
  refuseDocumentDates,
  type DocumentCategory,
  type DocumentView,
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
import { uploadFile } from '@/lib/upload';
import { useFileReadiness, type Readiness } from '@/lib/useFileReadiness';
import { formatDate } from '@/lib/format';

/**
 * Project documents (§24) — the manager, the version chain and the expiry ladder.
 *
 * **A document is a chain, not an edit.** The one interaction rule this screen has
 * to get right: correcting a title is an edit and new bytes are a *new version*,
 * and there is no control anywhere here that replaces a document's file in place.
 * The API has no route for it and `updateDocumentSchema` is strict, so adding one
 * would be a deliberate act at both ends — this file is the end where somebody
 * would reach for it first, because a "replace file" button looks symmetrical
 * with "edit details".
 *
 * The expiry ladder is the API's (90/60/30/14/7/0, in the project owner's own
 * zone) and so is the wording. `describeExpiry` produces "Insurance expires in 30
 * days" from the category and a number, never from the title — §11 excludes
 * document titles and references from every payload, and a screen that composed
 * its own sentence would be the place that quietly reintroduced them.
 */
export function DocumentsPanel({
  projectId,
  locations,
  canUpload,
  canManage,
  isOwner,
  onCountChanged,
}: {
  projectId: string;
  locations: readonly LocationView[];
  canUpload: boolean;
  canManage: boolean;
  isOwner: boolean;
  onCountChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [category, setCategory] = useState<string>('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [expiringOnly, setExpiringOnly] = useState(false);
  const [upload, setUpload] = useState<{ fileId: string; name: string } | null>(null);
  const [reissue, setReissue] = useState<{ document: DocumentView; fileId: string } | null>(
    null
  );
  const [detail, setDetail] = useState<DocumentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useAsyncData(
    ctx
      ? () =>
          api.listDocuments(ctx.accessToken, ctx.companyId, projectId, {
            category: (category || undefined) as DocumentCategory | undefined,
            includeSuperseded,
            expiringWithinDays: expiringOnly ? 90 : undefined,
          })
      : null,
    [ctx?.companyId, projectId, category, includeSuperseded, expiringOnly]
  );

  // Memoised because the expiry summary below derives from it: a fresh `[]` on
  // every render would re-run that loop on every keystroke in the filter above it.
  const documents = useMemo(() => list.data?.documents ?? [], [list.data]);
  const refresh = useCallback(() => {
    list.reload();
    onCountChanged();
  }, [list, onCountChanged]);

  /**
   * What the compliance strip says, and it counts the same rows the ladder warns
   * about: live, current documents inside the widest rung. Expired ones are
   * included and counted separately — they are the urgent case, and a summary that
   * folded them into "expiring" would go quiet exactly when something has lapsed.
   */
  const expiry = useMemo(() => {
    let soon = 0;
    let lapsed = 0;
    for (const d of documents) {
      if (d.daysUntilExpiry === null) continue;
      if (d.daysUntilExpiry < 0) lapsed += 1;
      else if (expiryThreshold(d.daysUntilExpiry) !== null) soon += 1;
    }
    return { soon, lapsed };
  }, [documents]);

  return (
    <Section
      title="Documents"
      description="RAMS, insurance, waste transfer notes, drawings. A new set of bytes is a new version, never an edit."
      actions={
        canUpload ? (
          <FilePicker
            projectId={projectId}
            label="Add document"
            accessibleName="Choose a document to file"
            onUploaded={(fileId, name) => setUpload({ fileId, name })}
            onError={setError}
          />
        ) : null
      }
    >
      <Stack>
        {expiry.lapsed > 0 || expiry.soon > 0 ? (
          <Notice>
            {expiry.lapsed > 0 ? (
              <>
                <strong>
                  {expiry.lapsed} {expiry.lapsed === 1 ? 'document has' : 'documents have'} lapsed.
                </strong>{' '}
              </>
            ) : null}
            {expiry.soon > 0
              ? `${expiry.soon} more ${expiry.soon === 1 ? 'is' : 'are'} approaching expiry. Upload a new version to replace one — the current copy stays in its history.`
              : 'Upload a new version to replace it — the current copy stays in its history.'}
          </Notice>
        ) : null}

        <div className="cq-form-grid">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DOCUMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show">
            <Select
              value={expiringOnly ? 'expiring' : 'all'}
              onChange={(e) => setExpiringOnly(e.target.value === 'expiring')}
            >
              <option value="all">Everything current</option>
              <option value="expiring">Expiring or expired</option>
            </Select>
          </Field>
          <Field label="History">
            <Select
              value={includeSuperseded ? 'all' : 'current'}
              onChange={(e) => setIncludeSuperseded(e.target.value === 'all')}
            >
              <option value="current">Current versions only</option>
              <option value="all">Include superseded versions</option>
            </Select>
          </Field>
        </div>

        <ErrorText>{error ?? list.error}</ErrorText>

        {list.loading ? (
          <p className="cq-muted">Loading documents…</p>
        ) : documents.length === 0 ? (
          <EmptyState title="No documents filed">
            {canUpload
              ? 'File the site RAMS, a subcontractor’s insurance, or a waste transfer note. Anything with an expiry date is watched and you are told before it lapses.'
              : 'Nothing has been filed on this project yet.'}
          </EmptyState>
        ) : (
          <div className="cq-table-wrap" tabIndex={0} role="region" aria-label="Documents">
            <table className="cq-table cq-table--compact" aria-label="Documents">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Category</th>
                  <th>Version</th>
                  <th>Expires</th>
                  <th>Shared</th>
                  <th className="cq-table__actions" />
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button type="button" className="cq-link-button" onClick={() => setDetail(d)}>
                        {d.title}
                      </button>
                      {d.reference ? <span className="cq-table__note">{d.reference}</span> : null}
                    </td>
                    <td>{DOCUMENT_CATEGORY_LABELS[d.category]}</td>
                    <td>
                      v{d.version}
                      {d.supersededById ? <Badge tone="warning">Superseded</Badge> : null}
                    </td>
                    <td>
                      <ExpiryCell document={d} />
                    </td>
                    <td>{d.clientVisible ? <Badge tone="accent">Shared</Badge> : '—'}</td>
                    <td className="cq-table__actions">
                      {canUpload && !d.supersededById ? (
                        <FilePicker
                          projectId={projectId}
                          label="Re-issue"
                          accessibleName={`Re-issue ${d.title} with a new file`}
                          small
                          onUploaded={(fileId) => setReissue({ document: d, fileId })}
                          onError={setError}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Stack>

      {upload ? (
        <FileDocumentDrawer
          projectId={projectId}
          fileId={upload.fileId}
          filename={upload.name}
          locations={locations}
          isOwner={isOwner}
          onClose={() => setUpload(null)}
          onSaved={() => {
            setUpload(null);
            refresh();
          }}
        />
      ) : null}

      {reissue ? (
        <ReissueDrawer
          document={reissue.document}
          fileId={reissue.fileId}
          onClose={() => setReissue(null)}
          onSaved={() => {
            setReissue(null);
            refresh();
          }}
        />
      ) : null}

      {detail ? (
        <DocumentDrawer
          document={detail}
          locations={locations}
          canManage={canManage || canUpload}
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

/**
 * How long a document has, and it says it three different ways on purpose.
 *
 * "Expired 2 days ago" is a different state from "expires in 7 days", which is a
 * different state from a date with no urgency at all — and a screen that rendered
 * all three as a date leaves the reader to do the arithmetic that decides whether
 * somebody is on site under a lapsed method statement. `describeExpiry` writes
 * the sentence; the tone is the only thing decided here.
 */
function ExpiryCell({ document }: { document: DocumentView }) {
  if (document.expiresOn === null) return <span className="cq-muted">—</span>;
  const days = document.daysUntilExpiry;
  if (days === null) return <>{formatDate(document.expiresOn)}</>;
  const rung = expiryThreshold(days);
  const text = describeExpiry({ category: document.category, daysRemaining: days });
  if (days < 0) return <Badge tone="danger">{text}</Badge>;
  if (rung !== null && rung <= 30) return <Badge tone="warning">{text}</Badge>;
  return (
    <span>
      {formatDate(document.expiresOn)}
      {rung !== null ? <span className="cq-table__note">{text}</span> : null}
    </span>
  );
}

/**
 * Choose a file, upload it, and hand back the id.
 *
 * One file at a time, unlike evidence, and that asymmetry is the API's: a document
 * must be `READY` before it can be filed, because a compliance record pointing at
 * bytes that turned out to be an executable is worse than a missing one. Forty
 * photographs are tagged in a stairwell; a document is uploaded by somebody
 * watching the screen.
 */
function FilePicker({
  projectId,
  label,
  accessibleName,
  small,
  onUploaded,
  onError,
}: {
  projectId: string;
  label: string;
  /**
   * The control's name for anybody not reading the row it sits in.
   *
   * "Re-issue" is unambiguous beside the RAMS it belongs to and useless in a list
   * of nine documents read one control at a time — which is what a screen reader
   * user tabbing a table gets. Passed rather than derived, because only the caller
   * knows which document this row is.
   */
  accessibleName: string;
  small?: boolean;
  onUploaded: (fileId: string, name: string) => void;
  onError: (message: string | null) => void;
}) {
  const ctx = useSessionCtx();
  const [busy, setBusy] = useState(false);

  return (
    <label className={small ? 'cq-btn cq-btn--secondary cq-btn--sm' : 'cq-btn cq-btn--secondary'}>
      {busy ? 'Uploading…' : label}
      <input
        type="file"
        aria-label={accessibleName}
        className="cq-vh"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file || !ctx) return;
          setBusy(true);
          onError(null);
          try {
            const up = await uploadFile(
              { accessToken: ctx.accessToken, companyId: ctx.companyId },
              file,
              { kind: 'DOCUMENT', projectId }
            );
            onUploaded(up.fileId, file.name);
          } catch (err) {
            onError(err instanceof ApiError ? err.message : 'That file could not be uploaded');
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

/**
 * What the form says while the worker is looking at the file.
 *
 * A live region, because it appears without focus moving and it is the reason the
 * submit button is disabled — a disabled control with no announced explanation is
 * a dead end for anybody not watching that corner of the screen.
 */
function ScanState({ readiness }: { readiness: Readiness }) {
  if (readiness.state === 'READY') return null;
  return (
    <Notice live>
      {readiness.state === 'CHECKING'
        ? 'Checking this file before it is filed. A document has to be what it says it is — this usually takes a moment.'
        : readiness.state === 'FAILED'
          ? readiness.reason
          : 'This file is still being checked. Nothing is lost — close this and file it again in a few minutes.'}
    </Notice>
  );
}

function FileDocumentDrawer({
  projectId,
  fileId,
  filename,
  locations,
  isOwner,
  onClose,
  onSaved,
}: {
  projectId: string;
  fileId: string;
  filename: string;
  locations: readonly LocationView[];
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ctx = useSessionCtx();
  const [category, setCategory] = useState<DocumentCategory>('RAMS');
  const [title, setTitle] = useState(filename.replace(/\.[^.]+$/, ''));
  const [reference, setReference] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [locationId, setLocationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * A document must be scanned before it can be filed (§22.1), so the form waits
   * rather than refusing. The first version submitted straight away and answered
   * *"that upload is still being checked, try again in a moment"* — leaving somebody
   * holding a filled-in form and a guess about when the moment was.
   */
  const readiness = useFileReadiness(fileId);

  // The same check the API runs and the database constrains. Here as well because
  // an inverted pair is a typo, and telling somebody before they submit is cheaper
  // than a 422 that clears nothing.
  const dateProblem = refuseDocumentDates({
    issuedOn: issuedOn || null,
    expiresOn: expiresOn || null,
  });

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.createDocument(ctx.accessToken, ctx.companyId, projectId, {
        fileId,
        category,
        title: title.trim(),
        reference: reference.trim() || null,
        issuedOn: issuedOn || null,
        expiresOn: expiresOn || null,
        locationId: locationId || null,
        clientId: crypto.randomUUID(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not file that document');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title="File a document"
      description={filename}
      onClose={onClose}
      footer={
        <Row>
          <Button
            disabled={
              busy || !title.trim() || dateProblem !== null || readiness.state !== 'READY'
            }
            onClick={() => void save()}
          >
            {busy ? 'Filing…' : 'File document'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <ScanState readiness={readiness} />
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Category">
            <Select
              value={category}
              onChange={(e) => setCategory(e.target.value as DocumentCategory)}
            >
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {DOCUMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Reference" hint="A WTN number, a PO number, a ticket number.">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Issued on">
            <Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
          </Field>
          <Field
            label="Expires on"
            hint="Set this and you are warned at 90, 60, 30, 14 and 7 days, and on the day itself."
          >
            <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          </Field>
          <Field label="Location">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Whole project</option>
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

        {!isOwner ? (
          <Notice>
            This will be filed against your own company. A subcontractor’s paperwork is not
            the other trades’ business, so it is readable by you and by the project’s owner.
          </Notice>
        ) : null}

        <ErrorText>{dateProblem ?? error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

/**
 * A new version. Metadata is inherited where this form leaves it alone.
 *
 * `client_visible` is the one field that is **not** inherited, and the drawer says
 * so: new bytes republished automatically because the last version happened to be
 * shared would disclose a document nobody has looked at.
 */
function ReissueDrawer({
  document,
  fileId,
  onClose,
  onSaved,
}: {
  /** The version being replaced. */
  document: DocumentView;
  /** The bytes replacing it, already uploaded and scanned. */
  fileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ctx = useSessionCtx();
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readiness = useFileReadiness(fileId);

  const dateProblem = refuseDocumentDates({
    issuedOn: issuedOn || null,
    expiresOn: expiresOn || null,
  });

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.supersedeDocument(ctx.accessToken, ctx.companyId, document.id, {
        /*
         * Two ids, kept as two props rather than one merged record. The first draft
         * spread the new `fileId` over the old document — which type-checks, reads as
         * symmetrical, and makes the one distinction this whole feature exists for
         * (which bytes, which record) invisible at the call site.
         */
        fileId,
        ...(issuedOn ? { issuedOn } : {}),
        ...(expiresOn ? { expiresOn } : {}),
        clientId: crypto.randomUUID(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not re-issue that document');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title={`Re-issue ${DOCUMENT_CATEGORY_LABELS[document.category]}`}
      description={`This becomes v${document.version + 1}. The current version is kept in its history.`}
      onClose={onClose}
      footer={
        <Row>
          <Button
            disabled={busy || dateProblem !== null || readiness.state !== 'READY'}
            onClick={() => void save()}
          >
            {busy ? 'Re-issuing…' : `Create v${document.version + 1}`}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <ScanState readiness={readiness} />
        <p className="cq-muted">
          The category, title, reference and location carry forward. Set new dates if this
          version has them.
        </p>
        <div className="cq-form-grid cq-form-grid--drawer">
          <Field label="Issued on">
            <Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
          </Field>
          <Field label="Expires on">
            <Input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
          </Field>
        </div>
        {document.clientVisible ? (
          <Notice>
            The current version is shared with the client. <strong>This one will not be.</strong>{' '}
            Re-share it deliberately once you have looked at it.
          </Notice>
        ) : null}
        <ErrorText>{dateProblem ?? error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

function DocumentDrawer({
  document,
  locations,
  canManage,
  isOwner,
  onClose,
  onChanged,
}: {
  document: DocumentView;
  locations: readonly LocationView[];
  canManage: boolean;
  isOwner: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [title, setTitle] = useState(document.title);
  const [reference, setReference] = useState(document.reference ?? '');
  const [notes, setNotes] = useState(document.notes ?? '');
  const [locationId, setLocationId] = useState(document.locationId ?? '');
  const [clientVisible, setClientVisible] = useState(document.clientVisible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versions = useAsyncData(
    ctx ? () => api.documentVersions(ctx.accessToken, ctx.companyId, document.id) : null,
    [ctx?.companyId, document.id]
  );

  async function save() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateDocument(ctx.accessToken, ctx.companyId, document.id, {
        title: title.trim(),
        reference: reference.trim() || null,
        notes: notes.trim() || null,
        locationId: locationId || null,
        ...(isOwner ? { clientVisible } : {}),
        expectedRevision: document.revision,
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
      await api.deleteDocument(ctx.accessToken, ctx.companyId, document.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that document');
    } finally {
      setBusy(false);
    }
  }

  async function openFile() {
    if (!ctx) return;
    setError(null);
    try {
      const { url } = await api.fileDownloadUrl(ctx.accessToken, ctx.companyId, document.fileId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that file');
    }
  }

  return (
    <Drawer
      open
      title={document.title}
      description={`${DOCUMENT_CATEGORY_LABELS[document.category]} · v${document.version}`}
      onClose={onClose}
      footer={
        <Row between>
          <Row>
            {canManage ? (
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => void openFile()}>
              Open file
            </Button>
          </Row>
          {canManage ? (
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </Row>
      }
    >
      <Stack>
        {canManage ? (
          <div className="cq-form-grid cq-form-grid--drawer">
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="Reference">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
            <Field label="Location">
              <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">Whole project</option>
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

        {/*
          There is no "replace file" control, and its absence is the design rather
          than an omission. A document whose bytes can be swapped in place is a
          document whose history is a claim rather than a record — and a waste
          transfer note is exactly the document somebody is later asked to prove.
        */}
        <Notice>
          New bytes are a <strong>new version</strong>, never a replacement. Re-issue from the
          list to keep this copy in its history.
        </Notice>

        {isOwner ? (
          <label className="cq-row">
            <input
              type="checkbox"
              checked={clientVisible}
              onChange={(e) => setClientVisible(e.target.checked)}
            />
            <span>Share this version with the client</span>
          </label>
        ) : null}

        <div className="cq-fieldset">
          <span className="cq-fieldset__legend">History</span>
          {versions.loading ? (
            <p className="cq-muted">Loading versions…</p>
          ) : (
            <ul className="cq-object-list">
              {(versions.data?.versions ?? []).map((v) => (
                <li className="cq-object-list__item" key={v.id}>
                  <span>
                    <span className="cq-object-list__title">
                      v{v.version}
                      {v.id === document.id ? ' — you are looking at this one' : ''}
                    </span>
                    <span className="cq-object-list__meta">
                      Filed {formatDate(v.createdAt.slice(0, 10))}
                      {v.expiresOn ? ` · expires ${formatDate(v.expiresOn)}` : ''}
                      {v.deletedAt ? ' · retracted' : ''}
                    </span>
                  </span>
                  {v.supersededById ? <Badge tone="warning">Superseded</Badge> : <Badge tone="success">Current</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}
