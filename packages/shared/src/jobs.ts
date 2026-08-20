/**
 * Scheduled-job identity and the overdue policy (CREWQUO_V2_PLAN.md §2348).
 * Operating-model packet: `docs/operating-model/observability-data-lifecycle.md`
 * §9 and §14 step 1.
 *
 * Pure, because the interesting part of a dead man's switch is not the recording
 * — a table does that — but **the deadline**, and a deadline is where both failure
 * modes live. Too tight and the alarm cries wolf every time a shared runner is
 * busy, which is worse than no alarm: an alarm nobody believes is an alarm nobody
 * reads. Too loose and the thing it exists to catch — a schedule that stopped —
 * goes unnoticed for exactly as long as the slack allows.
 *
 * **Why there is a deadline at all.** The failure mode of scheduled work is not a
 * crash, it is silence, and silence is indistinguishable from a quiet week. Every
 * host option considered in §13.5 can stop quietly, and the chosen one has a
 * documented way of doing it: GitHub disables a `schedule` trigger after 60 days
 * without repository activity. So the scheduler ships with an alarm for its own
 * absence, or it is the same gap with a cron file added.
 */

export const SCHEDULED_JOBS = ['workers', 'audit-retention', 'auth-retention'] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export interface JobSchedule {
  /** How often the scheduler is configured to start a pass. */
  intervalSeconds: number;
  /**
   * How long after the last success before the job is called overdue.
   *
   * Always a multiple of the interval rather than the interval plus a constant,
   * so that a job is only ever declared dead after several consecutive misses.
   * One skipped run is a busy runner; four in a row is a stopped schedule.
   */
  overdueAfterSeconds: number;
  /** What an operator is told is not working, in their words rather than ours. */
  describes: string;
}

export const JOB_SCHEDULES: Readonly<Record<ScheduledJob, JobSchedule>> = {
  /**
   * The outbox drain and the notification delivery pass, scheduled as one unit
   * because they fail together and a split name would let one report success for
   * the pair.
   *
   * Five minutes is the cadence and twenty is the deadline — four misses. The
   * chosen host bills scheduled runs against Actions minutes and is explicit that
   * `schedule` is best-effort, so a single late run is the normal case rather than
   * an incident.
   */
  workers: {
    intervalSeconds: 5 * 60,
    overdueAfterSeconds: 20 * 60,
    describes: 'notifications and queued work are not being delivered',
  },

  /**
   * Retention runs daily and is given a day and a half.
   *
   * Deliberately not tighter. Nothing breaks for a customer when a purge is a few
   * hours late — the rows are expired, not exposed, because readability was never
   * gated on the purge having run. What a missed purge costs is the promise, and
   * that is a promise measured in days.
   */
  'audit-retention': {
    intervalSeconds: 24 * 60 * 60,
    overdueAfterSeconds: 36 * 60 * 60,
    describes: 'expired audit rows are not being deleted, and retention is a promise',
  },

  'auth-retention': {
    intervalSeconds: 24 * 60 * 60,
    overdueAfterSeconds: 36 * 60 * 60,
    describes: 'sign-in attempt counters and old session rows are not being pruned',
  },
};

export interface JobHealth {
  job: ScheduledJob;
  /** Null when the job has never succeeded — see below, this is not "fine". */
  lastSuccessAt: string | null;
  secondsSinceSuccess: number | null;
  overdue: boolean;
  describes: string;
}

/**
 * Decide whether each job is overdue, given when it last succeeded.
 *
 * **A job that has never succeeded is overdue, not unknown.** This is the case
 * that matters most and the one a naive implementation gets backwards: on the day
 * the scheduler is configured wrong — a bad secret, a workflow that never fires, a
 * typo in the job name — there is no last-success row at all, and treating a
 * missing row as "no evidence of a problem" means the alarm is silent for exactly
 * the deployment that needed it. The only exception is a platform that has not
 * finished starting, which is what `since` is for: nothing is judged before it has
 * had one interval to run.
 */
export function jobHealth(input: {
  now: Date;
  lastSuccessAt: Partial<Record<ScheduledJob, Date | null>>;
  /** When this deployment's clock started, so a fresh install is not instantly red. */
  since?: Date | null;
}): JobHealth[] {
  const nowMs = input.now.getTime();

  return SCHEDULED_JOBS.map((job) => {
    const schedule = JOB_SCHEDULES[job];
    const last = input.lastSuccessAt[job] ?? null;

    if (last === null) {
      // Grace only from a known start. Without one, never-succeeded is overdue.
      const graceUntil =
        input.since === null || input.since === undefined
          ? null
          : input.since.getTime() + schedule.overdueAfterSeconds * 1000;

      return {
        job,
        lastSuccessAt: null,
        secondsSinceSuccess: null,
        overdue: graceUntil === null ? true : nowMs > graceUntil,
        describes: schedule.describes,
      };
    }

    /*
     * Clamped at zero, because the two clocks involved are not the same clock.
     * `finished_at` is written by Postgres and `now` is the application's, and a
     * few hundred milliseconds of skew between them is normal — enough that a
     * pass which finished a moment ago floors to -1. Negative is not a smaller
     * number here, it is a nonsense one: it would render as "-1m ago" on the
     * operator console and, worse, any future comparison written as
     * `seconds > deadline` would quietly treat it as the freshest possible
     * success. A job cannot have succeeded in the future; when the arithmetic
     * says otherwise the honest reading is "just now".
     */
    const secondsSinceSuccess = Math.max(0, Math.floor((nowMs - last.getTime()) / 1000));
    return {
      job,
      lastSuccessAt: last.toISOString(),
      secondsSinceSuccess,
      overdue: secondsSinceSuccess > schedule.overdueAfterSeconds,
      describes: schedule.describes,
    };
  });
}
