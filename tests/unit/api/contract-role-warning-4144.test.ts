/**
 * Issue #4144: the warning's "running" no longer counts a pane back at its shell. It reads
 * `list-panes -a`, which names no session (the route's exemption from the session-ownership
 * guard says it never addresses one), and only a pane read as a shell takes the warning away.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const tmux = vi.hoisted(() => ({
  sessions: { code: 0 as number | null, stdout: '', stderr: '', failure: null as string | null },
  panes: { code: 0 as number | null, stdout: '', stderr: '', failure: null as string | null },
  calls: [] as string[][],
}));

vi.mock('@/lib/verification/env-snapshot', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/verification/env-snapshot')>();
  return {
    ...original,
    DEFAULT_ENV_PROBE_DEPS: {
      ...original.DEFAULT_ENV_PROBE_DEPS,
      run: async (_command: string, args: string[]) => {
        tmux.calls.push(args);
        return args[0] === 'list-panes' ? tmux.panes : tmux.sessions;
      },
    },
  };
});

const role = vi.hoisted(() => ({ evidence: null as unknown, gives: true }));

vi.mock('@/lib/session/role-launch', () => ({
  getLaunchRoleEvidence: () => role.evidence,
  settingsGiveRole: async () => role.gives,
}));

vi.mock('@/lib/session/session-launch-flight', () => ({
  isSessionLaunchInFlight: () => false,
}));

import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { contractRoleWarning, UNKNOWN_ROLE_WARNING } from '@/app/api/worktrees/[id]/tasks/contract-role-warning';

const target = { worktreeId: 'wt-4144', cliToolId: 'codex', instanceId: 'codex' } as const;
const NAME = resolveSessionName(target.cliToolId, target.worktreeId, target.instanceId);
const warning = () => contractRoleWarning({} as Database.Database, target, '/nowhere');

beforeEach(() => {
  tmux.sessions = { code: 0, stdout: `${NAME}\n`, stderr: '', failure: null };
  tmux.panes = { code: 0, stdout: '', stderr: '', failure: null };
  tmux.calls = [];
  role.evidence = null;
  role.gives = true;
});

describe('[#4144] a pane back at its shell is not a running session', () => {
  it.each(['zsh', '-zsh', 'bash', 'sh', 'fish'])('its pane is at %s: no warning', async (shell) => {
    tmux.panes.stdout = `${NAME} ${shell}\n`;
    expect(await warning()).toBeNull();
  });

  it.each(['codex', 'node', '2.1.287'])('its pane runs %s: warned, as before (negative control)', async (command) => {
    tmux.panes.stdout = `${NAME} ${command}\n`;
    expect(await warning()).toBe(UNKNOWN_ROLE_WARNING);
  });

  it('another session at its shell, this one busy: warned', async () => {
    tmux.panes.stdout = `${NAME}-2 zsh\nx${NAME} zsh\n${NAME} codex\n`;
    expect(await warning()).toBe(UNKNOWN_ROLE_WARNING);
  });

  it('a second pane still busy: warned', async () => {
    tmux.panes.stdout = `${NAME} zsh\n${NAME} codex\n`;
    expect(await warning()).toBe(UNKNOWN_ROLE_WARNING);
  });

  it.each([
    ['tmux could not be run', { code: null, stdout: '', stderr: '', failure: 'gone' }],
    ['tmux refused', { code: 1, stdout: `${NAME} zsh\n`, stderr: 'x', failure: null }],
    ['the panes do not name it', { code: 0, stdout: '', stderr: '', failure: null }],
  ])('%s: the pane is not known to be at a shell, so warned as before', async (_name, panes) => {
    tmux.panes = panes;
    expect(await warning()).toBe(UNKNOWN_ROLE_WARNING);
  });

  it('addresses no session, and asks only when the name is there', async () => {
    tmux.panes.stdout = `${NAME} codex\n`;
    await warning();
    expect(tmux.calls.map(([subcommand]) => subcommand)).toEqual(['list-sessions', 'list-panes']);
    expect(tmux.calls[1]).toContain('-a');
    expect(tmux.calls[1]).not.toContain('-t');

    tmux.calls = [];
    tmux.sessions.stdout = '';
    expect(await warning()).toBeNull();
    expect(tmux.calls.map(([subcommand]) => subcommand)).toEqual(['list-sessions']);
  });

  it('settings giving no role: nothing to warn of, whatever the pane runs (negative control)', async () => {
    role.gives = false;
    tmux.panes.stdout = `${NAME} codex\n`;
    expect(await warning()).toBeNull();
  });
});
