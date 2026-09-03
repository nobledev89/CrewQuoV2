import { describe, expect, it } from 'vitest';
import {
  createScheduleSchema,
  detectScheduleConflicts,
  scheduleAssignmentInputSchema,
  scheduleWindow,
  unfilledRequirements,
  windowIntersection,
  windowsOverlap,
  type AvailabilityWindow,
  type ExistingAssignment,
  type ScheduleCandidate,
} from './scheduling';

const FEMI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VAN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PASHE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RIGGER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function candidate(over: Partial<ScheduleCandidate> = {}): ScheduleCandidate {
  return {
    id: null,
    resourceType: 'USER',
    userId: FEMI,
    providerCompanyId: null,
    vehicleId: null,
    headcount: 1,
    status: 'PLANNED',
    startsAt: '2027-06-08T07:00:00.000Z',
    endsAt: '2027-06-08T17:00:00.000Z',
    ...over,
  };
}

function existing(over: Partial<ExistingAssignment> = {}): ExistingAssignment {
  return {
    ...candidate(),
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    projectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    projectName: 'Pier 9',
    resourceLabel: 'Femi Adeyemi',
    ...over,
  };
}

describe('window arithmetic', () => {
  it('treats intervals as half-open, so a handover is not a clash', () => {
    // A day shift ending at 17:00 and a night shift starting at 17:00 are
    // back-to-back. Warning on that would warn on every ordinary handover, which is
    // how a warning channel gets ignored.
    expect(
      windowsOverlap(
        { startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z' },
        { startsAt: '2027-06-08T17:00:00Z', endsAt: '2027-06-09T03:00:00Z' }
      )
    ).toBe(false);
  });

  it('overlaps on containment, partial overlap and identity', () => {
    const a = { startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z' };
    expect(windowsOverlap(a, a)).toBe(true);
    expect(
      windowsOverlap(a, { startsAt: '2027-06-08T09:00:00Z', endsAt: '2027-06-08T10:00:00Z' })
    ).toBe(true);
    expect(
      windowsOverlap(a, { startsAt: '2027-06-08T16:00:00Z', endsAt: '2027-06-08T22:00:00Z' })
    ).toBe(true);
    expect(
      windowsOverlap(a, { startsAt: '2027-06-09T07:00:00Z', endsAt: '2027-06-09T17:00:00Z' })
    ).toBe(false);
  });

  it('reports the overlapping part, or nothing', () => {
    expect(
      windowIntersection(
        { startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z' },
        { startsAt: '2027-06-08T12:00:00Z', endsAt: '2027-06-08T22:00:00Z' }
      )
    ).toEqual({ startsAt: '2027-06-08T12:00:00Z', endsAt: '2027-06-08T17:00:00Z' });
    expect(
      windowIntersection(
        { startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T08:00:00Z' },
        { startsAt: '2027-06-08T09:00:00Z', endsAt: '2027-06-08T10:00:00Z' }
      )
    ).toBeNull();
  });
});

describe('conflict detection — §31, and every one is a warning', () => {
  it('warns when the same person is booked twice, naming the other project', () => {
    const conflicts = detectScheduleConflicts({
      candidate: candidate(),
      existing: [existing()],
      availability: [],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.code).toBe('USER_OVERLAP');
    expect(conflicts[0]?.message).toContain('Pier 9');
    expect(conflicts[0]?.otherAssignmentId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  });

  it('warns when the same vehicle is booked twice', () => {
    const conflicts = detectScheduleConflicts({
      candidate: candidate({ resourceType: 'VEHICLE', userId: null, vehicleId: VAN }),
      existing: [existing({ resourceType: 'VEHICLE', userId: null, vehicleId: VAN, resourceLabel: 'Transit LX21 ABC' })],
      availability: [],
    });
    expect(conflicts.map((c) => c.code)).toEqual(['VEHICLE_OVERLAP']);
    expect(conflicts[0]?.message).toContain('Transit LX21 ABC');
  });

  it('lets a CANCELLED row conflict with nothing, on either side', () => {
    // §31 says so in as many words, and a retained row that still blocks is a delete
    // with extra steps — it is kept as the answer to "was Femi ever booked that
    // week?", which is the row Priya needs when the client asks why nobody came.
    expect(
      detectScheduleConflicts({
        candidate: candidate(),
        existing: [existing({ status: 'CANCELLED' })],
        availability: [],
      })
    ).toEqual([]);
    expect(
      detectScheduleConflicts({
        candidate: candidate({ status: 'CANCELLED' }),
        existing: [existing()],
        availability: [],
      })
    ).toEqual([]);
  });

  it('never clashes a row with itself when it is moved', () => {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    expect(
      detectScheduleConflicts({
        candidate: candidate({ id }),
        existing: [existing({ id })],
        availability: [],
      })
    ).toEqual([]);
  });

  it('does not warn on overlapping PROVIDER rows, because that is normal', () => {
    // §31: "Deliberate double-booking of a subcontractor's company is normal."
    const conflicts = detectScheduleConflicts({
      candidate: candidate({
        resourceType: 'PROVIDER',
        userId: null,
        providerCompanyId: PASHE,
        headcount: 3,
      }),
      existing: [
        existing({
          resourceType: 'PROVIDER',
          userId: null,
          providerCompanyId: PASHE,
          headcount: 3,
        }),
      ],
      availability: [],
    });
    expect(conflicts).toEqual([]);
  });

  it('warns a provider only when the booked headcount exceeds a stated availability', () => {
    const stated: AvailabilityWindow = {
      id: 'a1',
      resourceType: 'PROVIDER',
      userId: null,
      providerCompanyId: PASHE,
      vehicleId: null,
      kind: 'AVAILABLE',
      headcount: 4,
      note: null,
      startsAt: '2027-06-01T00:00:00.000Z',
      endsAt: '2027-07-01T00:00:00.000Z',
    };
    const base = {
      resourceType: 'PROVIDER' as const,
      userId: null,
      providerCompanyId: PASHE,
    };

    const under = detectScheduleConflicts({
      candidate: candidate({ ...base, headcount: 3 }),
      existing: [],
      availability: [stated],
    });
    expect(under).toEqual([]);

    const over = detectScheduleConflicts({
      candidate: candidate({ ...base, headcount: 6 }),
      existing: [],
      availability: [stated],
    });
    expect(over.map((c) => c.code)).toEqual(['PROVIDER_HEADCOUNT']);
    expect(over[0]?.message).toContain('4 crew');
    expect(over[0]?.message).toContain('6 would now be booked');

    // And it counts what is already booked elsewhere in the same window.
    const cumulative = detectScheduleConflicts({
      candidate: candidate({ ...base, headcount: 2 }),
      existing: [existing({ ...base, headcount: 3, resourceLabel: 'Pashe' })],
      availability: [stated],
    });
    expect(cumulative.map((c) => c.code)).toEqual(['PROVIDER_HEADCOUNT']);
    expect(cumulative[0]?.message).toContain('3 already elsewhere');
  });

  it('stays quiet about headcount when the subcontractor has stated nothing', () => {
    const conflicts = detectScheduleConflicts({
      candidate: candidate({
        resourceType: 'PROVIDER',
        userId: null,
        providerCompanyId: PASHE,
        headcount: 40,
      }),
      existing: [],
      availability: [],
    });
    expect(conflicts).toEqual([]);
  });

  it('takes the smallest overlapping statement, not the sum', () => {
    // Two overlapping statements are two answers about the same crew — "4 this
    // month, 2 the week of the 14th" — not six people.
    const windows: AvailabilityWindow[] = [
      {
        id: 'a1', resourceType: 'PROVIDER', userId: null, providerCompanyId: PASHE,
        vehicleId: null, kind: 'AVAILABLE', headcount: 4, note: null,
        startsAt: '2027-06-01T00:00:00.000Z', endsAt: '2027-07-01T00:00:00.000Z',
      },
      {
        id: 'a2', resourceType: 'PROVIDER', userId: null, providerCompanyId: PASHE,
        vehicleId: null, kind: 'AVAILABLE', headcount: 2, note: null,
        startsAt: '2027-06-07T00:00:00.000Z', endsAt: '2027-06-14T00:00:00.000Z',
      },
    ];
    const conflicts = detectScheduleConflicts({
      candidate: candidate({
        resourceType: 'PROVIDER', userId: null, providerCompanyId: PASHE, headcount: 3,
      }),
      existing: [],
      availability: windows,
    });
    expect(conflicts.map((c) => c.code)).toEqual(['PROVIDER_HEADCOUNT']);
    expect(conflicts[0]?.message).toContain('2 crew');
  });

  it('warns on an assignment inside an UNAVAILABLE window', () => {
    const conflicts = detectScheduleConflicts({
      candidate: candidate(),
      existing: [],
      availability: [
        {
          id: 'u1', resourceType: 'USER', userId: FEMI, providerCompanyId: null,
          vehicleId: null, kind: 'UNAVAILABLE', headcount: null, note: null,
          startsAt: '2027-06-07T00:00:00.000Z', endsAt: '2027-06-14T00:00:00.000Z',
        },
      ],
    });
    expect(conflicts.map((c) => c.code)).toEqual(['UNAVAILABLE_WINDOW']);
  });

  it('treats a resource with no AVAILABLE windows as always available', () => {
    // Every company in the product is in this state today, and warning on every row
    // because an optional table is empty would be a feature that ships broken.
    expect(detectScheduleConflicts({ candidate: candidate(), existing: [], availability: [] }))
      .toEqual([]);
  });

  it('warns when AVAILABLE windows exist and none of them covers the assignment', () => {
    const windows: AvailabilityWindow[] = [
      {
        id: 'u1', resourceType: 'USER', userId: FEMI, providerCompanyId: null,
        vehicleId: null, kind: 'AVAILABLE', headcount: null, note: null,
        startsAt: '2027-06-08T06:00:00.000Z', endsAt: '2027-06-08T12:00:00.000Z',
      },
    ];
    expect(
      detectScheduleConflicts({ candidate: candidate(), existing: [], availability: windows })
        .map((c) => c.code)
    ).toEqual(['OUTSIDE_AVAILABILITY']);

    // Fully covered: quiet.
    expect(
      detectScheduleConflicts({
        candidate: candidate({
          startsAt: '2027-06-08T07:00:00.000Z',
          endsAt: '2027-06-08T11:00:00.000Z',
        }),
        existing: [],
        availability: windows,
      })
    ).toEqual([]);
  });

  it('ignores availability recorded for a different resource', () => {
    const conflicts = detectScheduleConflicts({
      candidate: candidate(),
      existing: [],
      availability: [
        {
          id: 'u1', resourceType: 'VEHICLE', userId: null, providerCompanyId: null,
          vehicleId: VAN, kind: 'UNAVAILABLE', headcount: null, note: null,
          startsAt: '2027-06-01T00:00:00.000Z', endsAt: '2027-07-01T00:00:00.000Z',
        },
      ],
    });
    expect(conflicts).toEqual([]);
  });

  it('reports several clashes at once rather than the first', () => {
    const conflicts = detectScheduleConflicts({
      candidate: candidate(),
      existing: [existing(), existing({ id: 'other-id', projectName: 'Marina Bay' })],
      availability: [
        {
          id: 'u1', resourceType: 'USER', userId: FEMI, providerCompanyId: null,
          vehicleId: null, kind: 'UNAVAILABLE', headcount: null, note: null,
          startsAt: '2027-06-08T00:00:00.000Z', endsAt: '2027-06-09T00:00:00.000Z',
        },
      ],
    });
    expect(conflicts.map((c) => c.code).sort()).toEqual([
      'UNAVAILABLE_WINDOW',
      'USER_OVERLAP',
      'USER_OVERLAP',
    ]);
  });
});

describe('unfilled requirements — §31 indicator', () => {
  const requirement = {
    id: 'r1',
    projectId: 'p1',
    roleId: RIGGER,
    roleName: 'Rigger',
    quantity: 2,
    isSupervisor: false,
    startsOn: '2027-06-07',
    endsOn: '2027-06-09',
    notes: null,
  };

  it('reports a shortfall and clears when it is filled', () => {
    const one = unfilledRequirements({
      requirements: [requirement],
      assignments: [
        {
          roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'PLANNED',
          startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z',
        },
      ],
    });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ required: 2, filled: 1, short: 1, roleName: 'Rigger' });

    const two = unfilledRequirements({
      requirements: [requirement],
      assignments: [
        { roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'PLANNED', startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z' },
        { roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'CONFIRMED', startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z' },
      ],
    });
    expect(two).toEqual([]);
  });

  it('counts a PROVIDER row by its headcount — "4 crew from Pashe"', () => {
    const filled = unfilledRequirements({
      requirements: [requirement],
      assignments: [
        {
          roleId: RIGGER, resourceType: 'PROVIDER', headcount: 4, status: 'PLANNED',
          startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z',
        },
      ],
    });
    expect(filled).toEqual([]);
  });

  it('counts nothing from a CANCELLED row', () => {
    const short = unfilledRequirements({
      requirements: [requirement],
      assignments: [
        {
          roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'CANCELLED',
          startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z',
        },
      ],
    });
    expect(short[0]?.filled).toBe(0);
  });

  it('ignores an assignment outside the requirement window', () => {
    const short = unfilledRequirements({
      requirements: [requirement],
      assignments: [
        {
          roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'PLANNED',
          startsAt: '2027-06-15T07:00:00Z', endsAt: '2027-06-15T17:00:00Z',
        },
      ],
    });
    expect(short[0]?.filled).toBe(0);
  });

  it('treats a requirement with no dates as covering the whole project', () => {
    const filled = unfilledRequirements({
      requirements: [{ ...requirement, quantity: 1, startsOn: null, endsOn: null }],
      assignments: [
        {
          roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'PLANNED',
          startsAt: '2029-01-01T07:00:00Z', endsAt: '2029-01-01T17:00:00Z',
        },
      ],
    });
    expect(filled).toEqual([]);
  });

  it('returns only shortfalls, so a screen showing ten satisfied rows cannot happen', () => {
    const rows = unfilledRequirements({
      requirements: [
        { ...requirement, id: 'r1', quantity: 1 },
        { ...requirement, id: 'r2', quantity: 5 },
      ],
      assignments: [
        {
          roleId: RIGGER, resourceType: 'USER', headcount: 1, status: 'PLANNED',
          startsAt: '2027-06-08T07:00:00Z', endsAt: '2027-06-08T17:00:00Z',
        },
      ],
    });
    expect(rows.map((r) => r.requirementId)).toEqual(['r2']);
  });
});

describe('view windows', () => {
  it('covers one day', () => {
    expect(scheduleWindow({ view: 'DAY', date: '2027-06-08', weekStartsOn: 1 })).toEqual({
      fromDate: '2027-06-08',
      toDate: '2027-06-09',
    });
  });

  it('snaps a week back to its declared start', () => {
    // 2027-06-08 is a Tuesday.
    expect(scheduleWindow({ view: 'WEEK', date: '2027-06-08', weekStartsOn: 1 })).toEqual({
      fromDate: '2027-06-07',
      toDate: '2027-06-14',
    });
    // The same date with a Sunday-start week is a different week, which is why the
    // parameter has no default — a Monday start is a convention, not a fact.
    expect(scheduleWindow({ view: 'WEEK', date: '2027-06-08', weekStartsOn: 0 })).toEqual({
      fromDate: '2027-06-06',
      toDate: '2027-06-13',
    });
  });

  it('covers a whole month regardless of its length', () => {
    expect(scheduleWindow({ view: 'MONTH', date: '2027-02-14', weekStartsOn: 1 })).toEqual({
      fromDate: '2027-02-01',
      toDate: '2027-03-01',
    });
    expect(scheduleWindow({ view: 'MONTH', date: '2028-02-14', weekStartsOn: 1 })).toEqual({
      fromDate: '2028-02-01',
      toDate: '2028-03-01',
    });
    expect(scheduleWindow({ view: 'MONTH', date: '2027-12-31', weekStartsOn: 1 })).toEqual({
      fromDate: '2027-12-01',
      toDate: '2028-01-01',
    });
  });
});

describe('the assignment schema', () => {
  const base = {
    startsAt: '2027-06-08T07:00:00.000Z',
    endsAt: '2027-06-08T17:00:00.000Z',
  };

  it('requires the id column its resourceType names', () => {
    expect(scheduleAssignmentInputSchema.safeParse({ ...base, resourceType: 'USER' }).success)
      .toBe(false);
    expect(
      scheduleAssignmentInputSchema.safeParse({ ...base, resourceType: 'USER', userId: FEMI })
        .success
    ).toBe(true);
  });

  it('refuses a row naming two resources', () => {
    // Otherwise it is stored, conflicts against nothing, and is invisible in both
    // views — book the van as its own row.
    expect(
      scheduleAssignmentInputSchema.safeParse({
        ...base, resourceType: 'USER', userId: FEMI, vehicleId: VAN,
      }).success
    ).toBe(false);
  });

  it('refuses a headcount on anything but a PROVIDER', () => {
    // A headcount of 3 on a named person fills three requirement slots with one
    // human, which is the arithmetic the indicator depends on.
    expect(
      scheduleAssignmentInputSchema.safeParse({
        ...base, resourceType: 'USER', userId: FEMI, headcount: 3,
      }).success
    ).toBe(false);
    expect(
      scheduleAssignmentInputSchema.safeParse({
        ...base, resourceType: 'PROVIDER', providerCompanyId: PASHE, headcount: 4,
      }).success
    ).toBe(true);
  });

  it('refuses a window that ends before it starts', () => {
    expect(
      scheduleAssignmentInputSchema.safeParse({
        resourceType: 'USER', userId: FEMI,
        startsAt: '2027-06-08T17:00:00.000Z', endsAt: '2027-06-08T07:00:00.000Z',
      }).success
    ).toBe(false);
  });

  it('defaults a shift type to null rather than guessing one from the clock', () => {
    // Packet finding 6. Deriving NIGHT from an hour would put a rate rule back in
    // code eleven phases after the owner had the FRI_SAT_NIGHT branch removed.
    const parsed = scheduleAssignmentInputSchema.parse({
      ...base, resourceType: 'USER', userId: FEMI,
    });
    expect(parsed.shiftType).toBeNull();
  });

  it('takes a whole batch under one client id', () => {
    const parsed = createScheduleSchema.parse({
      batchClientId: '99999999-9999-4999-8999-999999999999',
      assignments: [{ ...base, resourceType: 'USER', userId: FEMI }],
    });
    expect(parsed.assignments).toHaveLength(1);
    expect(createScheduleSchema.safeParse({ assignments: [] }).success).toBe(false);
  });
});
