/**
 * The unit suite must not be able to reach `~/.commandmate/opencode-v2` (Issue #2948).
 *
 * OpenCode V2 persists per-instance passwords and port assignments under
 * `~/.commandmate/opencode-v2` unless `CM_OPENCODE_V2_DIR` redirects it.
 * Tests that reach the startup sweep (`server.ts` -> `reattachOpencodeV2EventStreams()`)
 * with no running tmux sessions would otherwise delete real credentials and ports
 * belonging to the user's running OpenCode V2 instances.
 *
 * `tests/setup.ts` isolates this by setting `CM_OPENCODE_V2_DIR` to a process-scoped
 * temporary directory under `tmpdir()`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  OPENCODE_V2_DIR_ENV,
  getOpencodeV2StateDir,
} from '@/lib/hooks/sources/opencode-v2/secrets';

const REAL_OPENCODE_V2_DIR = join(homedir(), '.commandmate', 'opencode-v2');

describe('OpenCode V2 test isolation (Issue #2948)', () => {
  it('points getOpencodeV2StateDir() under os.tmpdir() and not the real state directory', () => {
    const stateDir = getOpencodeV2StateDir();
    expect(stateDir.startsWith(tmpdir())).toBe(true);
    expect(stateDir).not.toBe(REAL_OPENCODE_V2_DIR);
  });

  it('has a non-empty CM_OPENCODE_V2_DIR environment variable', () => {
    const value = process.env[OPENCODE_V2_DIR_ENV];
    expect(value).toBeDefined();
    expect(value?.trim()).not.toBe('');
  });
});
