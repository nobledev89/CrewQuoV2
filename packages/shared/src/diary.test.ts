import { describe, expect, it } from 'vitest';
import {
  CLOSE_DAY_PROMPT_CODES,
  DIARY_FIELD_LABELS,
  DIARY_NARRATIVE_FIELDS,
  attendanceTotals,
  closeDayPrompts,
  closeDiaryEntrySchema,
  createDiaryAttendanceSchema,
  createDiaryEntrySchema,
  describeAmendments,
  describeCloseRace,
  describeDiaryDay,
  diaryAmendedEventPayload,
  diaryClosedEventPayload,
  mergeDiaryEdit,
  narrativeFieldsFilled,
  refuseDiaryEdit,
  refuseDiaryTimes,
  refuseFutureEntryDate,
  suggestAttendance,
  updateDiaryEntrySchema,
  type DiaryNarrativeField,
} from './diary';

/**
 * The site diary's pure half (§23, item 7.5).
 *
 * The cases that matter here are the ones a fixture cannot reach: the merge that
 * decides whether two people's paragraphs collide, the counters §23 wanted stored
 * and this module derives, and the Close Day prompts that must stay prompts.
 */

const emptyNarrative = Object.fromEntries(
  DIARY_NARRATIVE_FIELDS.map((f) => [f, null])
) as Record<DiaryNarrativeField, string | null>;

describe('the narrative field list', () => {
  it('has a label for every field and no orphans', () => {
    expect(Object.keys(DIARY_FIELD_LABELS).sort()).toEqual([...DIARY_NARRATIVE_FIELDS].sort());
  });

  it('is thirteen fields, matching §23’s columns rather than the packet’s prose', () => {
    expect(DIARY_NARRATIVE_FIELDS).toHaveLength(13);
  });

  it('lists no field twice, which a merge keyed on it would silently tolerate', () => {
    expect(new Set(DIARY_NARRATIVE_FIELDS).size).toBe(DIARY_NARRATIVE_FIELDS.length);
  });
});

describe('refuseDiaryTimes', () => {
  it('accepts a day with no times at all', () => {
    expect(refuseDiaryTimes({})).toBeNull();
    expect(refuseDiaryTimes({ startTime: '07:30', finishTime: null })).toBeNull();
  });

  it('accepts a day that finishes exactly when it started', () => {
    expect(refuseDiaryTimes({ startTime: '07:30', finishTime: '07:30' })).toBeNull();
  });

  it('refuses a day that finishes before it starts', () => {
    expect(refuseDiaryTimes({ startTime: '17:00', finishTime: '07:30' })).toMatch(/before it starts/);
  });
});

describe('refuseFutureEntryDate', () => {
  it('accepts today and every day behind it', () => {
    expect(refuseFutureEntryDate('2026-03-03', '2026-03-03')).toBeNull();
    expect(refuseFutureEntryDate('2026-01-01', '2026-03-03')).toBeNull();
  });

  /*
   * The tolerance is deliberate and is the reason this is not a plain `>`
   * comparison: a night shift finishing at 02:00 is written up as the day it
   * started, and the person writing it may be a day ahead of the project owner.
   */
  it('tolerates one day ahead, for the night shift and the date line', () => {
    expect(refuseFutureEntryDate('2026-03-04', '2026-03-03')).toBeNull();
  });

  it('refuses a day that genuinely has not happened', () => {
    expect(refuseFutureEntryDate('2026-03-05', '2026-03-03')).toMatch(/has not happened/);
  });
});

describe('refuseDiaryEdit', () => {
  it('lets an open day be edited with no reason at all', () => {
    expect(refuseDiaryEdit({ status: 'OPEN' })).toBeNull();
  });

  it('requires a reason on a closed day', () => {
    expect(refuseDiaryEdit({ status: 'CLOSED' })?.code).toBe('REASON_REQUIRED');
  });

  it('does not accept whitespace as a reason', () => {
    expect(refuseDiaryEdit({ status: 'CLOSED', reason: '   ' })?.code).toBe('REASON_REQUIRED');
  });

  it('accepts a real reason', () => {
    expect(refuseDiaryEdit({ status: 'CLOSED', reason: 'Delivery note arrived late' })).toBeNull();
  });
});

