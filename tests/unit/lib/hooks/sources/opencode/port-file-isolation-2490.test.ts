/**
 * The suite must not rewrite the developer's opencode port ledger (Issue #2490).
 *
 * `~/.commandmate/opencode-ports.json` is live production state, not a cache: a
 * running CommandMate server writes an instance's port there when it launches
 * the pane and reads it back on the next start to re-attach to the server that
 * outlived the process (`hooks/sources/opencode/reattach.ts`,
 * `slash-commands/opencode-live.ts`). `rememberOpencodePort` and
 * `forgetOpencodePort` are read-modify-write on that single JSON document, so a
 * test that reaches them without an override does not add a stray entry — it
 * rewrites the whole file from whatever it happened to read, and an assignment
 * the server made in between is gone. A lost assignment is not noisy: the pane
 * keeps running, the port is simply never found again and the session drops to
 * the scraper for the rest of its life.
 *
 * ## Why this file asserts rather than merely documents
 *
 * Unlike the COPILOT_HOME fence (#1942), this one was written after the leak,
 * not before it. Measured on the author's machine 2026-09-12: the real ledger
 * held seven entries and all seven were fixtures (`wt-alpha` / `wt-beta` /
 * `wt-1898` / `wt-respond` / `wt-recheck`, rooted at `/tmp/wt*`) — the
 * operator's own assignments had been read-modify-written away by a unit run.
 * Nineteen opencode test files redirect themselves and were never the problem;
 * the ones that leaked reach the module transitively and never mention it,
 * which is why the fix is the default in `tests/setup.ts` rather than an edit
 * to the files somebody happened to notice.
 *
 * `verify`'s env-clean gate is structurally blind to this: it counts the
 * entries directly under `~/.commandmate`, and rewriting a file that is already
 * there changes no count (#2487's run 750 reported `commandmate-entries clean`
 * while doing exactly this). So a red test is the only thing that notices.
 *
 * It sets **no** environment of its own except in the positive control below:
 * what it reads is the process `tests/setup.ts` handed it, because a
 * `beforeEach` that stubbed `CM_OPENCODE_PORT_FILE` would make every assertion
 * here a tautology. The real ledger is only ever read.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, sep } from 'path';
import {
  forgetOpencodePort,
  getOpencodePortFilePath,
  readPersistedOpencodePorts,
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';

/** The file this suite must never resolve to. */
const REAL_LEDGER = join(homedir(), '.commandmate', 'opencode-ports.json');

const underHome = (path: string): boolean =>
  path === homedir() || path.startsWith(homedir() + sep);

/** Its bytes, or null when it does not exist. Read-only, always. */
function realLedgerSnapshot(): string | null {
  return existsSync(REAL_LEDGER) ? readFileSync(REAL_LEDGER, 'utf8') : null;
}

afterEach(() => {
  resetOpencodePortAssignments();
});

describe('Issue #2490: the unit suite never writes the real opencode port ledger', () => {
  it('resolves the ledger outside the home directory', () => {
    // The exact call production code makes: no argument, real process.env.
    expect(underHome(getOpencodePortFilePath())).toBe(false);
  });

  it('is not asserting a tautology — the unpinned default *is* the home ledger', () => {
    // Without this, the assertion above would keep passing against a resolver
    // that could no longer answer `~/.commandmate/...` at all, and removing the
    // default from `tests/setup.ts` would be a silent change. Read-only:
    // `getOpencodePortFilePath` resolves a string and creates nothing.
    const saved = process.env.CM_OPENCODE_PORT_FILE;
    delete process.env.CM_OPENCODE_PORT_FILE;
    try {
      expect(getOpencodePortFilePath()).toBe(REAL_LEDGER);
    } finally {
      if (saved === undefined) delete process.env.CM_OPENCODE_PORT_FILE;
      else process.env.CM_OPENCODE_PORT_FILE = saved;
    }
  });

  it('pins the override to a value the resolver actually honours', () => {
    // Blank is the trap, not absence: `resolveSafeDirectory` reads `''` as
    // unset and answers the fallback, so "the variable is set" is not the
    // property worth asserting.
    const pinned = process.env.CM_OPENCODE_PORT_FILE;
    expect(pinned).toBeDefined();
    expect(pinned?.trim()).not.toBe('');
    expect(getOpencodePortFilePath()).toBe(pinned);
  });

  it('points under the shared temp directory, like the other pinned defaults', () => {
    // Not merely "not under home": a pin that resolved to some other writable
    // path on the machine would satisfy the assertions above and still be
    // somebody's real file. The other pinned defaults all live under tmpdir so
    // the whole family is `rm -rf`-able.
    expect(getOpencodePortFilePath().startsWith(tmpdir())).toBe(true);
  });

  it('sends a real assignment to the pinned ledger and never to the home one', () => {
    // The end-to-end property, exercised the way `allocateOpencodePort` does
    // it. The probe key is unique to this file because the pinned ledger is
    // shared by every test file in this worker and the writers merge rather
    // than replace.
    const target = { worktreeId: 'wt-2490-isolation-probe', cliToolId: 'opencode' } as const;
    const key = `${target.worktreeId}:opencode`;
    const before = realLedgerSnapshot();

    try {
      rememberOpencodePort(target, 4242, '/tmp/wt-2490-isolation-probe', 1_700_000_000_000);

      expect(readPersistedOpencodePorts()[key]).toEqual({
        port: 4242,
        worktreePath: '/tmp/wt-2490-isolation-probe',
        updatedAt: 1_700_000_000_000,
      });
      expect(JSON.parse(readFileSync(getOpencodePortFilePath(), 'utf8'))).toHaveProperty(key);
    } finally {
      forgetOpencodePort(target);
    }

    // Both halves matter: a ledger that did not exist must not have been
    // created, and one that did must not carry the probe.
    //
    // Deliberately not byte-identity against `before`. The real ledger belongs
    // to a server that may legitimately write it while this test runs, and a
    // guard that goes red for that would be reporting somebody else's correct
    // behaviour. The defect this file exists for — the probe landing in the
    // operator's file because the pin went away — is named exactly by the two
    // assertions below.
    const after = realLedgerSnapshot();
    expect(after === null).toBe(before === null);
    expect(after ?? '').not.toContain(target.worktreeId);
    expect(readPersistedOpencodePorts()[key]).toBeUndefined();
  });
});
