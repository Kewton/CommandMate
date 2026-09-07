/**
 * whoami Command - which session am I? (Issue #2376)
 *
 *   commandmate whoami [--json]
 *
 * ## Why an agent cannot answer this for itself
 *
 * Every delegation command needs a worktree id and an instance id, and an agent
 * running INSIDE one of those sessions had no way to produce either. `ls` lists
 * every worktree on the machine without saying which row is the caller;
 * `instances` needs the worktree id you are trying to find out. So the first
 * step of "ask that other session something" was a human pasting two ids in.
 *
 * ## Where the answer comes from, in order
 *
 * 1. **The environment.** `CM_WORKTREE_ID` / `CM_INSTANCE_ID` / `CM_CLI_TOOL`
 *    first, then the `CM_AGENT_*` correlation variables CommandMate already
 *    puts on the launch line of every tool whose hooks ride there (codex,
 *    copilot, gemini, antigravity, opencode, command-code — see
 *    `AGENT_CORRELATION_ENV_VARS` in `lib/hooks/sources/launch-command.ts`).
 *    Authoritative when present: the server wrote them when it started the
 *    session.
 * 2. **The tmux session name.** claude is configured through `--settings` and
 *    carries no launch-line environment at all, so for the most common agent
 *    of the lot the environment says nothing. `mcbd-<tool>-<worktree>[-<n>]` is
 *    the name CommandMate gave the session (`lib/cli-tools/session-name.ts`),
 *    and a shell inside the pane can read it back from tmux. Shelling out to
 *    `tmux` rather than importing anything: the CLI build sets `paths: {}` and
 *    an ESLint guard (Issue #1922) forbids `lib/tmux/**` outright — `attach`
 *    already talks to the binary the same way.
 *
 * Neither one answering means this is not a CommandMate-started session, and
 * that is {@link NOT_IN_SESSION} rather than a guess.
 */

import { spawnSync } from 'child_process';
import { Command } from 'commander';
import type { AgentInstance, WorktreeItem, WorktreeListResponse } from '../types/api-responses';
import { ApiClient } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { CLI_TOOL_IDS, isCliToolId } from '../config/cli-tool-ids';
import { fetchAgentInstances } from '../utils/agent-instances';

/**
 * Exit code for "this shell is not inside a CommandMate agent session".
 *
 * 3 by the Issue's contract. It is the numeric slot `ExitCode.START_FAILED`
 * occupies for the server-lifecycle commands, and it is spelled here as its own
 * constant rather than reused from that enum because the two mean nothing alike:
 * a caller branching on `whoami` exiting 3 is asking "am I inside a session",
 * not "did a server fail to start". `src/cli/types/index.ts` is where the shared
 * enum lives; adding a name to it is a separate change from this one.
 */
export const NOT_IN_SESSION = 3;

/** Environment names CommandMate sets, newest spelling first. */
const WORKTREE_ENV_VARS = ['CM_WORKTREE_ID', 'CM_AGENT_WORKTREE_ID'] as const;
const INSTANCE_ENV_VARS = ['CM_INSTANCE_ID', 'CM_AGENT_INSTANCE_ID'] as const;
const TOOL_ENV_VARS = ['CM_CLI_TOOL', 'CM_AGENT_TOOL'] as const;

/** The tmux session-name prefix `resolveSessionName` builds every name from. */
const SESSION_NAME_PREFIX = 'mcbd-';

/** How this identity was established. Reported so a wrong answer is traceable. */
export type IdentitySource = 'env' | 'tmux-session';

/** Who the caller is, as far as anything can say. */
export interface SessionIdentity {
  worktreeId: string;
  /** Instance ID. The primary instance is `instanceId === cliToolId` (#868). */
  instanceId: string;
  cliToolId: string;
  source: IdentitySource;
  /** The tmux session, when the identity came from (or could be checked against) one. */
  sessionName: string | null;
  /**
   * Every worktree id the server answered with while this identity was resolved,
   * or null/undefined when no list was read (Issue #2404).
   *
   * Carried rather than discarded because it is the whole evidence for
   * {@link detectServerMismatch}: the tmux path already fetches it to break the
   * `-<n>` ambiguity, so "is my own worktree on the server I am dialling?" costs
   * no second request. Absent on the env path, which never asks — and that is
   * the reason a `source: 'env'` identity never reports a mismatch here.
   */
  knownWorktreeIds?: Set<string> | null;
}

/**
 * The caller is on a session one server started and is talking to another
 * (Issue #2404).
 */
