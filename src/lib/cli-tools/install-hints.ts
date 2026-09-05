/**
 * How to obtain each agent CLI CommandMate can drive (Issue #2301).
 *
 * ## Why this exists
 *
 * Every one of the eight tools already refuses to start when its binary is not
 * on `PATH` — that gate is #2009's, and it is uniform. What was NOT uniform was
 * what the refusal said. Seven of them said some spelling of
 * `<tool> is not installed or not in PATH` and stopped there; only copilot went
 * on to name the installer (`COPILOT_INSTALL_HINT`, #1907). So a reader who
 * picked opencode or Command Code from the agent list got a sentence that told
 * them the tool was missing and nothing about how to stop it being missing,
 * while the reader who picked copilot got both. This module is the second half
 * of that sentence, written once for all eight.
 *
 * ## Where the strings come from
 *
 * Measured against the npm registry and this machine's global install on
 * 2026-09-05, not copied from an Issue body:
 *
 * | tool          | binary        | evidence                                    |
 * |---------------|---------------|---------------------------------------------|
 * | claude        | `claude`      | `@anthropic-ai/claude-code` 2.1.261          |
 * | codex         | `codex`       | `@openai/codex` — the package #2069 updates  |
 * | gemini        | `gemini`      | `@google/gemini-cli` 0.58.0                  |
 * | opencode      | `opencode`    | `opencode-ai` 1.18.28                        |
 * | copilot       | `copilot`     | {@link COPILOT_INSTALL_HINT} (#1907)         |
 * | command-code  | `commandcode` | `command-code` 1.49.0 (four bins; #2250      |
 * |               |               | picked `commandcode`)                        |
 * | antigravity   | `agy`         | no package — the URL below is a string in    |
 * |               |               | the shipped `agy` binary itself              |
 * | vibe-local    | `vibe-local`  | a local script, not a published artifact     |
 *
 * `@anthropic-ai/claude-cli` — the name `PreflightChecker.getInstallHint` still
 * carries — is **not** a package that exists; `npm view` 404s it. The spelling
 * here is the one that resolves.
 *
 * ## Why not `CLI_TOOL_DISPLAY_NAMES`' neighbour in `types.ts`
 *
 * A hint is advice about the world outside this repository, and it goes stale
 * on someone else's release schedule. Keeping it out of `types.ts` keeps the
 * module that every consumer of `CLIToolType` imports free of a table that has
 * to be re-measured, and gives the re-measurement one file to land in.
 *
 * ## The one path this does not reach yet
 *
 * Seven tools ask `isInstalled()` inside their own `launchSession` and throw
 * from there, so pointing that line at {@link missingToolError} is all it takes.
 * claude does not: `ClaudeTool.launchSession` delegates to
 * `lib/session/claude-session`, which owns the detection AND composes the
 * sentence (`Claude CLI is not installed or not in PATH`, #1637). Enriching it
 * means editing that module, and `tests/integration/api-send-cli-tool.test.ts`
 * pins the sentence verbatim — both outside the scope this change was allowed to
 * touch, so claude's tmux-launch wording is unchanged here.
 *
 * claude is NOT hintless, though: `assertToolStartable` and
 * `reportToolUnavailable` (`./start-availability`) both build their refusal from
 * this module, so the path Assistant Chat takes already carries the hint. What
 * remains is one line in `claude-session.ts` plus the assertion that pins it.
 *
 * @module lib/cli-tools/install-hints
 */

import { COPILOT_INSTALL_HINT } from '@/config/copilot-constants';
import type { CLIToolType, ICLITool } from './types';
import { SessionStartUnavailableError } from '../session/session-start-error';

/**
 * One sentence per tool, saying how to get it.
 *
 * Total rather than partial (`Record`, not `Partial<Record>`), so adding a
 * ninth entry to `CLI_TOOL_IDS` fails `tsc` here instead of shipping a tool
 * whose refusal says nothing — the shape #2009 used to make the gate itself
 * impossible to forget.
 */
export const CLI_TOOL_INSTALL_HINTS: Readonly<Record<CLIToolType, string>> = {
  claude: 'Install with: npm install -g @anthropic-ai/claude-code',
  codex: 'Install with: npm install -g @openai/codex',
  gemini: 'Install with: npm install -g @google/gemini-cli',
  opencode: 'Install with: npm install -g opencode-ai',
  copilot: COPILOT_INSTALL_HINT,
  'command-code': 'Install with: npm install -g command-code',
  // No package to name: `agy` ships with Antigravity and updates itself. The
  // URL is lifted from the binary on PATH rather than from a search result.
  antigravity: 'Install the Antigravity CLI: https://antigravity.google/docs/cli/reference',
  // Deliberately not an install command. `vibe-local` is a local shell script
  // driving an Ollama model, which is also why `version-probes.ts` excludes it
  // from staleness probing — there is no published artifact to point at.
  'vibe-local':
    'vibe-local is a local script rather than a published package: put your own `vibe-local` executable on PATH.',
} as const;

/**
 * How to obtain `id`.
 *
 * @param id - The tool whose binary is missing
 * @returns The tool's install sentence
 */
export function getCliToolInstallHint(id: CLIToolType): string {
  return CLI_TOOL_INSTALL_HINTS[id];
}

/** The identity a refusal needs; satisfied by every {@link ICLITool}. */
export type InstallHintSubject = Pick<ICLITool, 'id' | 'name' | 'command'>;

/**
 * The whole sentence a missing binary earns: what is missing, what it is
 * called on `PATH`, and how to get it.
 *
 * The binary name is inside the message because the display name is often not
 * the thing to type — `Command Code CLI` is `commandcode`, `Antigravity CLI` is
 * `agy` — and the two tools whose old wording already spelled it out were the
 * two whose names diverge most.
 *
 * `is not installed` is load-bearing: `lib/push/failure-push-notifier` renders
 * its own localized body, but the HTTP layer and three suites read this string,
 * and #2009's contract is that the phrase survives.
 *
 * @param tool - The tool that could not be started
 * @returns A sentence safe to hand back to an HTTP caller
 */
export function buildMissingToolMessage(tool: InstallHintSubject): string {
  return (
    `${tool.name} (${tool.command}) is not installed or not in PATH. ` +
    `${getCliToolInstallHint(tool.id)}`
  );
}

/**
 * The typed refusal, carrying {@link buildMissingToolMessage}.
 *
 * @param tool - The tool that could not be started
 * @returns The error every launch path throws for a missing binary
 */
export function missingToolError(tool: InstallHintSubject): SessionStartUnavailableError {
  return new SessionStartUnavailableError(tool.name, buildMissingToolMessage(tool));
}
