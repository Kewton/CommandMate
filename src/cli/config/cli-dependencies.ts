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
  // Issue #2301: the same gap #2069 closed for codex, still open for three more
  // of the eight tools `CLI_TOOL_IDS` names. `commandmate init` reported a
  // version for four agent CLIs and stayed silent about gemini, antigravity and
  // Command Code, so an operator who had just picked one of those from the
  // agent list got no answer from the one command whose job is to answer it.
  //
  // The binary names are the ones the tool implementations launch, not the ones
  // the package is called: `command-code` ships four bins and
  // `src/lib/cli-tools/command-code.ts` picks `commandcode`; Antigravity's is
  // `agy`.
  //
  // `vibe-local` is the eighth id and is deliberately NOT here. It is a local
  // shell script rather than an installable CLI (`version-probes.ts` excludes it
  // for the same reason), and it has no `--version`: measured on 2026-09-05,
  // `vibe-local --version` ignores the flag and opens its interactive
  // permission prompt, which is the last thing `init` should do to a terminal.
  {
    name: 'Gemini CLI',
    command: 'gemini',
    versionArg: '--version',
    required: false,
  },
  {
    name: 'Antigravity CLI',
    command: 'agy',
    versionArg: '--version',
    required: false,
  },
  {
    name: 'Command Code CLI',
    command: 'commandcode',
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
