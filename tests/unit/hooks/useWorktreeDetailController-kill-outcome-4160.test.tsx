/**
 * The ordinary End (PC and phone share `handleKillConfirm`) when the kill's answer says
 * nothing about the session (Issue #4160, after #4133 and #4145 did this for the role
 * pane and the update card).
 *
 * Positive controls: every "says nothing" test fails on the code before this Issue,
 * which showed the failure toast and kept the dialog without reading anything.
 * Negative controls: 200, 404 and a refusal behave as they did and read nothing extra.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import ja from '../../../locales/ja/common.json';
import jaWorktree from '../../../locales/ja/worktree.json';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

const toast = vi.hoisted(() => ({ show: vi.fn() }));

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-a',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true,
    width: 288,
    isMobileDrawerOpen: false,
    toggle: vi.fn(),
    setWidth: vi.fn(),
    openMobileDrawer: vi.fn(),
    closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () => ({ worktrees: [], repositories: [], isLoading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/components/common/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useToast: () => ({ showToast: toast.show }) };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const A = 'wt-a';
const B = 'wt-b';
const TARGET: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex-2', label: 'Review agent' };
const FAILED = jaWorktree.session.failedToKill;
const UNKNOWN = ja.sessionKill.outcomeUnknown.replace('{label}', TARGET.label);
const IN_PROGRESS = ja.sessionKill.inProgress.replace('{label}', TARGET.label);

type KillBehaviour = number | 'reject' | 'stall' | 'hold';

interface Server {
  kill: KillBehaviour;
  /** What the worktree GET says is running; null answers 500. */
  running: Record<string, boolean> | null;
  /** While set, worktree GETs wait in `heldReads`. */
  holdReads: boolean;
  heldReads: Array<() => void>;
  heldKills: Array<(status: number) => void>;
  kills: string[];
  reads: string[];
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function install(kill: KillBehaviour): Server {
  const server: Server = {
    kill,
    running: { 'codex-2': true },
    holdReads: false,
    heldReads: [],
    heldKills: [],
    kills: [],
    reads: [],
  };
  const worktreeAnswer = (id: string): Response => {
    if (server.running === null) return reply(500, {});
    const statuses: Record<string, { isRunning: boolean }> = {};
    for (const [instance, isRunning] of Object.entries(server.running)) statuses[instance] = { isRunning };
    return reply(200, {
      id,
      name: id,
      path: '/p',
      repositoryPath: '/r',
      repositoryName: 'R',
      sessionStatusByInstance: statuses,
    });
  };
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/kill-session')) {
      server.kills.push(url);
      if (server.kill === 'reject') return Promise.reject(new TypeError('Failed to fetch'));
      if (server.kill === 'stall') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (server.kill === 'hold') {
        return new Promise<Response>((resolve) => server.heldKills.push((status) => resolve(reply(status, {}))));
      }
      return Promise.resolve(reply(server.kill, { success: true, message: 'ok' }));
    }
    if (url.includes('/current-output')) return Promise.resolve(reply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(reply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(reply(200, { instances: {} }));
    const detail = /\/api\/worktrees\/([^/?]+)$/.exec(url);
    if (detail) {
      server.reads.push(detail[1]);
      if (server.holdReads) {
        return new Promise<Response>((resolve) => {
          server.heldReads.push(() => resolve(worktreeAnswer(detail[1])));
        });
      }
      return Promise.resolve(worktreeAnswer(detail[1]));
    }
    return Promise.resolve(reply(404, {}));
  }) as unknown as typeof fetch;
  return server;
}

