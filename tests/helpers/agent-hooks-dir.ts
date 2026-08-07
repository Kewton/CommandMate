/**
 * Keeping test session starts out of the real `~/.commandmate/hooks`.
 *
 * Issue #1722 writes a hooks settings file every time a Claude session is
 * created, so any suite that calls `startClaudeSession()` leaves files in the
 * developer's home directory — and in CI's, which is where the
 * `/home/runner/.commandmate/hooks/...` path in the PR #1732 failure output
 * came from.
 *
 * `CM_AGENT_HOOKS_DIR` is the generator's directory override. Call this at the
 * top level of any suite that starts a session; it registers its own
 * `beforeAll`/`afterAll` and restores whatever was there before.
 *
 * @module tests/helpers/agent-hooks-dir
 */

import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from './temp-dir';

/**
 * Point `CM_AGENT_HOOKS_DIR` at a temporary directory for this suite.
 *
 * @param prefix - Directory name prefix, so a stray directory names its suite
 * @returns A getter for the directory, for suites that want to inspect what was
 *   written
 */
export function useIsolatedAgentHooksDir(prefix: string): () => string {
  let dir = '';
  let previous: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), `${prefix}-hooks-`));
    previous = process.env.CM_AGENT_HOOKS_DIR;
    process.env.CM_AGENT_HOOKS_DIR = dir;
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.CM_AGENT_HOOKS_DIR;
    else process.env.CM_AGENT_HOOKS_DIR = previous;
    if (dir) removeTempDir(dir);
  });

  return () => dir;
}
