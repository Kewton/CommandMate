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
 * Building the plans also turned up something #1942's docblock does not say:
 * the launch line carries SIX correlation variables, and only two of them start
 * with `CM_HOOK_`. See `ALLOWED_CORRELATION_PREFIXES` and the last test.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import {
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
 * Config-file variables a source is allowed to set, beyond the correlation
 * namespaces.
 *
 * Each is a per-tool HOME/config redirect the tool needs in order to read the
 * settings file CommandMate wrote for it. Enumerated, so a source that starts
 * exporting something new has to be looked at rather than waved through.
 */
const ALLOWED_CONFIG_ENV_VARS = ['CODEX_HOME', 'XDG_CONFIG_HOME', 'COPILOT_HOME'];

/**
 * The namespaces a correlation variable may live in, as MEASURED on this
 * branch — not as `COMMANDMATE_HOOK_ENV_VARS` describes them.
 *
 * That list names two variables (`CM_HOOK_URL`, `CM_HOOK_PORT`) and its
 * docblock calls itself "every `CM_HOOK_*` variable CommandMate sets on a
 * launch line", which is true and also not the whole launch line. Building the
 * seven plans and reading their `env` back turns up four more names, none of
 * which start with `CM_HOOK_`:
 *
 *   CM_AGENT_TOOL / CM_AGENT_WORKTREE_ID / CM_AGENT_INSTANCE_ID  (codex, copilot)
 *   CM_PERMISSION_HOOK_URL                                        (codex, antigravity)
 *
 * They are correlation keys, not credentials, so S18 — "no secret reaches
 * `AgentLaunchPlan.env`" — is met. What they are not is stripped from
 * CommandMate's own child processes, which the last test in this file states
 * outright rather than leaving for somebody to discover.
 */
const ALLOWED_CORRELATION_PREFIXES = [COMMANDMATE_HOOK_ENV_PREFIX, 'CM_AGENT_'];

/** Correlation variables outside those prefixes, enumerated so they cannot grow silently. */
const ALLOWED_CORRELATION_NAMES = ['CM_PERMISSION_HOOK_URL'];

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
          ALLOWED_CORRELATION_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
          ALLOWED_CORRELATION_NAMES.includes(name) ||
          ALLOWED_CONFIG_ENV_VARS.includes(name);
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
   * The measured launch line, name by name, and which half of it
   * `sanitizeEnvForChildProcess()` reaches.
   *
   * #1942's leak is that a CommandMate server started from inside a pane
   * CommandMate launched inherits that pane's correlation variables, and every
   * child THAT process spawns (`claude -p`, the slash-command probes,
   * `copilot --version`) inherits them in turn — so a relay firing from one of
   * those children posts to a server that is not the one running. The fix was a
   * prefix strip on `CM_HOOK_`. Reading the plans back shows that catches two of
   * the six correlation variables actually on the launch line.
   *
   * The remaining four are recorded here rather than fixed: closing the gap
   * means editing `lib/security/env-sanitizer.ts`, which is outside Issue
   * #1933's scope. This assertion is what makes the next person's edit to
   * either module land in front of the fact.
   */
  it('records which launch-line correlation variables a child process still inherits', () => {
    const onLaunchLine = new Set<string>();
    for (const id of CLI_TOOL_IDS) {
      for (const name of Object.keys(planFor(id).env)) onLaunchLine.add(name);
    }

    const correlation = [...onLaunchLine]
      .filter((name) => !ALLOWED_CONFIG_ENV_VARS.includes(name))
      .sort();

    expect(correlation).toEqual([
      'CM_AGENT_INSTANCE_ID',
      'CM_AGENT_TOOL',
      'CM_AGENT_WORKTREE_ID',
      'CM_HOOK_PORT',
      'CM_HOOK_URL',
      'CM_PERMISSION_HOOK_URL',
    ]);

    const stripped = correlation.filter(isStrippedChildProcessEnvKey);
    const inherited = correlation.filter((name) => !isStrippedChildProcessEnvKey(name));

    expect(stripped).toEqual(['CM_HOOK_PORT', 'CM_HOOK_URL']);
    expect(inherited).toEqual([
      'CM_AGENT_INSTANCE_ID',
      'CM_AGENT_TOOL',
      'CM_AGENT_WORKTREE_ID',
      'CM_PERMISSION_HOOK_URL',
    ]);
    // None of them is a credential, which is what S18 asks about.
    for (const name of inherited) {
      expect(SENSITIVE_ENV_KEYS).not.toContain(name);
    }
  });
});
