'use client';

import { useState } from 'react';
import {
  FEATURE_KEYS,
  SHIFT_TYPES,
  type FeatureKey,
  type RequirementShortfall,
  type RoleRequirement,
  type ScheduleAssignmentView,
  type ScheduleConflict,
  type ShiftType,
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
  Table,
} from '@crewquo/ui';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncData } from '@/lib/useAsyncData';
import { FeatureLocked } from '@/components/FeatureLock';
import { formatCents, formatDateTime, titleCase } from '@/lib/format';

/**
 * The project Schedule section (§31) — step 11.9's second screen.
 *
 * **A clash is rendered beside the row it belongs to and never as a refusal.**
 * §31: *"Conflict detection is a warning, not a block — overlapping assignments for
 * the same user or vehicle are surfaced at save time with the clash named."* The
 * save succeeds, `warnings` comes back with it, and the drawer stays closed. The
 * reason is not squeamishness: the double-booking is sometimes the plan, because
 * the other job finishes at noon and the schedule does not know that.
 *
 * **The planned figures are null with a reason, never zero** (packet finding 6). An
 * assignment with no shift type has no rate label to resolve, and an assignment with
 * no role has no card at all. `plannedReason` is the sentence; there is no `?? 0`.
 *
 * **This panel has no drag-and-drop.** Moving a booking on a project's own list is a
 * form, and the drag lives in the company-wide week planner where it is genuinely
 * faster — with a keyboard equivalent registered in `keyboard.spec.ts`, which is a
 * build gate rather than a promise.
 */

const CONFLICT_TONE: Readonly<Record<ScheduleConflict['code'], 'warning' | 'danger'>> = {
  USER_OVERLAP: 'danger',
  VEHICLE_OVERLAP: 'danger',
  OUTSIDE_AVAILABILITY: 'warning',
  UNAVAILABLE_WINDOW: 'warning',
  PROVIDER_HEADCOUNT: 'warning',
};

interface ScheduleData {
  assignments: ScheduleAssignmentView[];
  requirements: RoleRequirement[];
  shortfalls: RequirementShortfall[];
}

