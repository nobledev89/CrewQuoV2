'use client';

import { useState } from 'react';
import { FEATURE_KEYS, type FeatureKey, type VehicleView } from '@crewquo/shared';
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
  Stack,
  Table,
} from '@crewquo/ui';
import { Shell } from '@/components/Shell';
import { api, ApiError, refusedFeature } from '@/api/client';
import { useSessionCtx } from '@/auth/AuthProvider';
import { useAsyncList } from '@/lib/useAsyncList';
import { useCapabilities } from '@/lib/useCapabilities';
import { FeatureLocked } from '@/components/FeatureLock';

/**
 * The fleet (§31) — company reference data, like a role.
 *
 * **`scheduling` is checked against this company's own plan here**, not a project
 * owner's, which is the exception `custom_factors` already is: a fleet has no
 * project to find an owner of, so transferring the 2026-09-01 rule by analogy
 * would have been wrong for the third time in three phases.
 *
 * **A vehicle is retired, never deleted while anything points at it.** The delete
 * refuses with the count and offers Retire instead — the pattern §3.3's locked rate
 * cards established: a foreign key violation reaching the caller as a 500 is not an
 * explanation, and the useful refusal names what to do instead. A cancelled booking
 * counts, because it is a retained record of a booking that was made.
 *
 * `emissionFactorActivity` is what makes a row useful to Phase 9 rather than
 * decorative: an activity recorded against this vehicle prefills its category and
 * fuel from here — by **copying** them, so retiring a vehicle next year cannot
 * restate last year's emissions (§41.3).
 */
export default function FleetPage() {
  return (
    <Shell>
      <Fleet />
    </Shell>
  );
}

function Fleet() {
  const ctx = useSessionCtx();
  const caps = useCapabilities();
  const canManage = caps.can('crew.manage');

  const vehicles = useAsyncList<VehicleView>(
    ctx
      ? () => api.listVehicles(ctx.accessToken, ctx.companyId, true).then((r) => r.vehicles)
      : null,
    [ctx?.companyId]
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [registration, setRegistration] = useState('');
  const [category, setCategory] = useState('');
  const [fuelType, setFuelType] = useState('');
  const [activity, setActivity] = useState('');
  const [capacityNote, setCapacityNote] = useState('');

  const locked = refusedFeature(vehicles.error);
  if (locked !== null && (FEATURE_KEYS as readonly string[]).includes(locked)) {
    return (
      <Stack>
        <PageHeader eyebrow="Operations" title="Fleet" />
        <FeatureLocked feature={locked as FeatureKey} />
      </Stack>
    );
  }

  const add = async () => {
    if (!ctx || name.trim() === '') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.createVehicle(ctx.accessToken, ctx.companyId, {
        name: name.trim(),
        registration: registration.trim() === '' ? null : registration.trim(),
        category: category.trim() === '' ? null : category.trim(),
        fuelType: fuelType.trim() === '' ? null : fuelType.trim(),
        emissionFactorActivity: activity.trim() === '' ? null : activity.trim(),
        capacityNote: capacityNote.trim() === '' ? null : capacityNote.trim(),
        active: true,
      });
      setName('');
      setRegistration('');
      setCategory('');
      setFuelType('');
      setActivity('');
      setCapacityNote('');
      vehicles.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that vehicle');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (vehicle: VehicleView, active: boolean) => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateVehicle(ctx.accessToken, ctx.companyId, vehicle.id, { active });
      vehicles.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that vehicle');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (vehicle: VehicleView) => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteVehicle(ctx.accessToken, ctx.companyId, vehicle.id);
      vehicles.reload();
    } catch (err) {
      /*
       * The refusal is the useful part, so it is shown as a notice rather than as an
       * error: it names the count and says to retire instead, which is an
       * instruction rather than a failure.
       */
      setNotice(err instanceof ApiError ? err.message : 'Could not delete that vehicle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <PageHeader
        eyebrow="Operations"
        title="Fleet"
        description="Vehicles you can put on a schedule, and map to an emission factor so a recorded journey prices its own carbon."
      />
      <ErrorText>{error ?? vehicles.error}</ErrorText>
      {notice ? <Notice live>{notice}</Notice> : null}

      {canManage ? (
        <Section title="Add a vehicle">
          <Row>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Registration" hint="Unique in your fleet, whatever the capitalisation">
              <Input
                value={registration}
                onChange={(e) => setRegistration(e.target.value)}
                maxLength={30}
              />
            </Field>
            <Field label="Category" hint="e.g. Van (class III), HGV rigid 7.5–17t">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Fuel">
              <Input value={fuelType} onChange={(e) => setFuelType(e.target.value)} maxLength={60} />
            </Field>
            <Field
              label="Emission factor activity"
              hint="The activity key in your factor set. Copied onto a journey, never joined."
            >
              <Input value={activity} onChange={(e) => setActivity(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Capacity note">
              <Input
                value={capacityNote}
                onChange={(e) => setCapacityNote(e.target.value)}
                maxLength={300}
              />
            </Field>
            <Button disabled={busy || name.trim() === ''} onClick={() => void add()}>
              Add
            </Button>
          </Row>
        </Section>
      ) : null}

      <Section title="Your fleet">
        {vehicles.loading ? (
          <p className="cq-muted">Loading the fleet…</p>
        ) : vehicles.items.length === 0 ? (
          <EmptyState title="No vehicles yet">
            Add a van and you can book it alongside people on a project schedule.
          </EmptyState>
        ) : (
          <Table label="Vehicles">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Registration</th>
                <th scope="col">Category</th>
                <th scope="col">Fuel</th>
                <th scope="col">Factor activity</th>
                <th scope="col">Status</th>
                {canManage ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {vehicles.items.map((vehicle) => (
                <tr key={vehicle.id}>
                  <td>{vehicle.name}</td>
                  <td>{vehicle.registration ?? '—'}</td>
                  <td>{vehicle.category ?? '—'}</td>
                  <td>{vehicle.fuelType ?? '—'}</td>
                  <td>
                    {vehicle.emissionFactorActivity ?? (
                      <span className="cq-muted">Not mapped</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={vehicle.active ? 'success' : 'neutral'}>
                      {vehicle.active ? 'Active' : 'Retired'}
                    </Badge>
                  </td>
                  {canManage ? (
                    <td>
                      <Row>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void setActive(vehicle, !vehicle.active)}
                        >
                          {vehicle.active ? 'Retire' : 'Bring back'}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void remove(vehicle)}
                        >
                          Delete
                        </Button>
                      </Row>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="cq-muted">
          Retiring keeps every booking and journey recorded against a vehicle and takes
          it out of the pickers. Deleting is refused while anything points at it.
        </p>
      </Section>
    </Stack>
  );
}
