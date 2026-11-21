/**
 * Issue #4484: `?instance=X` and where the first message typed on the screen goes.
 *
 * Sprint 7 saw it once: a detail opened with `?instance=antigravity` showed Claude
 * and the body typed into it reached Claude. The trigger was never identified, so
 * this suite closes the Issue by pinning that no path is left where the instance
 * the URL asked for and the send target part ways (Issue's second completion
 * criterion). Two holes the investigation found:
 *
 *  - hole 1 (controller): the URL was judged once, at the first `rosterReady`; an
 *    id missing from that roster was dropped without a word;
 *  - hole 2 (PC): the PC layout acknowledged the request the moment it handed it
 *    to the header path, before the split container had applied it, so a rebuild
 *    of the layout in between lost it and the screen fell back to the default.
 *
 * Every case renders the real `WorktreeDetailRefactored` with the real split
 * container and panes, sends from the composer that is visible and selected, and
 * reads the `/send` body: an alias must be `instanceId === X`; a primary must
 * carry no `instanceId` and `cliToolId === X` (so `cliToolId` alone cannot hide a
 * primary/alias mix-up). The header's current session and the To: line are read
 * at the same time (I1: what the screen says is where the body goes).
 *
 * Positive controls (red before the fix): #3 (the rebuild between hand-over and
 * application) and #4 (X arrives with the second poll). Negative controls: no
 * query does nothing; the unknown id still lands on the default, now with a toast.
 *
 * Harness notes: the controller is the real one; its wrapper only (a) counts the
 * acknowledgements and (b) for #3 forces `loading` for one step right after the
 * request first reaches the page — the window of hole 2, which no real event
 * produces deterministically in jsdom.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';

type Inst = { id: string; cliTool: string; alias?: string; order: number };

const { nav, mobileStore, server, harness, cache } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let mobile = false;
  return {
    nav: { search: new URLSearchParams(), replace: vi.fn() },
    mobileStore: {
      get: () => mobile,
      set: (next: boolean) => {
        mobile = next;
        listeners.forEach((l) => l());
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
    },
    server: {
      sends: [] as Array<Record<string, unknown>>,
      /** Rosters per worktree, one per detail GET; the last repeats. */
      rosters: {} as Record<string, Inst[][]>,
      calls: {} as Record<string, number>,
      gate: null as Promise<void> | null,
    },
    harness: {
      acks: [] as unknown[][],
      rebuildOnRequest: false,
      setForced: null as ((v: boolean) => void) | null,
    },
    cache: { ids: [] as string[] },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: nav.replace, prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4484',
  useSearchParams: () => nav.search,
}));
vi.mock('@/hooks/useIsMobile', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useIsMobile: () => useSyncExternalStore(mobileStore.subscribe, mobileStore.get, mobileStore.get),
    MOBILE_BREAKPOINT: 768,
  };
});
vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false, toggle: vi.fn(),
    setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    groups: [], filteredGroups: [], allCommands: [], loading: false,
    error: null, filter: '', setFilter: vi.fn(), refresh: vi.fn(), isCatalogStale: false,
  }),
}));
vi.mock('@/components/error/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});
// (#1, P2-1) a cache hit: the PC layout is drawn before the roster arrives.
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({
  useOptionalWorktreesCacheContext: () =>
    cache.ids.length > 0
      ? {
          worktrees: cache.ids.map((id) => ({
            id, name: `feature/${id}`, path: `/repo/${id}`, repositoryPath: '/repo', repositoryName: 'Repo',
          })),
          repositories: [], isLoading: false, error: null, refresh: vi.fn(),
        }
      : null,
}));
vi.mock('@/hooks/useWorktreeDetailController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useWorktreeDetailController')>();
  const R = await import('react');
  return {
    ...actual,
    useWorktreeDetailController: (args: { worktreeId: string }) => {
      const c = actual.useWorktreeDetailController(args);
      const [forced, setForced] = R.useState(false);
      harness.setForced = setForced;
      const req = c.instanceSelectionRequest;
      R.useEffect(() => {
        if (harness.rebuildOnRequest && req) {
          harness.rebuildOnRequest = false;
          setForced(true);
        }
      }, [req]);
      const ack = c.acknowledgeInstanceSelection as (...a: unknown[]) => void;
      const countedAck = R.useCallback((...a: unknown[]) => {
        harness.acks.push(a);
        ack(...a);
      }, [ack]);
      return { ...c, loading: c.loading || forced, acknowledgeInstanceSelection: countedAck };
    },
  };
});

