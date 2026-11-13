/**
 * The hand-off dialog answers to its page's registration (Issue #4317 PR1, `@/lib/handoff/page-registration`;
 * the pre-review `prereview-4317-reply.md` 1).
 *
 * The page is the real one: `useWorktreeDetailController` and the dialog wired as
 * `WorktreeDetailRefactored` wires it (`onClose={closeHandoff}`, `onStop={stopForHandoff}`,
 * `registration={handoffRegistration}`).
 *
 * Invariants:
 * - the registration lapsed — a newer page registered (overlap) or the page's own removed (gap):
 *   the dialog is still drawn, its buttons disabled, and no close (Escape, ×, the buttons), stop,
 *   decide nor text starts;
 * - the registration lapses while something is answered: nothing new begins after the await (no
 *   kill after `end`'s answer, no close after the cancel's or the kill's answer), but what was
 *   sent is recorded for its own unit (`end`'s answer adopted, a decide's unknown result kept, the
 *   cancel's answer read, the plain stop's "stopped" kept);
 * - the opening's token swapped under the same registration: the old press stops nothing, the new
 *   opening's stop runs.
 *
 * 再指示 2: one condition starts anything new — the current registration and the session not
 * expired. "expired" is a lapse as the overlap and the gap are; the text after create goes for the
 * registration the request was made under (not any page of the same worktree), else stays unsent.
 * Positive controls on 64dc4b6: the "expired" cases, and the overlap during create (it sent the text).
 *
 * Positive controls (the code before #4317 PR1, the page handing no registration): the cases
 * marked "lapsed" fail — the Escape cancels and closes, the kill is started after `end`, the
 * cancel's answer closes the dialog. Negative controls: the same with the registration current.
 *
 * PR2 再指示 1: the route takes part in that condition. The page's registration stays the current
 * one while the path turns to another worktree's (B → A on the dev server: B's page still
 * registered while A's route is loading): a create, an `end` or the mode's read answered then
 * starts no text, kill nor opening; what was sent is recorded. Positive control: on a8a2ef0 (the
 * route not in `handoffPageMayStart`) the "route turned" cases send, kill and open. Negative
 * control: the path still the page's — they go on.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

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

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';
import { SessionHandoffDialog } from '@/components/mem/SessionHandoffDialog';
import { publishMemWriteLock } from '@/components/mem/mem-write-lock';
import { beginHandoffOpening, handoffStoreSnapshot, handoffUnitsOf, resetHandoffStoreForTests } from '@/lib/handoff/close-rule';
import {
  handoffRegistrySnapshot,
  registerHandoffPage,
  reportHandoffPageAuth,
  reportHandoffRoute,
  resetHandoffRegistryForTests,
  unregisterHandoffPage,
} from '@/lib/handoff/page-registration';
import type { HandoffProposalView, HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

const A = 'wt-a';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

type Post = { worktree: string; path: string };
let posts: Post[];
let kills: string[];
let request: HandoffRequestView;
let proposals: HandoffProposalView[];
let holds: Record<'end' | 'cancel' | 'decide' | 'kill' | 'create' | 'mode', (() => void) | null>;
let holding: Set<keyof typeof holds>;
let createAnswer: 'ok' | 'session_unknown';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: proposals.map((p) => ({ ...p })), direct: [] });
const hold = async (name: keyof typeof holds) => {
  if (holding.has(name)) await new Promise<void>((resolve) => (holds[name] = resolve));
};

beforeEach(() => {
  resetHandoffRegistryForTests();
  resetHandoffStoreForTests();
  posts = [];
  kills = [];
  holds = { end: null, cancel: null, decide: null, kill: null, create: null, mode: null };
  holding = new Set();
  createAnswer = 'ok';
  request = {
    id: 'r1', worktreeId: A, instanceId: 'claude', cliToolId: 'claude', branch: 'feat/x', detached: false,
    state: 'reviewing', sendState: 'sent', endForced: false, endToken: null, outcome: null, outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z', extensions: 0, expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: '2026-11-10T00:01:00.000Z', endedAt: null, agentTimedOut: false, version: 3,
  };
  proposals = [
    {
      id: 'p1', op: 'add', itemId: null, kind: 'note', baseVersion: null, revision: 1, fingerprint: 'fp-p1',
      state: 'proposed', stateReason: null, payload: { text: 'text of p1' }, current: null, appliedItemId: null, appliedVersion: null,
    },
  ];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const match = /^\/api\/worktrees\/([^/?]+)(.*)$/.exec(url);
    const worktree = match ? decodeURIComponent(match[1]) : '';
    const rest = match ? match[2] : url;
    if (method === 'POST') posts.push({ worktree, path: rest });
    if (rest.startsWith('/mem/mode')) {
      await hold('mode');
      return reply(200, ATTENDED);
    }
    if (rest.startsWith('/kill-session')) {
      kills.push(url);
      await hold('kill');
      return reply(200, { success: true, message: 'ok' });
    }
    if (rest === '/send') return reply(201, { id: 'm1' });
    if (rest === '/mem/handoff/requests' && method === 'POST') {
      await hold('create');
      if (createAnswer === 'session_unknown') return reply(409, { ok: false, code: 'session_unknown' });
      return reply(201, { ...view(), text: 'the request text' });
    }
    const step = /^\/mem\/handoff\/requests\/r1(\/.*)?$/.exec(rest);
    if (step) {
      switch (step[1]) {
        case undefined:
        case '/sent':
        case '/send-failed':
          return reply(200, view());
        case '/decide':
          await hold('decide');
          throw new TypeError('Failed to fetch');
        case '/cancel':
          await hold('cancel');
          request = { ...request, state: 'cancelled' };
          return reply(200, view());
        case '/end':
          await hold('end');
          request = { ...request, state: 'ending', endToken: 'tok-1', version: request.version + 1 };
          return reply(200, { ...view(), endToken: 'tok-1' });
        case '/end/observe':
          request = { ...request, state: 'ended', outcome: 'confirmed' };
          return reply(200, view());
        default:
          return reply(404, { ok: false, code: 'not_found' });
      }
    }
    if (rest.startsWith('/current-output')) return reply(200, { isRunning: false });
    if (rest.startsWith('/messages')) return reply(200, []);
    if (rest.startsWith('/auto-yes')) return reply(200, { instances: {} });
    if (match && rest === '') {
      return reply(200, { id: worktree, name: worktree, path: '/p', repositoryPath: '/r', repositoryName: 'R', sessionStatusByInstance: {} });
    }
    return reply(404, {});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  for (const release of Object.values(holds)) release?.();
  publishMemWriteLock('mem-items', null);
  resetHandoffStoreForTests();
  resetHandoffRegistryForTests();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

let page: ReturnType<typeof useWorktreeDetailController>;
/** The page as `WorktreeDetailRefactored` wires its one host. */
function Page({ worktreeId }: { worktreeId: string }) {
  page = useWorktreeDetailController({ worktreeId });
  return (
    <SessionHandoffDialog
      isOpen={page.handoffTarget !== null}
      worktreeId={worktreeId}
      target={page.handoffTarget}
      onClose={page.closeHandoff}
      onStop={page.stopForHandoff}
      registration={page.handoffRegistration}
    />
  );
}

