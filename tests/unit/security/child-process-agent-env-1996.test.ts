/**
 * A child process may read neither CommandMate's credentials nor the identity
 * of the agent CommandMate was started under (Issue #1996).
 *
 * ## What #1942 left open
 *
 * #1942 stripped `CM_HOOK_*` by prefix, on the reasoning that a namespace is
 * stronger than a list. The reasoning holds; the premise did not. #1933 then
 * built all seven sources' `prepareLaunch` and read `env` back, and recorded —
 * in `tests/unit/lib/agent-launch-plan-secrets-1933.test.ts`, as an assertion
 * rather than a comment — that the launch line carries **six** identity
 * variables and that the prefix caught two of them. This file is the other four
 * closing, plus a credential the list never had.
 *
 * ## The definition being enforced
 *
 * **A CommandMate process hands its children neither a credential nor the
 * identity of the agent that started it.** The identity half is
 * `AGENT_CORRELATION_ENV_VARS` — which server to report to, and as which
 * instance. A per-tool config redirect (`AGENT_LAUNCH_CONFIG_ENV_VARS`) is on
 * the same launch line and is deliberately kept: it says where a tool reads its
 * own settings, which is neither.
 *
 * ## Why this starts real processes
 *
 * Same reason #1942's file does, and the reason the acceptance condition names
 * it: `sanitizeEnvForChildProcess()` returning an object without a key and a
 * child that genuinely cannot read that key back are not the same claim. The
 * positive control — the same child, inheriting `process.env` verbatim, printing
 * every one of them — is what stops the negative assertion passing on a machine
 * where the variables were never set.
 *
 * ## Why the names come from `lib/hooks` and not from `lib/security`
 *
 * So that deleting a name from `AGENT_CORRELATION_ENV_KEYS` is caught here
 * instead of silently shrinking what this file iterates. `lib/security` does not
 * import `lib/hooks` — `tests/unit/guards/security-no-hooks-import.test.ts`
 * holds that — so the two modules keep independent copies and these assertions
 * are the join, exactly as #1942 arranged it. Whether `lib/hooks`' copy still
 * matches the *measured* launch line is the other half, asserted in #1933's
 * file where the plans are already built.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  AGENT_CORRELATION_ENV_VARS,
  AGENT_LAUNCH_CONFIG_ENV_VARS,
} from '@/lib/hooks/sources/launch-command';
import {
  AGENT_CORRELATION_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  isStrippedChildProcessEnvKey,
  sanitizeEnvForChildProcess,
} from '@/lib/security/env-sanitizer';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';

/**
 * Everything a child must not be able to read: the launch line's identity, as
 * `lib/hooks` declares it, plus every credential.
 *
 * The union is built from the two independent declarations rather than from
 * `isStrippedChildProcessEnvKey`, which is the function under test.
 */
const MUST_NOT_REACH_A_CHILD: readonly string[] = [
  ...AGENT_CORRELATION_ENV_VARS,
  ...SENSITIVE_ENV_KEYS,
];

/** A value distinctive enough that finding it anywhere is unambiguous. */
function leakValue(name: string): string {
  return `cmate-1996-leak-${name}`;
}

function stubEnv(names: readonly string[]): void {
  for (const name of names) vi.stubEnv(name, leakValue(name));
}

/**
 * A node one-liner reporting which of `names` the child can actually read, and
 * with what value — the value matters because a variable that survived as an
 * empty string is still a variable that survived.
 */
function namesVisibleToChild(names: readonly string[], env?: NodeJS.ProcessEnv): string[] {
  const script =
    `process.stdout.write(JSON.stringify(${JSON.stringify([...names])}` +
    `.filter((n) => process.env[n] !== undefined)))`;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
  return (JSON.parse(stdout) as string[]).sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the set a child process must not inherit (Issue #1996)', () => {
  it('is the launch line’s identity plus every credential, and is not empty', () => {
    // Non-vacuity for everything below: the union is what the real-child tests
    // iterate, so a name dropped from either half shrinks the iteration instead
    // of failing an assertion. Both halves are counted, and the two names whose
    // absence started this Issue are asserted by name.
    expect(AGENT_CORRELATION_ENV_VARS.length).toBe(6);
    expect(SENSITIVE_ENV_KEYS.length).toBe(10);
    expect(MUST_NOT_REACH_A_CHILD).toContain('CM_AUTH_TOKEN');
    expect(MUST_NOT_REACH_A_CHILD).toContain('CM_PERMISSION_HOOK_URL');
    expect(new Set(MUST_NOT_REACH_A_CHILD).size).toBe(MUST_NOT_REACH_A_CHILD.length);
  });

  it('agrees, name for name, with what `lib/security` enumerates', () => {
    // The join. `lib/hooks/sources/launch-command` owns the names because it is
    // the module the launch line is rendered by; `lib/security` cannot import it
    // without inverting a dependency that already runs hooks -> security. So the
    // second copy is checked here, in both directions — a name added to one list
    // and not the other is what this catches.
    expect([...AGENT_CORRELATION_ENV_KEYS].sort()).toEqual([...AGENT_CORRELATION_ENV_VARS].sort());
  });

  it('claims every one of them, and none of the config redirects', () => {
    for (const name of MUST_NOT_REACH_A_CHILD) {
      expect(isStrippedChildProcessEnvKey(name), `${name} is not claimed`).toBe(true);
    }
    for (const name of AGENT_LAUNCH_CONFIG_ENV_VARS) {
      expect(isStrippedChildProcessEnvKey(name), `${name} is a redirect, not an identity`).toBe(
        false
      );
    }
  });
});