async function opened(kill: KillBehaviour) {
  const server = install(kill);
  const hook = renderHook(({ worktreeId }) => useWorktreeDetailController({ worktreeId }), {
    initialProps: { worktreeId: A },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
  act(() => hook.result.current.openKillConfirm(TARGET));
  server.reads.length = 0;
  toast.show.mockClear();
  return { ...hook, server };
}

const confirm = (hook: Awaited<ReturnType<typeof opened>>) =>
  act(async () => {
    await hook.result.current.handleKillConfirm();
  });
const shown = () => toast.show.mock.calls.map((call) => call[0]);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('[#4160] an End whose answer says nothing: what is running now decides', () => {
  it.each([
    ['a 500', 500],
    ['a 503', 503],
    ['no answer', 'reject'],
  ] as const)('%s, and the session did end: no failure, and the dialog closes', async (_label, kill) => {
    const hook = await opened(kill);
    hook.server.running = {};
    await confirm(hook);
    expect(hook.server.reads.length).toBeGreaterThan(0);
    expect(shown()).toEqual([]);
    expect(hook.result.current.killTarget).toBeNull();
    expect(hook.result.current.isKillPending).toBe(false);
  });

  it('the deadline, and the session did end: no failure, and the dialog closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const hook = await opened('stall');
    hook.server.running = {};
    let done = false;
    act(() => {
      void hook.result.current.handleKillConfirm().then(() => {
        done = true;
      });
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(29000)));
    expect(hook.server.reads).toEqual([]);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    await waitFor(() => expect(done).toBe(true));
    expect(shown()).toEqual([]);
    expect(hook.result.current.killTarget).toBeNull();
  });

  it("the read's answer is about the target: another instance still running does not count", async () => {
    const hook = await opened(500);
    hook.server.running = { claude: true };
    await confirm(hook);
    expect(shown()).toEqual([]);
    expect(hook.result.current.killTarget).toBeNull();
  });

  it('the kill names the tool and the instance (without them it ends every session)', async () => {
    const hook = await opened(500);
    await confirm(hook);
    expect(hook.server.kills).toEqual([`/api/worktrees/${A}/kill-session?cliTool=codex&instance=codex-2`]);
  });

  it.each([
    ['a 500', 500],
    ['no answer', 'reject'],
  ] as const)('%s, and the read fails: it says it could not tell, and the dialog stays to retry', async (_label, kill) => {
    const hook = await opened(kill);
    hook.server.running = null;
    await confirm(hook);
    expect(shown()).toEqual([UNKNOWN]);
    expect(hook.result.current.killTarget).toEqual(TARGET);
    expect(hook.result.current.isKillPending).toBe(false);
  });

  it('a 500, the session still running: the server has finished and it did not end, so it failed', async () => {
    const hook = await opened(500);
    await confirm(hook);
    expect(hook.server.reads.length).toBeGreaterThan(0);
    expect(shown()).toEqual([FAILED]);
    expect(hook.result.current.killTarget).toEqual(TARGET);
  });

  it('no answer, the session still running: the kill may still be working, which is not a failure', async () => {
    const hook = await opened('reject');
    await confirm(hook);
    expect(shown()).toEqual([IN_PROGRESS]);
    expect(hook.result.current.killTarget).toEqual(TARGET);
  });

  it('ending late: not called a failure, and pressing again finds it gone and closes', async () => {
    const hook = await opened('reject');
    await confirm(hook);
    expect(shown()).toEqual([IN_PROGRESS]);
    toast.show.mockClear();
    hook.server.kill = 404;
    hook.server.running = {};
    await confirm(hook);
    expect(shown()).toEqual([]);
    expect(hook.result.current.killTarget).toBeNull();
  });

  it('while the read is out the dialog is still pending: a second confirm sends nothing', async () => {
    const hook = await opened(500);
    hook.server.holdReads = true;
    hook.server.running = {};
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
    });
    await waitFor(() => expect(hook.server.heldReads.length).toBeGreaterThan(0));
    expect(hook.result.current.isKillPending).toBe(true);
    await act(async () => {
      await hook.result.current.handleKillConfirm();
      hook.result.current.handleKillCancel();
    });
    expect(hook.server.kills).toHaveLength(1);
    expect(hook.result.current.killTarget).toEqual(TARGET);

    hook.server.holdReads = false;
    await act(async () => {
      hook.server.heldReads.forEach((answer) => answer());
      await first;
    });
    expect(hook.result.current.killTarget).toBeNull();
    expect(hook.result.current.isKillPending).toBe(false);
  });
});