import { WorktreeDetailRefactored } from '@/components/worktree/WorktreeDetailRefactored';
import { ToastProvider } from '@/components/common/Toast';
import { mockTerminalSplitsLocalStorage } from '@tests/helpers/terminal-splits';

const WT = 'wt-4484';
const WT_B = 'wt-4484-b';
const RUNNING = { isRunning: true, isWaitingForResponse: false, isProcessing: false };
const CLAUDE: Inst = { id: 'claude', cliTool: 'claude', order: 0 };
const CODEX: Inst = { id: 'codex', cliTool: 'codex', order: 1 };
const REVIEW: Inst = { id: 'claude-2', cliTool: 'claude', alias: 'Review', order: 2 };
const FULL = [CLAUDE, CODEX, REVIEW];
const WITHOUT_REVIEW = [CLAUDE, CODEX];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function detail(id: string): Record<string, unknown> {
  const seq = server.rosters[id] ?? [FULL];
  const n = server.calls[id] ?? 0;
  server.calls[id] = n + 1;
  const roster = seq[Math.min(n, seq.length - 1)];
  const status = Object.fromEntries(roster.map((i) => [i.id, RUNNING]));
  return {
    id, name: `feature/${id}`, path: `/repo/${id}`, repositoryPath: '/repo', repositoryName: 'Repo',
    selectedAgents: ['claude', 'codex'], agentInstances: roster,
    sessionStatusByCli: { claude: RUNNING, codex: RUNNING },
    sessionStatusByInstance: status,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  nav.search = new URLSearchParams();
  nav.replace.mockClear();
  mobileStore.set(false);
  server.sends = [];
  server.rosters = {};
  server.calls = {};
  server.gate = null;
  harness.acks = [];
  harness.rebuildOnRequest = false;
  harness.setForced = null;
  cache.ids = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const path = url.split('?')[0];
    for (const id of [WT, WT_B]) {
      if (path === `/api/worktrees/${id}`) {
        if (server.gate) await server.gate;
        return json(detail(id));
      }
      if (path === `/api/worktrees/${id}/send` && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        server.sends.push(body);
        return json({
          id: `m-${server.sends.length}`, worktreeId: id, role: 'user', content: body.content,
          timestamp: new Date().toISOString(), messageType: 'normal', cliToolId: body.cliToolId,
        }, 201);
      }
    }
    if (path.endsWith('/start-preview')) return json({ ok: true, show: false, attended: false });
    if (path.endsWith('/messages')) return json([]);
    if (path.endsWith('/current-output')) return json({ isRunning: true, output: '', isComplete: false });
    return json({});
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function holdDetail(): () => void {
  let release: () => void = () => {};
  server.gate = new Promise<void>((r) => {
    release = r;
  });
  return () => {
    server.gate = null;
    release();
  };
}

function renderScreen(worktreeId = WT) {
  const Screen = ({ id }: { id: string }) => (
    <ToastProvider>
      <WorktreeDetailRefactored worktreeId={id} />
    </ToastProvider>
  );
  const view = render(<Screen id={worktreeId} />);
  return { ...view, switchTo: (id: string) => view.rerender(<Screen id={id} />) };
}

/** The selected split: the framed one, or split 0 when there is one split. */
function selectedIndex(): number {
  const framed = document.querySelector('[data-focused="true"]');
  if (!framed) return 0;
  const wrapper = framed.closest('[data-testid^="split-wrapper-"]');
  return Number(wrapper?.getAttribute('data-testid')?.split('-').pop() ?? 0);
}

const currentSession = () => document.querySelector('[data-session-current]')?.getAttribute('data-testid');
const labelOf = (inst: Inst) => inst.alias ?? (inst.cliTool === 'claude' ? 'Claude' : 'Codex');

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Types into the composer of the selected, visible split and returns the `/send` body. */
async function sendFromSelected(text: string): Promise<Record<string, unknown>> {
  const idx = selectedIndex();
  const composer = screen.getByTestId(`split-composer-${idx}`);
  const before = server.sends.length;
  fireEvent.change(within(composer).getByTestId('message-input-textarea'), { target: { value: text } });
  fireEvent.click(within(composer).getByRole('button', { name: /send message/i }));
  await waitFor(() => expect(server.sends.length).toBe(before + 1));
  return server.sends[server.sends.length - 1];
}

function expectBodyTargets(body: Record<string, unknown>, inst: Inst): void {
  if (inst.id === inst.cliTool) {
    expect(body.instanceId).toBeUndefined();
    expect(body.cliToolId).toBe(inst.id);
  } else {
    expect(body.instanceId).toBe(inst.id);
  }
}

/** The screen says `inst` (header, To:, active) and the body really goes there. */
async function expectPcDeliversTo(inst: Inst, text = 'hello'): Promise<void> {
  await waitFor(() => {
    const idx = selectedIndex();
    expect(screen.getByTestId(`split-wrapper-${idx}`)).not.toHaveAttribute('data-hidden');
    expect(screen.getByTestId(`split-composer-target-${idx}`).textContent).toMatch(
      new RegExp(`^To: ${labelOf(inst)}( ·|$)`),
    );
    expect(currentSession()).toBe(`desktop-agent-status-${inst.id}`);
  });
  // Nothing stored yet means the default (the roster's first, Claude).
  expect(window.localStorage.getItem(`activeInstanceId-${WT}`) ?? CLAUDE.id).toBe(inst.id);
  expectBodyTargets(await sendFromSelected(text), inst);
}

async function expectPhoneDeliversTo(inst: Inst, text = 'hello'): Promise<void> {
  await waitFor(() => {
    const tab = document.querySelector('nav button[aria-current="page"]');
    expect(tab?.textContent ?? '').toMatch(new RegExp(`${labelOf(inst)}$`));
  });
  const wrapper = screen.getByTestId('mobile-composer-wrapper');
  const before = server.sends.length;
  fireEvent.change(within(wrapper).getByTestId('message-input-textarea'), { target: { value: text } });
  fireEvent.click(within(wrapper).getByRole('button', { name: /send message/i }));
  await waitFor(() => expect(server.sends.length).toBe(before + 1));
  expectBodyTargets(server.sends[server.sends.length - 1], inst);
}

const toastTexts = () => Array.from(document.querySelectorAll('[data-testid^="toast-"]')).map((el) => el.textContent ?? '');

describe('[#4484] ?instance=X: the selected split, the active instance and the first send are X', () => {
  it('#1 the roster arrives after the PC layout is drawn (cache hit)', async () => {
    cache.ids = [WT];
    const release = holdDetail();
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    await screen.findByTestId('split-composer-0');
    await act(async () => release());
    await expectPcDeliversTo(REVIEW);
    expect(harness.acks).toHaveLength(1);
  });

  it('#2 the roster arrives with the end of loading and the PC layout mounts after it (a primary)', async () => {
    nav.search = new URLSearchParams('instance=codex');
    renderScreen();
    await expectPcDeliversTo(CODEX);
    expect(harness.acks).toHaveLength(1);
    expect(nav.replace).toHaveBeenCalledWith(`/worktrees/${WT}`, { scroll: false });
  });

  it('#3 the PC layout is rebuilt after the request reached it and before the split applied it', async () => {
    harness.rebuildOnRequest = true;
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    // The page went to Loading right after the request first reached it.
    await waitFor(() => expect(harness.rebuildOnRequest).toBe(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => harness.setForced?.(false));
    await expectPcDeliversTo(REVIEW);
    expect(harness.acks).toHaveLength(1);
  });

  it('#4 X is missing from the first roster and arrives with the next poll; a send before that goes to what To: shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.rosters[WT] = [WITHOUT_REVIEW, FULL];
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    // Before X is known (P1-1 / PM 2(a)): the To: line names Claude and the body goes to Claude.
    await expectPcDeliversTo(CLAUDE, 'before');
    await advance(5_500);
    await expectPcDeliversTo(REVIEW, 'after');
    expect(harness.acks).toHaveLength(1);
    expect(toastTexts().join('\n')).not.toMatch(/claude-2/);
  });

  it('#5 an id outside the roster: a toast after the grace names what is shown, and the body goes there', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    nav.search = new URLSearchParams('instance=codex-9');
    renderScreen();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    expect(toastTexts().join('\n')).not.toMatch(/codex-9/);
    await advance(10_500);
    await waitFor(() =>
      expect(toastTexts().join('\n')).toContain("codex-9 is not one of this worktree's agents. Showing Claude instead."),
    );
    await expectPcDeliversTo(CLAUDE);
    expect(harness.acks).toHaveLength(0);
  });

  it('does nothing without the query (negative control)', async () => {
    renderScreen();
    await expectPcDeliversTo(CLAUDE);
    expect(nav.replace).not.toHaveBeenCalled();
    expect(harness.acks).toHaveLength(0);
  });
});

describe('[#4484] a waiting request is tied to its worktree and ended by a manual pick (P1-3)', () => {
  it('leaving worktree A for B, where the same id exists, does not select it on B and says nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.rosters[WT] = [WITHOUT_REVIEW];
    server.rosters[WT_B] = [FULL];
    nav.search = new URLSearchParams('instance=claude-2');
    const view = renderScreen(WT);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    nav.search = new URLSearchParams();
    view.switchTo(WT_B);
    await waitFor(() => expect(server.calls[WT_B]).toBeGreaterThan(0));
    await advance(11_000);
    await waitFor(() => expect(currentSession()).toBe('desktop-agent-status-claude'));
    expect(window.localStorage.getItem(`activeInstanceId-${WT_B}`)).not.toBe('claude-2');
    expect(toastTexts().join('\n')).not.toMatch(/claude-2/);
    expect(harness.acks).toHaveLength(0);
  });

  it('X waiting, the user picks codex in the header, X arrives: codex stays and nothing is said', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.rosters[WT] = [WITHOUT_REVIEW, FULL];
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    await screen.findByTestId('split-composer-0');
    fireEvent.click(screen.getByTestId('desktop-agent-status-overflow'));
    fireEvent.click(screen.getByTestId('desktop-agent-status-codex'));
    await waitFor(() => expect(currentSession()).toBe('desktop-agent-status-codex'));
    await advance(5_500);
    await waitFor(() => expect(server.calls[WT]).toBeGreaterThan(1));
    await advance(6_000);
    await expectPcDeliversTo(CODEX);
    expect(toastTexts().join('\n')).not.toMatch(/claude-2/);
    expect(harness.acks).toHaveLength(0);
  });
});