const press = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const button = (testId: string) => screen.queryByTestId(testId) as HTMLButtonElement | null;
const sent = (suffix: string) => posts.filter((post) => post.path.endsWith(suffix));
const esc = () => fireEvent.keyDown(document, { key: 'Escape' });
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

async function opened() {
  render(<Page worktreeId={A} />);
  await waitFor(() => expect(page.loading).toBe(false));
  await act(async () => {
    await page.openEnd(TARGET);
  });
  await screen.findByTestId('handoff-approve-p1');
}

type Lapse = 'overlap' | 'gap' | 'expired';
/**
 * The page may start nothing any more: a newer page registered (overlap), the page's own removed
 * (gap), or (再指示 2) the session expired under the page's current registration — its newest read
 * answered 401 (the dialog is still drawn here: this harness draws it whatever the expiry).
 */
function lapse(how: Lapse): void {
  act(() => {
    if (how === 'overlap') registerHandoffPage(A);
    else if (how === 'gap') unregisterHandoffPage(page.handoffRegistration!);
    else reportHandoffPageAuth(page.handoffRegistration!, 'expired', Number.MAX_SAFE_INTEGER);
  });
}
const LAPSES: Lapse[] = ['overlap', 'gap', 'expired'];

describe('[#4317 PR1] a lapsed registration: drawn, nothing starts', () => {
  it.each(LAPSES)('lapsed (%s): the dialog stays drawn, its buttons are disabled, Escape cancels and closes nothing', async (how) => {
    await opened();
    lapse(how);
    await settle();
    expect(screen.getByTestId('handoff-dialog')).toBeTruthy();
    for (const id of ['handoff-cancel', 'handoff-stop', 'handoff-stop-now']) expect(button(id)?.disabled).toBe(true);
    esc();
    await settle();
    expect(sent('/cancel')).toHaveLength(0);
    expect(page.handoffTarget).toEqual(TARGET);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(screen.getByTestId('handoff-dialog')).toBeTruthy();
  });

  it('(negative control) the registration current: Escape cancels the request and closes', async () => {
    await opened();
    expect(button('handoff-cancel')?.disabled).toBe(false);
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(1);
  });

  it('the overlap ends (the newer page’s late cleanup): the page’s own registration is current again and its Escape closes', async () => {
    await opened();
    let newer: ReturnType<typeof registerHandoffPage> | null = null;
    act(() => {
      newer = registerHandoffPage(A);
    });
    act(() => unregisterHandoffPage(newer!));
    await settle();
    expect(button('handoff-cancel')?.disabled).toBe(false);
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });
});

