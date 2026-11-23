/**
 * Issue #4560: verify-run.sh retires a ticket ahead of it with the token its judgement read, not one
 * read again when it retires.
 *
 * Before the fix the waiter judged ticket n retirable (its pid gone) and then passed
 * `$(lock_json_field <n> token)` to lock_mark_done — a second read. A ticket put at the same name in
 * between (a number reused after the GC, design 4432a §6 #2) was the one marked done: a live waiter's
 * ticket retired. The swap is put between the judgement and the retirement by wrapping
 * lock_ticket_retirable after the section is loaded (the way #4277's tests wrap `ln`). Both waits that
 * retire tickets are driven: the acquisition (lock_acquire_path) and the head wait (lock_wait_head,
 * through D6's lock_recover_only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { machineLockPath, machineLockQueuePath } from '@/lib/verification/machine-lock';
import { bashSection, cleanRoots, deadPid, freshRoot, HOST, VERIFY_RUN } from './lock-holder-identity-4558-harness';

afterEach(() => cleanRoots());

/** After the original judges, the ticket at $SWAP_FILE is replaced (rename) by $SWAP_TEXT, once. */
const WRAP = `
eval "orig_$(declare -f lock_ticket_retirable)"
lock_ticket_retirable() {
  orig_lock_ticket_retirable "$@"
  wrap_rc=$?
  if [ -n "\${SWAP_FILE:-}" ] && [ "$1" = "$SWAP_FILE" ] && [ ! -e "$SWAP_FILE.swapped" ]; then
    : > "$SWAP_FILE.swapped"
    printf '%s\\n' "$SWAP_TEXT" > "$SWAP_FILE.tmp" && mv -f "$SWAP_FILE.tmp" "$SWAP_FILE"
  fi
  return $wrap_rc
}
`;

const CALLS = {
  acquire: 'lock_acquire x 0; echo "rc=$?"',
  'head wait (D6)': 'lock_recover_only "$LK" "${LK%.lock}.queue" 0; echo "$LRO_RESULT"',
};

function setup(tag: string) {
  const root = freshRoot(tag);
  const queue = machineLockQueuePath('x', root);
  fs.mkdirSync(queue, { recursive: true });
  const first = path.join(queue, '000000000001');
  // Ticket 1: a waiter whose pid is gone — retirable.
  fs.writeFileSync(first, JSON.stringify({ pid: deadPid(), host: HOST, token: 'old', createdAt: Date.now(), deadline: Date.now() + 60_000 }));
  // What is put there after the judgement: a live waiter's ticket under a new token.
  const live = JSON.stringify({ pid: process.pid, host: HOST, token: 'swapped', createdAt: Date.now(), deadline: Date.now() + 600_000 });
  return { root, first, live, lockPath: machineLockPath('x', root) };
}

function run(root: string, call: string, env: Record<string, string>) {
  return spawnSync('bash', ['-c', bashSection(`${WRAP}\n${call}`), 'bash', VERIFY_RUN], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CM_VERIFY_LOCK_ROOT: root, ...env },
  });
}

const ticket = (file: string): { token?: string; done?: boolean } => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { token: '(collected)' });

describe.each(Object.entries(CALLS))('#4560 bash %s: the ticket retired is the one judged', (_label, call) => {
  it('positive: the ticket replaced between the judgement and the retirement is not marked done', () => {
    const s = setup('4560');
    const r = run(s.root, call, { SWAP_FILE: s.first, SWAP_TEXT: s.live, LK: s.lockPath });
    expect(fs.existsSync(`${s.first}.swapped`), 'the swap was put into the window').toBe(true);
    const after = ticket(s.first);
    expect({ token: after.token, done: after.done === true }).toEqual({ token: 'swapped', done: false });
    expect(r.stderr).not.toContain('machine-lock-ticket-retired');
  });

  it('negative control: no swap — the dead waiter\'s ticket is retired, as before', () => {
    const s = setup('4560-ok');
    const r = run(s.root, call, { LK: s.lockPath });
    // Retired, and after an acquisition collected as a used ticket below the largest.
    const after = fs.existsSync(s.first) ? ticket(s.first) : { token: 'old', done: true };
    expect({ token: after.token, done: after.done === true }).toEqual({ token: 'old', done: true });
    expect(r.stderr).toContain(`machine-lock-ticket-retired ${s.first} (gone)`);
  });
});