describe('[#4484] where X must be visible to count as applied (P2-1)', () => {
  it('a split maximized when the URL is applied is restored, so the selected X is visible', async () => {
    mockTerminalSplitsLocalStorage(WT, {
      splits: [{ cliToolId: 'claude', instanceId: 'claude' }, { cliToolId: 'claude', instanceId: 'claude-2' }],
      widths: [0.5, 0.5],
    });
    cache.ids = [WT];
    const release = holdDetail();
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    await screen.findByTestId('split-composer-1');
    fireEvent.click(screen.getByTestId('toggle-maximize-split'));
    await waitFor(() => expect(screen.getByTestId('split-wrapper-1')).toHaveAttribute('data-hidden', 'true'));
    await act(async () => release());
    await expectPcDeliversTo(REVIEW);
    expect(selectedIndex()).toBe(1);
    expect(harness.acks).toHaveLength(1);
  });

  it('after a success on split 2, a rebuild of the PC layout does not apply it again; To: and the body still agree', async () => {
    mockTerminalSplitsLocalStorage(WT, {
      splits: [{ cliToolId: 'claude', instanceId: 'claude' }, { cliToolId: 'claude', instanceId: 'claude-2' }],
      widths: [0.5, 0.5],
    });
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    await expectPcDeliversTo(REVIEW);
    expect(selectedIndex()).toBe(1);
    nav.search = new URLSearchParams();

    await act(async () => mobileStore.set(true));
    await act(async () => mobileStore.set(false));
    await screen.findByTestId('split-composer-1');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // Not applied again (the request was acknowledged once and is gone). The
    // rebuilt container starts on split 1, as after any rebuild, and the screen
    // and the body agree on it.
    expect(harness.acks).toHaveLength(1);
    await expectPcDeliversTo(CLAUDE, 'after rebuild');
  });
});

