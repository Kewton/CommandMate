/**
 * Issue #2317 Phase B — publishing a session's state onto its tmux session.
 *
 * The behaviours worth pinning are not "does it call tmux" but the three that
 * make the feature affordable and polite:
 *
 *  1. it writes on a TRANSITION and not on every poll (the status poll runs
 *     every couple of seconds, for every tool of every worktree);
 *  2. it never touches server-global state, and never overwrites a `status-right`
 *     the user set on that session themselves;
 *  3. `CM_TMUX_STATUS=off` UNINSTALLS rather than merely stopping — the same
 *     converging opt-out #1623 gave its key binding, because tmux state outlives
 *     the process that wrote it.
 *
 * Every test uses its own session name: the module's memos are globalThis-backed
 * (so a `npm run dev` reload cannot make it re-issue five writes per session),
 * which means they survive `vi.resetModules()` by design.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import {
  clearSessionStatus,
  ensureSessionStatusLine,
  forgetSessionStatus,
  publishSessionStatus,
} from '@/lib/tmux/session-status-options';
import {
  CM_SESSION_OPTIONS,
  CM_STATUS_RIGHT_FORMAT,
} from '@/lib/session/tmux-session-surface';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

/**
 * Install a fake tmux and record every argv.
 *
 * @param stdoutFor - What each call prints; default is empty, i.e. "the option
 *   was never set on this session", which is what a fresh session answers.
 */
function mockTmux(stdoutFor: (argv: string[]) => string = () => ''): string[][] {
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const argv = args[1] as string[];
    calls.push(argv);
    const callback = args[args.length - 1] as (
      err: Error | null,
      result?: { stdout: string; stderr: string },
    ) => void;
    callback(null, { stdout: stdoutFor(argv), stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
  return calls;
}

const BASE = {
  worktreeId: 'wt-1',
  cliToolId: 'claude',
  instanceId: 'claude',
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CM_TMUX_STATUS;
});

afterEach(() => {
  delete process.env.CM_TMUX_STATUS;
});

describe('publishSessionStatus', () => {
  it('writes the five options and installs the status line on the first poll', async () => {
    const sessionName = 'mcbd-claude-first';
    const calls = mockTmux();

    const outcome = await publishSessionStatus({ ...BASE, sessionName, status: 'running' });

    expect(outcome).toBe('written');
    const written = calls.filter((argv) => argv[0] === 'set-option' && argv[3].startsWith('@cm_'));
    expect(written.map((argv) => argv[3])).toEqual([
      '@cm_status',
      '@cm_worktree',
      '@cm_tool',
      '@cm_instance',
      '@cm_updated',
    ]);
    expect(written[0]).toEqual(['set-option', '-t', '=mcbd-claude-first:', '@cm_status', 'running']);
    expect(calls).toContainEqual([
      'set-option',
      '-t',
      '=mcbd-claude-first:',
      'status-right',
      CM_STATUS_RIGHT_FORMAT,
    ]);

    forgetSessionStatus(sessionName);
  });

  it('stamps @cm_updated with an ISO timestamp', async () => {
    const sessionName = 'mcbd-claude-stamp';
    const calls = mockTmux();

    await publishSessionStatus({
      ...BASE,
      sessionName,
      status: 'waiting',
      now: new Date('2026-09-05T01:02:03.000Z'),
    });

    const updated = calls.find((argv) => argv[3] === '@cm_updated');
    expect(updated?.[4]).toBe('2026-09-05T01:02:03.000Z');

    forgetSessionStatus(sessionName);
  });

  it('touches tmux only when something CHANGED', async () => {
    const sessionName = 'mcbd-claude-dedup';
    mockTmux();
    await publishSessionStatus({ ...BASE, sessionName, status: 'running' });

    const second = mockTmux();
    const outcome = await publishSessionStatus({ ...BASE, sessionName, status: 'running' });

    expect(outcome).toBe('unchanged');
    // The whole point: the poll runs every couple of seconds and a status
    // changes a few times an hour.
    expect(second).toEqual([]);

    const third = mockTmux();
    expect(await publishSessionStatus({ ...BASE, sessionName, status: 'waiting' })).toBe('written');
    expect(third.some((argv) => argv[4] === 'waiting')).toBe(true);

    forgetSessionStatus(sessionName);
  });

  it('re-publishes after the session is forgotten', async () => {
    // A session killed and recreated under the same name must not be deduped
    // against the dead one's last status.
    const sessionName = 'mcbd-claude-recreate';
    mockTmux();
    await publishSessionStatus({ ...BASE, sessionName, status: 'ready' });
    forgetSessionStatus(sessionName);

    const calls = mockTmux();
    expect(await publishSessionStatus({ ...BASE, sessionName, status: 'ready' })).toBe('written');
    expect(calls.length).toBeGreaterThan(0);

    forgetSessionStatus(sessionName);
  });

  it('drops the memo when a write fails, so the next poll retries', async () => {
    const sessionName = 'mcbd-claude-failing';
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        err: Error | null,
        result?: { stdout: string; stderr: string },
      ) => void;
      callback(new Error("can't find session"), { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });

    expect(await publishSessionStatus({ ...BASE, sessionName, status: 'running' })).toBe('error');

    const calls = mockTmux();
    expect(await publishSessionStatus({ ...BASE, sessionName, status: 'running' })).toBe('written');
    expect(calls.length).toBeGreaterThan(0);

    forgetSessionStatus(sessionName);
  });

  it('never emits -g, and always targets the session exactly', async () => {
    const sessionName = 'mcbd-claude-scoped';
    const calls = mockTmux();
    await publishSessionStatus({ ...BASE, sessionName, status: 'idle' });

    for (const argv of calls) {
      expect(argv, argv.join(' ')).not.toContain('-g');
      expect(argv, argv.join(' ')).toContain('=mcbd-claude-scoped:');
    }

    forgetSessionStatus(sessionName);
  });
});

