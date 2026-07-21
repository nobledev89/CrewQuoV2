import { describe, it, expect } from 'vitest';
import { membershipRoleSchema, SHIFT_TYPE_TO_RATE_LABEL } from './index';

describe('shared enums', () => {
  it('accepts a valid membership role', () => {
    expect(membershipRoleSchema.parse('OWNER')).toBe('OWNER');
  });

  it('rejects an invalid membership role', () => {
    expect(() => membershipRoleSchema.parse('SUBCONTRACTOR')).toThrow();
  });

  it('maps shift types to rate-card labels', () => {
    expect(SHIFT_TYPE_TO_RATE_LABEL.WEEKDAY_DAY).toBe('MON_FRI_DAY');
    expect(SHIFT_TYPE_TO_RATE_LABEL.NIGHT).toBe('MON_THU_NIGHT');
  });
});