describe('[#4484] the phone (P2-2)', () => {
  beforeEach(() => {
    window.localStorage.setItem('commandmate:worktree:mobileInstances:wt-4484', JSON.stringify(['claude']));
  });

  it('X arrives late on the phone: its tab is shown, selected, and the body goes to X', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mobileStore.set(true);
    server.rosters[WT] = [WITHOUT_REVIEW, FULL];
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    await expectPhoneDeliversTo(CLAUDE, 'before');
    await advance(5_500);
    await expectPhoneDeliversTo(REVIEW, 'after');
    expect(toastTexts().join('\n')).not.toMatch(/claude-2/);
  });

  it('an unknown id on the phone: the toast after the grace, and the body goes to what is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mobileStore.set(true);
    nav.search = new URLSearchParams('instance=codex-9');
    renderScreen();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    await advance(10_500);
    await waitFor(() =>
      expect(toastTexts().join('\n')).toContain("codex-9 is not one of this worktree's agents. Showing Claude instead."),
    );
    await expectPhoneDeliversTo(CLAUDE);
  });

  it('a request made on the PC is applied on the phone after a switch of width; the first phone send goes to X', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.rosters[WT] = [WITHOUT_REVIEW, FULL];
    nav.search = new URLSearchParams('instance=claude-2');
    renderScreen();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    await act(async () => mobileStore.set(true));
    await advance(5_500);
    await expectPhoneDeliversTo(REVIEW);
    expect(toastTexts().join('\n')).not.toMatch(/claude-2/);
  });
});
