import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendEmail } from './channels';

/**
 * The one branch of the email adapter that must hold with no provider, no network
 * and no environment: an address that cannot receive mail is never posted anywhere.
 *
 * Worth a test rather than a comment because the failure is invisible locally and
 * expensive remotely. Both suites in this repo address fixtures at reserved
 * domains, so the moment a live API key is present a full run would post dozens of
 * provably-undeliverable messages and earn hard bounces against the account's own
 * sending reputation — the thing that decides whether real password-reset mail
 * arrives. Nothing in a test run would look wrong while it happened.
 *
 * **`fetch` is replaced, not merely observed.** The first version of this file used
 * `vi.spyOn` with no implementation, which calls through — so the day a real
 * `RESEND_API_KEY` appeared in `.env`, the test that exists to prove nothing is sent
 * sent something. `env` reads the repo-root `.env` whatever `NODE_ENV` says, so a
 * unit test here is only hermetic if the transport is stubbed outright.
 */
describe('sendEmail address guard', () => {
  const message = {
    recipientName: 'Fixture',
    title: 'Test',
    body: 'Body',
    actionUrl: null,
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_stub' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses reserved domains without touching the network', async () => {
    for (const address of [
      'dana@verify.crewquo.test',
      'ola@parity.crewquo.test',
      'someone@example.com',
      'someone@anything.invalid',
      // Bare labels, no subdomain. `root@localhost` is the one that got through the
      // first version of the guard, and is also the likeliest to be typed by hand.
      'root@localhost',
      'someone@test',
    ]) {
      const outcome = await sendEmail({ ...message, recipientEmail: address });
      expect(outcome.status, address).toBe('skipped');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('matches on the domain, not on the string appearing anywhere', async () => {
    // `test@corporatespec.com` and `invalid@example.co.uk` both contain a reserved
    // word. A substring check would silently stop mailing real people — the failure
    // mode nobody reports, because the person who never got the email cannot know.
    for (const address of ['test@corporatespec.com', 'invalid@example.co.uk']) {
      const outcome = await sendEmail({ ...message, recipientEmail: address });
      const reason = outcome.status === 'skipped' ? outcome.reason : '';
      expect(reason, address).not.toMatch(/Reserved/);
    }
  });

  it('treats a missing address as a permanent failure, not a skip', async () => {
    // No retry produces an address, and a skip would lose the fact that somebody
    // who should have been told has nowhere to be told.
    const outcome = await sendEmail({ ...message, recipientEmail: null });
    expect(outcome).toEqual({
      status: 'failed',
      error: 'Recipient has no email address',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