describe('a real child process cannot read them back (Issue #1996)', () => {
  it('sees all of them when the environment is inherited untouched', () => {
    // The positive control. Without it the assertion in the next test passes
    // just as happily against a machine where nothing was ever set.
    stubEnv(MUST_NOT_REACH_A_CHILD);

    expect(namesVisibleToChild(MUST_NOT_REACH_A_CHILD)).toEqual(
      [...MUST_NOT_REACH_A_CHILD].sort()
    );
  });

  it('sees none of them through `sanitizeEnvForChildProcess()`', () => {
    stubEnv(MUST_NOT_REACH_A_CHILD);

    expect(namesVisibleToChild(MUST_NOT_REACH_A_CHILD, sanitizeEnvForChildProcess())).toEqual([]);
  });

  it('still hands the child its config redirects and the operator’s own settings', () => {
    stubEnv(MUST_NOT_REACH_A_CHILD);
    // `CM_AGENT_HOOKS_INJECT` and `CM_AGENT_HOOKS_DIR` are why the prefix was
    // not simply widened to `CM_AGENT_`: they are operator switches read from
    // the ambient environment, not names CommandMate writes onto a launch line.
    const kept = [...AGENT_LAUNCH_CONFIG_ENV_VARS, 'CM_AGENT_HOOKS_INJECT', 'CM_AGENT_HOOKS_DIR'];
    stubEnv(kept);

    expect(namesVisibleToChild(kept, sanitizeEnvForChildProcess())).toEqual([...kept].sort());
  });
});

describe('the plaintext auth token (Issue #1996, 優先度高)', () => {
  /**
   * Measured before the fix: `SENSITIVE_ENV_KEYS` listed `CM_AUTH_TOKEN_HASH`
   * and not `CM_AUTH_TOKEN`, and a real child launched through
   * `sanitizeEnvForChildProcess()` printed the plaintext token back. Every
   * spawner that uses this function — `claude -p` for Assistant Chat, the
   * slash-command probes, `copilot --version`, the detector version probes, the
   * non-interactive assistant runner — was handing a third-party CLI a bearer
   * token for this server, while `lib/slash-command-catalog`'s own docblock said
   * a probe "never hands CommandMate's auth token … to a third-party CLI".
   *
   * The variable is expected to be present: `src/cli/utils/api-client.ts` warns
   * operators to prefer it over `--token`, and 設計方針書 §10.7 has the agent's
   * hooks read it "from process inheritance". That inheritance is tmux's, which
   * copies the server's environment directly and never calls this function, so
   * `$CM_AUTH_TOKEN` still expands inside a hook on the agent's pane.
   */
  it('is stripped, unlike before, and separately from its hash', () => {
    vi.stubEnv('CM_AUTH_TOKEN', leakValue('CM_AUTH_TOKEN'));
    vi.stubEnv('CM_AUTH_TOKEN_HASH', leakValue('CM_AUTH_TOKEN_HASH'));

    expect(SENSITIVE_ENV_KEYS).toContain('CM_AUTH_TOKEN');
    expect(namesVisibleToChild(['CM_AUTH_TOKEN', 'CM_AUTH_TOKEN_HASH'])).toEqual([
      'CM_AUTH_TOKEN',
      'CM_AUTH_TOKEN_HASH',
    ]);
    expect(
      namesVisibleToChild(['CM_AUTH_TOKEN', 'CM_AUTH_TOKEN_HASH'], sanitizeEnvForChildProcess())
    ).toEqual([]);
  });

  it('does not leak its value into the child by some other name', () => {
    // A key removed from the copy but re-added under an alias would satisfy
    // every assertion above. This looks for the value itself.
    const secret = leakValue('CM_AUTH_TOKEN');
    vi.stubEnv('CM_AUTH_TOKEN', secret);

    const sanitized = sanitizeEnvForChildProcess();
    const stdout = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { encoding: 'utf8', timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS, env: sanitized }
    );

    expect(stdout).not.toContain(secret);
  });
});
