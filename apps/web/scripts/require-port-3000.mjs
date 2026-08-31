/**
 * Refuse to start unless the web app can have port 3000.
 *
 * WHY THIS IS NOT ALREADY GUARANTEED BY `-p 3000`. Both scripts pass it, and Next
 * treats it as a preference rather than a requirement: when 3000 is occupied it
 * prints `⚠ Port 3000 is in use, trying 3001 instead` and carries on. That warning
 * scrolls away, and what is left is an app that works and is on the wrong address —
 * which is the worst shape a misconfiguration can take, because everything that
 * depends on the address fails somewhere else:
 *
 *   · the API's CORS allowlist is built from APP_BASE_URL (http://localhost:3000),
 *     so a browser on :3001 gets opaque CORS failures rather than a wrong-port error;
 *   · every email link the mail adapter writes points at :3000, so a verification or
 *     closure link opens the *other* instance, or nothing;
 *   · Playwright's baseURL is :3000 with `reuseExistingServer`, so a suite can end up
 *     driving a stale server on 3000 while the one you just started is on 3001.
 *
 * So a hard failure here is cheaper than any of those, and the message is the point:
 * it says which port, that the drift would be silent, and what to do next.
 *
 * `net.createServer().listen()` rather than a fetch, because the question is "can I
 * bind this port", not "is something answering HTTP on it" — a socket held by a
 * non-HTTP process would pass the second test and still take the port.
 */
import { createServer } from 'node:net';

const PORT = 3000;
const HOST = '127.0.0.1';

/*
 * The same address Next will bind, and that has to match exactly. A probe on
 * 0.0.0.0 can succeed where a bind on 127.0.0.1 would fail and the reverse, so
 * checking a different interface from the one the server uses is a check that
 * answers a different question.
 */
const probe = createServer();

probe.once('error', (err) => {
  if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
    console.error(`[web] Could not check port ${PORT}: ${err.message}`);
    process.exit(1);
  }

  const reason =
    err.code === 'EACCES'
      ? `Port ${PORT} is not available to this user.`
      : `Port ${PORT} is already in use.`;

  console.error(`
[web] Refusing to start: ${reason}

  The web app must always run on http://localhost:${PORT}. Next.js would otherwise
  move to ${PORT + 1} with only a warning, leaving an app that loads but is at the
  wrong address — the API's CORS allowlist, every link in an outbound email, and
  Playwright's baseURL are all built from :${PORT}.

  If this is already your dev server, you do not need a second one.
  If it is something else, find and stop it:

    Windows    netstat -ano | findstr :${PORT}      then: taskkill /PID <pid> /F
    macOS      lsof -nP -iTCP:${PORT} -sTCP:LISTEN  then: kill <pid>
    Linux      ss -ltnp 'sport = :${PORT}'          then: kill <pid>
`);
  process.exit(1);
});

probe.once('listening', () => {
  /*
   * Released immediately so Next can take it. There is a gap between this close and
   * Next's bind that another process could theoretically win; that is unavoidable
   * for any pre-flight check, and losing it produces Next's own port-in-use warning
   * rather than a wrong answer here.
   */
  probe.close(() => process.exit(0));
});

probe.listen(PORT, HOST);
