/**
 * Running an agent CLI's own updater, in a process that is not an agent pane
 * (Issue #2069).
 *
 * ## The failure this replaces
 *
 * codex's "Update now" is not an in-place upgrade. Measured against upstream
 * `codex-rs/cli/src/main.rs`: the codex process **exits**, its parent runs the
 * install in the foreground, prints `Update ran successfully! Please restart
 * Codex.` and stops. Nothing restarts codex. Run inside a CommandMate pane that
 * means the pane's foreground program is gone and the pane falls back to a bare
 * shell — the state #2070 taught the detector to recognise, and which the user
 * then has to clean up by hand.
 *
 * So the update runs **here**: a child of the server (or of the CLI), with its
 * own stdio, wholly outside tmux. A pane that is mid-turn keeps its session; the
 * binary underneath it changes, and restarting that pane is a separate,
 * explicit act (the restart button, or `kill-session`).
 *
 * `tests/unit/api/agents-update-2069.test.ts` holds that structurally: it fails
 * the moment this route's module graph reaches tmux or a CLI tool's session
 * API at all. "Not in the pane" is the Issue's central claim, so it is asserted
 * rather than asserted-in-a-comment.
 *
 * ## The OTHER update path, and why it does not make this one redundant (#2068)
 *
 * codex's dialog can still appear inside a pane — a codex the user updated by
 * hand, an `Update now` they pressed themselves — and #2068 owns what
 * CommandMate answers there and how the pane is repaired afterwards (it re-sends
 * the launch command to the same pane). The two are complements, not
 * duplicates:
 *
 *  - the pane path is **reactive**: it only exists because codex asked, and it
 *    costs the session (the pane drops to a shell and has to be restarted);
 *  - this path is **initiated by the user from CommandMate** and costs no
 *    session at all.
 *
 * The consequence for THIS module is the lock below: after #2068 there are
 * three ways to reach one `npm install -g @openai/codex`, and only a lock that
 * every one of them takes is a lock.
 *
 * ## Two strategies, and how the choice is made
 *
 * codex 0.149.0 added a `codex update` subcommand that works out how the binary
 * was installed (npm, Homebrew, the standalone installer) and updates it the
 * same way. That is strictly better than assuming npm, so it is preferred — but
 * only when the installed build actually has it. A `codex update` typed at
 * 0.148 is an unknown-subcommand error, so below
 * {@link CODEX_NATIVE_UPDATE_MIN_VERSION} the plan falls back to
 * `npm install -g @openai/codex@latest`, which is what codex's own pre-0.149
 * updater ran.
 *
 * ### Why the fallback pins `@latest` and codex's own command does not
 *
 * codex spells it `npm install -g @openai/codex`. That resolves through npm's
 * default dist-tag, which is `latest` **unless** the user has set one
 * (`npm config set tag`, or a `tag=` line in `.npmrc`) — in which case the two
 * spellings install different versions. The explicit `@latest` here is the
 * fixed-argv rule applied to the version as well as to the words: what this
 * module runs must not depend on a config value neither CommandMate nor the
 * user is looking at while pressing the button. On a machine with no such
 * setting — which is nearly all of them — the two commands are identical.
 *
 * ## The execution rules (this Issue's 実装内容 4, and DR4-010)
 *
 * - **`execFile` with an argv array, never a shell string.** There is no
 *   `sh -c`, no interpolation, and nothing derived from an HTTP request reaches
 *   the command: the tool id is validated against {@link UPDATABLE_AGENT_TOOLS}
 *   and then *discarded* — the argv is a literal in this file, selected by that
 *   id. Same shape as `/api/app/update`'s fixed argv (#1198 §5).
 * - **The command is resolved to an absolute path first**, through
 *   {@link resolveAbsoluteExecutable}, and the plan fails rather than handing a
 *   relative or bare name to `execFile`. A repo-local `node_modules/.bin/codex`
 *   on `PATH` must not be able to decide what "update codex" runs.
 *
 *   `findExecutableOnPath` alone is **not** enough for that, which is why this
 *   module wraps it: it joins each `PATH` entry with the name and returns the
 *   first hit, so a `PATH` carrying a RELATIVE entry (`PATH=.:/usr/bin`, a
 *   `node_modules/.bin` written without a leading slash) yields a relative
 *   command — `./codex` — and `execFile` would resolve that against the child's
 *   cwd. The `isAbsolute` check is the half that makes the sentence above true.
 * - **`PATH` still comes from the shell that started the server**, because that
 *   is the PATH the user's codex is actually on; the environment is passed
 *   through {@link sanitizeEnvForChildProcess} so the updater cannot read
 *   CommandMate's auth token, DB path, or the launching agent's correlation
 *   variables (#1996).
 *
 * @module lib/updates/agent-updater
 */

