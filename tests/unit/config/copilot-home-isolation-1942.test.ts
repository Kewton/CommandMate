/**
 * The unit suite must not be able to reach `~/.copilot` (Issue #1942).
 *
 * copilot's `AgentEventSource` declares `configScope: 'global-singleton'`, and
 * that is not a label — copilot has no `--settings` flag, so
 * `writeCopilotHookSettings` writes `~/.copilot/settings.json`, **one file for
 * the whole machine**, merging into whatever the operator has there, taking a
 * backup over the previous one, and re-pointing every copilot session on the
 * machine at the port that wrote it last. `COPILOT_HOME` is the only override.
 *
 * `CODEX_HOME` and `CM_VERIFY_WORKTREE_INDEX_ROOT` have had a default in
 * `tests/setup.ts` since #1760 / #1873 for exactly this reason. `COPILOT_HOME`
 * did not, and the tool it guards is the one whose config file has the widest
 * blast radius.
 *
 * ## Why this file asserts rather than merely documents
 *
 * Nothing is leaking today — measured, not assumed: the whole `tests/unit`
 * suite was run once with `HOME` redirected to an empty sentinel directory and
 * `COPILOT_HOME` unset, and no `.copilot` appeared in it. Every copilot test
 * redirects itself, and `terminal-route` / `api-send-cli-tool` mock
 * `CopilotTool` outright. So the default in `tests/setup.ts` is a fence around
 * the test somebody writes next month, and a fence nobody can see is a fence
 * that gets removed. This file is what notices.
 *
 * It deliberately sets **no** environment of its own: what it reads is the
 * process `tests/setup.ts` handed it. A `beforeEach` here that stubbed
 * `COPILOT_HOME` would make every assertion below a tautology.
 *
 * Read-only throughout — the point is that a path is never *reached*, so
 * proving it by writing there would be the accident itself.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import {
  getCopilotConfigPath,
  getCopilotHomeDirectory,
  getCopilotSettingsPath,
} from '@/lib/hooks/sources/copilot/hook-settings';

/** The machine-global directory this suite must never resolve to. */
const REAL_COPILOT_HOME = join(homedir(), '.copilot');

describe('COPILOT_HOME isolation for the unit suite (Issue #1942)', () => {
  it('is filled in for every test file, without any file asking', () => {
    // Blank counts as unset for `resolveSafeDirectory`, so blank must not pass
    // here either.
    expect((process.env.COPILOT_HOME ?? '').trim()).not.toBe('');
  });

  it('resolves copilot’s machine-global files somewhere that is not the developer’s', () => {
    expect(getCopilotHomeDirectory()).not.toBe(REAL_COPILOT_HOME);
    expect(getCopilotSettingsPath()).not.toBe(join(REAL_COPILOT_HOME, 'settings.json'));
    expect(getCopilotConfigPath()).not.toBe(join(REAL_COPILOT_HOME, 'config.json'));
  });

  it('points at the shared temp directory, like CODEX_HOME does', () => {
    // Not merely "somewhere else": a value that resolved under the home
    // directory would satisfy the test above and still be the operator's.
    expect(getCopilotHomeDirectory().startsWith(tmpdir())).toBe(true);
  });

  it('and the variable is the only thing standing between the suite and that file', () => {
    // The positive control for all three assertions above. Without it they are
    // equally satisfied by a resolver that could never answer `~/.copilot` —
    // which would make removing the default in `tests/setup.ts` a silent
    // change. Read-only: `getCopilotHomeDirectory` resolves a string and
    // creates nothing.
    const saved = process.env.COPILOT_HOME;
    delete process.env.COPILOT_HOME;
    try {
      expect(getCopilotHomeDirectory()).toBe(REAL_COPILOT_HOME);
    } finally {
      if (saved === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = saved;
    }
  });
});
