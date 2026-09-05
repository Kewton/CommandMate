/**
 * CLI Dependencies Config Tests
 * Tests for dependency definitions (OCP - external configuration)
 */

import { describe, it, expect } from 'vitest';
import {
  DEPENDENCIES,
  getDependencies,
  getRequiredDependencies,
  getOptionalDependencies,
} from '../../../../src/cli/config/cli-dependencies';

describe('DEPENDENCIES', () => {
  it('should include Node.js as required', () => {
    const nodejs = DEPENDENCIES.find(d => d.name === 'Node.js');
    expect(nodejs).toBeDefined();
    expect(nodejs?.required).toBe(true);
    expect(nodejs?.command).toBe('node');
    expect(nodejs?.versionArg).toBe('-v');
  });

  it('should include npm as required', () => {
    const npm = DEPENDENCIES.find(d => d.name === 'npm');
    expect(npm).toBeDefined();
    expect(npm?.required).toBe(true);
  });

  it('should include tmux as required', () => {
    const tmux = DEPENDENCIES.find(d => d.name === 'tmux');
    expect(tmux).toBeDefined();
    expect(tmux?.required).toBe(true);
  });

  it('should include git as required', () => {
    const git = DEPENDENCIES.find(d => d.name === 'git');
    expect(git).toBeDefined();
    expect(git?.required).toBe(true);
  });

  it('should include Claude CLI as optional', () => {
    const claude = DEPENDENCIES.find(d => d.name === 'Claude CLI');
    expect(claude).toBeDefined();
    expect(claude?.required).toBe(false);
  });

  it('should have minVersion for Node.js', () => {
    const nodejs = DEPENDENCIES.find(d => d.name === 'Node.js');
    expect(nodejs?.minVersion).toBe('22.0.0');
  });
});

describe('getDependencies', () => {
  it('should return all dependencies', () => {
    const deps = getDependencies();
    expect(Array.isArray(deps)).toBe(true);
    expect(deps.length).toBeGreaterThan(0);
  });
});

describe('getRequiredDependencies', () => {
  it('should return only required dependencies', () => {
    const required = getRequiredDependencies();
    expect(required.every(d => d.required === true)).toBe(true);
  });

  it('should include Node.js, npm, tmux, git', () => {
    const required = getRequiredDependencies();
    const names = required.map(d => d.name);
    expect(names).toContain('Node.js');
    expect(names).toContain('npm');
    expect(names).toContain('tmux');
    expect(names).toContain('git');
  });
});