import { execFile } from 'child_process';
import { isAbsolute } from 'path';
import { findExecutableOnPath } from '../cli-tools/copilot-executable';
import { sanitizeEnvForChildProcess } from '../security/env-sanitizer';
import { compareCliVersions, runDetectorVersionProbe } from '../detection/version-probes';

/**
 * Tools this module can update.
 *
 * One entry today, and the array — rather than an `if (tool === 'codex')` — is
 * the point: it is the allow-list the route validates against, so adding a tool
 * is adding a row here plus its plan below, and never a new place where a
 * request string reaches a command.
 */
export const UPDATABLE_AGENT_TOOLS = ['codex'] as const;

/** A tool id {@link resolveAgentUpdatePlan} accepts. */
export type UpdatableAgentTool = (typeof UPDATABLE_AGENT_TOOLS)[number];

/** Narrow arbitrary input — a request body, an argv operand — to a known tool. */
export function isUpdatableAgentTool(value: unknown): value is UpdatableAgentTool {
  return typeof value === 'string' && (UPDATABLE_AGENT_TOOLS as readonly string[]).includes(value);
}

/** The package `npm install -g` would fetch when codex cannot update itself. */
export const CODEX_NPM_PACKAGE = '@openai/codex';

/**
 * First codex release with a `codex update` subcommand.
 *
 * Below this the subcommand does not exist and invoking it is an error, so the
 * plan takes the npm route instead. Measured on 0.149.1, whose `codex update
 * --help` reads "Update Codex to the latest version".
 */
export const CODEX_NATIVE_UPDATE_MIN_VERSION = '0.149.0';

/**
 * How long one update may run.
 *
 * An install pulls a release over the network, so this is minutes rather than
 * the five seconds a `--version` probe gets. It is a ceiling on a hang, not a
 * budget: the ordinary run finishes far inside it.
 */
export const AGENT_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

/** Cap on captured output. npm is chatty; a runaway installer is not parsed. */
export const AGENT_UPDATE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/** Which updater a plan runs. */
export type AgentUpdateStrategy = 'native' | 'npm';

/** A resolved, ready-to-run update. Every field is decided before any spawn. */
export interface AgentUpdatePlan {
  tool: UpdatableAgentTool;
  strategy: AgentUpdateStrategy;
  /** Absolute path of the executable. Never a bare name. */
  command: string;
  /** Literal argv. Nothing here is derived from caller input. */
  args: readonly string[];
  /**
   * The same command as a single string, **for display only**.
   *
   * Deliberately not what is executed — it exists so the UI and the CLI can
   * show the user what is about to run. Nothing in this module ever hands it to
   * a shell.
   */
  display: string;
  /** Version the probe read before planning, or null when not installed. */
  installed: string | null;
  /** Why this strategy was chosen, for the log line and the CLI's output. */
  reason: 'native-subcommand' | 'no-native-subcommand' | 'not-installed';
}

/** Why no plan could be made. */
export interface AgentUpdatePlanFailure {
  ok: false;
  code: 'unsupported-tool' | 'no-executable';
  message: string;
}

/** {@link resolveAgentUpdatePlan}'s answer. */
export type AgentUpdatePlanResult = { ok: true; plan: AgentUpdatePlan } | AgentUpdatePlanFailure;

/** Seams for tests: the two things this module reads from the machine. */
export interface AgentUpdatePlanDeps {
  /** Resolve an executable name on PATH to an absolute path, or null. */
  resolveExecutable?: (name: string) => string | null;
  /** Read the installed version of `tool`, or null. */
  probeInstalledVersion?: (tool: UpdatableAgentTool) => Promise<string | null>;
}

/** Default probe: the same `codex --version` row the detector's table uses. */
async function probeCodexVersion(): Promise<string | null> {
  return runDetectorVersionProbe({ kind: 'execFile', command: 'codex', args: ['--version'] });
}

/**
 * Resolve `name` on `PATH` to an **absolute** path, or null.
 *
 * The `isAbsolute` half is not belt-and-braces. `findExecutableOnPath` splits
 * `PATH` and returns `join(entry, name)` for the first entry that holds an
 * executable file; a relative `PATH` entry therefore yields a relative command,
 * which `execFile` resolves against the child's cwd rather than against
 * anything this process decided. A `PATH` of `.:/usr/local/bin` in the shell
 * that started the server would let whichever directory the child happens to
 * run in supply the binary that "update codex" executes.
 *
 * Refusing is the right failure: the caller reports "there is nothing to update
 * with" and nothing is spawned, which is the same answer a machine with no
 * codex and no npm gets.
 *
 * @param name - Executable name to look up, e.g. `codex`.
 * @param resolveExecutable - Injected lookup (tests); defaults to PATH.
 * @returns An absolute path, or null when it is missing OR not absolute.
 */
