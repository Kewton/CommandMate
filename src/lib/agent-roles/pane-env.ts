/**
 * Reading the environment a pane will have (§7.1). Apart from `./composition`
 * because this is the one part of composing a role that runs tmux: a Schedule and
 * the contract check never need it, and importing it would give every route they
 * are reached from a path to tmux.
 *
 * Read-only. It names a session only to read one variable of its environment.
 *
 * @module lib/agent-roles/pane-env
 */
import { execFile } from 'child_process';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { isUnderTest } from '@/lib/test-run-detection';
import { fixedEnvReader, loadRoleComposition, type RoleEnv, type RoleEnvReader } from './composition';
import type { RoleComposition } from './adapters';
import type { AgentRoleCliTool } from '@/types/agent-roles';

/**
 * An env reader for a pane: the session's own value, then the tmux server's, and
 * with no server the environment the server about to start would be given.
 */
export function tmuxPaneEnvReader(sessionName: string, fallback: RoleEnv = process.env): RoleEnvReader {
  const show = (args: string[]): Promise<{ kind: 'set'; value: string } | { kind: 'absent' } | { kind: 'no-server' }> =>
    new Promise((resolve) => {
      execFile('tmux', ['show-environment', ...args], { timeout: 5000 }, (error, stdout, stderr) => {
        if (!error) {
          // `-NAME` says it was removed from the environment.
          const line = stdout.replace(/\n$/, '');
          const equals = line.indexOf('=');
          resolve(line.startsWith('-') || equals === -1 ? { kind: 'absent' } : { kind: 'set', value: line.slice(equals + 1) });
          return;
        }
        const text = String(stderr);
        resolve(/no server running|error connecting/i.test(text) ? { kind: 'no-server' } : { kind: 'absent' });
      });
    });
  return async (name) => {
    const own = await show(['-t', `=${sessionName}`, name]);
    if (own.kind === 'set') return own.value;
    const global = await show(['-g', name]);
    if (global.kind === 'set') return global.value;
    return global.kind === 'no-server' ? fallback[name] : undefined;
  };
}

/**
 * The reader for one instance's pane. In a test run, this process's environment: no
 * test reaches a real tmux server from here.
 */
export function roleEnvReaderForPane(target: {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId?: string;
}): RoleEnvReader {
  if (isUnderTest()) return fixedEnvReader(process.env);
  return tmuxPaneEnvReader(resolveSessionName(target.cliToolId, target.worktreeId, target.instanceId));
}

/** The user's settings for a tool, as a pane of this worktree would see them. */
export function loadPaneComposition(
  worktreeId: string,
  cliToolId: CLIToolType,
  worktreePath: string
): Promise<RoleComposition> {
  return loadRoleComposition(cliToolId as AgentRoleCliTool, {
    worktreePath,
    readEnv: roleEnvReaderForPane({ worktreeId, cliToolId }),
  });
}
