/**
 * CLI Dependencies Configuration
 * Issue #96: npm install CLI support
 * SF-2: OCP - External configuration for extensibility
 */

import { DependencyCheck } from '../types';

/**
 * System dependencies required by CommandMate
 */
export const DEPENDENCIES: DependencyCheck[] = [
  {
    name: 'Node.js',
    command: 'node',
    versionArg: '-v',
    required: true,
    minVersion: '22.0.0',
  },
  {
    name: 'npm',
    command: 'npm',
    versionArg: '-v',
    required: true,
  },
  {
    name: 'tmux',
    command: 'tmux',
    versionArg: '-V',
    required: true,
  },
  {
    name: 'git',
    command: 'git',
    versionArg: '--version',
    required: true,
  },
  {
    name: 'Claude CLI',
    command: 'claude',
    versionArg: '--version',
    required: false,
  },
  {
    name: 'gh CLI',
    command: 'gh',
    versionArg: '--version',
    required: false,
  },
  // Issue #1907: agent CLIs CommandMate can drive but does not require. Copilot
  // is checked as the standalone `copilot` executable, NOT as `gh copilot` —
  // that is a preview command built into gh which exits 0 (and offers to
  // download the CLI) on a machine that has no copilot at all.
  {
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    versionArg: '--version',
    required: false,
  },
  {
    name: 'OpenCode CLI',
    command: 'opencode',
    versionArg: '--version',
    required: false,
  },
  // Issue #2069: codex was the one agent CLI CommandMate drives that this list
  // never named, so `commandmate init` reported a version for claude, copilot
  // and opencode and said nothing at all about the tool most of this
  // repository's own sessions run. Optional for the same reason as its
  // siblings: CommandMate drives codex, it does not require it.
  {
    name: 'Codex CLI',
    command: 'codex',
    versionArg: '--version',
    required: false,
  },
];

/**
 * Get all dependencies
 */
export function getDependencies(): DependencyCheck[] {
  return [...DEPENDENCIES];
}

/**
 * Get only required dependencies
 */
export function getRequiredDependencies(): DependencyCheck[] {
  return DEPENDENCIES.filter(d => d.required);
}

/**
 * Get only optional dependencies
 */
export function getOptionalDependencies(): DependencyCheck[] {
  return DEPENDENCIES.filter(d => !d.required);
}
