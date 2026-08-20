import { randomUUID } from 'node:crypto';
import {
  jobHealth,
  SCHEDULED_JOBS,
  type JobHealth,
  type ScheduledJob,
} from '@crewquo/shared';
import { query, queryOne } from '../db';
import { log } from '../observability/log';

/**
 * The record of scheduled work running, and the read behind the alarm
 * (`observability-data-lifecycle.md` §14 step 1).
 *
 * The persistence half. The policy half — how long is too long, and what a
 * never-succeeded job means — is pure and lives in `@crewquo/shared`, because a
 * deadline is easy to get subtly wrong in both directions and neither direction
 * needs a database to demonstrate.
 */

export interface JobRunHandle {
  id: string;
  runId: string;
  job: ScheduledJob;
}

/**
 * Open a run. Called before the work, so a pass that dies mid-flight leaves
 * `RUNNING` behind rather than nothing at all.
 *
 * That distinction is the point: a missing row and a `RUNNING` row are different
 * facts. Nothing decided the second one went wrong — the process simply stopped
 * existing, which is what a killed runner or a mid-pass deploy looks like — and
 * an operator reading the console should see that rather than a gap they have to
 * interpret.
 */
export async function startJobRun(job: ScheduledJob): Promise<JobRunHandle> {
  const runId = randomUUID();
  const row = await queryOne<{ id: string }>(
    `insert into job_runs (job, run_id) values ($1, $2) returning id`,
    [job, runId]
  );
  if (!row) throw new Error(`could not open a job run for ${job}`);

  log('info', 'job_started', { job, jobId: runId });
  return { id: row.id, runId, job };
}

export interface JobRunCounts {
  claimed?: number;
  succeeded?: number;
  failed?: number;
}

/** Close a run as successful, with what it moved. Counts only, never contents. */
export async function finishJobRun(
  handle: JobRunHandle,
  counts: JobRunCounts = {}
): Promise<void> {
  await query(
    `update job_runs
        set outcome = 'SUCCEEDED', finished_at = now(),
            claimed = $2, succeeded = $3, failed = $4
      where id = $1`,
    [handle.id, counts.claimed ?? 0, counts.succeeded ?? 0, counts.failed ?? 0]
  );

  log('info', 'job_finished', {
    job: handle.job,
    jobId: handle.runId,
    claimed: counts.claimed,
    succeeded: counts.succeeded,
    failed: counts.failed,
  });
}

/**
 * Close a run as failed.
 *
 * **The message is recorded, never the payload that produced it.** A job error is
 * operational data an operator reads; the row that caused it belongs to a tenant,
 * and a job log quoting payloads would be a copy of the notification queue with
 * weaker access control than the queue has (§7). Truncated because an error is a
 * sentence for a person, and a stack thousands of characters long in a column is a
 * log file that has escaped into the database.
 */
export async function failJobRun(handle: JobRunHandle, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);

  await query(
    `update job_runs set outcome = 'FAILED', finished_at = now(), error = $2 where id = $1`,
    [handle.id, message]
  );

  log('error', 'job_failed', {
    job: handle.job,
    jobId: handle.runId,
    errorClass: err instanceof Error ? err.constructor.name : typeof err,
  });
}

/**
 * Run one pass, recorded either way.
 *
 * A wrapper rather than three copies of try/catch/finally in three CLIs, because
 * the one thing every caller must not be able to forget is closing the row — and
 * a job that silently never reports success is exactly the state the alarm reads
 * as "the scheduler has stopped". Getting that wrong would make the switch fire on
 * a bug in the switch.
 */
export async function recordJobRun(
  job: ScheduledJob,
  work: (handle: JobRunHandle) => Promise<JobRunCounts | void>
): Promise<void> {
  const handle = await startJobRun(job);
  try {
    const counts = await work(handle);
    await finishJobRun(handle, counts ?? {});
  } catch (err) {
    await failJobRun(handle, err);
    throw err;
  }
}

/**
 * When each job last succeeded, and whether that is too long ago.
 *
 * One query for all three rather than one per job: the answer is read on every
 * operator dashboard load and by the health probe, and three round trips to
 * answer "is anything wrong" is three chances for the answer to be partly stale.
 */
export async function readJobHealth(now: Date = new Date()): Promise<JobHealth[]> {
  const rows = await query<{ job: string; last_success: Date | null }>(
    `select j.job, max(r.finished_at) as last_success
       from unnest($1::text[]) as j(job)
       left join job_runs r on r.job = j.job and r.outcome = 'SUCCEEDED'
      group by j.job`,
    [[...SCHEDULED_JOBS]]
  );

  const lastSuccessAt: Partial<Record<ScheduledJob, Date | null>> = {};
  for (const row of rows) {
    lastSuccessAt[row.job as ScheduledJob] = row.last_success ?? null;
  }

  /*
   * No `since`, so a job that has never succeeded reads as overdue rather than
   * unknown. On a fresh deployment that is briefly and correctly red: the
   * scheduler genuinely has not run yet, and the first successful pass clears it
   * within one interval. The alternative — treating "no evidence" as "no problem"
   * — is silent on exactly the deployment where the schedule was never wired up,
   * which is the failure this whole slice exists to catch.
   */
  return jobHealth({ now, lastSuccessAt });
}

/**
 * Drop job runs past the operational 30-day retention (§7).
 *
 * Called from the auth-retention pass rather than given a job of its own. A table
 * whose purpose is to record whether jobs are running, pruned by a job that can
 * itself stop, would be one more thing somebody has to notice had stopped — and
 * the pruning is two orders of magnitude cheaper than the pass it rides along
 * with.
 *
 * Safe for the same reason the attempt pruner is: these rows are a heartbeat, and
 * the evidence of what the platform actually did to anybody's data is in
 * `audit_logs` and `platform_audit_logs`, neither of which this can touch.
 */
export async function pruneJobRuns(olderThanDays = 30): Promise<number> {
  const deleted = await query<{ id: string }>(
    `delete from job_runs where started_at < now() - ($1 || ' days')::interval returning id`,
    [String(olderThanDays)]
  );
  return deleted.length;
}