function resolveAbsoluteExecutable(
  name: string,
  resolveExecutable: (name: string) => string | null
): string | null {
  const resolved = resolveExecutable(name);
  if (!resolved) return null;
  return isAbsolute(resolved) ? resolved : null;
}

/**
 * Decide what "update codex" runs on THIS machine, without running anything.
 *
 * Separated from {@link runAgentUpdate} so both the API route and the CLI can
 * show the user the exact argv before it executes, and so a test can assert the
 * strategy choice without a child process.
 *
 * @param tool - Tool id, validated here rather than trusted.
 * @param deps - Injection seams; production defaults read the real machine.
 */
export async function resolveAgentUpdatePlan(
  tool: unknown,
  deps: AgentUpdatePlanDeps = {}
): Promise<AgentUpdatePlanResult> {
  if (!isUpdatableAgentTool(tool)) {
    return {
      ok: false,
      code: 'unsupported-tool',
      message: `No update flow for '${String(tool)}'. Updatable tools: ${UPDATABLE_AGENT_TOOLS.join(', ')}.`,
    };
  }

  const resolveExecutable = deps.resolveExecutable ?? findExecutableOnPath;
  const probeVersion = deps.probeInstalledVersion ?? probeCodexVersion;

  const codexPath = resolveAbsoluteExecutable('codex', resolveExecutable);
  const installed = codexPath ? await probeVersion(tool) : null;

  // The native subcommand needs both: an executable to run it, and a build old
  // enough that `update` is not a typo to it.
  if (
    codexPath &&
    installed !== null &&
    compareCliVersions(installed, CODEX_NATIVE_UPDATE_MIN_VERSION) >= 0
  ) {
    return {
      ok: true,
      plan: {
        tool,
        strategy: 'native',
        command: codexPath,
        args: ['update'],
        display: 'codex update',
        installed,
        reason: 'native-subcommand',
      },
    };
  }

  const npmPath = resolveAbsoluteExecutable('npm', resolveExecutable);
  if (!npmPath) {
    return {
      ok: false,
      code: 'no-executable',
      message:
        codexPath === null
          ? 'Neither codex nor npm resolves to an absolute path on PATH, so there is nothing to update with.'
          : 'This codex is too old for `codex update`, and npm does not resolve to an absolute path on PATH.',
    };
  }

  return {
    ok: true,
    plan: {
      tool,
      strategy: 'npm',
      command: npmPath,
      args: ['install', '-g', `${CODEX_NPM_PACKAGE}@latest`],
      display: `npm install -g ${CODEX_NPM_PACKAGE}@latest`,
      installed,
      reason: codexPath === null ? 'not-installed' : 'no-native-subcommand',
    },
  };
}

/** One piece of the updater's output, as it arrives. */
export interface AgentUpdateChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

/** How an update finished. */
export interface AgentUpdateResult {
  ok: boolean;
  /** Process exit code, or null when it was killed by a signal / never ran. */
  exitCode: number | null;
  /** Signal that killed it (`SIGTERM` on timeout), or null. */
  signal: NodeJS.Signals | null;
  /** Present only on failure: a one-line reason for the UI and the log. */
  error?: string;
  /**
   * `in_progress` when the run was refused because another one holds the lock.
   *
   * A refusal is not a failed install — nothing was spawned — so callers that
   * report failures differently (the route's 409, the CLI's exit code) can tell
   * the two apart without parsing {@link AgentUpdateResult.error}.
   */
  code?: 'in_progress';
}

