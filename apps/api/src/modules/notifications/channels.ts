import { env } from '../../env';
import { tokensForUser } from '../push/repo';

/**
 * The intrusive channels. In-product delivery is the `notifications` row itself
 * and never appears here — see the packet's §6.
 *
 * Every adapter returns one of three outcomes rather than throwing for all of
 * them, because the three mean different things to an operator:
 *
 *  - `sent`     — the provider accepted it.
 *  - `skipped`  — we deliberately did not send, and here is why. **Not a synonym
 *                 for sent.** A dev environment with no API key must not look
 *                 like a successful delivery in the history six months later.
 *  - `failed`   — with `retryable` deciding between "try again" and "stop". A
 *                 dead push token is permanent: no number of retries will bring
 *                 a device back, and burning eight attempts on it just delays the
 *                 dead letter that tells somebody the truth.
 */

export type ChannelOutcome =
  | { status: 'sent'; providerMessageId: string | null }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean };

export interface OutgoingMessage {
  recipientUserId: string;
  recipientEmail: string | null;
  recipientName: string | null;
  title: string;
  body: string;
  actionUrl: string | null;
}

/** Escape before any value reaches HTML: a project name is user-controlled. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEmailHtml(message: OutgoingMessage): string {
  const link = message.actionUrl
    ? `<p><a href="${escapeHtml(new URL(message.actionUrl, env.APP_BASE_URL).toString())}">Open in CrewQuo</a></p>`
    : '';
  return [
    `<p>${escapeHtml(message.body)}</p>`,
    link,
    `<p style="color:#666;font-size:12px">You are receiving this because of your CrewQuo notification settings.</p>`,
  ].join('\n');
}

export async function sendEmail(message: OutgoingMessage): Promise<ChannelOutcome> {
  if (!message.recipientEmail) {
    // Permanent by nature: no retry produces an address.
    return { status: 'failed', error: 'Recipient has no email address', retryable: false };
  }
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM_EMAIL) {
    // The same shape the verify/reset links already use in dev — but recorded,
    // so "nothing arrived" is answerable rather than a shrug.
    console.log(`[notify:email] (not configured) to=${message.recipientEmail} :: ${message.title}`);
    return { status: 'skipped', reason: 'No email provider configured for this environment' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.NOTIFICATION_FROM_EMAIL,
        to: [message.recipientEmail],
        subject: message.title,
        html: renderEmailHtml(message),
      }),
    });
    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { status: 'sent', providerMessageId: json.id ?? null };
    }
    const text = await res.text().catch(() => '');
    // 4xx is our mistake or a bad address — retrying re-sends the same wrong
    // thing. 429 is the exception: it is a 4xx that explicitly means "later".
    const retryable = res.status >= 500 || res.status === 429;
    return { status: 'failed', error: `Resend ${res.status}: ${text.slice(0, 500)}`, retryable };
  } catch (err) {
    // Network-shaped: the provider may be fine in a minute.
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendPush(message: OutgoingMessage): Promise<ChannelOutcome> {
  const tokens = (await tokensForUser(message.recipientUserId)).filter(
    (t) => t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken')
  );
  if (tokens.length === 0) {
    // Not a failure: most users never install the app, and recording eight
    // failed attempts for each of them would bury the real dead letters.
    return { status: 'skipped', reason: 'No registered device for this user' };
  }
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          sound: 'default',
          title: message.title,
          body: message.body,
          data: message.actionUrl ? { url: message.actionUrl } : undefined,
        }))
      ),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        status: 'failed',
        error: `Expo ${res.status}: ${text.slice(0, 500)}`,
        retryable: res.status >= 500 || res.status === 429,
      };
    }
    return { status: 'sent', providerMessageId: null };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}