describe('the session status line', () => {
  it('is not installed over a status-right the user set on that session', async () => {
    const calls = mockTmux((argv) =>
      argv[0] === 'show-options' ? 'status-right "#(my-own-script)"' : '',
    );

    expect(await ensureSessionStatusLine('mcbd-claude-userowned')).toBe(false);
    expect(calls.some((argv) => argv[0] === 'set-option')).toBe(false);
  });

  it('is left alone once it is already ours', async () => {
    const calls = mockTmux((argv) =>
      argv[0] === 'show-options' ? `status-right "${CM_STATUS_RIGHT_FORMAT}"` : '',
    );

    expect(await ensureSessionStatusLine('mcbd-claude-ours')).toBe(true);
    expect(calls.some((argv) => argv[0] === 'set-option')).toBe(false);
  });
});

describe('CM_TMUX_STATUS=off', () => {
  it('removes every @cm_* option and our status line, once per session', async () => {
    process.env.CM_TMUX_STATUS = 'off';
    const sessionName = 'mcbd-claude-optout';
    const calls = mockTmux((argv) =>
      argv[0] === 'show-options' ? `status-right "${CM_STATUS_RIGHT_FORMAT}"` : '',
    );

    expect(await publishSessionStatus({ ...BASE, sessionName, status: 'running' })).toBe('disabled');

    const unset = calls.filter((argv) => argv[0] === 'set-option' && argv[1] === '-u');
    expect(unset.map((argv) => argv[4])).toEqual([...CM_SESSION_OPTIONS, 'status-right']);

    // Second poll: nothing left to remove, and a server with the feature off
    // must not pay six execFile calls every couple of seconds for it.
    const second = mockTmux();
    expect(await publishSessionStatus({ ...BASE, sessionName, status: 'waiting' })).toBe('disabled');
    expect(second).toEqual([]);

    forgetSessionStatus(sessionName);
  });

  it('leaves a status-right the user owns even while uninstalling', async () => {
    const calls = mockTmux((argv) =>
      argv[0] === 'show-options' ? 'status-right "#(my-own-script)"' : '',
    );

    await clearSessionStatus('mcbd-claude-clear-userowned');

    expect(calls.some((argv) => argv[1] === '-u' && argv[4] === 'status-right')).toBe(false);
    // The @cm_* options are still ours to remove.
    expect(calls.some((argv) => argv[1] === '-u' && argv[4] === '@cm_status')).toBe(true);
  });
});
