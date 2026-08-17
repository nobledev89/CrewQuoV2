'use client';

import { useState } from 'react';
import { Button, Notice, Row } from '@crewquo/ui';

/**
 * The accept link for a freshly created invite.
 *
 * This is not a convenience. Email delivery (Resend) is deferred to Phase 5, so
 * **the token shown here is the only copy that reaches a human** — the API returns
 * it once, on the create call, and nothing re-reads it afterwards. If the screen
 * dropped it the invite would exist in the database with no way to accept it. Hence
 * the explicit warning: send it yourself, and it will not be shown again.
 */
export function InviteLink({
  token,
  email,
  onDismiss,
}: {
  token: string;
  email: string;
  onDismiss?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url =
    typeof window === 'undefined'
      ? `/invite/${token}`
      : `${window.location.origin}/invite/${token}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the input below is selectable either way.
      setCopied(false);
    }
  }

  return (
    <Notice>
      <div className="cq-stack" style={{ gap: 10 }}>
        <div>
          <strong>Send this link to {email}.</strong> CrewQuo does not email invites yet,
          so this is the only copy — it is not shown again once you leave this screen.
        </div>
        <input
          className="cq-input"
          readOnly
          value={url}
          aria-label="Invite accept link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Row>
          <Button size="sm" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          {onDismiss ? (
            <Button size="sm" variant="secondary" onClick={onDismiss}>
              I have sent it
            </Button>
          ) : null}
        </Row>
      </div>
    </Notice>
  );
}
