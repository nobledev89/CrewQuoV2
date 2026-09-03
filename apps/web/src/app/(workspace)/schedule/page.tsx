'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  SCHEDULE_VIEWS,
  scheduleWindow,
  type AvailabilityWindow,
  type ScheduleAssignmentView,
  type ScheduleConflict,
  type ScheduleView,
  type VehicleView,
} from '@crewquo/shared';
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Notice,
  PageHeader,
  Row,
  Section,
  Select,
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useCapabilities } from '@/lib/useCapabilities';
import { useAsyncData } from '@/lib/useAsyncData';
import { FeatureLocked } from '@/components/FeatureLock';
import { FEATURE_KEYS, type FeatureKey } from '@crewquo/shared';
import { formatDateTime, titleCase } from '@/lib/format';

/**
 * The week planner (§31) — the one screen in the product with drag-and-drop.
 *
 * §31: *"Drag-and-drop on web where it is genuinely faster than a form; mobile is
 * read-plus-confirm, not drag."* This is that one place: Priya moves a booking from
 * Tuesday to Wednesday by dragging it, because the alternative is opening a form to
 * change one date.
 *
 * ── SC 2.5.7, AND WHY THE EQUIVALENT IS A REAL CONTROL ─────────────────────
 *
 * WCAG 2.2 requires every dragging movement to have a single-pointer alternative
 * that reaches the same outcome, and §42 requires it to be operable by keyboard.
 * `keyboard.spec.ts` enforces that with a source scan and a registry, and it was
 * shipped deliberately empty two phases early so this screen could not arrive
 * without one.
 *
 * The equivalent here is **a day `<select>` on every row**, focusable, in the tab
 * order, and changing it performs exactly the move a drag performs — same call,
 * same warnings. Not a "move" button that opens the drawer: an alternative that
 * takes more steps than the drag is an alternative somebody has to be told about.
 *
 * ── AND A CLASH IS STILL NEVER A REFUSAL ───────────────────────────────────
 *
 * A drop that creates a double-booking **saves**, and the warning renders beside
 * the row. Reverting the drag would be the schedule refusing a plan on grounds it
 * cannot judge: the other job might finish at noon.
 */

const DAY_MS = 86_400_000;

