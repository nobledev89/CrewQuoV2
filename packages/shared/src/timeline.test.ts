import { describe, expect, it } from 'vitest';
import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_SOURCES,
  decodeTimelineCursor,
  encodeTimelineCursor,
  timelineQuerySchema,
  timelineTypesFor,
  timelineTypesWithoutSource,
} from './timeline';

describe('the timeline source registry — §35', () => {
  it('declares every type exactly once', () => {
    expect(TIMELINE_SOURCES.map((s) => s.type).sort()).toEqual([...TIMELINE_EVENT_TYPES].sort());
    expect(new Set(TIMELINE_SOURCES.map((s) => s.type)).size).toBe(TIMELINE_EVENT_TYPES.length);
  });

  it('declares INCIDENT with no table, because the plan declares no table', () => {
    // Packet finding 10. `null` rather than a guessed phase number, exactly as
    // REPORT_SECTIONS carries `availableFrom: null` for PACK_INCIDENTS — the next
    // reader of §35 will come looking for this line.
    const incident = TIMELINE_SOURCES.find((s) => s.type === 'INCIDENT');
    expect(incident?.sourceTable).toBeNull();
    expect(timelineTypesWithoutSource()).toEqual(['INCIDENT']);
  });

  it('reports completion from the sign-off, because projects hold no completed_at', () => {
    const completed = TIMELINE_SOURCES.find((s) => s.type === 'PROJECT_COMPLETED');
    expect(completed?.sourceTable).toBe('client_signoffs');
  });

  it('keeps the schedule out of the client variant structurally', () => {
    // A schedule row names a person, a van and a registration — the shape of the
    // contractor's operation. The exclusion is a flag on this registry rather than a
    // `where` clause, so widening it means editing the line where the reason is.
    const schedule = TIMELINE_SOURCES.find((s) => s.type === 'SCHEDULE_ASSIGNED');
    expect(schedule?.clientVisibility).toBe('NEVER');
    expect(timelineTypesFor('CLIENT')).not.toContain('SCHEDULE_ASSIGNED');
  });

  it('keeps every PAY-side and internal class out of the client variant', () => {
    const client = timelineTypesFor('CLIENT');
    for (const type of [
      'SCHEDULE_ASSIGNED',
      'TIME_LOGGED',
      'EXPENSE_APPROVED',
      'DIARY_ENTRY',
      'ACTIVITY_RECORDED',
      'VARIATION_RAISED',
    ] as const) {
      expect(client).not.toContain(type);
    }
  });

  it('lets a decided variation cross but not a raised one — §13.6', () => {
    const raised = TIMELINE_SOURCES.find((s) => s.type === 'VARIATION_RAISED');
    const decided = TIMELINE_SOURCES.find((s) => s.type === 'VARIATION_DECIDED');
    expect(raised?.clientVisibility).toBe('NEVER');
    expect(decided?.clientVisibility).toBe('SOME');
  });

  it('omits sourceless types from both audiences', () => {
    expect(timelineTypesFor('INTERNAL')).not.toContain('INCIDENT');
    expect(timelineTypesFor('CLIENT')).not.toContain('INCIDENT');
  });

  it('distinguishes the two kinds of assignment, which are different records', () => {
    // `project_assignments` says a company is on the job — commercial structure the
    // client can see. `schedule_assignments` says which people and which van.
    const crew = TIMELINE_SOURCES.find((s) => s.type === 'CREW_ASSIGNED');
    expect(crew?.sourceTable).toBe('project_assignments');
    expect(crew?.clientVisibility).toBe('ALWAYS');
  });

  it('gates each source on the feature that governs its records, not on one key', () => {
    // Packet §13.7: a company without `site_diary` still has time logs and
    // photographs, so there is no single key the union could honestly be gated on.
    const byType = Object.fromEntries(TIMELINE_SOURCES.map((s) => [s.type, s]));
    expect(byType.DIARY_ENTRY?.feature).toBe('site_diary');
    expect(byType.EVIDENCE_UPLOADED?.feature).toBe('project_evidence');
    expect(byType.VARIATION_RAISED?.feature).toBe('variations');
    expect(byType.SCHEDULE_ASSIGNED?.feature).toBe('scheduling');
    // And the ones that are ungated because their records are.
    expect(byType.TIME_LOGGED?.feature).toBeNull();
    expect(byType.PROJECT_CREATED?.feature).toBeNull();
  });
});

describe('the keyset cursor', () => {
  it('round-trips', () => {
    const item = { at: '2027-06-08T07:00:00.000Z', id: 'VARIATION_RAISED:abc' };
    expect(decodeTimelineCursor(encodeTimelineCursor(item))).toEqual(item);
  });

  it('survives an id that itself contains the separator', () => {
    // Item ids are `<type>:<row id>`, and a naive `split('|')` would truncate any id
    // that ever grew a bar. Splitting on the first one only is the fix.
    const item = { at: '2027-06-08T07:00:00.000Z', id: 'X:a|b' };
    expect(decodeTimelineCursor(encodeTimelineCursor(item))).toEqual(item);
  });

  it('refuses garbage rather than paginating from a guess', () => {
    expect(decodeTimelineCursor('')).toBeNull();
    expect(decodeTimelineCursor('|abc')).toBeNull();
    expect(decodeTimelineCursor('2027-06-08T07:00:00.000Z|')).toBeNull();
    expect(decodeTimelineCursor('not-a-date|abc')).toBeNull();
    expect(decodeTimelineCursor('no-separator')).toBeNull();
  });
});

describe('the timeline query', () => {
  it('accepts a type filter and a cursor', () => {
    const parsed = timelineQuerySchema.parse({
      types: ['VARIATION_RAISED', 'DIARY_ENTRY'],
      cursor: '2027-06-08T07:00:00.000Z|X:1',
      limit: 50,
    });
    expect(parsed.types).toEqual(['VARIATION_RAISED', 'DIARY_ENTRY']);
  });

  it('refuses an unknown type rather than silently returning everything', () => {
    expect(timelineQuerySchema.safeParse({ types: ['NOT_A_TYPE'] }).success).toBe(false);
  });
});
