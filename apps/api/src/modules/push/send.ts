import { tokensForCompanyManagers, tokensForUser } from './repo';

/**
 * Fire-and-forget Expo push (CREWQUO_V2_PLAN.md §3.4). Uses the public Expo push
 * service (https://exp.host) — no SDK, just fetch. Failures are swallowed and
 * logged; a notification never blocks or fails the request that triggered it.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

async function sendToTokens(tokens: string[], message: PushMessage): Promise<void> {
  const valid = tokens.filter((t) => t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken'));
  if (valid.length === 0) return;
  try {
    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        valid.map((to) => ({ to, sound: 'default', title: message.title, body: message.body, data: message.data }))
      ),
    });
  } catch (err) {
    console.warn('[push] send failed:', err);
  }
}

/** Notify a company's approvers (managers) — e.g. new work submitted for review. */
export async function notifyCompanyManagers(companyId: string, message: PushMessage): Promise<void> {
  await sendToTokens(await tokensForCompanyManagers(companyId), message);
}

/** Notify a single user's devices — e.g. their submission was approved/rejected. */
export async function notifyUser(userId: string, message: PushMessage): Promise<void> {
  await sendToTokens(await tokensForUser(userId), message);
}
