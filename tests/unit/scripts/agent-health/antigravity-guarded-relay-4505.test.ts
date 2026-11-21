/**
 * Issue #4505: the daily check guards every file CommandMate writes into a
 * shared location, and agy now gets a second one.
 *
 * `prepareLaunch` writes `~/.gemini/config/hooks.json` *and* the relay copy it
 * names, `~/.gemini/config/commandmate/cmate-agent-event.sh`. The agent-health
 * run executes on the real machine from a permanent worktree, so a file it does
 * not snapshot is a file it leaves behind or changes. codex's row already lists
 * its relay install path; antigravity's must too.
 *
 * Nothing is written here: the spec only resolves paths, against a throwaway
 * HOME.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';
import { TOOL_PROBE_SPECS } from '../../../../scripts/agent-health/tool-table';
import { getAntigravityHooksConfigPath } from '@/lib/hooks/sources/antigravity/hooks-config';
import { getAntigravityRelayInstallPath } from '@/lib/hooks/sources/antigravity/relay-install';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-health-4505-')));
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempDir(home);
});

describe('antigravity guarded files (Issue #4505)', () => {
  it('guards the relay copy the hooks file names, not only hooks.json', () => {
    const hooksConfig = getAntigravityHooksConfigPath();
    const relayInstall = getAntigravityRelayInstallPath(hooksConfig);
    expect(relayInstall).toBe(
      join(home, '.gemini', 'config', 'commandmate', 'cmate-agent-event.sh')
    );

    const { hookConfig } = TOOL_PROBE_SPECS.antigravity.guardedFiles();
    expect(hookConfig).toContain(hooksConfig);
    expect(hookConfig).toContain(relayInstall);
  });
});
