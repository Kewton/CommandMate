/**
 * The only way agent-health builds a tmux command line (Issue #2878).
 *
 * The script runs inside the user's own tmux (often inside a CommandMate
 * session), so `$TMUX` points at the production server and a bare `tmux …`
 * lands there. Every argv therefore starts with `-L cm-agent-health`, which
 * tmux honours ahead of `$TMUX`, and the child environment drops `TMUX` as
 * well. Tearing the server down has its own builder so there is no code path
 * that spells the teardown without the socket label.
 */

/** The private tmux socket label. Nothing else in CommandMate uses it. */
export const AGENT_HEALTH_TMUX_SOCKET = 'cm-agent-health';

/**
 * Subcommands that change server-global state or end the server. They are
 * refused by {@link buildTmuxArgv}; teardown goes through
 * {@link buildTmuxTeardownArgv}.
 */
export const REFUSED_TMUX_SUBCOMMANDS: readonly string[] = [
  'kill-server',
  'bind-key',
  'unbind-key',
  'source-file',
];

/** Environment variables removed from every child process the run starts. */
export const STRIPPED_CHILD_ENV_VARS: readonly string[] = ['TMUX', 'TMUX_PANE'];

/**
 * Prefixes of variables inherited from the agent the script may itself be
 * running under (a CommandMate-launched claude / codex). Left in place they
 * would point the probe's hooks at production (`CM_PORT`, `CM_HOOK_URL`) or
 * make the probe CLI believe it is nested.
 */
export const STRIPPED_CHILD_ENV_PREFIXES: readonly string[] = ['CM_', 'CLAUDE', 'CODEX_'];

/** Kept even though they match a stripped prefix: they locate the user's own config. */
export const KEPT_CHILD_ENV_VARS: readonly string[] = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

export function buildTmuxArgv(args: readonly string[]): string[] {
  if (args.length === 0) {
    throw new Error('agent-health: refusing to run tmux with an empty command');
  }
  if (REFUSED_TMUX_SUBCOMMANDS.includes(args[0])) {
    throw new Error(
      `agent-health: tmux "${args[0]}" is refused here (server teardown goes through buildTmuxTeardownArgv)`
    );
  }
  if (args.includes('-g')) {
    throw new Error('agent-health: tmux global options (-g) are refused; use the config file');
  }
  return ['-L', AGENT_HEALTH_TMUX_SOCKET, ...args];
}

/** Teardown of the private server — the socket label is part of the constant argv. */
export function buildTmuxTeardownArgv(): string[] {
  return ['-L', AGENT_HEALTH_TMUX_SOCKET, 'kill-server'];
}

/**
 * The first `new-session` also starts the server, so it is the one call that
 * passes the config file (`-f`). Kept separate so the config is never applied
 * to anything but the private server.
 */
export function buildTmuxStartArgv(configPath: string, args: readonly string[]): string[] {
  const [label, socket, ...rest] = buildTmuxArgv(args);
  return [label, socket, '-f', configPath, ...rest];
}

/**
 * The environment for every child process: `TMUX` gone, inherited CommandMate
 * and agent variables gone, then `overrides` applied.
 */
export function buildChildEnv(
  base: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_CHILD_ENV_VARS.includes(key)) continue;
    const prefixed = STRIPPED_CHILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
    if (prefixed && !KEPT_CHILD_ENV_VARS.includes(key)) continue;
    env[key] = value;
  }
  // ProcessEnv (as augmented by Next) declares NODE_ENV required; a child
  // environment is whatever the parent had, which may not include it.
  return { ...env, ...overrides } as NodeJS.ProcessEnv;
}

/** `=name:` — an exact session match, so `probe` never resolves to `probe-2`. */
export function exactSessionTarget(sessionName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionName)) {
    throw new Error(`agent-health: invalid tmux session name ${JSON.stringify(sessionName)}`);
  }
  return `=${sessionName}:`;
}