export interface ServerMismatch {
  /** The worktree this session belongs to, as {@link resolveSessionIdentity} read it. */
  worktreeId: string;
  /** The server this CLI is dialling — the one that does NOT list that worktree. */
  serverUrl: string;
  /** Where the worktree id came from, so the warning can say how it is known. */
  source: IdentitySource;
}

/** First non-empty value among `names`, or undefined. */
function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The tmux session this process is running inside, or null.
 *
 * `$TMUX` is checked first so a call from an ordinary shell costs no process
 * spawn at all — `whoami` outside a session is the case that has to be cheap,
 * because a script that probes for CommandMate runs it once per invocation.
 *
 * @param env - Environment to read
 * @returns The session name, or null when there is no tmux to ask
 */
export function readTmuxSessionName(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!env.TMUX) return null;
  const result = spawnSync('tmux', ['display-message', '-p', '#{session_name}'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  const name = (result.stdout ?? '').trim();
  return name === '' ? null : name;
}

/** A session name split into the parts {@link resolveSessionName} put there. */
interface ParsedSessionName {
  cliToolId: string;
  /** Everything after `mcbd-<tool>-`: a worktree id, possibly plus `-<n>`. */
  remainder: string;
}

/**
 * Split `mcbd-<tool>-<rest>` into its tool and the rest.
 *
 * Matched against the tool ids longest-first, because two of them contain a
 * hyphen (`vibe-local`, `command-code`) and a shortest-first scan would read
 * `mcbd-command-code-wt` as the tool `command` — which is not a tool, but the
 * scan does not know that until it has already split in the wrong place.
 *
 * @param sessionName - A tmux session name
 * @returns The parts, or null when this is not a CommandMate session name
 */
export function parseSessionName(sessionName: string): ParsedSessionName | null {
  if (!sessionName.startsWith(SESSION_NAME_PREFIX)) return null;
  const body = sessionName.slice(SESSION_NAME_PREFIX.length);

  const byLength = [...CLI_TOOL_IDS].sort((a, b) => b.length - a.length);
  for (const cliToolId of byLength) {
    const prefix = `${cliToolId}-`;
    if (body.startsWith(prefix)) {
      const remainder = body.slice(prefix.length);
      return remainder === '' ? null : { cliToolId, remainder };
    }
  }
  return null;
}

/**
 * Every worktree id the server knows, or null when it could not be asked.
 *
 * Best effort by design: it is used only to break the one ambiguity a session
 * name has, and a `whoami` that cannot reach the daemon still has an answer
 * worth printing.
 */
async function readWorktreeIds(client: ApiClient): Promise<Set<string> | null> {
  try {
    const response = await client.get<WorktreeListResponse>('/api/worktrees');
    return new Set((response.worktrees ?? []).map((wt: WorktreeItem) => wt.id));
  } catch {
    return null;
  }
}

/**
 * Decide which part of `mcbd-<tool>-<remainder>` is the worktree.
 *
 * `mcbd-claude-anvil-develop-2` is genuinely two readings: worktree
 * `anvil-develop-2` running claude's primary instance, or worktree
 * `anvil-develop` running `claude-2`. Both are names CommandMate produces. The
 * worktree list settles it; without one the primary reading wins, because a
 * worktree id ending in a number is ordinary (`feature/2-…` slugs to
 * `repo-feature-2`) while a second instance is not the common case.
 *
 * @param parsed - Tool and remainder from {@link parseSessionName}
 * @param knownWorktreeIds - Worktree ids from the server, or null
 */
function splitRemainder(
  parsed: ParsedSessionName,
  knownWorktreeIds: Set<string> | null,
): { worktreeId: string; instanceId: string } {
  const { cliToolId, remainder } = parsed;
  const primary = { worktreeId: remainder, instanceId: cliToolId };

  const suffixMatch = /^(.*)-(\d+)$/.exec(remainder);
  if (!suffixMatch) return primary;

  const [, base, suffix] = suffixMatch;
  if (!knownWorktreeIds) return primary;
  if (knownWorktreeIds.has(remainder)) return primary;
  if (base !== '' && knownWorktreeIds.has(base)) {
    return { worktreeId: base, instanceId: `${cliToolId}-${suffix}` };
  }
  return primary;
}

/**
 * Work out which session this process is running inside.
 *
 * @param client - API client, used only to disambiguate a session name
 * @param env - Environment to read
 * @returns The identity, or null when nothing establishes one
 */
export async function resolveSessionIdentity(
  client: ApiClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<SessionIdentity | null> {
  const sessionName = readTmuxSessionName(env);

  const envWorktree = readEnv(env, WORKTREE_ENV_VARS);
  if (envWorktree) {
    const envTool = readEnv(env, TOOL_ENV_VARS);
    const envInstance = readEnv(env, INSTANCE_ENV_VARS);
    // The tool is the one field with a sane derivation when it is missing: a
    // primary instance id IS its tool id (#868), so `CM_INSTANCE_ID=codex`
    // says codex on its own.
    const cliToolId = envTool
      ?? (envInstance && isCliToolId(envInstance) ? envInstance : undefined);
    if (cliToolId) {
      return {
        worktreeId: envWorktree,
        instanceId: envInstance ?? cliToolId,
        cliToolId,
        source: 'env',
        sessionName,
      };
    }
  }

  if (!sessionName) return null;
  const parsed = parseSessionName(sessionName);
  if (!parsed) return null;

  const known = await readWorktreeIds(client);
  const { worktreeId, instanceId } = splitRemainder(parsed, known);
  return {
    worktreeId,
    instanceId,
    cliToolId: parsed.cliToolId,
    source: 'tmux-session',
    sessionName,
    knownWorktreeIds: known,
  };
}

// ===========================================================================
// "Am I even talking to the server that started me?" (Issue #2404)
// ===========================================================================

/**
 * Whether the caller's own worktree is missing from the server it is dialling.
 *
 * The contradiction this names was, until now, unnameable: `whoami` answers
 * from the tmux session name and therefore succeeds, while `ls` / `instances` /
 * `peers` answer from a *different* server's ledger and therefore say the
 * worktree does not exist. Both are correct and they disagree, and an agent
 * reading them concluded the reasonable, wrong thing — "I must not be in the
 * ledger" — and delegated its work into an unrelated worktree on the other
 * server (#2403). Exit codes said nothing: `ask` returned 0.
 *
 * Deliberately NOT gated on {@link IdentitySource}. The gate is having a list at
 * all: the env path never fetches one, so it passes null and cannot flag, while
 * `peers` — which has just fetched the whole list for its own listing — can
 * check an env-derived identity for free. A missing list is never a mismatch:
 * a stopped server must not be reported as the wrong server.
 *
 * @param identity - Who the caller is
 * @param knownWorktreeIds - Worktree ids from the server, or null when unread
 * @param serverUrl - The URL those ids came from ({@link ApiClient.serverUrl})
 * @returns The mismatch, or null when there is nothing to report
 */
export function detectServerMismatch(
  identity: SessionIdentity,
  knownWorktreeIds: Set<string> | null | undefined,
  serverUrl: string,
): ServerMismatch | null {
  if (!knownWorktreeIds) return null;
  if (knownWorktreeIds.has(identity.worktreeId)) return null;
  return { worktreeId: identity.worktreeId, serverUrl, source: identity.source };
}

/** How the worktree id was established, as a phrase for the warning. */
function describeSource(source: IdentitySource): string {
  return source === 'tmux-session'
    ? 'read from the tmux session name'
    : 'read from the CM_* variables on this session\'s launch line';
}

/**
 * The multi-line warning printed when {@link detectServerMismatch} fires.
 *
 * Says what is wrong, why it is not a typo, and what it costs to ignore —
 * because the failure it describes is silent by construction: every command
 * involved keeps exiting 0 while answering about the wrong machine's worktrees.
 */
export function formatServerMismatchWarning(mismatch: ServerMismatch): string {
  return [
    `Warning: this session is worktree '${mismatch.worktreeId}' (${describeSource(mismatch.source)}), `
      + `but the server this CLI is talking to (${mismatch.serverUrl}) does not list it.`,
    '  You are almost certainly connected to a DIFFERENT CommandMate server than the one that started this session.',
    '  Everything that reads the server ledger — ls / instances / peers / ask — is answering about that other server,',
    '  so anything delegated from here can land in an unrelated worktree while still exiting 0.',
    '  Aim the CLI at the right server (CM_PORT=<port> commandmate …) or check ~/.commandmate/.env, then re-run.',
  ].join('\n');
}

/** The one-line form, for a command that has already failed for another reason. */
export function formatServerMismatchHint(mismatch: ServerMismatch): string {
  return (
    `Hint: this session is worktree '${mismatch.worktreeId}' (${describeSource(mismatch.source)}), `
    + `which the server at ${mismatch.serverUrl} does not list — this CLI is probably connected to a `
    + 'different CommandMate server than the one that started this session, so the id is not the problem.'
  );
}

/**
 * Resolve the caller's identity and report a mismatch, or null.
 *
 * For commands that only need this on a failure path: it costs a `tmux
 * display-message` and one `GET /api/worktrees`, and it is called after the
 * request that already failed. Never throws — a diagnosis that fails must not
 * replace the error it was diagnosing.
 *
 * @param client - The client whose 404 is being explained
 */
export async function describeServerMismatch(client: ApiClient): Promise<ServerMismatch | null> {
  try {
    const identity = await resolveSessionIdentity(client);
    if (!identity) return null;
    // The env path carries no list, so ask for one here: this runs only after a
    // command has already failed, where one extra request buys the difference
    // between "check the worktree ID" and the actual cause.
    const known = identity.knownWorktreeIds ?? (await readWorktreeIds(client));
    return detectServerMismatch(identity, known, client.serverUrl);
  } catch {
    return null;
  }
}

/**
 * The roster row for this identity, or null.
 *
 * Best effort: the alias is a nicety (it is what the GUI calls this session),
 * and a worktree whose roster cannot be read still has a usable identity.
 */
export async function readOwnRosterEntry(
  client: ApiClient,
  identity: SessionIdentity,
): Promise<AgentInstance | null> {
  try {
    const instances = await fetchAgentInstances(client, identity.worktreeId);
    return instances.find((inst) => inst.id === identity.instanceId) ?? null;
  } catch {
    return null;
  }
}

/** The sentence printed when nothing establishes an identity. */
export const NOT_IN_SESSION_MESSAGE =
  'Error: not inside a CommandMate agent session.\n'
  + '  whoami reads CM_WORKTREE_ID / CM_INSTANCE_ID / CM_CLI_TOOL (or the CM_AGENT_* '
  + 'variables CommandMate puts on an agent launch line), and falls back to the\n'
  + '  mcbd-<tool>-<worktree> tmux session name. Neither said anything here, which '
  + 'means this shell was not started by CommandMate.\n'
  + '  Use `commandmate ls` to list worktrees from outside a session.';

export function createWhoamiCommand(): Command {
  const cmd = new Command('whoami');
  cmd
    .description('Print which worktree / agent instance this session is (exit 3 outside one)')
    .option('--json', 'JSON output')
    .option('--token <token>', TOKEN_WARNING)
    .action(async (options: { json?: boolean; token?: string }) => {
      try {
        const client = new ApiClient({ token: options.token });
        const identity = await resolveSessionIdentity(client);

        if (!identity) {
          console.error(NOT_IN_SESSION_MESSAGE);
          process.exit(NOT_IN_SESSION);
          return;
        }

        const roster = await readOwnRosterEntry(client, identity);
        // Issue #2404: no extra request — `resolveSessionIdentity` already read
        // the list on the tmux path, which is the path that can be wrong.
        const mismatch = detectServerMismatch(
          identity,
          identity.knownWorktreeIds,
          client.serverUrl,
        );

        // stderr in both modes: it must not corrupt `--json` stdout, and a skill
        // that reports "I asked <url>" needs to see it whichever mode it ran in.
        // Exit code stays 0 — whoami still answered the question it was asked.
        if (mismatch) console.error(formatServerMismatchWarning(mismatch));

        if (options.json) {
          console.log(JSON.stringify({
            worktreeId: identity.worktreeId,
            instanceId: identity.instanceId,
            cliToolId: identity.cliToolId,
            alias: roster?.alias ?? null,
            source: identity.source,
            sessionName: identity.sessionName,
            // Always present: "where did this answer come from" is half of what
            // makes the answer checkable (Issue #2404).
            serverUrl: client.serverUrl,
            // Absent, not false, when everything agrees: a reader tests for the
            // flag, and an ordinary session's output carries no trace of it.
            ...(mismatch ? { serverMismatch: true } : {}),
          }, null, 2));
          return;
        }

        console.log(`worktree:  ${identity.worktreeId}`);
        console.log(`instance:  ${identity.instanceId}`);
        console.log(`cli_tool:  ${identity.cliToolId}`);
        console.log(`alias:     ${roster?.alias ?? '-'}`);
        console.log(`source:    ${identity.source}`);
        console.log(`tmux:      ${identity.sessionName ?? '-'}`);
        console.log(`server:    ${client.serverUrl}`);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
