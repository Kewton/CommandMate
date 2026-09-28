/**
 * Issue #2878: every tmux argv agent-health builds is pinned to
 * `-L cm-agent-health`, and the child environment carries no `TMUX`.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_HEALTH_TMUX_SOCKET,
  buildChildEnv,
  buildTmuxArgv,
  buildTmuxStartArgv,
  buildTmuxTeardownArgv,
  exactSessionTarget,
  REFUSED_TMUX_SUBCOMMANDS,
} from '@/lib/agent-health/tmux-command';

const PINNED = ['-L', 'cm-agent-health'];

describe('buildTmuxArgv', () => {
  it('uses the dedicated socket label', () => {
    expect(AGENT_HEALTH_TMUX_SOCKET).toBe('cm-agent-health');
  });

  it.each([
    [['new-session', '-d', '-s', 'agent-health-claude', 'claude']],
    [['capture-pane', '-t', '=agent-health-claude:', '-p', '-e', '-S', '-1000', '-E', '-']],
    [['send-keys', '-t', '=agent-health-claude:', '-l', '--', 'hello']],
    [['send-keys', '-t', '=agent-health-claude:', 'Enter']],
    [['load-buffer', '-b', 'agent-health-claude', '-']],
    [['paste-buffer', '-p', '-d', '-b', 'agent-health-claude', '-t', '=agent-health-claude:']],
    [['kill-session', '-t', '=agent-health-claude:']],
    [['display-message', '-p', '#{socket_path}']],
    [['list-sessions']],
  ])('prefixes %j with -L cm-agent-health', (args) => {
    const argv = buildTmuxArgv(args);
    expect(argv.slice(0, 2)).toEqual(PINNED);
    expect(argv.slice(2)).toEqual(args);
  });

  it('refuses server-global subcommands and the unpinned teardown', () => {
    for (const subcommand of REFUSED_TMUX_SUBCOMMANDS) {
      expect(() => buildTmuxArgv([subcommand])).toThrow(/refused/);
    }
  });

  it('refuses global options (-g)', () => {
    expect(() => buildTmuxArgv(['show-options', '-g'])).toThrow(/-g/);
  });

  it('refuses an empty command', () => {
    expect(() => buildTmuxArgv([])).toThrow();
  });

  it('the teardown argv carries the label', () => {
    expect(buildTmuxTeardownArgv()).toEqual(['-L', 'cm-agent-health', 'kill-server']);
  });

  it('the server-starting argv carries the label and the config file', () => {
    expect(buildTmuxStartArgv('/tmp/x/tmux.conf', ['new-session', '-d', '-s', 'agent-health-codex'])).toEqual([
      '-L',
      'cm-agent-health',
      '-f',
      '/tmp/x/tmux.conf',
      'new-session',
      '-d',
      '-s',
      'agent-health-codex',
    ]);
  });

  it('exactSessionTarget matches one session exactly and rejects odd names', () => {
    expect(exactSessionTarget('agent-health-command-code')).toBe('=agent-health-command-code:');
    expect(() => exactSessionTarget('a:b')).toThrow();
    expect(() => exactSessionTarget('a.b')).toThrow();
  });
});

describe('buildChildEnv', () => {
  it('drops TMUX, inherited CommandMate and agent variables, keeps the rest', () => {
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/me',
        TMUX: '/private/tmp/tmux-501/default,1,2',
        TMUX_PANE: '%1',
        CM_PORT: '3000',
        CM_HOOK_URL: 'http://127.0.0.1:3000/api/hooks/agent-event',
        CM_AGENT_INSTANCE_ID: 'claude',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CODEX_THREAD_ID: 't',
        CODEX_HOME: '/Users/me/.codex',
        CLAUDE_CONFIG_DIR: '/Users/me/.claude',
        UNDEFINED: undefined,
      },
      { CM_PORT: '51234' }
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      CODEX_HOME: '/Users/me/.codex',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude',
      CM_PORT: '51234',
    });
  });
});