describe('[#4317 PR1] the registration lapses during an await: no new start, what was sent is recorded', () => {
  it.each(LAPSES)('lapsed (%s) while `end` is answered: no kill is started; `end`’s answer is adopted into the opening', async (how) => {
    await opened();
    holding.add('end');
    press('handoff-stop');
    await waitFor(() => expect(holds.end).not.toBeNull());
    lapse(how);
    await act(async () => holds.end!());
    await settle();
    expect(kills).toHaveLength(0);
    expect(sent('/end/observe')).toHaveLength(0);
    expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('ending');
    expect(handoffStoreSnapshot().opening?.view?.request.endToken).toBe('tok-1');
    expect(handoffUnitsOf(A).stopping).toBe(false);
  });

  it('(negative control) the registration current while `end` is answered: the kill runs once and is observed', async () => {
    await opened();
    holding.add('end');
    press('handoff-stop');
    await waitFor(() => expect(holds.end).not.toBeNull());
    await act(async () => holds.end!());
    await waitFor(() => expect(sent('/end/observe')).toHaveLength(1));
    expect(kills).toHaveLength(1);
  });

  it('lapsed while the kill is answered: the kill already sent is observed (recorded for its request)', async () => {
    await opened();
    holding.add('kill');
    press('handoff-stop');
    await waitFor(() => expect(holds.kill).not.toBeNull());
    lapse('gap');
    await act(async () => holds.kill!());
    await waitFor(() => expect(sent('/end/observe')).toHaveLength(1));
    expect(kills).toHaveLength(1);
    expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('ended');
  });

  it.each(LAPSES)('lapsed (%s) while the cancel is answered: nothing is closed, the answer is read into the opening', async (how) => {
    await opened();
    holding.add('cancel');
    press('handoff-cancel');
    await waitFor(() => expect(holds.cancel).not.toBeNull());
    lapse(how);
    await act(async () => holds.cancel!());
    await settle();
    expect(sent('/cancel')).toHaveLength(1);
    expect(handoffUnitsOf(A).cancelling).toBe(false);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(page.handoffTarget).toEqual(TARGET);
    await waitFor(() => expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('cancelled'));
  });

  it('(negative control) the registration current while the cancel is answered: the dialog closes', async () => {
    await opened();
    holding.add('cancel');
    press('handoff-cancel');
    await waitFor(() => expect(holds.cancel).not.toBeNull());
    await act(async () => holds.cancel!());
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });

  it('lapsed while a decide is answered: the decide’s unknown result is kept for its unit', async () => {
    await opened();
    holding.add('decide');
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(holds.decide).not.toBeNull());
    lapse('gap');
    await act(async () => holds.decide!());
    await settle();
    expect(handoffUnitsOf(A).inflight).toBeNull();
    expect(handoffUnitsOf(A).pending).toMatchObject({ worktreeId: A, requestId: 'r1', ifVersion: 3 });
  });

  it('lapsed while the plain stop’s kill is answered: “stopped” is kept on its opening, nothing is closed', async () => {
    createAnswer = 'session_unknown';
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-plain-stop');
    holding.add('kill');
    press('handoff-plain-stop');
    await waitFor(() => expect(holds.kill).not.toBeNull());
    lapse('gap');
    await act(async () => holds.kill!());
    await settle();
    expect(kills).toHaveLength(1);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(handoffStoreSnapshot().opening?.plainStopped).toBe(true);
    expect(page.handoffTarget).toEqual(TARGET);
  });
});

