'use strict';
/**
 * A parent that spawns the stand-in and then exits immediately (Issue #2146).
 *
 * This is `commandmate remote up` reduced to the one thing that makes the bug
 * fire: it starts a long-running child and then calls `process.exit()` while
 * that child is still writing to fd 2. Everything else about `up` — the metrics
 * poll, the pairing code, the QR — is irrelevant to whether the child survives.
 *
 * The stdio shape is passed in rather than hard-coded, so the regression test
 * can drive this with the shape the *production* Provider actually builds. If
 * the Provider goes back to `stdio: [..., 'pipe']`, this parent reproduces that
 * and the child dies, which is the point.
 *
 * argv[2] is JSON:
 *   { standin: string, stderr: 'pipe'|'ignore'|'inherit'|'file',
 *     logPath: string, detached: boolean, unref: boolean }
 *
 * Writes `{"pid":<child pid>}` to fd 1 and exits 0.
 */
const { spawn } = require('child_process');
const fs = require('fs');

const spec = JSON.parse(process.argv[2]);

// 'file' stands for "a file descriptor". The production Provider opens its own
// log file and puts the descriptor in slot 2; this does the same thing to the
// path it was given, because a descriptor number cannot cross a process
// boundary.
let ownFd = null;
let stderrSlot = spec.stderr;
if (spec.stderr === 'file') {
  ownFd = fs.openSync(spec.logPath, 'w', 0o600);
  stderrSlot = ownFd;
}

const child = spawn(process.execPath, [spec.standin], {
  detached: spec.detached === true,
  stdio: ['ignore', 'ignore', stderrSlot],
});

if (ownFd !== null) fs.closeSync(ownFd);

// The Provider reads the pipe when there is one, so read it here too: the two
// shapes must differ only in what fd 2 is, not in whether anyone drains it.
if (child.stderr) child.stderr.on('data', () => {});

if (spec.unref === true) child.unref();

// writeSync, not process.stdout.write: a write to a pipe is asynchronous and
// process.exit() would truncate it.
fs.writeSync(1, `${JSON.stringify({ pid: child.pid })}\n`);

// Exactly what the CLI does once it has the URL, and the moment the bug fires.
process.exit(0);
