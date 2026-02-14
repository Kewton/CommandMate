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
    minVersion: '20.0.0',
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