describe('[#4317 PR1] the opening’s token swapped under the same registration', () => {
  it('the old press stops nothing after `end`; the new opening’s stop runs', async () => {
    await opened();
    const first = handoffStoreSnapshot().opening!.token;
    holding.add('end');
    press('handoff-stop');
    await waitFor(() => expect(holds.end).not.toBeNull());
    act(() => {
      beginHandoffOpening(A, TARGET);
    });
    holding.delete('end');
    await act(async () => holds.end!());
    await settle();
    expect(kills).toHaveLength(0);
    const second = handoffStoreSnapshot().opening!;
    expect(second.token).not.toBe(first);
    await screen.findByTestId('handoff-stop');
    press('handoff-stop');
    await waitFor(() => expect(kills).toHaveLength(1));
  });
});

describe('[#4317 PR1 再指示 2] the text after create goes for the registration the request was made under', () => {
  /** The page presses "end"; the request's create is held until `lapse` (if any) and released. */
  async function created(how: Lapse | null) {
    request = { ...request, state: 'awaiting_agent', sendState: 'unsent', agentDoneAt: null };
    holding.add('create');
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(holds.create).not.toBeNull());
    if (how !== null) lapse(how);
    await act(async () => holds.create!());
    await settle();
  }

  it.each(LAPSES)('lapsed (%s) while the create is answered: no text is sent, the request stays unsent on its opening', async (how) => {
    await created(how);
    expect(sent('/send')).toHaveLength(0);
    expect(sent('/sent')).toHaveLength(0);
    expect(handoffStoreSnapshot().opening?.created).toBe('done');
    expect(handoffStoreSnapshot().opening?.view?.request.sendState).toBe('unsent');
    expect(handoffStoreSnapshot().opening?.text).toBe('the request text');
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
  });

  it('(negative control) the registration current and the session authenticated: the text is sent once', async () => {
    await created(null);
    await waitFor(() => expect(sent('/sent')).toHaveLength(1));
    expect(sent('/send')).toHaveLength(1);
  });
});

describe('[#4317 PR1 再指示 2] the session expired: the page opens nothing, the dialog starts nothing', () => {
  it('expired while the plain stop’s kill is answered: “stopped” is kept on its opening, nothing is closed', async () => {
    createAnswer = 'session_unknown';
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-plain-stop');
    holding.add('kill');
    press('handoff-plain-stop');
    await waitFor(() => expect(holds.kill).not.toBeNull());
    lapse('expired');
    await act(async () => holds.kill!());
    await settle();
    expect(kills).toHaveLength(1);
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    expect(handoffStoreSnapshot().opening?.plainStopped).toBe(true);
    expect(page.handoffTarget).toEqual(TARGET);
  });

  it('expired while a decide is answered: the decide’s unknown result is kept for its unit', async () => {
    await opened();
    holding.add('decide');
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(holds.decide).not.toBeNull());
    lapse('expired');
    await act(async () => holds.decide!());
    await settle();
    expect(handoffUnitsOf(A).inflight).toBeNull();
    expect(handoffUnitsOf(A).pending).toMatchObject({ worktreeId: A, requestId: 'r1', ifVersion: 3 });
  });

  it('expired under the current registration: "end" opens no hand-off and no confirmation', async () => {
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    lapse('expired');
    expect(handoffRegistrySnapshot().authExpired).toBe(true);
    await act(async () => {
      await page.openEnd(TARGET);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toBeNull();
    expect(handoffStoreSnapshot().opening).toBeNull();
  });

  it('expired while the mode is read: no hand-off is opened', async () => {
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = page.openEnd(TARGET);
    });
    lapse('expired');
    await act(async () => {
      await pressed;
    });
    expect(page.handoffTarget).toBeNull();
    expect(handoffStoreSnapshot().opening).toBeNull();
  });
});

