import { pruneAuthAttempts } from '../modules/auth/rateLimit';
import { pruneAuthSessions } from '../modules/auth/sessions.repo';

/**
 * Retention for the access domain (`docs/operating-model/access.md` §7).
 *
 * **`pruneAuthAttempts` was written by 0016 and never called by anything** — a
 * function with no caller, which is the same fault as a column with no reader, and
 * one this repo has caught twice already. This is its caller, and the session
 * pruner joins it here rather than starting a third one-shot job.
 *
 * Two different retentions, because they hold two different kinds of thing:
 *
 *  - **Attempt counters are operational.** They expire with their window and are
 *    pruned aggressively; a longer history of somebody's typing is a record §7
 *    explicitly refuses to keep.
 *  - **Session rows are personal, with a forensic tail.** "When did that device
 *    last sign in" has to outlive the token, so a session lingers well past its
 *    expiry before going.
 *
 * Neither prune can erase evidence. A lockout, a revocation and a detected reuse
 * are all rows in `platform_audit_logs`, which is insert-only and outside every
 * purge — including the tenant-configurable audit retention, so the cheapest way
 * to erase a compromise is *not* to downgrade the plan.
 */
export async function pruneAuthState(): Promise<{ attempts: number; sessions: number }> {
  const attempts = await pruneAuthAttempts();
  const sessions = await pruneAuthSessions();
  if (attempts > 0 || sessions > 0) {
    console.log(`[auth-retention] pruned ${attempts} attempt row(s), ${sessions} session(s)`);
  }
  return { attempts, sessions };
}
