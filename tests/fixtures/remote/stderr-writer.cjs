'use strict';
/**
 * Stand-in for cloudflared (Issue #2146).
 *
 * cloudflared is not needed to reproduce the bug, and using it would make the
 * regression test depend on a binary, an account-less Cloudflare service and a
 * network. What actually matters is one property of the real process: it keeps
 * writing to fd 2 for several seconds after it starts, and it dies if that
 * write fails. This script has exactly that property and nothing else.
 *
 * The write is deliberately NOT wrapped in try/catch. When fd 2 is a pipe whose
 * read end has closed, `fs.writeSync` throws EPIPE, the throw is uncaught, and
 * the process ends — the same fate SIGPIPE gives cloudflared, which is Go and
 * does not ignore that signal. Catching it here would turn the failure this
 * test exists to detect into a green.
 *
 * Prints nothing to stdout: the parent reports the pid, not the child.
 */
const fs = require('fs');

/** Long enough for any assertion here, short enough that a leak self-clears. */
const LIFETIME_MS = 10_000;

/** Small enough never to fill a pipe buffer, frequent enough to fail fast. */
const WRITE_INTERVAL_MS = 10;

const deadline = Date.now() + LIFETIME_MS;

const timer = setInterval(() => {
  if (Date.now() >= deadline) {
    clearInterval(timer);
    process.exit(0);
    return;
  }
  fs.writeSync(2, `standin ${String(Date.now())} still here\n`);
}, WRITE_INTERVAL_MS);
