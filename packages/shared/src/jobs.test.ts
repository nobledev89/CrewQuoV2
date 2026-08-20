import { describe, expect, it } from 'vitest';
import { JOB_SCHEDULES, SCHEDULED_JOBS, jobHealth } from './jobs';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function healthFor(lastSuccessAt: Parameters<typeof jobHealth>[0]['lastSuccessAt'], since?: Date | null) {
  const result = jobHealth({ now: NOW, lastSuccessAt, since });
  return Object.fromEntries(result.map((h) => [h.job, h]));
}

describe('job schedules', () => {
  it('gives every scheduled job a deadline', () => {
    for (const job of SCHEDULED_JOBS) {
      expect(JOB_SCHEDULES[job]).toBeDefined();
    }
  });

  it('sets every deadline at several missed intervals, not one', () => {
    // One skipped run is a busy shared runner; four in a row is a stopped
    // schedule. A deadline of interval-plus-a-bit would cry wolf on the normal
    // case, and an alarm nobody believes is an alarm nobody reads.
    for (const job of SCHEDULED_JOBS) {
      const { intervalSeconds, overdueAfterSeconds } = JOB_SCHEDULES[job];
      expect(overdueAfterSeconds / intervalSeconds).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('describes each job by what an operator loses, not by its mechanism', () => {
    for (const job of SCHEDULED_JOBS) {
      expect(JOB_SCHEDULES[job].describes.length).toBeGreaterThan(20);
      expect(JOB_SCHEDULES[job].describes).not.toMatch(/job_runs|cron|setInterval/);
    }
  });
});

describe('jobHealth', () => {
  it('is content with a job that succeeded a moment ago', () => {
    const health = healthFor({ workers: ago(60) });
    expect(health.workers?.overdue).toBe(false);
    expect(health.workers?.secondsSinceSuccess).toBe(60);
  });

  it('tolerates a single missed interval', () => {
    // 6 minutes on a 5-minute cadence. GitHub's `schedule` is best-effort and
    // drops runs under load, so this is the normal case rather than an incident.
    expect(healthFor({ workers: ago(6 * 60) }).workers?.overdue).toBe(false);
  });

  it('raises once the deadline passes', () => {
    expect(healthFor({ workers: ago(21 * 60) }).workers?.overdue).toBe(true);
  });

  it('treats a job that has never succeeded as overdue, not as unknown', () => {
    // The case that matters most, and the one a naive implementation gets
    // backwards. On the day the scheduler is wired up wrong there is no
    // last-success row at all, and reading a missing row as "no evidence of a
    // problem" makes the alarm silent for exactly that deployment.
    const health = healthFor({});
    for (const job of SCHEDULED_JOBS) {
      expect(health[job]?.overdue).toBe(true);
      expect(health[job]?.lastSuccessAt).toBeNull();
      expect(health[job]?.secondsSinceSuccess).toBeNull();
    }
  });

  it('gives a freshly started deployment one deadline of grace', () => {
    // A platform that booted two minutes ago has not failed to run anything yet.
    expect(healthFor({}, ago(2 * 60)).workers?.overdue).toBe(false);
    // ...and stops making excuses for it once the deadline has passed.
    expect(healthFor({}, ago(21 * 60)).workers?.overdue).toBe(true);
  });

  it('judges each job against its own deadline', () => {
    // Nine hours: long dead for a five-minute drain, perfectly fine for a daily
    // purge. A single global deadline would either page on a healthy purge or
    // stay silent on a stopped drain.
    const health = healthFor({
      workers: ago(9 * 60 * 60),
      'audit-retention': ago(9 * 60 * 60),
      'auth-retention': ago(9 * 60 * 60),
    });
    expect(health.workers?.overdue).toBe(true);
    expect(health['audit-retention']?.overdue).toBe(false);
    expect(health['auth-retention']?.overdue).toBe(false);
  });

  it('reports every job on every call, so a missing one cannot read as healthy', () => {
    expect(jobHealth({ now: NOW, lastSuccessAt: { workers: ago(30) } })).toHaveLength(
      SCHEDULED_JOBS.length
    );
  });

  it('reads a success timestamped in the future as "just now", not as negative', () => {
    // Postgres writes finished_at and the application supplies `now`; a few
    // hundred milliseconds of skew between the two is normal, and floors to -1
    // for a pass that just finished. Negative would render as "-1m ago" and
    // would read to any `seconds > deadline` comparison as the freshest possible
    // success.
    const health = healthFor({ workers: new Date(NOW.getTime() + 2_000) });
    expect(health.workers?.secondsSinceSuccess).toBe(0);
    expect(health.workers?.overdue).toBe(false);
  });

  it('carries the last success as an instant a console can render', () => {
    const at = ago(120);
    expect(healthFor({ workers: at }).workers?.lastSuccessAt).toBe(at.toISOString());
  });
});
