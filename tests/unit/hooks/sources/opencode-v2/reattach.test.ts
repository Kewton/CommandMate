/**
 * The OpenCode V2 startup sweep (Issue #2934, D3 / D5).
 *
 * A live pane gets its subscription back; a dead pane's password file and port
 * assignment are deleted.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import {
  opencodeV2TargetOfKey,
  reattachOpencodeV2EventStreams,
  type OpencodeV2ReattachDeps,
} from '@/lib/hooks/sources/opencode-v2/reattach';
import {
  readPersistedOpencodeV2Ports,
  rememberOpencodeV2Port,
  resetOpencodeV2PortAssignments,
} from '@/lib/hooks/sources/opencode-v2/ports';
import {
  OPENCODE_V2_DIR_ENV,
  getOpencodeV2PasswordFilePath,
  writeOpencodeV2Password,
} from '@/lib/hooks/sources/opencode-v2/secrets';
import type { AgentInstanceRef } from '@/lib/hooks/sources/types';

const live: AgentInstanceRef = { worktreeId: 'wt-live', cliToolId: 'opencode-v2', instanceId: 'opencode-v2' };
const dead: AgentInstanceRef = { worktreeId: 'wt-dead', cliToolId: 'opencode-v2', instanceId: 'opencode-v2' };
const orphan: AgentInstanceRef = {
  worktreeId: 'wt-orphan',
  cliToolId: 'opencode-v2',
  instanceId: 'opencode-v2-2',
};

let dir: string;

function deps(overrides: Partial<OpencodeV2ReattachDeps> = {}): OpencodeV2ReattachDeps {
  return {
    isPaneRunning: async (target) => target.worktreeId === 'wt-live',
    resolveWorktreePath: (worktreeId) => `/repos/${worktreeId}`,
    resume: vi.fn(async () => true),
    ...overrides,
  };
}

beforeEach(() => {
  dir = makeTempDir('cm-2934-reattach-');
  vi.stubEnv(OPENCODE_V2_DIR_ENV, join(dir, 'opencode-v2'));
  resetOpencodeV2PortAssignments();
});

afterEach(() => {
  resetOpencodeV2PortAssignments();
  vi.unstubAllEnvs();
  removeTempDir(dir);
});

describe('reattachOpencodeV2EventStreams (Issue #2934)', () => {
  it('resumes live panes and sweeps the leftovers of dead ones', async () => {
    rememberOpencodeV2Port(live, 4310, '/repos/wt-live');
    rememberOpencodeV2Port(dead, 4311, '/repos/wt-dead');
    writeOpencodeV2Password(live);
    writeOpencodeV2Password(dead);
    // A crash can leave a password with no port entry; it is swept too.
    writeOpencodeV2Password(orphan);

    const resolved = deps();
    const report = await reattachOpencodeV2EventStreams(resolved);

    expect(report).toEqual({ known: 3, candidates: 1, reattached: 1, swept: 2 });
    expect(resolved.resume).toHaveBeenCalledTimes(1);
    expect(resolved.resume).toHaveBeenCalledWith(live, '/repos/wt-live');
    expect(existsSync(getOpencodeV2PasswordFilePath(live))).toBe(true);
    expect(existsSync(getOpencodeV2PasswordFilePath(dead))).toBe(false);
    expect(existsSync(getOpencodeV2PasswordFilePath(orphan))).toBe(false);
    expect(Object.keys(readPersistedOpencodeV2Ports())).toEqual(['wt-live:opencode-v2']);
  });

  it('does nothing when there is nothing on disk', async () => {
    const resolved = deps();
    expect(await reattachOpencodeV2EventStreams(resolved)).toEqual({
      known: 0,
      candidates: 0,
      reattached: 0,
      swept: 0,
    });
    expect(resolved.resume).not.toHaveBeenCalled();
  });

  it('never touches a file that does not name an OpenCode V2 instance', async () => {
    writeOpencodeV2Password(live);
    const stray = join(dir, 'opencode-v2', 'wt-x:opencode.pw');
    writeFileSync(stray, 'x');
    const report = await reattachOpencodeV2EventStreams(deps());
    expect(report.known).toBe(1);
    expect(existsSync(stray)).toBe(true);
  });

  it('parses composite keys, primary and aliased', () => {
    expect(opencodeV2TargetOfKey('wt:opencode-v2')).toEqual({
      worktreeId: 'wt',
      cliToolId: 'opencode-v2',
      instanceId: 'opencode-v2',
    });
    expect(opencodeV2TargetOfKey('wt:opencode-v2:opencode-v2-2')?.instanceId).toBe('opencode-v2-2');
    expect(opencodeV2TargetOfKey('wt:opencode')).toBeNull();
  });
});