describe('mergeDiaryEdit', () => {
  const current = { ...emptyNarrative, delays: 'Crane late', deliveries: 'Two pallets' };

  it('applies an edit to a field nobody else touched', () => {
    const out = mergeDiaryEdit({
      base: { ...emptyNarrative, deliveries: 'Two pallets' },
      incoming: { issues: 'Water ingress in 3.12' },
      current,
    });
    expect(out.conflicted).toEqual([]);
    expect(out.applied).toEqual(['issues']);
    expect(out.merged).toEqual({ issues: 'Water ingress in 3.12' });
  });

  /*
   * The case the whole mechanism exists for: Ade wrote into `issues` while Priya
   * wrote into `delays`. Whole-row last-write-wins would delete one of them, and
   * the person who lost a paragraph finds out weeks later in a dispute.
   */
  it('lets two people write different fields of one day without colliding', () => {
    const out = mergeDiaryEdit({
      base: emptyNarrative,
      incoming: { issues: 'Water ingress' },
      current: { ...emptyNarrative, delays: 'Crane late' },
    });
    expect(out.conflicted).toEqual([]);
    expect(out.merged).toEqual({ issues: 'Water ingress' });
  });

  it('reports a genuine collision with both sides and a readable label', () => {
    const out = mergeDiaryEdit({
      base: { ...emptyNarrative, delays: 'Crane late' },
      incoming: { delays: 'Crane late by two hours' },
      current: { ...emptyNarrative, delays: 'Crane cancelled' },
    });
    expect(out.conflicted).toEqual([
      {
        field: 'delays',
        label: 'Delays',
        mine: 'Crane late by two hours',
        theirs: 'Crane cancelled',
      },
    ]);
  });

  it('is not a conflict when both sides made the same change', () => {
    const out = mergeDiaryEdit({
      base: emptyNarrative,
      incoming: { weather: 'Heavy rain' },
      current: { ...emptyNarrative, weather: 'Heavy rain' },
    });
    expect(out.conflicted).toEqual([]);
    // Applied, but not written again: the value is already what the caller wanted.
    expect(out.applied).toEqual(['weather']);
    expect(out.merged).toEqual({});
  });

  it('ignores fields the edit did not touch, however stale its copy of them is', () => {
    const out = mergeDiaryEdit({
      base: { ...emptyNarrative, delays: 'Crane late' },
      incoming: { notes: 'Site walk at 14:00' },
      current: { ...emptyNarrative, delays: 'Crane cancelled' },
    });
    expect(out.conflicted).toEqual([]);
    expect(out.merged).toEqual({ notes: 'Site walk at 14:00' });
  });

  /*
   * A non-narrative field arriving here must not be merged into the result. A
   * start time has one right answer and merging it would be inventing one.
   */
  it('merges narrative fields only, and drops anything else it is handed', () => {
    const out = mergeDiaryEdit({
      base: emptyNarrative,
      incoming: { weather: 'Dry', startTime: '07:00' } as never,
      current: emptyNarrative,
    });
    expect(Object.keys(out.merged)).toEqual(['weather']);
  });

  it('treats a field the editor never read as having been empty', () => {
    const out = mergeDiaryEdit({
      base: {},
      incoming: { hsNotes: 'Toolbox talk' },
      current: emptyNarrative,
    });
    expect(out.conflicted).toEqual([]);
    expect(out.merged).toEqual({ hsNotes: 'Toolbox talk' });
  });

  it('clearing a field somebody else has since filled is a conflict, not a silent wipe', () => {
    const out = mergeDiaryEdit({
      base: emptyNarrative,
      incoming: { issues: null },
      current: { ...emptyNarrative, issues: 'Water ingress' },
    });
    expect(out.conflicted.map((c) => c.field)).toEqual(['issues']);
  });
});

describe('attendanceTotals', () => {
  it('is zero for a day nobody has been recorded on', () => {
    expect(attendanceTotals([])).toEqual({
      workersPresentCount: 0,
      subcontractorsPresentCount: 0,
    });
  });

  /*
   * The split is by company, not by whether a user account is known. Splitting on
   * `userId` would file every hand-typed agency labourer as a subcontractor, and
   * the subcontractor count is the number a hiring company reads.
   */
  it('counts a hand-typed employee as a worker, not as a subcontractor', () => {
    expect(
      attendanceTotals([
        { providerCompanyId: null, headcount: 1 },
        { providerCompanyId: null, headcount: 1 },
      ])
    ).toEqual({ workersPresentCount: 2, subcontractorsPresentCount: 0 });
  });

  it('sums a crew line by its headcount rather than counting it as one person', () => {
    expect(
      attendanceTotals([
        { providerCompanyId: null, headcount: 2 },
        { providerCompanyId: 'c1', headcount: 6 },
        { providerCompanyId: 'c2', headcount: 3 },
      ])
    ).toEqual({ workersPresentCount: 2, subcontractorsPresentCount: 9 });
  });

  it('keeps a half day tidy instead of trailing floating-point dust', () => {
    expect(
      attendanceTotals([
        { providerCompanyId: null, headcount: 0.1 },
        { providerCompanyId: null, headcount: 0.2 },
      ]).workersPresentCount
    ).toBe(0.3);
  });
});

