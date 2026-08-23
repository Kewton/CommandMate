/**
 * `AgentLaunchPlan.env` carries the hook correlation keys and nothing else
 * (Issue #1933, 受入条件 S18).
 *
 * ## What is at stake
 *
 * `renderAgentLaunchCommand` turns a plan into `NAME='value' … command` and
 * `cli-tools/*.ts` types that line into a tmux pane. A pane's command line is
 * readable by `ps`, is echoed on the terminal surface CommandMate renders, and
 * — because the agent inherits it — reaches every child the agent spawns. So a
 * secret that lands in `env` does not stay in `env`.
 *
 * ## Why this is not the same pin as #1942's
 *
 * The two guards run in opposite directions and both are needed:
 *
 *  - `tests/unit/security/child-process-hook-env-1942.test.ts` pins that every
 *    name in `COMMANDMATE_HOOK_ENV_VARS` starts with `CM_HOOK_`, so
 *    `sanitizeEnvForChildProcess()`'s prefix strip catches all of them. That is
 *    about what leaves *CommandMate's own* children.
 *  - This file pins that `AgentLaunchPlan.env` contains **only** correlation
 *    keys and each source's own declared config variable — no credential, and
 *    no value read out of the ambient environment. That is about what enters
 *    *the agent's* environment.
 *
 * They agree on `CM_HOOK_*`, and they must: those variables are deliberately on
 * the launch line (#1904) and deliberately stripped from CommandMate's children
 * (#1942). A test that simply banned `CM_HOOK_*` here would contradict the
 * mechanism it is supposed to protect, so the assertion is an allowlist of
 * namespaces, with the secret list checked separately and exactly.
 *
 * Building the plans also turned up something #1942's docblock did not say: the
 * launch line carries SIX correlation variables, and only two of them start
 * with `CM_HOOK_`. Issue #1996 closed that — all six are stripped now, by an
 * enumeration beside the prefix — and moved the measurement from a record into
 * a **drift guard**: the last test asserts the seven plans' env keys are
 * EXACTLY `AGENT_CORRELATION_ENV_VARS` plus `AGENT_LAUNCH_CONFIG_ENV_VARS`, in
 * both directions. That is what replaces the prefix for names outside
 * `CM_HOOK_`, which the prefix never covered at all.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import {
  AGENT_CORRELATION_ENV_VARS,
  AGENT_LAUNCH_CONFIG_ENV_VARS,
  COMMANDMATE_HOOK_ENV_VARS,
  renderAgentLaunchCommand,
} from '@/lib/hooks/sources/launch-command';
import {
  SENSITIVE_ENV_KEYS,
  COMMANDMATE_HOOK_ENV_PREFIX,
  isStrippedChildProcessEnvKey,
} from '@/lib/security/env-sanitizer';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import type { AgentLaunchPlan } from '@/lib/hooks/sources/types';

/**
 * Secrets planted in `process.env` before the plans are built.
 *
 * `CM_AUTH_TOKEN` is the one the acceptance condition names; the rest are the
 * other credentials `SENSITIVE_ENV_KEYS` knows about. A source that read the
 * ambient environment and copied any of them onto the launch line would show up
 * here as a value, not merely as a name.
 */
const PLANTED_SECRETS: Record<string, string> = {
  CM_AUTH_TOKEN: 'ZZTOP-cm-auth-token-1933',
  CM_AUTH_TOKEN_HASH: 'ZZTOP-cm-auth-hash-1933',
  CM_HTTPS_KEY: 'ZZTOP-https-key-1933',
  CM_HTTPS_CERT: 'ZZTOP-https-cert-1933',
  CM_DB_PATH: 'ZZTOP-db-path-1933',
  CM_ALLOWED_IPS: 'ZZTOP-allowed-ips-1933',
  GH_DEBUG: 'ZZTOP-gh-debug-1933',
};

/**
 * Config-file variables a source is allowed to set, beyond the correlation set.
 *
 * A per-tool HOME/config redirect the tool needs in order to read the settings
 * file CommandMate wrote for it. This file used to carry its own allowlist of
 * three (`CODEX_HOME` / `XDG_CONFIG_HOME` / `COPILOT_HOME`); #1996 measured that
 * only `CODEX_HOME` is ever written — the other two are *read* from the ambient
 * environment to decide where a file goes and never reach `plan.env` — and moved
 * the declaration into `launch-command` so the exact-set assertion below has one
 * list rather than a local copy.
 */
const ALLOWED_CONFIG_ENV_VARS = AGENT_LAUNCH_CONFIG_ENV_VARS;

/**
 * Every correlation variable a source may set, as MEASURED and now DECLARED.
 *
 * Until #1996 this was a pair of namespace prefixes, because
 * `COMMANDMATE_HOOK_ENV_VARS` named two variables while the launch line carried
 * six. A prefix allowlist admits a name nobody has looked at, which is the wrong
 * shape for the question "did a source start exporting something new?" — so the
 * declaration is now the exact list, `AGENT_CORRELATION_ENV_VARS`, and the last
 * test in this file holds the measurement to it in both directions.
 */
const ALLOWED_CORRELATION_NAMES = AGENT_CORRELATION_ENV_VARS;

const originalEnv = { ...process.env };

function planFor(cliToolId: CLIToolType): AgentLaunchPlan {
  return getAgentEventSource(cliToolId).prepareLaunch({
    target: { worktreeId: 'wt-1933', cliToolId, instanceId: cliToolId },
    executablePath: `/usr/local/bin/${cliToolId}`,
    worktreePath: '/tmp/cm-1933-worktree',
  });
}

