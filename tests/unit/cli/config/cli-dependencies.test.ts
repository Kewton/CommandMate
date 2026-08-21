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
    const agentCliNames = ['Claude CLI', 'gh CLI', 'GitHub Copilot CLI', 'OpenCode CLI'];
    for (const name of agentCliNames) {
      expect(DEPENDENCIES.find(d => d.name === name)?.required).toBe(false);
    }
  });
});
