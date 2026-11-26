/**
 * A lock holder / waiter in its own process, for the #4277 lock tests.
 *
 *   node lock-actor-4277.mjs <machine-lock-sync.mjs> <root> <name> <pollMs> <holdMs> <timeoutMs> <events> [grandchild]
 *   node lock-actor-4277.mjs <machine-lock-sync.mjs> <root> <name> <pollMs> <holdMs> <timeoutMs> <events> gen '<json>'
 *
 * Takes `<name>` with scripts/orchestrate/machine-lock-sync.mjs (tickets), appends one JSON line per
 * event to `<events>` (start / acquired / not-acquired / released / grandchild), holds the lock
 * `holdMs`, releases it and exits. With `grandchild` it names its own process group in the owner
 * (it is started detached), starts `sleep 30` in that group and waits to be killed.
 *
 * `gen` (#4559, the generation chain's T2): the options are JSON — `genDir` (the generation directory),
 * `handOff` (hand the holding to this process's own pid and group after the take), `fields` (a
 * setOwnerFields after the take), `nowAheadMs` (a clock this far ahead: others' tickets are past their
 * deadline, as the stalled recoverer's of #4559's report). The events carry the generation and the token, and `released` the
 * release's answer. The pauses are the core's own (CM_VERIFY_TEST_HANDOFF=pause:<stage>#<n>).
 * #4559 PR-2 r6: `fields` may be the object to write (merge-pr's phase), `ownerFields` the record's own fields
 * (merge-pr's `phase: 'idle'`), `seams` logs every seam the core reaches (`seam` events: stage and count), and
 * `ready` names a file written once the take (and the fields) are done.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [modulePath, root, name, pollMs, holdMs, timeoutMs, eventsFile, mode] = process.argv.slice(2);
const { acquireMachineLockSync, sleepSync } = await import(pathToFileURL(modulePath).href);
const emit = (event, extra = {}) =>
  fs.appendFileSync(eventsFile, `${JSON.stringify({ event, t: Date.now(), pid: process.pid, ...extra })}\n`);

if (mode === 'gen') {
  const o = JSON.parse(process.argv[10] ?? '{}');
  emit('start');
  const hooks = {
    ...(o.nowAheadMs ? { now: () => Date.now() + o.nowAheadMs, startOf: () => 0 } : {}),
    ...(o.genDir ? { genDir: o.genDir } : {}),
    ...(o.seams ? { onGenStage: (stage, n) => emit('seam', { stage, n }) } : {}),
  };
  const held = acquireMachineLockSync(name, { root, timeoutMs: Number(timeoutMs), pollMs: Number(pollMs), hooks, ...(o.ownerFields ? { ownerFields: o.ownerFields } : {}) });
  emit(held.acquired ? 'acquired' : 'not-acquired', { gen: held.gen ?? null, token: held.token ?? null, heldBy: held.heldBy ?? null });
  if (!held.acquired) process.exit(3);
  if (o.fields) emit('fields', { ok: held.setOwnerFields(typeof o.fields === 'object' ? o.fields : { phase: 'write' }) });
  if (o.handOff) emit('handoff', held.handOff(process.pid, process.pid));
  if (o.ready) fs.writeFileSync(o.ready, String(process.pid));
  sleepSync(Number(holdMs));
  emit('releasing', { gen: held.gen });
  emit('released', { gen: held.gen, result: held.release() });
  process.exit(0);
}

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
