/**
 * `CM_PORT` reaches a child process, and that is the point (Issue #2403).
 *
 * ## What #2403 changed, and the decision this file records
 *
 * The launch line CommandMate types into an agent's pane now states the
 * launching server's own port, because the pane's shell inherits a `CM_PORT`
 * from the tmux server's global environment and `src/cli/utils/server-url.ts`
 * ranks `process.env` above `~/.commandmate/.env` (#1743). With two servers
 * sharing one tmux server the inherited value is whichever server started the
 * tmux server, so an agent's `commandmate ls` answered for the wrong server
 * while its hooks posted to the right one.
 *
 * A new name on the launch line has to be sorted into one of two lists:
 *
 *  - `AGENT_CORRELATION_ENV_VARS` — "which agent is this?" — every member of
 *    which #1996 strips from CommandMate's own child processes, so that a relay
 *    firing from a grandchild cannot claim an agent's identity.
 *  - `AGENT_LAUNCH_CONFIG_ENV_VARS` — config the agent and its descendants are
 *    meant to keep, which is deliberately not stripped.
 *
 * `CM_PORT` went on the second list. A child is not an agent, so it has no
 * identity to claim; but a `commandmate` invoked by a shell the agent spawned
 * must reach the server that launched the agent, which is the same answer the
 * agent itself needs. Stripping it would recreate the reported bug one level
 * down — the grandchild would fall back to the tmux-inherited value — and would
 * additionally delete an operator-facing variable from every child of the
 * server.
 *
 * ## Why the file exists at all
 *
 * The acceptance condition asks for the placement to be *measured*, not argued:
 * whether `sanitizeEnvForChildProcess()`'s call sites break if `CM_PORT` is
 * present. The two measurements are here.
 *
 *  1. A real child, started with the sanitized environment, reads `CM_PORT`
 *    back — the positive statement every call site inherits, since all six pass
 *    the same `env`. An object that merely still has the key and a process that
 *    can actually read it are not the same claim, which is the reason #1942 and
 *    #1996 start real processes too.
 *  2. None of the six call sites reads the variable, scanned from their source
 *    rather than asserted from memory. So "present" and "absent" are the same
 *    input to all of them, and the placement cannot change their behaviour in
 *    either direction.
 *
 * @vitest-environment node
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import {
  AGENT_LAUNCH_CONFIG_ENV_VARS,
  SERVER_PORT_ENV_VAR,
} from '@/lib/hooks/sources/launch-command';
import {
  AGENT_CORRELATION_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  isStrippedChildProcessEnvKey,
  sanitizeEnvForChildProcess,
} from '@/lib/security/env-sanitizer';
import { REAL_SHELL_SUBPROCESS_TIMEOUT_MS } from '@tests/helpers/real-shell-budget';

/** The port from the report: a global CommandMate on 60301, poisoned by 3000. */
const CONFIGURED_PORT = '60301';

/**
 * Every module that hands a child `sanitizeEnvForChildProcess()`, as measured
 * by `grep -rn sanitizeEnvForChildProcess src/`.
 *
 * Repo-relative so a failure names the file a reader has to open. `security/`'s
 * own module and its barrel re-export are not call sites and are not here.
 */
const SANITIZED_CHILD_CALL_SITES: readonly string[] = [
  'src/lib/assistant/non-interactive-runner.ts',
  'src/lib/updates/agent-updater.ts',
  'src/lib/cli-tools/copilot-executable.ts',
  'src/lib/slash-command-catalog.ts',
  'src/lib/detection/version-probes.ts',
  'src/lib/session/claude-executor.ts',
];

/** What a call site would have to name in order to care about the port. */
const PORT_READERS = /\bCM_PORT\b|\bMCBD_PORT\b|\bgetServerPort\b/;

function readSource(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

/**
 * A node one-liner reporting the child's own view of `names`, so a variable
 * that survived as an empty string is distinguishable from one that was kept.
 */
function valuesVisibleToChild(
  names: readonly string[],
  env: NodeJS.ProcessEnv
): Record<string, string | null> {
  const script =
    `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify([...names])}` +
    `.map((n) => [n, process.env[n] ?? null]))))`;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: REAL_SHELL_SUBPROCESS_TIMEOUT_MS,
    env,
  });
  return JSON.parse(stdout) as Record<string, string | null>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CM_PORT is config, not identity (Issue #2403)', () => {
  it('is declared beside the config redirect, not beside the correlation keys', () => {
    expect(AGENT_LAUNCH_CONFIG_ENV_VARS).toContain(SERVER_PORT_ENV_VAR);
    expect(AGENT_CORRELATION_ENV_KEYS as readonly string[]).not.toContain(SERVER_PORT_ENV_VAR);
    // …and it is not a credential either, which is the other list that would
    // have taken it out of a child's environment.
    expect(SENSITIVE_ENV_KEYS as readonly string[]).not.toContain(SERVER_PORT_ENV_VAR);
    expect(isStrippedChildProcessEnvKey(SERVER_PORT_ENV_VAR)).toBe(false);
  });

  it('survives sanitizing, while the identity beside it does not', () => {
    vi.stubEnv(SERVER_PORT_ENV_VAR, CONFIGURED_PORT);
    vi.stubEnv('CM_AGENT_WORKTREE_ID', 'wt-2403');

    const env = sanitizeEnvForChildProcess();

    expect(env[SERVER_PORT_ENV_VAR]).toBe(CONFIGURED_PORT);
    // The contrast is the non-vacuity: a sanitizer that stripped nothing would
    // pass the line above just as happily.
    expect(env.CM_AGENT_WORKTREE_ID).toBeUndefined();
  });

  it('is readable by a real child started with that environment', () => {
    vi.stubEnv(SERVER_PORT_ENV_VAR, CONFIGURED_PORT);
    vi.stubEnv('CM_AGENT_WORKTREE_ID', 'wt-2403');

    const seen = valuesVisibleToChild(
      [SERVER_PORT_ENV_VAR, 'CM_AGENT_WORKTREE_ID'],
      sanitizeEnvForChildProcess()
    );

    expect(seen[SERVER_PORT_ENV_VAR]).toBe(CONFIGURED_PORT);
    expect(seen.CM_AGENT_WORKTREE_ID).toBeNull();
  });
});

describe('the sanitized-child call sites are indifferent to it (Issue #2403)', () => {
  it('still names every module that spawns with a sanitized environment', () => {
    // Non-vacuity for the scan below: a call site added since the measurement
    // would otherwise be scanned by nobody. The list is checked against the
    // file contents rather than a count so a rename fails by name.
    for (const relativePath of SANITIZED_CHILD_CALL_SITES) {
      expect(readSource(relativePath), `${relativePath} no longer sanitizes`).toContain(
        'sanitizeEnvForChildProcess'
      );
    }
    expect(SANITIZED_CHILD_CALL_SITES).toHaveLength(6);
  });

  it.each(SANITIZED_CHILD_CALL_SITES)('%s reads no port from the environment', (relativePath) => {
    // The measurement the acceptance condition asks for. Each of these starts an
    // agent CLI or a `--version`/catalog probe; none of them resolves a
    // CommandMate server, so `CM_PORT` being present or absent is the same input.
    expect(readSource(relativePath)).not.toMatch(PORT_READERS);
  });

  it('would notice if one of them started reading it', () => {
    // Positive control for the regex, so an expression that matches nothing
    // cannot report six clean files.
    expect('const port = getServerPort();').toMatch(PORT_READERS);
    expect('process.env.CM_PORT').toMatch(PORT_READERS);
    expect("process.env.CM_PORTAL_URL").not.toMatch(PORT_READERS);
  });
});
