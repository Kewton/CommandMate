/**
 * Environment Variable Sanitizer
 * Issue #294: Sanitizes environment variables for child processes
 *
 * Removes sensitive environment variables (auth tokens, certificates, database paths)
 * before spawning child processes like `claude -p`.
 *
 * [S1-001/S4-001] Centralized sensitive key management
 *
 * ## What this file defends — the one sentence (Issue #1996)
 *
 * **A CommandMate process must hand its children neither a credential nor the
 * identity of the agent that started it.**
 *
 * Two halves, and they fail differently:
 *
 *  - **Credentials** — {@link SENSITIVE_ENV_KEYS}. A child that can read them
 *    can act as this server, or read its database.
 *  - **The launching agent's identity** — {@link AGENT_CORRELATION_ENV_KEYS}:
 *    every variable `AgentLaunchPlan.env` writes onto an agent's launch line
 *    that says *which server to report to* and *as which instance*. A child
 *    that inherits them reports somebody else's work as that instance's.
 *
 * A per-tool config redirect (`CODEX_HOME`) is on the launch line too and is
 * deliberately **not** stripped: it says where a tool reads its own settings,
 * which is neither a credential nor an identity, and a child that inherits one
 * is unaffected.
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
 * a pane CommandMate itself launched inherits that pane's launch line, and
 * every child *this* process then spawns (`claude -p` for Assistant Chat, the
 * slash-command probes, `copilot --version`) inherits it in turn. The values
 * are a correlation key and a port: a relay firing from one of those children
 * posts its events to another server, attributed to an instance that is not the
 * one running. Nothing errors; the events simply land on the wrong session.
 *
 * ## Issue #1996 — why the prefix could not be the whole rule
 *
 * #1942 chose `CM_HOOK_*` because a namespace is stronger than a list: the next
 * variable in it is stripped whether or not its author reads this file. That
 * reasoning is still right, and the prefix stays. What was wrong was the
 * premise that the namespace *covers the launch line*. Building all seven
 * sources' `prepareLaunch` and reading `env` back — the measurement is pinned in
 * `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts` — finds six identity
 * variables, and two of them start with `CM_HOOK_`.
 *
 * The other four produce the same failure #1942 named, by two measured routes:
 *
 *  - `scripts/hooks/cmate-agent-event.sh` reads `CM_AGENT_TOOL` from the
 *    environment (`TOOL="${CM_AGENT_TOOL:-claude}"`) and, with no `CM_HOOK_URL`,
 *    falls back to `http://127.0.0.1:${CM_PORT:-3000}/api/hooks/agent-event`.
 *    Stripping only the `CM_HOOK_` half therefore makes the destination *valid
 *    again* — usually the live server — while the attribution stays wrong. The
 *    event lands, on the wrong tool.
 *  - The generated antigravity `PreToolUse` command gates on
 *    `[ -z "${CM_PERMISSION_HOOK_URL:-}" ]`, which is its whole test for "am I a
 *    CommandMate-launched session". `~/.gemini/config/hooks.json` is a
 *    machine-global singleton, so an inherited `CM_PERMISSION_HOOK_URL` makes
 *    any agy started under one of CommandMate's children ask *another
 *    instance's* server for permission, and obey the answer.
 *
 * ### Why the prefix was not simply widened to `CM_AGENT_`
 *
 * Because `CM_AGENT_` is not CommandMate's own namespace, and the sentence that
 * justifies the `CM_HOOK_` prefix — "there is no operator value here to
 * preserve" — is false for it. `CM_AGENT_HOOKS_INJECT` and `CM_AGENT_HOOKS_DIR`
 * are **operator switches read from the ambient environment**
 * (`hooks/sources/copilot/hook-settings.ts`, `hooks/hook-settings-generator.ts`);
 * stripping them would silently change a child's configuration. #1942's own test
 * already pinned that shape. And `CM_PERMISSION_HOOK_URL` shares no prefix with
 * anything, so no namespace rule could have covered the set in any case.
 *
 * Renaming the four into `CM_HOOK_*` so the prefix *would* suffice was
 * considered and rejected: `CM_AGENT_TOOL` is documented in the shipped relay's
 * own `--help` and depended on by the hand-configured hooks of #1549, and
 * `~/.copilot/settings.json` / `~/.gemini/config/hooks.json` are machine-global
 * files already on disk carrying the old names — every already-configured
 * session would stop correlating until rewritten.
 *
 * So the rule is a **union**: the credential list, the enumerated identity set,
 * and the `CM_HOOK_` prefix that still covers whatever is invented inside it.
 *
 * ## The join with `lib/hooks`, and what replaces the prefix as a drift guard
 *
 * `lib/security` does not import `lib/hooks` — the dependency already runs the
 * other way (`hooks/agent-event-service`, `hooks/sources/copilot/hook-settings`
 * and `hooks/sources/codex/hooks-config` all import
 * `lib/security/path-validator`), and inverting it would put a package cycle
 * underneath four child-process spawners. `tests/unit/guards/security-no-hooks-import.test.ts`
 * holds that.
 *
 * The enumeration below is therefore a second copy of a list `lib/hooks` also
 * declares, and two tests are the join:
 *
 *  1. `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts` builds all seven
 *     `prepareLaunch` plans and asserts their env keys are **exactly**
 *     `AGENT_CORRELATION_ENV_VARS` plus `AGENT_LAUNCH_CONFIG_ENV_VARS`. A source
 *     that starts writing a new variable — in any namespace — goes red there, by
 *     name.
 *  2. `tests/unit/security/child-process-agent-env-1996.test.ts` takes that
 *     declared list and proves, with a real child process, that none of it is
 *     readable. Deleting a name from {@link AGENT_CORRELATION_ENV_KEYS} does not
 *     shrink what that test iterates, so the deletion is what goes red.
 *
 * Together those two are stronger than the prefix was, because the prefix never
 * covered a name outside its own namespace at all.
 */