describe('getOptionalDependencies', () => {
  it('should return only optional dependencies', () => {
    const optional = getOptionalDependencies();
    expect(optional.every(d => d.required === false)).toBe(true);
  });

  it('should include Claude CLI', () => {
    const optional = getOptionalDependencies();
    const names = optional.map(d => d.name);
    expect(names).toContain('Claude CLI');
  });

  // [SF-IMP-003] Issue #264: gh CLI verification tests
  it('should include gh CLI as optional', () => {
    const optional = getOptionalDependencies();
    const names = optional.map(d => d.name);
    expect(names).toContain('gh CLI');
  });

  it('gh CLI should have required: false', () => {
    const ghCli = DEPENDENCIES.find(d => d.name === 'gh CLI');
    expect(ghCli).toBeDefined();
    expect(ghCli?.required).toBe(false);
  });

  it('gh CLI should have command: "gh"', () => {
    const ghCli = DEPENDENCIES.find(d => d.name === 'gh CLI');
    expect(ghCli).toBeDefined();
    expect(ghCli?.command).toBe('gh');
  });

  it('gh CLI should have versionArg: "--version"', () => {
    const ghCli = DEPENDENCIES.find(d => d.name === 'gh CLI');
    expect(ghCli).toBeDefined();
    expect(ghCli?.versionArg).toBe('--version');
  });

  // Issue #1907: `commandmate init` の依存表に copilot / opencode が無く、
  // どちらも入っていない環境で「準備完了」に見えていた。
  it('should include GitHub Copilot CLI as optional', () => {
    const optional = getOptionalDependencies();
    expect(optional.map(d => d.name)).toContain('GitHub Copilot CLI');
  });

  it('should check copilot as the standalone executable, not via gh', () => {
    // `gh copilot --help` は copilot 未インストールでも exit 0 を返すため、
    // `command: 'gh'` で copilot の実在を測ることはできない（gh 2.86.0 実測）。
    const copilot = DEPENDENCIES.find(d => d.name === 'GitHub Copilot CLI');
    expect(copilot?.command).toBe('copilot');
    expect(copilot?.versionArg).toBe('--version');
    expect(copilot?.required).toBe(false);
  });

  it('should include OpenCode CLI as optional', () => {
    const opencode = DEPENDENCIES.find(d => d.name === 'OpenCode CLI');
    expect(opencode).toBeDefined();
    expect(opencode?.command).toBe('opencode');
    expect(opencode?.versionArg).toBe('--version');
    expect(opencode?.required).toBe(false);
  });

  it('should keep every agent CLI optional so init cannot start failing on them', () => {
    const agentCliNames = [
      'Claude CLI',
      'gh CLI',
      'GitHub Copilot CLI',
      'OpenCode CLI',
      'Codex CLI',
      // Issue #2301
      'Gemini CLI',
      'Antigravity CLI',
      'Command Code CLI',
    ];
    for (const name of agentCliNames) {
      expect(DEPENDENCIES.find(d => d.name === name)?.required).toBe(false);
    }
  });

  // Issue #2301: `init` named four of the eight agent CLIs CommandMate drives.
  // A reader who had just picked Command Code or Antigravity from the agent list
  // got no version, no "Not found", and no hint that the check even existed.
  it('should include Command Code CLI as optional, probing `commandcode`', () => {
    const commandCode = DEPENDENCIES.find(d => d.name === 'Command Code CLI');
    expect(commandCode).toBeDefined();
    // The Issue's named trap. The package is `command-code` and ships four bins;
    // `src/lib/cli-tools/command-code.ts` launches `commandcode`, and a row that
    // probed any of the other three would report "Not found" for a tool that is
    // installed and working. Pinned against the tool implementation itself in
    // tests/unit/cli-tools/install-hints-2301.test.ts.
    expect(commandCode?.command).toBe('commandcode');
    expect(commandCode?.versionArg).toBe('--version');
    expect(commandCode?.required).toBe(false);
  });

  it('should include Antigravity CLI as optional, probing `agy`', () => {
    const antigravity = DEPENDENCIES.find(d => d.name === 'Antigravity CLI');
    expect(antigravity).toBeDefined();
    expect(antigravity?.command).toBe('agy');
    expect(antigravity?.versionArg).toBe('--version');
    expect(antigravity?.required).toBe(false);
  });

  it('should include Gemini CLI as optional, probing `gemini`', () => {
    // Not named by the Issue, which listed only the two tools it was opened for.
    // Measured on this tree, gemini was missing for exactly the same reason and
    // the Issue's own goal — "init can report a version for all eight tools" —
    // is unreachable without it.
    const gemini = DEPENDENCIES.find(d => d.name === 'Gemini CLI');
    expect(gemini).toBeDefined();
    expect(gemini?.command).toBe('gemini');
    expect(gemini?.versionArg).toBe('--version');
    expect(gemini?.required).toBe(false);
  });

  it('exposes command-code and antigravity through getOptionalDependencies()', () => {
    // The Issue's acceptance criterion, read through the accessor `init` calls
    // rather than off the array literal.
    const commands = getOptionalDependencies().map(d => d.command);
    expect(commands).toContain('commandcode');
    expect(commands).toContain('agy');
  });

  it('asks no tool for a version it does not answer', () => {
    // `vibe-local` is the eighth CLI_TOOL_ID and is deliberately not a row.
    // Measured 2026-09-05: `vibe-local --version` ignores the flag and opens its
    // interactive permission prompt, so a row for it would have `init` park a
    // terminal on a dialog. It is a local shell script rather than an
    // installable CLI, which is also why `lib/detection/version-probes.ts`
    // excludes it.
    expect(DEPENDENCIES.find(d => d.command === 'vibe-local')).toBeUndefined();
  });

  it('names every agent CLI exactly once', () => {
    // A duplicated row would make `init` run the same probe twice and print the
    // tool twice, which is how a copy-pasted entry survives review.
    const commands = DEPENDENCIES.map(d => d.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});