describe('[#4317 PR2 再指示 1] the path turns to another worktree while the page is still registered', () => {
  const B = 'wt-b';
  /** The host's report of the path's detail route (as `HandoffDialogHost` makes it). */
  const route = (worktreeId: string) => act(() => reportHandoffRoute(worktreeId));

  beforeEach(() => {
    reportHandoffRoute(A);
  });

  async function rendered() {
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
  }

  it.each([
    ['turned to B', B],
    ['(negative control) still A', A],
  ])('the create answered with the path %s: the text is sent only on the page’s route; the request is recorded either way', async (_, to) => {
    request = { ...request, state: 'awaiting_agent', sendState: 'unsent', agentDoneAt: null };
    holding.add('create');
    await rendered();
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await waitFor(() => expect(holds.create).not.toBeNull());
    route(to);
    await act(async () => holds.create!());
    await settle();
    expect(handoffStoreSnapshot().opening?.created).toBe('done');
    expect(handoffStoreSnapshot().opening?.text).toBe('the request text');
    expect(handoffStoreSnapshot().opening?.closed).toBe(false);
    if (to === A) {
      await waitFor(() => expect(sent('/sent')).toHaveLength(1));
      expect(sent('/send')).toHaveLength(1);
    } else {
      expect(sent('/send')).toHaveLength(0);
      expect(sent('/sent')).toHaveLength(0);
      expect(handoffStoreSnapshot().opening?.view?.request.sendState).toBe('unsent');
    }
  });

  it.each([
    ['turned to B', B],
    ['(negative control) still A', A],
  ])('`end` answered with the path %s: the kill starts only on the page’s route; `end`’s answer is adopted either way', async (_, to) => {
    await rendered();
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-approve-p1');
    holding.add('end');
    press('handoff-stop');
    await waitFor(() => expect(holds.end).not.toBeNull());
    route(to);
    await act(async () => holds.end!());
    await settle();
    expect(handoffStoreSnapshot().opening?.view?.request.endToken).toBe('tok-1');
    if (to === A) {
      await waitFor(() => expect(sent('/end/observe')).toHaveLength(1));
      expect(kills).toHaveLength(1);
    } else {
      expect(kills).toHaveLength(0);
      expect(sent('/end/observe')).toHaveLength(0);
      expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('ending');
      expect(handoffUnitsOf(A).stopping).toBe(false);
    }
  });

  it('the path turns to B while the kill already sent is answered: it is observed (recorded for its request)', async () => {
    await rendered();
    await act(async () => {
      await page.openEnd(TARGET);
    });
    await screen.findByTestId('handoff-approve-p1');
    holding.add('kill');
    press('handoff-stop');
    await waitFor(() => expect(holds.kill).not.toBeNull());
    route(B);
    await act(async () => holds.kill!());
    await waitFor(() => expect(sent('/end/observe')).toHaveLength(1));
    expect(kills).toHaveLength(1);
    expect(handoffStoreSnapshot().opening?.view?.request.state).toBe('ended');
  });

  it.each([
    ['turned to B', B],
    ['(negative control) still A', A],
  ])('the mode read answered with the path %s: the hand-off opens only on the page’s route', async (_, to) => {
    await rendered();
    holding.add('mode');
    let pressed: Promise<void> | null = null;
    act(() => {
      pressed = page.openEnd(TARGET);
    });
    await waitFor(() => expect(holds.mode).not.toBeNull());
    route(to);
    await act(async () => {
      holds.mode!();
      await pressed;
    });
    await settle();
    if (to === A) {
      expect(page.handoffTarget).toEqual(TARGET);
      expect(handoffStoreSnapshot().opening).not.toBeNull();
    } else {
      expect(page.handoffTarget).toBeNull();
      expect(page.killTarget).toBeNull();
      expect(handoffStoreSnapshot().opening).toBeNull();
      expect(sent('/mem/handoff/requests')).toHaveLength(0);
    }
  });
});