describe('AgentLaunchPlan.env carries no secrets (Issue #1933 S18)', () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(PLANTED_SECRETS)) {
      process.env[name] = value;
    }
  });

  afterEach(() => {
    for (const name of Object.keys(PLANTED_SECRETS)) {
      if (originalEnv[name] === undefined) delete process.env[name];
      else process.env[name] = originalEnv[name];
    }
  });

  it.each(CLI_TOOL_IDS)('%s: names no secret and leaks no secret value', (cliToolId) => {
    const plan = planFor(cliToolId);
    const rendered = renderAgentLaunchCommand(plan);

    for (const name of Object.keys(plan.env)) {
      expect(SENSITIVE_ENV_KEYS).not.toContain(name);
      expect(name).not.toBe('CM_AUTH_TOKEN');
    }
    for (const [name, value] of Object.entries(PLANTED_SECRETS)) {
      expect(Object.values(plan.env)).not.toContain(value);
      // The rendered line is what actually reaches the pane, so it is checked
      // as well as the map it was built from.
      expect(rendered).not.toContain(value);
      expect(rendered).not.toContain(`${name}=`);
    }
  });

  it.each(CLI_TOOL_IDS)(
    '%s: names only a correlation key or a declared config var',
    (cliToolId) => {
      const plan = planFor(cliToolId);

      for (const name of Object.keys(plan.env)) {
        const allowed =
          ALLOWED_CORRELATION_NAMES.includes(name) || ALLOWED_CONFIG_ENV_VARS.includes(name);
        expect(allowed, `unexpected launch-line variable: ${name}`).toBe(true);
      }
    }
  );

  it.each(CLI_TOOL_IDS)('%s: keeps `command` free of NAME=value prefixes', (cliToolId) => {
    // The contract `AgentLaunchPlan.command` states: the executable and its
    // flags, and nothing else. A source that went back to prefixing its own
    // string would put variables somewhere this file cannot inspect.
    const { command } = planFor(cliToolId);
    const firstWord = command.trim().split(/\s+/)[0];
    expect(firstWord).not.toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/);
  });

  /**
   * The join with #1942, restated from this side: everything the enumerated
   * hook list names must be something a child process has stripped.
   */
  it('agrees with the sanitizer about the CM_HOOK_ namespace', () => {
    for (const name of COMMANDMATE_HOOK_ENV_VARS) {
      expect(name.startsWith(COMMANDMATE_HOOK_ENV_PREFIX)).toBe(true);
      expect(isStrippedChildProcessEnvKey(name)).toBe(true);
    }
    // …and the config redirects are NOT stripped, because they are not secrets
    // and a child that inherits one is unaffected.
    for (const name of ALLOWED_CONFIG_ENV_VARS) {
      expect(isStrippedChildProcessEnvKey(name)).toBe(false);
    }
  });

  /**
   * The launch line, measured — and held to the declaration in both directions
   * (Issue #1996).
   *
   * #1942's leak is that a CommandMate server started from inside a pane
   * CommandMate launched inherits that pane's correlation variables, and every
   * child THAT process spawns (`claude -p`, the slash-command probes,
   * `copilot --version`) inherits them in turn — so a relay firing from one of
   * those children posts to a server that is not the one running, or under an
   * instance that is not its own. The fix was a prefix strip on `CM_HOOK_`, and
   * reading the plans back showed that caught two of the six.
   *
   * #1996 stripped all six, and this assertion is what replaced the prefix as
   * the drift guard. Being an EXACT set comparison it fires in both directions:
   * a source that starts writing a new launch-line variable — in any namespace,
   * `CM_HOOK_` or not — goes red here by name, and so does one that stops
   * writing a declared one. The prefix never covered either case for a name
   * outside its own namespace; this does.
   *
   * The set is the union across all seven sources, not per-tool: no single tool
   * writes all six (copilot has no `CM_AGENT_TOOL`, antigravity no
   * `CM_AGENT_*` at all), and what a child inherits is the union of whatever
   * pane it was started under.
   */
  it('writes exactly the launch-line variables that are declared', () => {
    const onLaunchLine = new Set<string>();
    for (const id of CLI_TOOL_IDS) {
      for (const name of Object.keys(planFor(id).env)) onLaunchLine.add(name);
    }

    const declared = [...ALLOWED_CORRELATION_NAMES, ...ALLOWED_CONFIG_ENV_VARS].sort();
    expect([...onLaunchLine].sort()).toEqual(declared);

    // Non-vacuity: hook injection can be switched off (`CM_AGENT_HOOKS_INJECT=0`),
    // and every plan then renders a bare command with an empty `env`. An empty
    // measurement would make the comparison above pass against an empty
    // declaration, so the count is pinned too.
    expect(onLaunchLine.size).toBe(7);
  });

  /**
   * And every one of the correlation half is gone from a child's environment.
   *
   * Stated here as well as in
   * `tests/unit/security/child-process-agent-env-1996.test.ts` because the two
   * files answer different questions: that one proves a real child cannot read
   * them, this one proves the names it proves it for are the names the launch
   * line actually writes.
   */
  it('has the sanitizer strip the correlation half and keep the config half', () => {
    const correlation = [...ALLOWED_CORRELATION_NAMES].sort();

    expect(correlation.filter(isStrippedChildProcessEnvKey)).toEqual(correlation);
    expect([...ALLOWED_CONFIG_ENV_VARS].filter(isStrippedChildProcessEnvKey)).toEqual([]);
    // None of them is a credential, which is what S18 asks about.
    for (const name of correlation) {
      expect(SENSITIVE_ENV_KEYS).not.toContain(name);
    }
  });
});
