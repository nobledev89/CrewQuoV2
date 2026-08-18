import { describe, expect, it } from 'vitest';
import {
  resolveLandingRoute,
  resolveSelectedWorkspaceView,
  resolveWorkspaceViews,
  type WorkspaceEligibilityFacts,
} from './workspace';

const NONE: WorkspaceEligibilityFacts = {
  operationsEntitled: false,
  hasProviderRelationship: false,
  hasAssignedWork: false,
  hasClientRelationship: false,
  hasPortalProject: false,
};

describe('resolveWorkspaceViews', () => {
  it('returns the operations view only for an entitled operating company', () => {
    expect(resolveWorkspaceViews({ ...NONE, operationsEntitled: true })).toEqual(['OPERATIONS']);
  });

  it('returns the subcontractor view for a provider relationship or assignment', () => {
    expect(resolveWorkspaceViews({ ...NONE, hasProviderRelationship: true })).toEqual([
      'SUBCONTRACTOR',
    ]);
    expect(resolveWorkspaceViews({ ...NONE, hasAssignedWork: true })).toEqual(['SUBCONTRACTOR']);
  });

  it('returns the client view before or after a portal project is published', () => {
    expect(resolveWorkspaceViews({ ...NONE, hasClientRelationship: true })).toEqual(['CLIENT']);
    expect(resolveWorkspaceViews({ ...NONE, hasPortalProject: true })).toEqual(['CLIENT']);
  });

  it('supports a free company that is both a subcontractor and client', () => {
    expect(
      resolveWorkspaceViews({
        ...NONE,
        hasProviderRelationship: true,
        hasClientRelationship: true,
      })
    ).toEqual(['SUBCONTRACTOR', 'CLIENT']);
  });

  it('supports all three views without duplicating a view when two facts imply it', () => {
    expect(
      resolveWorkspaceViews({
        operationsEntitled: true,
        hasProviderRelationship: true,
        hasAssignedWork: true,
        hasClientRelationship: true,
        hasPortalProject: true,
      })
    ).toEqual(['OPERATIONS', 'SUBCONTRACTOR', 'CLIENT']);
  });

  it('returns no customer view for an unentitled, unassigned setup company', () => {
    expect(resolveWorkspaceViews(NONE)).toEqual([]);
  });
});

describe('workspace selection', () => {
  it('uses a valid deep-link view, then valid current and device preferences', () => {
    const eligible = ['OPERATIONS', 'CLIENT'] as const;
    expect(resolveSelectedWorkspaceView([...eligible], ['CLIENT'], 'OPERATIONS', null)).toBe('CLIENT');
    expect(resolveSelectedWorkspaceView([...eligible], ['SUBCONTRACTOR'], 'OPERATIONS', 'CLIENT')).toBe('OPERATIONS');
    expect(resolveSelectedWorkspaceView([...eligible], null, null, 'CLIENT')).toBe('CLIENT');
  });

  it('keeps the active lens on a route shared by more than one eligible view', () => {
    const eligible = ['OPERATIONS', 'CLIENT'] as const;
    expect(resolveSelectedWorkspaceView([...eligible], eligible, 'CLIENT', 'OPERATIONS')).toBe('CLIENT');
    expect(resolveSelectedWorkspaceView([...eligible], eligible, null, 'CLIENT')).toBe('CLIENT');
  });

  it('falls back to the first eligible view and returns null for account setup', () => {
    expect(resolveSelectedWorkspaceView(['SUBCONTRACTOR', 'CLIENT'], null, null, null)).toBe('SUBCONTRACTOR');
    expect(resolveSelectedWorkspaceView([], ['OPERATIONS'], 'OPERATIONS', 'CLIENT')).toBeNull();
  });

});

describe('resolveLandingRoute', () => {
  it('maps every customer view and account setup explicitly', () => {
    expect(resolveLandingRoute({ view: 'OPERATIONS' })).toBe('/app');
    expect(resolveLandingRoute({ view: 'SUBCONTRACTOR' })).toBe('/work');
    expect(resolveLandingRoute({ view: 'CLIENT' })).toBe('/portal');
    expect(resolveLandingRoute({ view: null })).toBe('/profile');
  });

  it('routes platform staff to the platform and preserves a safe requested path', () => {
    expect(resolveLandingRoute({ isSuperAdmin: true })).toBe('/admin');
    expect(resolveLandingRoute({ isSuperAdmin: true, requestedPath: '/invite/token' })).toBe('/invite/token');
  });

  it('rejects protocol-relative and backslash redirect values', () => {
    expect(resolveLandingRoute({ requestedPath: '//evil.example' })).toBe('/profile');
    expect(resolveLandingRoute({ requestedPath: '/\\evil.example' })).toBe('/profile');
  });
});
