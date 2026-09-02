'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DIARY_FIELD_LABELS,
  DIARY_NARRATIVE_FIELDS,
  describeAmendments,
  narrativeFieldsFilled,
  type CloseDayPrompt,
  type DiaryEntryView,
  type DiaryNarrativeField,
  type DiaryPrefillResponse,
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
  Stack,
  Textarea,
} from '@crewquo/ui';
import { api, ApiError } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { formatDate } from '@/lib/format';

/**
 * The site diary (§23) — the day list, the editor and Close Day.
 *
 * Three things this screen exists to make true, and all three are the API's rules
 * rendered rather than re-decided:
 *
 *  - **A day is closed once and never reopened.** After that the same form is
 *    still there, and it demands a reason. The reason field is not a modal
 *    somebody can dismiss: it is the field between the edit and the Save button.
 *  - **"Amended N times" appears wherever the entry appears** — in the list, at
 *    the top of the editor, and beside the history. `describeAmendments` writes
 *    it, so the three cannot drift into three different sentences.
 *  - **Close Day prompts and never gates.** The prompts arrive with the entry;
 *    they are shown beside the button and the button still works. A close that
 *    refused until a photograph existed would teach somebody to photograph the
 *    floor twice.
 */
export function DiaryPanel({
  projectId,
  locations,
  canWrite,
  canClose,
  ownCompanyId,
  onCountChanged,
}: {
  projectId: string;
  locations: readonly LocationView[];
  canWrite: boolean;
  canClose: boolean;
  ownCompanyId: string;
  onCountChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [openId, setOpenId] = useState<string | null>(null);
  const [newDay, setNewDay] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useAsyncData(
    ctx ? () => api.listDiary(ctx.accessToken, ctx.companyId, projectId) : null,
    [ctx?.companyId, projectId]
  );
  const entries = useMemo(() => list.data?.entries ?? [], [list.data]);

  const refresh = useCallback(() => {
    list.reload();
    onCountChanged();
  }, [list, onCountChanged]);

  /**
   * Whether this project carries more than one company's diary.
   *
   * §2: a subcontractor's diary is its own record, not a draft of the hiring
   * company's. When both exist the list has to say whose each day is — and when
   * only one does, the attribution column is noise that repeats the same company
   * name down the page.
   */
  const multiCompany = new Set(entries.map((e) => e.companyId)).size > 1;

  return (
    <Section
      title="Site diary"
      description="What happened, day by day. A closed day can still be corrected — never quietly."
      actions={
        canWrite ? (
          <Button size="sm" onClick={() => setNewDay(true)}>
            Write up a day
          </Button>
        ) : null
      }
    >
      <Stack>
        <ErrorText>{error ?? list.error}</ErrorText>

        {list.loading ? (
          <p className="cq-muted">Loading the diary…</p>
        ) : entries.length === 0 ? (
          <EmptyState title="Nothing written up yet">
            {canWrite
              ? 'A day records who was on site, what was done, and what got in the way. Attendance is offered from the day’s timesheets so you confirm rather than retype.'
              : 'No days have been written up on this project.'}
          </EmptyState>
        ) : (
          <div className="cq-table-wrap" tabIndex={0} role="region" aria-label="Site diary">
            <table className="cq-table cq-table--compact" aria-label="Site diary">
              <thead>
                <tr>
                  <th>Day</th>
                  {multiCompany ? <th>Written by</th> : null}
                  <th>Hours</th>
                  <th className="cq-numeric">On site</th>
                  <th className="cq-numeric">Photos</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <button
                        type="button"
                        className="cq-link-button"
                        onClick={() => setOpenId(e.id)}
                      >
                        {formatDate(e.entryDate)}
                      </button>
                      {e.amendedTimes > 0 ? (
                        <span className="cq-table__note">{describeAmendments(e.amendedTimes)}</span>
                      ) : null}
                    </td>
                    {multiCompany ? (
                      <td>
                        {e.companyName ?? 'Unknown'}
                        {e.companyId === ownCompanyId ? (
                          <span className="cq-table__note">yours</span>
                        ) : null}
                      </td>
                    ) : null}
                    <td>
                      {e.startTime && e.finishTime ? `${e.startTime}–${e.finishTime}` : '—'}
                    </td>
                    <td className="cq-numeric">
                      {e.workersPresentCount + e.subcontractorsPresentCount || '—'}
                    </td>
                    <td className="cq-numeric">{e.evidenceCount || '—'}</td>
                    <td>
                      {e.status === 'CLOSED' ? (
                        <Badge tone="success">Closed</Badge>
                      ) : (
                        <Badge tone="warning">Open</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Stack>

      {newDay ? (
        <NewDayDrawer
          projectId={projectId}
          onClose={() => setNewDay(false)}
          onOpened={(id) => {
            setNewDay(false);
            setOpenId(id);
            refresh();
          }}
          onError={setError}
        />
      ) : null}

      {openId ? (
        <DayDrawer
          entryId={openId}
          projectId={projectId}
          locations={locations}
          canWrite={canWrite}
          canClose={canClose}
          ownCompanyId={ownCompanyId}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      ) : null}
    </Section>
  );
}

/**
 * Open a day, which is idempotent on the natural key.
 *
 * `POST` for a date that already has an entry returns that entry with a 200 —
 * §23's key is `(project, company, date)`, so "write up Tuesday" asked twice is
 * one Tuesday. This form therefore never has to check first, and two supervisors
 * tapping it at once get the same day rather than a conflict.
 */
function NewDayDrawer({
  projectId,
  onClose,
  onOpened,
  onError,
}: {
  projectId: string;
  onClose: () => void;
  onOpened: (id: string) => void;
  onError: (message: string | null) => void;
}) {
  const ctx = useSessionCtx();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const res = await api.openDiaryEntry(ctx.accessToken, ctx.companyId, projectId, {
        entryDate: date,
        clientId: crypto.randomUUID(),
      });
      onOpened(res.entry.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open that day');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      title="Write up a day"
      description="One entry per day. If you have already started this one, you will be taken back to it."
      onClose={onClose}
      footer={
        <Row>
          <Button disabled={busy} onClick={() => void open()}>
            {busy ? 'Opening…' : 'Open the day'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </Row>
      }
    >
      <Stack>
        <Field label="Which day">
          <Input type="date" value={date} autoFocus onChange={(e) => setDate(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
      </Stack>
    </Drawer>
  );
}

// ── One day ─────────────────────────────────────────────────────────────────────

type Narrative = Partial<Record<DiaryNarrativeField, string>>;

function narrativeOf(entry: DiaryEntryView): Narrative {
  const out: Narrative = {};
  for (const field of DIARY_NARRATIVE_FIELDS) out[field] = entry[field] ?? '';
  return out;
}

function DayDrawer({
  entryId,
  projectId,
  locations,
  canWrite,
  canClose,
  ownCompanyId,
  onClose,
  onChanged,
}: {
  entryId: string;
  projectId: string;
  locations: readonly LocationView[];
  canWrite: boolean;
  canClose: boolean;
  ownCompanyId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const day = useAsyncData(
    ctx ? () => api.getDiaryEntry(ctx.accessToken, ctx.companyId, entryId) : null,
    [ctx?.companyId, entryId]
  );

  const entry = day.data?.entry ?? null;
  const [draft, setDraft] = useState<Narrative>({});
  const [startTime, setStartTime] = useState('');
  const [finishTime, setFinishTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<
    { field: string; label: string; mine: string | null; theirs: string | null }[]
  >([]);
  const [showHistory, setShowHistory] = useState(false);

  /**
   * The version this edit was composed against, and what it looked like then.
   *
   * `base` is the client's half of §8's per-field merge: the server never stored
   * a snapshot of an open entry, so the only party that knows what the editor
   * started from is the editor. Captured when the entry loads, and **not** updated
   * as the person types — that is the whole point, since the base is what they
   * read, not what they have written since.
   */
  const [base, setBase] = useState<{ revision: number; narrative: Narrative } | null>(null);

  useEffect(() => {
    if (!entry) return;
    setDraft(narrativeOf(entry));
    setStartTime(entry.startTime ?? '');
    setFinishTime(entry.finishTime ?? '');
    setBase({ revision: entry.revision, narrative: narrativeOf(entry) });
    setConflicts([]);
  }, [entry]);

  const closed = entry?.status === 'CLOSED';
  const mine = entry?.companyId === ownCompanyId;
  const editable = canWrite && mine && (!closed || canClose);

  async function save() {
    if (!ctx || !entry || !base) return;
    setBusy(true);
    setError(null);
    setConflicts([]);
    try {
      const changed: Narrative = {};
      const changedBase: Narrative = {};
      for (const field of DIARY_NARRATIVE_FIELDS) {
        if ((draft[field] ?? '') === (base.narrative[field] ?? '')) continue;
        changed[field] = draft[field] ?? '';
        changedBase[field] = base.narrative[field] ?? '';
      }
      const body = {
        ...Object.fromEntries(
          Object.entries(changed).map(([k, v]) => [k, v.trim() === '' ? null : v])
        ),
        ...(startTime !== (entry.startTime ?? '') ? { startTime: startTime || null } : {}),
        ...(finishTime !== (entry.finishTime ?? '') ? { finishTime: finishTime || null } : {}),
        expectedRevision: base.revision,
        // Only for an open day: an amendment is not merged, it is a recorded
        // change to a frozen record and the reason is what makes it one.
        ...(closed
          ? { reason: reason.trim() }
          : {
              base: Object.fromEntries(
                Object.entries(changedBase).map(([k, v]) => [k, v === '' ? null : v])
              ),
            }),
      };
      await api.updateDiaryEntry(ctx.accessToken, ctx.companyId, entry.id, body);
      setReason('');
      day.reload();
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { reason?: string; conflicts?: typeof conflicts } | undefined;
        if (details?.reason === 'FIELD_CONFLICT' && details.conflicts) {
          // Nothing was written — the API refuses the whole patch when any field
          // collides, so the draft below is still exactly what this person typed.
          setConflicts(details.conflicts);
          setError(err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not save that change');
      }
    } finally {
      setBusy(false);
    }
  }

  async function closeDay() {
    if (!ctx || !entry) return;
    setBusy(true);
    setError(null);
    try {
      await api.closeDiaryEntry(ctx.accessToken, ctx.companyId, entry.id, {
        startTime: startTime || null,
        finishTime: finishTime || null,
        expectedRevision: entry.revision,
        clientId: crypto.randomUUID(),
      });
      day.reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not close the day');
    } finally {
      setBusy(false);
    }
  }

  const prompts: CloseDayPrompt[] = day.data?.closePrompts ?? [];
  const amended = entry ? describeAmendments(entry.amendedTimes) : null;

  return (
    <Drawer
      open
      title={entry ? formatDate(entry.entryDate) : 'Loading…'}
      description={
        entry
          ? [
              entry.companyName,
              entry.status === 'CLOSED'
                ? `Closed${entry.closedByName ? ` by ${entry.closedByName}` : ''}`
                : 'Open',
              amended,
            ]
              .filter(Boolean)
              .join(' · ')
          : undefined
      }
      onClose={onClose}
      footer={
        <Row between>
          <Row>
            {editable ? (
              <Button disabled={busy || (closed && reason.trim() === '')} onClick={() => void save()}>
                {busy ? 'Saving…' : closed ? 'Save amendment' : 'Save'}
              </Button>
            ) : null}
            {/*
              "Done", not "Close panel": the Drawer's header already owns that
              accessible name, and two controls sharing one inside a dialog is
              ambiguous to a screen reader exactly as it is to a test — which is how
              this was found.
            */}
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
          </Row>
          {entry && !closed && canClose && mine ? (
            <Button variant="secondary" disabled={busy} onClick={() => void closeDay()}>
              Close the day
            </Button>
          ) : null}
        </Row>
      }
    >
      {day.loading || !entry ? (
        <p className="cq-muted">Loading…</p>
      ) : (
        <Stack>
          {closed ? (
            <Notice>
              <strong>This day is closed.</strong> It can still be corrected, and every
              correction is recorded with a reason and shown wherever the entry appears. There
              is no way to reopen it — a recorded change is a more honest object than a day
              that stopped being closed.
            </Notice>
          ) : null}

          {!mine ? (
            <Notice>
              {entry.companyName ?? 'Another company'} wrote this day. Their diary is theirs to
              correct — you are reading it, not editing it.
            </Notice>
          ) : null}

          {conflicts.length > 0 ? (
            <Notice>
              <strong>Somebody else wrote in the same part of this day.</strong> Nothing was
              saved, so what you typed is still here. Keep yours or theirs:
              <ul>
                {conflicts.map((c) => (
                  <li key={c.field}>
                    <strong>{c.label}</strong> — theirs: “{c.theirs ?? 'empty'}”
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setDraft((prev) => ({
                          ...prev,
                          [c.field as DiaryNarrativeField]: c.theirs ?? '',
                        }));
                        setBase((prev) =>
                          prev
                            ? {
                                ...prev,
                                narrative: {
                                  ...prev.narrative,
                                  [c.field as DiaryNarrativeField]: c.theirs ?? '',
                                },
                              }
                            : prev
                        );
                        setConflicts((prev) => prev.filter((x) => x.field !== c.field));
                      }}
                    >
                      Take theirs
                    </Button>
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}

          <div className="cq-form-grid cq-form-grid--drawer">
            <Field label="Started">
              <Input
                type="time"
                value={startTime}
                disabled={!editable}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </Field>
            <Field label="Finished">
              <Input
                type="time"
                value={finishTime}
                disabled={!editable}
                onChange={(e) => setFinishTime(e.target.value)}
              />
            </Field>
          </div>

          <AttendancePanel
            entry={entry}
            projectId={projectId}
            editable={editable}
            closed={closed}
            onChanged={() => {
              day.reload();
              onChanged();
            }}
          />

          <div className="cq-fieldset">
            <span className="cq-fieldset__legend">What happened</span>
            <p className="cq-fieldset__hint">
              {narrativeFieldsFilled(entry)} of {DIARY_NARRATIVE_FIELDS.length} filled in. Leave
              what does not apply empty — a blank field is not a gap.
            </p>
            <div className="cq-diary-grid">
              {DIARY_NARRATIVE_FIELDS.map((field) => (
                <Field key={field} label={DIARY_FIELD_LABELS[field]} wide={field === 'workCompleted'}>
                  <Textarea
                    value={draft[field] ?? ''}
                    disabled={!editable}
                    rows={field === 'workCompleted' ? 4 : 2}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </div>

          {closed && editable ? (
            <Field
              label="Why is this changing?"
              hint="Required. It is shown to the hiring company and kept with the change."
            >
              <Textarea
                value={reason}
                placeholder="Delivery note arrived the next morning"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          ) : null}

          {!closed && prompts.length > 0 ? (
            <Notice>
              <strong>Before you close the day:</strong>
              <ul>
                {prompts.map((p) => (
                  <li key={p.code}>{p.message}</li>
                ))}
              </ul>
              You can close it anyway — this is a check, not a gate.
            </Notice>
          ) : null}

          {entry.amendedTimes > 0 ? (
            <Row between>
              <span className="cq-muted">{amended}</span>
              <Button size="sm" variant="secondary" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? 'Hide history' : 'View history'}
              </Button>
            </Row>
          ) : null}

          {showHistory ? <History entryId={entry.id} /> : null}

          {locations.length > 0 ? (
            <p className="cq-muted">
              Areas:{' '}
              {entry.locationIds.length === 0
                ? 'none set'
                : entry.locationIds
                    .map((id) => locations.find((l) => l.id === id)?.name ?? 'Unknown')
                    .join(', ')}
            </p>
          ) : null}

          <ErrorText>{error}</ErrorText>
        </Stack>
      )}
    </Drawer>
  );
}

/**
 * Who was on site, and the prefill that offers it from the timesheets.
 *
 * §23's rule is that the supervisor **confirms rather than retypes**, and that is
 * the whole value: a diary that filled itself in from the timesheets would agree
 * with them by construction and prove nothing. So the suggestions are a list with
 * a button each, and one already on the day is marked rather than hidden — a list
 * that shrank as it was confirmed would leave nothing to say what it decided not
 * to show.
 */
function AttendancePanel({
  entry,
  projectId,
  editable,
  closed,
  onChanged,
}: {
  entry: DiaryEntryView;
  projectId: string;
  editable: boolean;
  closed: boolean;
  onChanged: () => void;
}) {
  const ctx = useSessionCtx();
  const [prefill, setPrefill] = useState<DiaryPrefillResponse | null>(null);
  const [name, setName] = useState('');
  const [headcount, setHeadcount] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ctx || !editable) return;
    let cancelled = false;
    api
      .diaryPrefill(ctx.accessToken, ctx.companyId, projectId, entry.entryDate)
      .then((res) => {
        if (!cancelled) setPrefill(res);
      })
      .catch(() => {
        if (!cancelled) setPrefill(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, projectId, entry.entryDate, entry.attendance.length, editable]);

  async function confirm(suggestion: DiaryPrefillResponse['attendance'][number]) {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.addDiaryAttendance(ctx.accessToken, ctx.companyId, entry.id, {
        userId: suggestion.userId,
        providerCompanyId: suggestion.providerCompanyId,
        roleId: suggestion.roleId,
        headcount: suggestion.headcount,
        hours: suggestion.hours,
        timeLogId: suggestion.timeLogId,
        ...(closed ? { reason: reason.trim() } : {}),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that person');
    } finally {
      setBusy(false);
    }
  }

  async function addByName() {
    if (!ctx || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addDiaryAttendance(ctx.accessToken, ctx.companyId, entry.id, {
        name: name.trim(),
        headcount: Number(headcount) || 1,
        ...(closed ? { reason: reason.trim() } : {}),
      });
      setName('');
      setHeadcount('1');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that crew');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeDiaryAttendance(
        ctx.accessToken,
        ctx.companyId,
        entry.id,
        id,
        closed ? reason.trim() : undefined
      );
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that line');
    } finally {
      setBusy(false);
    }
  }

  const unconfirmed = (prefill?.attendance ?? []).filter((s) => !s.alreadyPresent);

  return (
    <div className="cq-fieldset">
      <span className="cq-fieldset__legend">Who was on site</span>
      <p className="cq-fieldset__hint">
        {entry.workersPresentCount} of your own
        {entry.subcontractorsPresentCount > 0
          ? `, ${entry.subcontractorsPresentCount} subcontracted`
          : ''}
        . Counted from the lines below, never typed as a total.
      </p>

      {entry.attendance.length > 0 ? (
        <ul className="cq-object-list">
          {entry.attendance.map((a) => (
            <li className="cq-object-list__item" key={a.id}>
              <span>
                <span className="cq-object-list__title">{a.name ?? 'Unnamed'}</span>
                <span className="cq-object-list__meta">
                  {a.roleName ? `${a.roleName} · ` : ''}
                  {a.headcount === 1 ? '1 person' : `${a.headcount} people`}
                  {a.hours !== null ? ` · ${a.hours}h` : ''}
                  {a.timeLogId ? ' · from a timesheet' : ''}
                </span>
              </span>
              {editable && (!closed || reason.trim() !== '') ? (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove(a.id)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="cq-muted">Nobody recorded yet.</p>
      )}

      {editable && unconfirmed.length > 0 ? (
        <Stack>
          <p className="cq-muted">
            From today’s timesheets — confirm rather than retype. Drafts are not offered.
          </p>
          <ul className="cq-object-list">
            {unconfirmed.map((s) => (
              <li className="cq-object-list__item" key={s.timeLogId ?? s.userId ?? s.name}>
                <span>
                  <span className="cq-object-list__title">{s.name ?? 'A crew'}</span>
                  <span className="cq-object-list__meta">
                    {s.roleName ? `${s.roleName} · ` : ''}
                    {s.hours !== null ? `${s.hours}h` : 'hours not given'}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || (closed && reason.trim() === '')}
                  onClick={() => void confirm(s)}
                >
                  Confirm
                </Button>
              </li>
            ))}
          </ul>
        </Stack>
      ) : null}

      {prefill && prefill.unsubmittedTimeLogs > 0 ? (
        <p className="cq-muted">
          {prefill.unsubmittedTimeLogs}{' '}
          {prefill.unsubmittedTimeLogs === 1 ? 'timesheet is' : 'timesheets are'} still a draft
          for this day. Drafts are somebody’s unfinished intention, so they are not offered as
          attendance.
        </p>
      ) : null}

      {editable ? (
        <Row>
          <Field label="Add by name">
            <Input
              value={name}
              placeholder="Agency labourer"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="How many">
            <Input
              type="number"
              min="1"
              value={headcount}
              onChange={(e) => setHeadcount(e.target.value)}
            />
          </Field>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !name.trim() || (closed && reason.trim() === '')}
            onClick={() => void addByName()}
          >
            Add
          </Button>
        </Row>
      ) : null}

      {editable && closed ? (
        <Field
          label="Reason for changing a closed day"
          hint="Attendance on a closed day is an amendment like any other."
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}

      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** §36's before/after trail: what changed, who changed it, and why. */
function History({ entryId }: { entryId: string }) {
  const ctx = useSessionCtx();
  const history = useAsyncData(
    ctx ? () => api.diaryHistory(ctx.accessToken, ctx.companyId, entryId) : null,
    [ctx?.companyId, entryId]
  );

  if (history.loading) return <p className="cq-muted">Loading history…</p>;
  const rows = history.data?.revisions ?? [];
  if (rows.length === 0) return <p className="cq-muted">No amendments recorded.</p>;

  return (
    <ul className="cq-object-list">
      {rows.map((r) => (
        <li className="cq-object-list__item" key={r.revision}>
          <span>
            <span className="cq-object-list__title">
              {r.changedFields
                .map((f) => DIARY_FIELD_LABELS[f as DiaryNarrativeField] ?? f)
                .join(', ') || 'No visible change'}
            </span>
            <span className="cq-object-list__meta">
              {r.reason ?? 'No reason given'} — {r.changedByName ?? 'a withdrawn person'},{' '}
              {new Date(r.changedAt).toLocaleString()}
            </span>
          </span>
          <Badge>#{r.revision}</Badge>
        </li>
      ))}
    </ul>
  );
}