/**
 * List of environment variable keys that must be removed before
 * passing environment to child processes.
 *
 * These include authentication tokens, TLS certificates, IP restriction
 * settings, and database paths that should not be inherited by spawned
 * CLI tool processes.
 *
 * `CM_AUTH_TOKEN` — the **plaintext** bearer token — joined in Issue #1996. Only
 * the `_HASH` form was listed, and the plaintext one is what a request is
 * actually authenticated with: measured with a real child, `claude -p` and the
 * version probes could read it back. It is expected in a server's environment
 * (the CLI's own `--token` warning tells operators to prefer the variable, and
 * §10.7 of the 設計方針書 has the agent's hooks read it "from process
 * inheritance"), and `lib/slash-command-catalog`'s docblock already claimed a
 * probe "never hands CommandMate's auth token … to a third-party CLI".
 *
 * Nothing that spawns with {@link sanitizeEnvForChildProcess} needs it: none of
 * the five call sites configures hooks for its child. The **agent's** pane is
 * unaffected — tmux inherits the server's environment directly and never goes
 * through this function — so `$CM_AUTH_TOKEN` still expands in a hook.
 */
export const SENSITIVE_ENV_KEYS = [
  'CLAUDECODE',
  'CM_AUTH_TOKEN',  // Issue #1996: plaintext bearer token, not just its hash
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
 * Kept alongside {@link AGENT_CORRELATION_ENV_KEYS} rather than replaced by it.
 * Inside this namespace the prefix is still the stronger rule — a `CM_HOOK_*`
 * variable invented next year is stripped whether or not anyone remembers this
 * file exists, and `CM_HOOK_` is CommandMate's own namespace, so there is no
 * operator value here to preserve. What #1996 measured is that the namespace is
 * two of the launch line's six identity variables, not all of them; see the
 * module comment.
 */
export const COMMANDMATE_HOOK_ENV_PREFIX = 'CM_HOOK_';

/**
 * Every variable an agent's launch line uses to say **which server to report to
 * and as which instance** (Issue #1996).
 *
 * The measured contents of `AgentLaunchPlan.env` across all seven sources, minus
 * the per-tool config redirects. `lib/hooks/sources/launch-command` declares the
 * same set as `AGENT_CORRELATION_ENV_VARS`; this is the second copy, and the two
 * tests named in the module comment are the join. Sorted, so a diff against the
 * measured set reads cleanly.
 *
 * Two of them are inside {@link COMMANDMATE_HOOK_ENV_PREFIX} and would be
 * stripped anyway. They are listed regardless: this array is the statement of
 * *what the rule is about*, and a reader who has to subtract a prefix to see the
 * set is a reader who will get it wrong again.
 */
export const AGENT_CORRELATION_ENV_KEYS = [
  'CM_AGENT_INSTANCE_ID',
  'CM_AGENT_TOOL',
  'CM_AGENT_WORKTREE_ID',
  'CM_HOOK_PORT',
  'CM_HOOK_URL',
  'CM_PERMISSION_HOOK_URL',
] as const;

/**
 * Whether `key` is removed from a child process's environment.
 *
 * @param key - An environment variable name
 * @returns `true` for a listed secret, a launch-line identity variable, or
 *   anything in CommandMate's hook namespace
 */
export function isStrippedChildProcessEnvKey(key: string): boolean {
  return (
    (SENSITIVE_ENV_KEYS as readonly string[]).includes(key) ||
    (AGENT_CORRELATION_ENV_KEYS as readonly string[]).includes(key) ||
    key.startsWith(COMMANDMATE_HOOK_ENV_PREFIX)
  );
}

/**
 * Create a sanitized copy of process.env suitable for child processes.
 *
 * Removes every key {@link isStrippedChildProcessEnvKey} claims: the listed
 * secrets (Issue #294/#545/#1996), the launch-line identity of the agent this
 * process was started under (Issue #1996), and CommandMate's own `CM_HOOK_*`
 * namespace (Issue #1942). Non-sensitive variables (PATH, HOME, NODE_ENV, etc.)
 * are preserved, including the operator's own `CM_AGENT_HOOKS_*` switches.
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