describe('closeDayPrompts', () => {
  const complete = {
    attendanceRows: 3,
    narrativeFieldsFilled: 4,
    evidenceCount: 12,
    unsubmittedTimeLogs: 0,
    startTime: '07:30',
    finishTime: '17:00',
  };

  it('says nothing about a day that is fully written up', () => {
    expect(closeDayPrompts(complete)).toEqual([]);
  });

  it('names an empty day one prompt at a time rather than as one lump', () => {
    const codes = closeDayPrompts({
      attendanceRows: 0,
      narrativeFieldsFilled: 0,
      evidenceCount: 0,
      unsubmittedTimeLogs: 2,
      startTime: null,
      finishTime: null,
    }).map((p) => p.code);
    expect(codes).toEqual([...CLOSE_DAY_PROMPT_CODES]);
  });

  it('counts one draft timesheet in the singular', () => {
    const prompt = closeDayPrompts({ ...complete, unsubmittedTimeLogs: 1 })[0];
    expect(prompt?.message).toMatch(/^1 time log/);
  });

  it('prompts when only one of the two times is set', () => {
    expect(closeDayPrompts({ ...complete, finishTime: null }).map((p) => p.code)).toEqual([
      'NO_TIMES',
    ]);
  });
});

describe('narrativeFieldsFilled', () => {
  it('does not count whitespace as writing', () => {
    expect(narrativeFieldsFilled({ delays: '   ', notes: null })).toBe(0);
  });

  it('counts only the fields that carry something', () => {
    expect(narrativeFieldsFilled({ delays: 'Crane late', weather: 'Dry', notes: null })).toBe(2);
  });
});

describe('suggestAttendance', () => {
  const log = {
    id: 'log-1',
    userId: 'u1',
    userName: 'Ade',
    providerCompanyId: 'ade-co',
    roleId: 'r1',
    roleName: 'Labourer',
    hours: 8,
  };

  it('files the diary’s own company as a worker rather than as a crew', () => {
    const [row] = suggestAttendance({
      timeLogs: [log],
      existingTimeLogIds: [],
      authoringCompanyId: 'ade-co',
    });
    expect(row?.providerCompanyId).toBeNull();
    expect(row?.headcount).toBe(1);
    expect(row?.source).toBe('TIME_LOG');
  });

  /*
   * Still offered, and marked. Dropping a line the day already carries would make
   * the prefill's list shrink as it is confirmed, so a supervisor re-opening the
   * screen cannot tell what it decided not to show them.
   */
  it('marks a suggestion the day already holds instead of hiding it', () => {
    const [row] = suggestAttendance({
      timeLogs: [log],
      existingTimeLogIds: ['log-1'],
      authoringCompanyId: 'ade-co',
    });
    expect(row?.alreadyPresent).toBe(true);
  });
});

describe('the sentences a person reads', () => {
  it('names the day the way a person would say it', () => {
    expect(describeDiaryDay('2026-03-03')).toBe('Tuesday 3 March');
  });

  it('does not invent a date out of something that is not one', () => {
    expect(describeDiaryDay('not-a-date')).toBe('not-a-date');
  });

  it('says nothing at all about a day that was never amended', () => {
    expect(describeAmendments(0)).toBeNull();
    expect(describeAmendments(-1)).toBeNull();
  });

  it('gets the singular right, which is where this kind of string usually fails', () => {
    expect(describeAmendments(1)).toBe('amended 1 time');
    expect(describeAmendments(3)).toBe('amended 3 times');
  });

  it('tells the loser of a close race who won and offers the recovery', () => {
    const message = describeCloseRace({
      closedByName: 'Ade',
      closedAt: '2026-03-03T17:04:00.000Z',
      zone: 'UTC',
    });
    expect(message).toBe('Ade closed this day at 17:04. Amend it with a reason?');
  });

  it('still says something useful when the closer has been anonymised', () => {
    expect(
      describeCloseRace({ closedByName: null, closedAt: '2026-03-03T17:04:00.000Z' })
    ).toMatch(/^Somebody else closed this day at 17:04/);
  });
});

