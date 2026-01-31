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
    expect(nodejs?.minVersion).toBe('20.0.0');
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
});
