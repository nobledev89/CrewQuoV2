import { describe, expect, it } from 'vitest';
import {
  complianceAlertThreshold,
  complianceDaysUntil,
  deriveComplianceStatus,
  evaluateCompliance,
  type ComplianceDocumentView,
} from './compliance';

const row = (
  status: ComplianceDocumentView['status'],
  kind: ComplianceDocumentView['kind'] = 'PUBLIC_LIABILITY',
  title = 'Public liability'
) => ({ kind, title, status, mandatory: true, expiresOn: status === 'EXPIRING' ? '2026-09-10' : null });

describe('compliance status and ladder', () => {
  it('distinguishes missing, rejected, expired, expiring and valid', () => {
    expect(deriveComplianceStatus({ fileId: null, expiresOn: null, today: '2026-09-03', rejected: false })).toBe('MISSING');
    expect(deriveComplianceStatus({ fileId: 'f', expiresOn: null, today: '2026-09-03', rejected: true })).toBe('REJECTED');
    expect(deriveComplianceStatus({ fileId: 'f', expiresOn: '2026-09-02', today: '2026-09-03', rejected: false })).toBe('EXPIRED');
    expect(deriveComplianceStatus({ fileId: 'f', expiresOn: '2026-12-02', today: '2026-09-03', rejected: false })).toBe('EXPIRING');
    expect(deriveComplianceStatus({ fileId: 'f', expiresOn: '2026-12-03', today: '2026-09-03', rejected: false })).toBe('VALID');
  });

  it('uses calendar dates and chooses each ladder rung', () => {
    expect(complianceDaysUntil('2026-09-04', '2026-09-03')).toBe(1);
    expect([91, 90, 61, 60, 31, 30, 15, 14, 8, 7, 0, -1].map(complianceAlertThreshold)).toEqual([
      null, 90, 90, 60, 60, 30, 30, 14, 14, 7, 7, null,
    ]);
  });
});

describe('compliance evaluation', () => {
  it('calls an empty register unknown rather than compliant', () => {
    expect(evaluateCompliance([]).overallStatus).toBe('UNKNOWN');
  });

  it('reports blocking rows and expiring rows separately', () => {
    const result = evaluateCompliance([row('EXPIRED'), row('EXPIRING', 'RAMS', 'RAMS')]);
    expect(result.overallStatus).toBe('EXPIRED');
    expect(result.blocking).toHaveLength(1);
    expect(result.expiring).toHaveLength(1);
  });

  it('allows a current shared certificate to satisfy a missing requirement of the same kind', () => {
    const result = evaluateCompliance([row('MISSING'), row('VALID')]);
    expect(result.overallStatus).toBe('VALID');
    expect(result.blocking).toEqual([]);
  });

  it('does not let optional records block work', () => {
    expect(evaluateCompliance([{ ...row('EXPIRED'), mandatory: false }]).overallStatus).toBe('UNKNOWN');
  });
});