describe('event payloads', () => {
  /*
   * §11 excludes the thirteen narrative fields and attendance names from every
   * payload. These two tests are the allowlist read backwards: whatever the
   * builders are handed, only the named keys come out.
   */
  it('diary.closed carries totals and ids, never prose', () => {
    const payload = diaryClosedEventPayload({
      diaryEntryId: 'e1',
      projectId: 'p1',
      ownerCompanyId: 'o1',
      authorCompanyId: 'a1',
      entryDate: '2026-03-03',
      actorUserId: 'u1',
      supervisorUserId: null,
      workersPresentCount: 4,
      subcontractorsPresentCount: 6,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'actorUserId',
      'authorCompanyId',
      'diaryEntryId',
      'entryDate',
      'ownerCompanyId',
      'projectId',
      'subcontractorsPresentCount',
      'supervisorUserId',
      'workersPresentCount',
    ]);
  });

  it('diary.amended carries changed field NAMES and the reason, never the values', () => {
    const payload = diaryAmendedEventPayload({
      diaryEntryId: 'e1',
      projectId: 'p1',
      ownerCompanyId: 'o1',
      authorCompanyId: 'a1',
      entryDate: '2026-03-03',
      actorUserId: 'u1',
      revision: 2,
      changedFields: ['delays', 'issues'],
      reason: 'Delivery note arrived the next morning',
    });
    expect(payload.changedFields).toEqual(['delays', 'issues']);
    expect(payload.reason).toBe('Delivery note arrived the next morning');
    expect(JSON.stringify(payload)).not.toContain('Crane');
  });
});

describe('the schemas, and what they refuse', () => {
  it('an attendance line has to name a person, a crew or a name', () => {
    expect(createDiaryAttendanceSchema.safeParse({ headcount: 4 }).success).toBe(false);
    expect(
      createDiaryAttendanceSchema.safeParse({ name: 'Agency labourer', headcount: 4 }).success
    ).toBe(true);
  });

  it('a headcount of zero is not attendance', () => {
    expect(
      createDiaryAttendanceSchema.safeParse({ name: 'Nobody', headcount: 0 }).success
    ).toBe(false);
  });

  /*
   * `status` is not a patchable field, and its absence is the design: a day whose
   * status can be PATCHed is a day anybody with write access can close, bypassing
   * `diary.close` and the whole amendment machinery behind it.
   */
  it('refuses to let status be patched onto an entry', () => {
    const result = updateDiaryEntrySchema.safeParse({ status: 'CLOSED' });
    expect(result.success).toBe(false);
  });

  it('refuses a patch that changes nothing but carries a reason', () => {
    expect(updateDiaryEntrySchema.safeParse({ reason: 'because' }).success).toBe(false);
  });

  it('accepts a patch with a base, which is what an offline edit sends', () => {
    const parsed = updateDiaryEntrySchema.safeParse({
      delays: 'Crane late',
      expectedRevision: 3,
      base: { delays: null },
    });
    expect(parsed.success).toBe(true);
  });

  it('a diary entry needs a date, and it has to look like one', () => {
    expect(createDiaryEntrySchema.safeParse({}).success).toBe(false);
    expect(createDiaryEntrySchema.safeParse({ entryDate: '3 March' }).success).toBe(false);
    expect(createDiaryEntrySchema.safeParse({ entryDate: '2026-03-03' }).success).toBe(true);
  });

  it('takes HH:MM and refuses seconds, which is what a time input sends', () => {
    expect(
      closeDiaryEntrySchema.safeParse({ startTime: '07:30', finishTime: '17:00' }).success
    ).toBe(true);
    expect(closeDiaryEntrySchema.safeParse({ startTime: '07:30:00' }).success).toBe(false);
    expect(closeDiaryEntrySchema.safeParse({ startTime: '25:00' }).success).toBe(false);
  });

  it('closes with an empty body, because Close Day usually has nothing to say', () => {
    expect(closeDiaryEntrySchema.safeParse({}).success).toBe(true);
  });
});
