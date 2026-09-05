/**
 * Issue #2317 — the session-scoped hooks and the geometry hand-back.
 *
 * Two things are asserted here that no amount of reading can establish:
 *
 *  - the opt-in hooks CONVERGE. Turning an option off removes the hook a
 *    previous run installed, rather than merely not installing it again; tmux
 *    state outlives the process that wrote it, and #1623's key binding learned
 *    that the hard way.
 *  - the hand-back is gated on a LIVE CLIENT, not on the flag. A `@cm_delegated`
 *    left behind by a CLI that was killed must never pin a window open forever.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import {
  ensureSessionHooks,
  forgetSessionHooks,
  reconcileDelegatedGeometry,
} from '@/lib/tmux/session-hooks';
import { resetGeometryDelegationState } from '@/lib/tmux/geometry-delegation';
import {
  AUTO_POPUP_ENV,
  AUTO_POPUP_HOOK,
  DELEGATE_HOOK,
  LIVE_ATTACH_HOOK_ENV,
} from '@/lib/session/tmux-session-surface';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

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

/** Every hook name in an argv list, so the assertions read as intent. */
function hookNames(calls: string[][]): string[] {
  return calls.filter((argv) => argv[0] === 'set-hook').map((argv) => argv[argv.indexOf('-u') >= 0 ? 4 : 3]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetGeometryDelegationState();
  delete process.env[LIVE_ATTACH_HOOK_ENV];
  delete process.env[AUTO_POPUP_ENV];
});

afterEach(() => {
  delete process.env[LIVE_ATTACH_HOOK_ENV];
  delete process.env[AUTO_POPUP_ENV];
});

describe('ensureSessionHooks', () => {
  it('installs NEITHER hook by default — both are opt-in', async () => {
    const sessionName = 'mcbd-claude-default';
    const calls = mockTmux();

    await ensureSessionHooks(sessionName);

    // Removal, not installation: the reconcile converges either way.
    const installs = calls.filter((argv) => argv[0] === 'set-hook' && !argv.includes('-u'));
    expect(installs).toEqual([]);
    expect(hookNames(calls)).toEqual([DELEGATE_HOOK, AUTO_POPUP_HOOK]);

    forgetSessionHooks(sessionName);
  });

  it('installs the delegate hook only when asked, and only on a live-eligible session', async () => {
    process.env[LIVE_ATTACH_HOOK_ENV] = 'on';

    const claudeCalls = mockTmux();
    await ensureSessionHooks('mcbd-claude-optin');
    const claudeInstall = claudeCalls.find(
      (argv) => argv[0] === 'set-hook' && argv[3] === DELEGATE_HOOK,
    );
    expect(claudeInstall).toBeDefined();
    expect(claudeInstall![4]).toContain('run-shell -b ');
    expect(claudeInstall![4]).toContain('#{client_control_mode}');

    // codex cannot be delegated, so the same option installs nothing for it.
    const codexCalls = mockTmux();
    await ensureSessionHooks('mcbd-codex-optin');
    expect(
      codexCalls.some((argv) => argv[0] === 'set-hook' && !argv.includes('-u')),
    ).toBe(false);

    forgetSessionHooks('mcbd-claude-optin');
    forgetSessionHooks('mcbd-codex-optin');
  });

  it('installs the auto popup only when asked', async () => {
    process.env[AUTO_POPUP_ENV] = 'on';
    const sessionName = 'mcbd-claude-popup';
    const calls = mockTmux();

    await ensureSessionHooks(sessionName);

    const install = calls.find((argv) => argv[0] === 'set-hook' && argv[3] === AUTO_POPUP_HOOK);
    expect(install).toBeDefined();
    expect(install![4]).toContain('cm-auto-popup.sh');
    // #{client_name} is what lets `display-popup -c` open on the RIGHT client.
    // (The `--follow` flag is inside the script, not in the hook body — see
    // `tests/unit/tmux/hook-scripts-2317.test.ts`.)
    expect(install![4]).toContain('#{client_name}');

    forgetSessionHooks(sessionName);
  });

  it('runs once per session, not once per poll', async () => {
    const sessionName = 'mcbd-claude-once';
    mockTmux();
    await ensureSessionHooks(sessionName);

    const second = mockTmux();
    await ensureSessionHooks(sessionName);
    expect(second).toEqual([]);

    forgetSessionHooks(sessionName);
  });

  it('ignores a session CommandMate did not create', async () => {
    const calls = mockTmux();
    await ensureSessionHooks('someone-elses-session');
    expect(calls).toEqual([]);
  });

  it('never emits -g', async () => {
    process.env[LIVE_ATTACH_HOOK_ENV] = 'on';
    process.env[AUTO_POPUP_ENV] = 'on';
    const sessionName = 'mcbd-claude-scoped';
    const calls = mockTmux();

    await ensureSessionHooks(sessionName);

    for (const argv of calls) {
      expect(argv, argv.join(' ')).not.toContain('-g');
    }

    forgetSessionHooks(sessionName);
  });
});

describe('reconcileDelegatedGeometry', () => {
  it('does nothing when the session was never delegated', async () => {
    const calls = mockTmux(() => '');
    expect(await reconcileDelegatedGeometry('mcbd-claude-plain')).toBe(false);
    expect(calls.some((argv) => argv[0] === 'resize-window')).toBe(false);
  });

  it('does nothing while a human client is still attached', async () => {
    const calls = mockTmux((argv) => {
      if (argv[0] === 'show-options') return '1\n';
      if (argv[0] === 'list-clients') return '0\n';
      return '';
    });

    expect(await reconcileDelegatedGeometry('mcbd-claude-watching')).toBe(false);
    expect(calls.some((argv) => argv[0] === 'resize-window')).toBe(false);
  });

  it('hands the canvas back once only control-mode clients remain', async () => {
    // Issue #2317 受入条件 Phase D 4: CommandMate's own transport attaches as a
    // `tmux -C` client and never leaves, so `#{session_attached}` would say
    // "somebody is here" forever.
    const calls = mockTmux((argv) => {
      if (argv[0] === 'show-options') return '1\n';
      if (argv[0] === 'list-clients') return '1\n1\n';
      return '';
    });

    expect(await reconcileDelegatedGeometry('mcbd-claude-control')).toBe(true);
    expect(calls).toContainEqual([
      'set-window-option',
      '-t',
      '=mcbd-claude-control:',
      'window-size',
      'manual',
    ]);
    expect(calls).toContainEqual([
      'resize-window',
      '-t',
      '=mcbd-claude-control:',
      '-x',
      '200',
      '-y',
      '1000',
    ]);
    expect(calls).toContainEqual([
      'set-option',
      '-u',
      '-t',
      '=mcbd-claude-control:',
      '@cm_delegated',
    ]);
  });

  it('repairs a flag left behind by a CLI that was killed', async () => {
    // Nobody attached at all: the flag alone must never keep a window unpinned.
    mockTmux((argv) => (argv[0] === 'show-options' ? '1\n' : ''));
    expect(await reconcileDelegatedGeometry('mcbd-claude-orphaned')).toBe(true);
  });

  it('never throws when tmux itself fails', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        err: Error | null,
        result?: { stdout: string; stderr: string },
      ) => void;
      callback(new Error('no server running'), { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    });

    await expect(reconcileDelegatedGeometry('mcbd-claude-broken')).resolves.toBe(false);
  });
});