export function SchedulePanel({
  projectId,
  currency,
  roles,
  providers,
  members,
  canManage,
  isOwner,
}: {
  projectId: string;
  currency: string;
  roles: { id: string; name: string }[];
  providers: { id: string; name: string }[];
  members: { userId: string; name: string | null }[];
  canManage: boolean;
  isOwner: boolean;
}) {
  const ctx = useSessionCtx();
  const schedule = useAsyncData<ScheduleData>(
    ctx ? () => api.listProjectSchedule(ctx.accessToken, ctx.companyId, projectId) : null,
    [ctx?.companyId, projectId]
  );
  const vehicles = useAsyncData(
    ctx && canManage
      ? () => api.listVehicles(ctx.accessToken, ctx.companyId).then((r) => r.vehicles)
      : null,
    [ctx?.companyId, canManage]
  );

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<{ assignmentId: string; conflicts: ScheduleConflict[] }[]>(
    []
  );

  const [resourceType, setResourceType] = useState<'USER' | 'PROVIDER' | 'VEHICLE'>('USER');
  const [userId, setUserId] = useState('');
  const [providerCompanyId, setProviderCompanyId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [shiftType, setShiftType] = useState('');
  const [headcount, setHeadcount] = useState('1');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [startTime, setStartTime] = useState('07:00');
  const [endTime, setEndTime] = useState('17:00');
  const [isSupervisor, setIsSupervisor] = useState(false);

  const locked = refusedFeature(schedule.error);
  // `refusedFeature` returns the raw string the API put in `details.feature`,
  // which is untrusted shape rather than a `FeatureKey` — narrowed against the
  // catalog so a response naming something this build has never heard of renders
  // the generic error rather than an empty explanation.
  if (locked !== null && (FEATURE_KEYS as readonly string[]).includes(locked)) {
    return <FeatureLocked feature={locked as FeatureKey} />;
  }

  const save = async () => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.createSchedule(ctx.accessToken, ctx.companyId, projectId, {
        // A batch id even for one row: the API keys its single notification and its
        // idempotent replay on it, and a retry that could not tell whether the first
        // attempt landed must be able to ask.
        batchClientId: crypto.randomUUID(),
        assignments: [
          {
            resourceType,
            userId: resourceType === 'USER' ? userId : null,
            providerCompanyId: resourceType === 'PROVIDER' ? providerCompanyId : null,
            vehicleId: resourceType === 'VEHICLE' ? vehicleId : null,
            roleId: roleId === '' ? null : roleId,
            isSupervisor,
            headcount: resourceType === 'PROVIDER' ? Number(headcount) || 1 : 1,
            startsAt: new Date(`${day}T${startTime}`).toISOString(),
            endsAt: new Date(`${day}T${endTime}`).toISOString(),
            locationId: null,
            shiftType: shiftType === '' ? null : (shiftType as ShiftType),
            status: 'PLANNED',
            notes: null,
          },
        ],
      });
      /*
       * The clash comes back with the row that was saved, and the drawer closes. A
       * modal that stayed open with a warning in it would read as a refusal, which
       * is the one thing §31 says this must not be.
       */
      setWarnings(result.warnings);
      setOpen(false);
      schedule.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that booking');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (assignment: ScheduleAssignmentView) => {
    if (!ctx) return;
    setBusy(true);
    try {
      await api.confirmAssignment(ctx.accessToken, ctx.companyId, assignment.id);
      schedule.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm that');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (assignment: ScheduleAssignmentView) => {
    if (!ctx) return;
    setBusy(true);
    try {
      await api.updateAssignment(ctx.accessToken, ctx.companyId, assignment.id, {
        status: 'CANCELLED',
      });
      schedule.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel that');
    } finally {
      setBusy(false);
    }
  };

  const data = schedule.data;
  const warningsFor = (id: string) =>
    warnings.find((w) => w.assignmentId === id)?.conflicts ?? [];

  return (
    <Stack>
      <Section
        title="Schedule"
        description="Who and what is on this project, and when. A clash is named when you create it — it never stops you."
        actions={
          canManage && isOwner ? <Button onClick={() => setOpen(true)}>Book someone</Button> : null
        }
      >
        <ErrorText>{error ?? schedule.error}</ErrorText>

        {warnings.length > 0 ? (
          <Notice live>
            <strong>Saved, with a clash to look at:</strong>
            <ul className="cq-list">
              {warnings.flatMap((w) =>
                w.conflicts.map((conflict) => (
                  <li key={`${w.assignmentId}-${conflict.code}-${conflict.message}`}>
                    {conflict.message}
                  </li>
                ))
              )}
            </ul>
          </Notice>
        ) : null}

        {data && data.shortfalls.length > 0 ? (
          <Notice>
            <strong>Unfilled requirements:</strong>{' '}
            {data.shortfalls
              .map(
                (s) =>
                  `${String(s.short)} × ${s.roleName ?? 'role'} short of ${String(s.required)}`
              )
              .join(' · ')}
          </Notice>
        ) : null}

        {schedule.loading ? (
          <p className="cq-muted">Loading schedule…</p>
        ) : !data || data.assignments.length === 0 ? (
          <EmptyState title="Nobody is scheduled yet">
            Book a person, a subcontractor crew or a van and it appears here. A booking
            pre-fills the site diary and the log-time screen for that day.
          </EmptyState>
        ) : (
          <Table label="Schedule">
            <thead>
              <tr>
                <th scope="col">Who / what</th>
                <th scope="col">Role</th>
                <th scope="col">When</th>
                <th scope="col">Status</th>
                {isOwner ? (
                  <th scope="col" className="cq-num">
                    Planned
                  </th>
                ) : null}
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.assignments.map((assignment) => {
                const conflicts = warningsFor(assignment.id);
                return (
                  <tr key={assignment.id}>
                    <td>
                      {assignment.userName ??
                        assignment.providerCompanyName ??
                        assignment.vehicleName ??
                        titleCase(assignment.resourceType)}
                      {assignment.vehicleRegistration ? (
                        <div className="cq-muted">{assignment.vehicleRegistration}</div>
                      ) : null}
                      {assignment.resourceType === 'PROVIDER' ? (
                        <div className="cq-muted">{assignment.headcount} crew</div>
                      ) : null}
                      {assignment.compliance ? (
                        <div title={assignment.compliance.warning ?? undefined}>
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
                            Compliance: {titleCase(assignment.compliance.status)}
                          </Badge>
                          {assignment.compliance.warning ? (
                            <div className="cq-muted">{assignment.compliance.warning}</div>
                          ) : null}
                        </div>
                      ) : null}
                      {assignment.isSupervisor ? <Badge tone="accent">Supervisor</Badge> : null}
                      {conflicts.map((conflict) => (
                        <div key={conflict.code + conflict.message}>
                          <Badge tone={CONFLICT_TONE[conflict.code]}>{conflict.message}</Badge>
                        </div>
                      ))}
                    </td>
                    <td>
                      {assignment.roleName ?? '—'}
                      {assignment.shiftType ? (
                        <div className="cq-muted">{titleCase(assignment.shiftType)}</div>
                      ) : null}
                    </td>
                    <td>
                      {formatDateTime(assignment.startsAt)}
                      <div className="cq-muted">to {formatDateTime(assignment.endsAt)}</div>
                    </td>
                    <td>
                      <Badge
                        tone={
                          assignment.status === 'CONFIRMED'
                            ? 'success'
                            : assignment.status === 'CANCELLED'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {titleCase(assignment.status)}
                      </Badge>
                    </td>
                    {isOwner ? (
                      <td className="cq-num">
                        {/*
                          * Packet finding 6. Null with a reason, never a zero: an
                          * assignment with no shift type has no rate label to
                          * resolve, and inventing one from the clock would put a rate
                          * rule back in code.
                          */}
                        {assignment.plannedSellCents === null ? (
                          <span className="cq-muted" title={assignment.plannedReason ?? undefined}>
                            Not priced
                          </span>
                        ) : (
                          formatCents(assignment.plannedSellCents, currency)
                        )}
                      </td>
                    ) : null}
                    <td>
                      <Row>
                        {assignment.status === 'PLANNED' && canManage ? (
                          <Button size="sm" disabled={busy} onClick={() => void confirm(assignment)}>
                            Confirm
                          </Button>
                        ) : null}
                        {assignment.status !== 'CANCELLED' && canManage && isOwner ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void cancel(assignment)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </Row>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {data && data.assignments.some((a) => a.plannedSellCents === null) && isOwner ? (
          <p className="cq-muted">
            A planned figure needs a role and a shift type, and a rate card covering
            them on the day. Where one is missing the cell says so rather than showing
            a zero.
          </p>
        ) : null}
      </Section>

      <Drawer
        open={open}
        title="Book someone on this project"
        description="A clash with another job is reported when you save. It does not stop you — sometimes the double-booking is the plan."
        onClose={() => setOpen(false)}
        footer={
          <Row>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Book'}
            </Button>
          </Row>
        }
      >
        <Stack>
          <ErrorText>{error}</ErrorText>
          <Field label="What are you booking">
            <Select
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value as 'USER' | 'PROVIDER' | 'VEHICLE')}
            >
              <option value="USER">One of your team</option>
              <option value="PROVIDER">A subcontractor crew</option>
              <option value="VEHICLE">A vehicle</option>
            </Select>
          </Field>

          {resourceType === 'USER' ? (
            <Field label="Person">
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Choose…</option>
                {members.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {member.name ?? member.userId.slice(0, 8)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {resourceType === 'PROVIDER' ? (
            <>
              <Field label="Subcontractor" hint="They must already be on this project's crew">
                <Select
                  value={providerCompanyId}
                  onChange={(e) => setProviderCompanyId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="How many crew" hint="Warns if it exceeds what they have said they can supply">
                <Input
                  type="number"
                  min="1"
                  value={headcount}
                  onChange={(e) => setHeadcount(e.target.value)}
                />
              </Field>
            </>
          ) : null}
          {resourceType === 'VEHICLE' ? (
            <Field label="Vehicle">
              <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                <option value="">Choose…</option>
                {(vehicles.data ?? []).map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.name}
                    {vehicle.registration ? ` (${vehicle.registration})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Row>
            <Field label="Role" hint="Counts toward this project's role requirements">
              <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">No role</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </Field>
            {/*
              * Packet finding 6. Optional, and the planned cost only exists when it
              * is set — deriving a shift from the clock would put a rate rule back
              * into code eleven phases after the owner had one taken out.
              */}
            <Field label="Shift" hint="Needed to work out what this is planned to cost">
              <Select value={shiftType} onChange={(e) => setShiftType(e.target.value)}>
                <option value="">Not stated</option>
                {SHIFT_TYPES.map((shift) => (
                  <option key={shift} value={shift}>
                    {titleCase(shift)}
                  </option>
                ))}
              </Select>
            </Field>
          </Row>

          <Row>
            <Field label="Day">
              <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <Field label="From">
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </Field>
          </Row>

          {resourceType === 'USER' ? (
            <Field label="Supervisor for the day">
              <input
                type="checkbox"
                checked={isSupervisor}
                onChange={(e) => setIsSupervisor(e.target.checked)}
                aria-label="Supervisor for the day"
              />
            </Field>
          ) : null}
        </Stack>
      </Drawer>
    </Stack>
  );
}
