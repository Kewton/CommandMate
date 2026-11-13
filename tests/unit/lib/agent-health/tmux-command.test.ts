/**
 * Issue #2878: every tmux argv agent-health builds is pinned to
 * `-L cm-agent-health`, and the child environment carries no `TMUX`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('buildChildEnv CODEX_HOME (Issue #4290)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('(1) unset -> absent in the child', () => {
    expect('CODEX_HOME' in buildChildEnv({ PATH: '/usr/bin' })).toBe(false);
  });
  it('(2) empty string -> passed through as it is today', () => {
    expect(buildChildEnv({ CODEX_HOME: '' }).CODEX_HOME).toBe('');
  });
  it('(3) ordinary absolute path (tmpdir) -> passed through', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codex-home-'));
    dirs.push(dir);
    expect(buildChildEnv({ CODEX_HOME: dir }).CODEX_HOME).toBe(dir);
  });
  it('(4a) /proc, /sys, /dev paths -> dropped from the child', () => {
    for (const v of ['/proc/self/codex', '/sys/codex', '/dev/shm/codex']) {
      expect('CODEX_HOME' in buildChildEnv({ CODEX_HOME: v })).toBe(false);
    }
  });
  it('(4b) symlink into /dev -> dropped from the child', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codex-home-'));
    dirs.push(dir);
    const link = path.join(dir, 'link');
    fs.symlinkSync('/dev', link);
    expect('CODEX_HOME' in buildChildEnv({ CODEX_HOME: link })).toBe(false);
  });
  it('(5) relative path -> passed through unchanged (left open in #4290)', () => {
    expect(buildChildEnv({ CODEX_HOME: 'rel/codex' }).CODEX_HOME).toBe('rel/codex');
  });
  it('(6) overrides win, even for a refused inherited value', () => {
    expect(buildChildEnv({ CODEX_HOME: '/proc/x' }, { CODEX_HOME: '/opt/c' }).CODEX_HOME).toBe('/opt/c');
    expect(buildChildEnv({ CODEX_HOME: '/opt/a' }, { CODEX_HOME: '/opt/c' }).CODEX_HOME).toBe('/opt/c');
  });
  it('does not touch CLAUDE_CONFIG_DIR or the parent env', () => {
    const base = { CODEX_HOME: '/proc/x', CLAUDE_CONFIG_DIR: '/proc/y' };
    expect(buildChildEnv(base).CLAUDE_CONFIG_DIR).toBe('/proc/y');
    expect(base.CODEX_HOME).toBe('/proc/x');
  });
});
