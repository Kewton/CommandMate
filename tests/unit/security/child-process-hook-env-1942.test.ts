/**
 * `CM_HOOK_*` must not reach a child process (Issue #1942, 設計方針書 §13.2 S8).
 *
 * S8 has two halves. #1904 (PR #1941) landed the first — the port a hook needs
 * rides on the agent's launch line rather than being baked into a machine-global
 * settings file — and left the second unimplemented: the sanitizer that keeps
 * those variables from travelling any further.
 *
 * The environment being defended is **CommandMate's own**. Start a server from
 * inside a pane CommandMate launched and its `process.env` carries that pane's
 * `CM_HOOK_URL` and `CM_HOOK_PORT`; every child the server then spawns with
 * `sanitizeEnvForChildProcess()` — `claude -p` for Assistant Chat
 * (`session/claude-executor`), the slash-command probes
 * (`lib/slash-command-catalog`), `copilot --version`
 * (`cli-tools/copilot-executable`), the non-interactive assistant runner —
 * inherits them. A relay firing from one of those children posts to a different
 * server under a correlation key that is not its own. Nothing errors.
 *
 * Two things are asserted, and the second is why this file starts a real
 * process: `sanitizeEnvForChildProcess()` returning an object without the keys
 * and a child that genuinely cannot read them back are not the same claim, and
 * the positive control (the same child, inheriting `process.env` verbatim,
 * printing every one of them) is what makes the second non-vacuous.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { COMMANDMATE_HOOK_ENV_VARS } from '@/lib/hooks/sources/launch-command';
import {
  COMMANDMATE_HOOK_ENV_PREFIX,
  SENSITIVE_ENV_KEYS,
  isStrippedChildProcessEnvKey,
  sanitizeEnvForChildProcess,
} from '@/lib/security/env-sanitizer';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';

/** A value distinctive enough that finding it anywhere is unambiguous. */
function leakValue(name: string): string {
  return `cmate-1942-leak-${name}`;
}

/** Put every launch-line variable into this process's environment. */
function stubLaunchLineEnv(): void {
  for (const name of COMMANDMATE_HOOK_ENV_VARS) {
    vi.stubEnv(name, leakValue(name));
  }
}

/**
 * A node one-liner that reports which of `names` the child can actually read.
 *
 * The names are baked in from `COMMANDMATE_HOOK_ENV_VARS` rather than matched
 * by prefix inside the child, so the assertion stays tied to the list the
 * launch line is built from even if a name outside the namespace is ever added
 * to it.
 */
function readableNamesScript(names: readonly string[]): string {
  return `process.stdout.write(JSON.stringify(${JSON.stringify([...names])}.filter((n) => process.env[n] !== undefined)))`;
}

function namesVisibleToChild(env?: NodeJS.ProcessEnv): string[] {
  const stdout = execFileSync(
    process.execPath,
    ['-e', readableNamesScript(COMMANDMATE_HOOK_ENV_VARS)],
    { encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS, ...(env ? { env } : {}) }
  );
  return (JSON.parse(stdout) as string[]).sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CommandMate’s hook variables in a child environment (Issue #1942)', () => {
  it('strips every name the launch line declares', () => {
    stubLaunchLineEnv();

    const sanitized = sanitizeEnvForChildProcess();

    expect(COMMANDMATE_HOOK_ENV_VARS.length).toBeGreaterThan(0);
    for (const name of COMMANDMATE_HOOK_ENV_VARS) {
      expect(process.env[name], `${name} was not actually set — the assertion below is vacuous`)
        .toBe(leakValue(name));
      expect(sanitized[name], `${name} reached the child environment`).toBeUndefined();
    }
  });

  it('a real child process cannot read them back', () => {
    stubLaunchLineEnv();

    // Positive control: the same child, inheriting process.env untouched, sees
    // all of them. Without this the assertion below passes just as happily
    // against a machine where the variables were never set.
    expect(namesVisibleToChild()).toEqual([...COMMANDMATE_HOOK_ENV_VARS].sort());

    expect(namesVisibleToChild(sanitizeEnvForChildProcess())).toEqual([]);
  });

  it('holds the launch line to CommandMate’s own namespace', () => {
    // `lib/security` deliberately does not import `COMMANDMATE_HOOK_ENV_VARS`
    // — the dependency between the two packages already runs hooks → security
    // (`hooks/sources/copilot/hook-settings` imports `security/path-validator`),
    // so the sanitizer matches the `CM_HOOK_` namespace instead. This is the
    // join: a name added to the launch line outside that namespace would be
    // configured and still ride into every child process.
    for (const name of COMMANDMATE_HOOK_ENV_VARS) {
      expect(name.startsWith(COMMANDMATE_HOOK_ENV_PREFIX), `${name} is outside ${COMMANDMATE_HOOK_ENV_PREFIX}*`)
        .toBe(true);
      expect(isStrippedChildProcessEnvKey(name)).toBe(true);
    }
  });

  it('covers a CM_HOOK_ variable nobody has invented yet', () => {
    // The reason the rule is a prefix and not a copy of the list: the next
    // `CM_HOOK_*` value is stripped whether or not its author reads this file.
    vi.stubEnv('CM_HOOK_FUTURE_THING', leakValue('CM_HOOK_FUTURE_THING'));

    expect(sanitizeEnvForChildProcess().CM_HOOK_FUTURE_THING).toBeUndefined();
  });

  it('still removes the keys Issue #294 and #545 listed', () => {
    for (const key of SENSITIVE_ENV_KEYS) {
      vi.stubEnv(key, leakValue(key));
    }

    const sanitized = sanitizeEnvForChildProcess();

    for (const key of SENSITIVE_ENV_KEYS) {
      expect(sanitized[key], `${key} leaked`).toBeUndefined();
    }
  });

  it('leaves everything else alone, including the operator’s own CM_ settings', () => {
    stubLaunchLineEnv();
    vi.stubEnv('CM_PORT', '3000');
    vi.stubEnv('CM_HOOKS_DIRECTORY_LOOKALIKE', 'kept');

    const sanitized = sanitizeEnvForChildProcess();

    expect(sanitized.PATH).toBe(process.env.PATH);
    expect(sanitized.HOME).toBe(process.env.HOME);
    expect(sanitized.CM_PORT).toBe('3000');
    // The trailing underscore is load-bearing: `CM_HOOKS_*` is a different
    // namespace (`CM_AGENT_HOOKS_DIR` is a real setting) and survives. Pinned
    // so a future widening of the prefix has to be a decision.
    expect(sanitized.CM_HOOKS_DIRECTORY_LOOKALIKE).toBe('kept');
  });
});
