/**
 * A lock holder / waiter in its own process, for the #4277 lock tests.
 *
 *   node lock-actor-4277.mjs <machine-lock-sync.mjs> <root> <name> <pollMs> <holdMs> <timeoutMs> <events> [grandchild]
 *
 * Takes `<name>` with scripts/orchestrate/machine-lock-sync.mjs (tickets), appends one JSON line per
 * event to `<events>` (start / acquired / not-acquired / released / grandchild), holds the lock
 * `holdMs`, releases it and exits. With `grandchild` it names its own process group in the owner
 * (it is started detached), starts `sleep 30` in that group and waits to be killed.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [modulePath, root, name, pollMs, holdMs, timeoutMs, eventsFile, mode] = process.argv.slice(2);
const { acquireMachineLockSync, sleepSync } = await import(pathToFileURL(modulePath).href);
const emit = (event, extra = {}) =>
  fs.appendFileSync(eventsFile, `${JSON.stringify({ event, t: Date.now(), pid: process.pid, ...extra })}\n`);

emit('start');
const lock = acquireMachineLockSync(name, {
  root,
  timeoutMs: Number(timeoutMs),
  pollMs: Number(pollMs),
  ...(mode === 'grandchild' ? { pgid: process.pid } : {}),
});
emit(lock.acquired ? 'acquired' : 'not-acquired');
if (!lock.acquired) process.exit(3);
if (mode === 'grandchild') {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  emit('grandchild', { child: child.pid });
  setInterval(() => {}, 1000);
} else {
  sleepSync(Number(holdMs));
  lock.release();
  emit('released');
}
