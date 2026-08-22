/**
 * Environment Variable Sanitizer
 * Issue #294: Sanitizes environment variables for child processes
 *
 * Removes sensitive environment variables (auth tokens, certificates, database paths)
 * before spawning child processes like `claude -p`.
 *
 * [S1-001/S4-001] Centralized sensitive key management
 *
 * ## Issue #1942 — why a *prefix* joined the list
 *
 * 設計方針書 §13.2 S8 asks for two halves. #1904 landed the first: the values a
 * hook needs are handed to the agent on its launch line (`CM_HOOK_PORT=3011
 * copilot`) instead of being baked into a machine-global settings file. This is
 * the second: those variables must not travel any further than the agent.
 *
 * The leak this closes is not the agent's own children — CommandMate does not
 * own that environment — it is **CommandMate's**. A server started from inside
 * a pane CommandMate itself launched inherits that pane's `CM_HOOK_*`, and
 * every child *this* process then spawns (`claude -p` for Assistant Chat, the
 * slash-command probes, `copilot --version`) inherits them in turn. The values
 * are a correlation key and a port: a relay firing from one of those children
 * posts its events to another server, attributed to an instance that is not the
 * one running. Nothing errors; the events simply land on the wrong session.
 */

/**
 * List of environment variable keys that must be removed before
 * passing environment to child processes.
 *
 * These include authentication tokens, TLS certificates, IP restriction
 * settings, and database paths that should not be inherited by spawned
 * CLI tool processes.
 */
export const SENSITIVE_ENV_KEYS = [
  'CLAUDECODE',
  'CM_AUTH_TOKEN_HASH',
  'CM_AUTH_EXPIRE',
  'CM_HTTPS_KEY',
  'CM_HTTPS_CERT',
  'CM_ALLOWED_IPS',
  'CM_TRUST_PROXY',
  'CM_DB_PATH',
  'GH_DEBUG',  // Issue #545: Prevent gh debug output in child processes [SEC4-003]
] as const;

/**
 * The namespace CommandMate writes onto an agent's launch line (Issue #1942).
 *
 * `lib/hooks/sources/launch-command` owns the *names* — `COMMANDMATE_HOOK_ENV_VARS`
 * is the enumerated list, and `tests/unit/security/child-process-hook-env-1942.test.ts`
 * pins that every one of them is caught by this prefix. That test is the join
 * between the two modules; the join is deliberately NOT an import.
 *
 * Importing the list here would point `lib/security` at `lib/hooks`, and the
 * dependency already runs the other way — `hooks/agent-event-service`,
 * `hooks/sources/copilot/hook-settings` and `hooks/sources/codex/hooks-config`
 * all import `lib/security/path-validator`. Inverting it for one array of two
 * strings would put a package cycle underneath four child-process spawners and
 * drag `hook-settings-generator`'s fs/crypto/logger graph in behind it.
 *
 * Matching the namespace is also strictly stronger than matching the list: a
 * `CM_HOOK_*` variable added next year is stripped whether or not anyone
 * remembers this file exists. `CM_HOOK_` is CommandMate's own namespace, so
 * there is no operator value here to preserve.
 */
export const COMMANDMATE_HOOK_ENV_PREFIX = 'CM_HOOK_';

/**
 * Whether `key` is removed from a child process's environment.
 *
 * @param key - An environment variable name
 * @returns `true` for a listed secret or anything in CommandMate's hook namespace
 */
export function isStrippedChildProcessEnvKey(key: string): boolean {
  return (
    (SENSITIVE_ENV_KEYS as readonly string[]).includes(key) ||
    key.startsWith(COMMANDMATE_HOOK_ENV_PREFIX)
  );
}

/**
 * Create a sanitized copy of process.env suitable for child processes.
 *
 * Removes every key {@link isStrippedChildProcessEnvKey} claims: the listed
 * secrets, plus CommandMate's own `CM_HOOK_*` namespace (Issue #1942).
 * Non-sensitive variables (PATH, HOME, NODE_ENV, etc.) are preserved.
 *
 * @returns A shallow copy of process.env with sensitive keys removed
 *
 * @example
 * ```typescript
 * import { execFile } from 'child_process';
 * import { sanitizeEnvForChildProcess } from './env-sanitizer';
 *
 * execFile('claude', ['-p', message], {
 *   env: sanitizeEnvForChildProcess(),
 *   cwd: worktreePath,
 * });
 * ```
 */
export function sanitizeEnvForChildProcess(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (isStrippedChildProcessEnvKey(key)) {
      delete env[key];
    }
  }
  return env;
}