function daysOf(window: { fromDate: string; toDate: string }): string[] {
  const out: string[] = [];
  const start = Date.parse(`${window.fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${window.toDate}T00:00:00.000Z`);
  for (let t = start; t < end && out.length < 42; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** The resource a row is about, as one label. */
function resourceOf(assignment: ScheduleAssignmentView): string {
  return (
    assignment.userName ??
    assignment.providerCompanyName ??
    (assignment.vehicleRegistration
      ? `${assignment.vehicleName ?? 'Vehicle'} (${assignment.vehicleRegistration})`
      : assignment.vehicleName) ??
    titleCase(assignment.resourceType)
  );
}

export default function SchedulePage() {
  return (
    <Shell>
      <Planner />
    </Shell>
  );
}

interface PlannerData {
  window: { fromDate: string; toDate: string };
  assignments: ScheduleAssignmentView[];
  vehicles: VehicleView[];
  availability: AvailabilityWindow[];
}

function Planner() {
  const ctx = useSessionCtx();
  const caps = useCapabilities();
  const [view, setView] = useState<ScheduleView>('WEEK');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<ScheduleConflict[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);

  const schedule = useAsyncData<PlannerData>(
    ctx ? () => api.companySchedule(ctx.accessToken, ctx.companyId, { view, date }) : null,
    [ctx?.companyId, view, date, nonce]
  );

  const locked = refusedFeature(schedule.error);
  if (locked !== null && (FEATURE_KEYS as readonly string[]).includes(locked)) {
    return (
      <Stack>
        <PageHeader eyebrow="Operations" title="Schedule" />
        <FeatureLocked feature={locked as FeatureKey} />
      </Stack>
    );
  }

  /**
   * Move one booking to a different day, keeping its time of day.
   *
   * **The one function both the drag and the keyboard path call.** Two
   * implementations of one outcome is how an "equivalent" quietly stops being one:
   * the drag gets a fix and the select does not, and nothing fails.
   */
  const moveTo = async (assignment: ScheduleAssignmentView, day: string) => {
    if (!ctx) return;
    const from = new Date(assignment.startsAt);
    const to = new Date(assignment.endsAt);
    const shift = Date.parse(`${day}T00:00:00.000Z`) -
      Date.parse(`${assignment.startsAt.slice(0, 10)}T00:00:00.000Z`);
    if (shift === 0) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api.updateAssignment(ctx.accessToken, ctx.companyId, assignment.id, {
        startsAt: new Date(from.getTime() + shift).toISOString(),
        endsAt: new Date(to.getTime() + shift).toISOString(),
      });
      // Saved, then warned — never the other way round.
      setWarnings(result.warnings.flatMap((w) => w.conflicts));
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move that booking');
    } finally {
      setBusy(false);
      setDragging(null);
    }
  };

  const data = schedule.data;
  const days = data ? daysOf(data.window) : [];
  const canManage = caps.can('schedule.manage');

  // Resource rows down, time across (§31).
  const byResource = new Map<string, ScheduleAssignmentView[]>();
  for (const assignment of data?.assignments ?? []) {
    const key = resourceOf(assignment);
    const list = byResource.get(key) ?? [];
    list.push(assignment);
    byResource.set(key, list);
  }

  return (
    <Stack>
      <PageHeader
        eyebrow="Operations"
        title="Schedule"
        description="Your people, your subcontractors' crews and your vehicles, across every project you own."
        actions={
          <Row>
            <Select
              value={view}
              aria-label="Day, week or month"
              onChange={(e) => setView(e.target.value as ScheduleView)}
            >
              {SCHEDULE_VIEWS.map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              value={date}
              aria-label="Week of"
              onChange={(e) => setDate(e.target.value)}
            />
          </Row>
        }
      />

      <ErrorText>{error ?? schedule.error}</ErrorText>

      {warnings.length > 0 ? (
        <Notice live>
          <strong>Moved, with a clash to look at:</strong>
          <ul className="cq-list">
            {warnings.map((conflict) => (
              <li key={conflict.code + conflict.message}>{conflict.message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <Section
        title={
          data
            ? `${data.window.fromDate} to ${daysOf(data.window).slice(-1)[0] ?? data.window.toDate}`
            : 'Loading'
        }
        description={
          canManage
            ? 'Drag a booking to another day, or change its day with the picker on the row — both do the same thing.'
            : 'Read-only: you do not have permission to change the schedule.'
        }
      >
        {schedule.loading ? (
          <p className="cq-muted">Loading the schedule…</p>
        ) : byResource.size === 0 ? (
          <EmptyState title="Nothing scheduled in this window">
            Open a project and book somebody on it, and they appear here across every
            job you run.
          </EmptyState>
        ) : (
          <Table label="Schedule by resource and day">
            <thead>
              <tr>
                <th scope="col">Resource</th>
                {days.map((day) => (
                  <th key={day} scope="col">
                    {day.slice(8)}/{day.slice(5, 7)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...byResource.entries()].map(([resource, rows]) => (
                <tr key={resource}>
                  <th scope="row">{resource}</th>
                  {days.map((day) => {
                    const onThisDay = rows.filter((r) => r.startsAt.slice(0, 10) === day);
                    return (
                      <td
                        key={day}
                        /*
                         * The drop target. `onDragOver` has to preventDefault or the
                         * browser refuses the drop — the single most common reason a
                         * hand-rolled drag silently does nothing.
                         */
                        onDragOver={
                          canManage
                            ? (e) => {
                                e.preventDefault();
                              }
                            : undefined
                        }
                        onDrop={
                          canManage
                            ? (e) => {
                                e.preventDefault();
                                const id = e.dataTransfer.getData('text/plain') || dragging;
                                const moving = (data?.assignments ?? []).find((a) => a.id === id);
                                if (moving) void moveTo(moving, day);
                              }
                            : undefined
                        }
                      >
                        <Stack>
                          {onThisDay.map((assignment) => (
                            <div
                              key={assignment.id}
                              draggable={canManage && assignment.status !== 'CANCELLED'}
                              onDragStart={(e) => {
                                e.dataTransfer.setData('text/plain', assignment.id);
                                setDragging(assignment.id);
                              }}
                              onDragEnd={() => setDragging(null)}
                              className="cq-chip"
                            >
                              <Link href={`/projects/${assignment.projectId}?section=schedule`}>
                                {assignment.projectName ?? 'Project'}
                              </Link>
                              {assignment.roleName ? (
                                <span className="cq-muted"> · {assignment.roleName}</span>
                              ) : null}
                              {assignment.status !== 'PLANNED' ? (
                                <Badge
                                  tone={assignment.status === 'CONFIRMED' ? 'success' : 'neutral'}
                                >
                                  {titleCase(assignment.status)}
                                </Badge>
                              ) : null}
                              {assignment.compliance ? (
                                <Badge
                                  tone={
                                    assignment.compliance.status === 'VALID'
                                      ? 'success'
                                      : assignment.compliance.status === 'UNKNOWN'
                                        ? 'neutral'
                                        : assignment.compliance.status === 'EXPIRING'
                                          ? 'warning'
                                          : 'danger'
                                  }
                                >
                                  Compliance {titleCase(assignment.compliance.status)}
                                </Badge>
                              ) : null}
                              {/*
                                * SC 2.5.7's equivalent, and it is a real control
                                * rather than a second route to a form. Changing it
                                * calls `moveTo` — the same function the drop handler
                                * calls, with the same arguments — so the pointer path
                                * and the keyboard path cannot drift apart.
                                *
                                * `keyboard.spec.ts` tabs to this exact control and
                                * operates it. A `display: none` here would keep the
                                * page looking identical, pass every axe rule, and
                                * fail that case.
                                */}
                              {canManage && assignment.status !== 'CANCELLED' ? (
                                <Select
                                  value={day}
                                  disabled={busy}
                                  aria-label={`Move ${resourceOf(assignment)} on ${
                                    assignment.projectName ?? 'this project'
                                  } to another day`}
                                  onChange={(e) => void moveTo(assignment, e.target.value)}
                                >
                                  {days.map((option) => (
                                    <option key={option} value={option}>
                                      {option}
                                    </option>
                                  ))}
                                </Select>
                              ) : null}
                            </div>
                          ))}
                        </Stack>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      {data && data.availability.length > 0 ? (
        <Section
          title="Availability"
          description="Windows recorded for your people, your vehicles, and the crew counts your subcontractors have stated."
        >
          <Table label="Availability windows" compact>
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">Kind</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col" className="cq-num">
                  Crew
                </th>
              </tr>
            </thead>
            <tbody>
              {data.availability.map((window) => (
                <tr key={window.id}>
                  <td>{titleCase(window.resourceType)}</td>
                  <td>
                    <Badge tone={window.kind === 'AVAILABLE' ? 'success' : 'warning'}>
                      {titleCase(window.kind)}
                    </Badge>
                  </td>
                  <td>{formatDateTime(window.startsAt)}</td>
                  <td>{formatDateTime(window.endsAt)}</td>
                  <td className="cq-num">{window.headcount ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {/*
            * No `reason` column, and there never will be: an availability window
            * naming a person is data about their private time, and "unavailable
            * Thursday afternoons" is frequently a medical appointment.
            */}
          <p className="cq-muted">
            A window records when, never why. CrewQuo has no field for the reason
            somebody is unavailable.
          </p>
        </Section>
      ) : null}

      <Section
        title="Fleet"
        description="Vehicles you can book. Retiring one keeps every journey and booking already recorded against it."
        actions={
          caps.can('crew.manage') ? <Link href="/schedule/fleet">Manage the fleet</Link> : null
        }
      >
        {(data?.vehicles ?? []).length === 0 ? (
          <EmptyState title="No vehicles yet">
            Add your vans and plant and you can book them alongside people — and map
            each one to an emission factor so a recorded journey prices its own carbon.
          </EmptyState>
        ) : (
          <Row>
            {(data?.vehicles ?? []).map((vehicle) => (
              <Badge key={vehicle.id} tone="neutral">
                {vehicle.name}
                {vehicle.registration ? ` · ${vehicle.registration}` : ''}
              </Badge>
            ))}
          </Row>
        )}
      </Section>

      <p className="cq-muted">
        {scheduleWindow({ view, date, weekStartsOn: 1 }).fromDate === data?.window.fromDate
          ? ''
          : 'Window recalculated by the server.'}
      </p>
    </Stack>
  );
}