/** Options for {@link runAgentUpdate}. */
export interface RunAgentUpdateOptions {
  /** Called for every chunk as it arrives, so callers can stream it onward. */
  onChunk?: (chunk: AgentUpdateChunk) => void;
  /** Override the ceiling. Defaults to {@link AGENT_UPDATE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Tools whose update is running in THIS process.
 *
 * ## What it guards, now that there are three ways in
 *
 * After #2068 there are three routes to one `npm install -g @openai/codex` on
 * one machine, and only the first two are this process's:
 *
 *  1. `POST /api/agents/update` — the More screen's and the agent pane's button;
 *  2. `commandmate agents update <tool>` — the CLI, which may be a SECOND
 *     process (a terminal beside a running server);
 *  3. codex's own in-pane `Update now`, which #2068 answers according to
 *     `CM_CODEX_UPDATE_DIALOG`.
 *
 * The lock is taken inside {@link runAgentUpdate} rather than by each caller,
 * so (1) and (2) are covered by construction and a fourth caller is covered by
 * calling the function. #2068 wires (3) by taking
 * {@link acquireAgentUpdateLock} itself — which is why these three functions
 * stay exported from `lib/updates` even though nothing inside this module needs
 * them to be.
 *
 * ## Why in-process rather than a lock file
 *
 * Two npm installs of the same global package racing each other is a
 * double-click, not a second machine, and (2) crossing process boundaries is a
 * real gap this deliberately does not close: a cross-process lock would also
 * have to be reconciled with the user running `codex update` in their own
 * terminal, which is legitimate and must not be blocked, and there is no way to
 * tell those two apart from the outside. npm's own global install is the last
 * line either way.
 */
const updatesInFlight = new Set<string>();

/**
 * Take the in-flight marker for `tool`, or report that one is already held.
 *
 * Callers that run the update do NOT need this — {@link runAgentUpdate} takes
 * it. It is exported for the one caller that cannot go through that function:
 * #2068's in-pane update path, where codex itself is the thing running the
 * install and CommandMate only answers a dialog.
 */
export function acquireAgentUpdateLock(tool: UpdatableAgentTool): boolean {
  if (updatesInFlight.has(tool)) return false;
  updatesInFlight.add(tool);
  return true;
}

/** Release the marker. Safe to call when none is held. */
export function releaseAgentUpdateLock(tool: UpdatableAgentTool): void {
  updatesInFlight.delete(tool);
}

/**
 * Whether an update for `tool` is running in this process.
 *
 * A pre-check, never the control: the authoritative acquisition is inside
 * {@link runAgentUpdate}. The route reads this to choose its status code
 * BEFORE it starts streaming, because once a 200 and a stream have been
 * returned there is no way to answer 409 any more.
 */
export function isAgentUpdateInProgress(tool: UpdatableAgentTool): boolean {
  return updatesInFlight.has(tool);
}

/**
 * Run a resolved plan, streaming its output.
 *
 * `execFile` — not `exec`, not `spawn` with `shell: true` — so the argv array is
 * handed to the OS as an array. Its returned `ChildProcess` still exposes
 * `stdout` / `stderr` as streams, which is what makes "argv array" and "stream
 * the output" the same choice rather than a trade: the callback's buffered copy
 * is ignored and the listeners below are the real output path.
 *
 * **Takes the in-flight lock itself**, synchronously, before it returns its
 * promise — so every caller is serialised by calling this function rather than
 * by remembering to. See {@link acquireAgentUpdateLock} for the three paths
 * that reach one global install and why one of them cannot use this door.
 *
 * Never rejects. An updater that fails is a result to render, not an exception
 * to unwind through a route handler; a refusal (`code: 'in_progress'`) is a
 * result too, and spawns nothing.
 *
 * @param plan - From {@link resolveAgentUpdatePlan}. Its argv is used verbatim.
 * @param options - Streaming callback and timeout.
 */
export function runAgentUpdate(
  plan: AgentUpdatePlan,
  options: RunAgentUpdateOptions = {}
): Promise<AgentUpdateResult> {
  const { onChunk } = options;
  const timeout = options.timeoutMs ?? AGENT_UPDATE_TIMEOUT_MS;

  // Synchronous, and before the promise is constructed: a caller that checked
  // `isAgentUpdateInProgress` and then called this has no interleaving point in
  // between, so the pre-check and the acquisition cannot disagree.
  if (!acquireAgentUpdateLock(plan.tool)) {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      signal: null,
      code: 'in_progress' as const,
      error: `An update for ${plan.tool} is already running.`,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: AgentUpdateResult): void => {
      if (settled) return;
      settled = true;
      releaseAgentUpdateLock(plan.tool);
      resolve(result);
    };

    let child;
    try {
      child = execFile(
        plan.command,
        [...plan.args],
        {
          timeout,
          maxBuffer: AGENT_UPDATE_MAX_BUFFER_BYTES,
          env: sanitizeEnvForChildProcess(),
        },
        (error) => {
          if (!error) {
            settle({ ok: true, exitCode: 0, signal: null });
            return;
          }
          const failure = error as NodeJS.ErrnoException & {
            code?: number | string;
            signal?: NodeJS.Signals;
          };
          settle({
            ok: false,
            exitCode: typeof failure.code === 'number' ? failure.code : null,
            signal: failure.signal ?? null,
            error: failure.message,
          });
        }
      );
    } catch (error) {
      // execFile throws synchronously only for a malformed invocation; a
      // missing binary arrives through the callback as ENOENT.
      settle({
        ok: false,
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (onChunk) {
      child.stdout?.setEncoding('utf-8');
      child.stderr?.setEncoding('utf-8');
      child.stdout?.on('data', (text: string) => onChunk({ stream: 'stdout', text }));
      child.stderr?.on('data', (text: string) => onChunk({ stream: 'stderr', text }));
    }
  });
}