describe('[#4160] an End that was answered (negative controls)', () => {
  it('200: closes without the extra read deciding anything, and no toast', async () => {
    const hook = await opened(200);
    hook.server.running = { 'codex-2': true };
    await confirm(hook);
    expect(shown()).toEqual([]);
    expect(hook.result.current.killTarget).toBeNull();
  });

  it('404 is already ended, which is the goal', async () => {
    const hook = await opened(404);
    await confirm(hook);
    expect(shown()).toEqual([]);
    expect(hook.result.current.killTarget).toBeNull();
  });

  it.each([400, 403, 409])('a refusal (%i) says it failed, without asking whether the session ended', async (status) => {
    const hook = await opened(status);
    hook.server.running = {};
    await confirm(hook);
    expect(hook.server.reads).toEqual([]);
    expect(shown()).toEqual([FAILED]);
    expect(hook.result.current.killTarget).toEqual(TARGET);
  });

  it('offline: nothing was sent, so it failed, and nothing is read', async () => {
    const hook = await opened(200);
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    await confirm(hook);
    onLine.mockRestore();
    expect(hook.server.kills).toEqual([]);
    expect(hook.server.reads).toEqual([]);
    expect(shown()).toEqual([FAILED]);
    expect(hook.result.current.killTarget).toEqual(TARGET);
  });
});

describe('[#4160] a worktree switch in the middle', () => {
  async function killHeldThenSwitched() {
    const hook = await opened('hold');
    let killing: Promise<void> = Promise.resolve();
    await act(async () => {
      killing = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(hook.server.heldKills).toHaveLength(1);
    hook.rerender({ worktreeId: B });
    await waitFor(() => expect(hook.result.current.worktree?.id).toBe(B));
    hook.server.reads.length = 0;
    return { hook, killing: () => killing };
  }

  it("A's kill says nothing after the switch: A is not read, B's dialog stays, and the toast names the session", async () => {
    const { hook, killing } = await killHeldThenSwitched();
    const bTarget: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'B agent' };
    act(() => hook.result.current.openKillConfirm(bTarget));
    await act(async () => {
      hook.server.heldKills[0](500);
      await killing();
    });
    expect(hook.server.reads).not.toContain(A);
    expect(hook.result.current.killTarget).toEqual(bTarget);
    expect(shown()).toEqual([UNKNOWN]);
  });

  it("a switch while A's read is out, and A ended: B's dialog and worktree are left alone, no toast", async () => {
    const hook = await opened('hold');
    let killing: Promise<void> = Promise.resolve();
    await act(async () => {
      killing = hook.result.current.handleKillConfirm();
      await new Promise((done) => setTimeout(done, 0));
    });
    hook.server.holdReads = true;
    hook.server.running = {};
    await act(async () => {
      hook.server.heldKills[0](500);
      await new Promise((done) => setTimeout(done, 0));
    });
    await waitFor(() => expect(hook.server.reads).toContain(A));

    hook.server.holdReads = false;
    hook.rerender({ worktreeId: B });
    await waitFor(() => expect(hook.result.current.worktree?.id).toBe(B));
    const bTarget: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'B agent' };
    act(() => hook.result.current.openKillConfirm(bTarget));
    hook.server.reads.length = 0;

    await act(async () => {
      hook.server.heldReads.forEach((answer) => answer());
      await killing;
    });
    expect(hook.server.reads).not.toContain(A);
    expect(hook.result.current.worktree?.id).toBe(B);
    expect(hook.result.current.killTarget).toEqual(bTarget);
    expect(shown()).toEqual([]);
  });
});
