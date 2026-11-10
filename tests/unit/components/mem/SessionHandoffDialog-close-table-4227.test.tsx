/**
 * The hand-off dialog's one rule for going away, as a table (Issue #4227 G-PR2 pr2d, design
 * `mem-ui-4227.md` §4.1.1, the PM's decision in `pm-return-4227-pr2c-codex.md`):
 *
 *   a decide being sent or whose result is unknown is never dropped by any path that makes the
 *   dialog go away without the person's choice (send it again / drop it); while there is one the
 *   dialog stays; once a cancel has started no new decide is sent.
 *
 * The page is the real one: the worktree detail hook (`useWorktreeDetailController`) and the
 * dialog wired as the pages wire them (`onClose={closeHandoff}`, `onStop={stopForHandoff}`).
 *
 * Rows: path (the person's / the cancel's answer / the plain stop's end / a switch of worktree /
 * the page's other "end") × state (being sent / unknown / the cancel waiting) × worktree (the
 * dialog's own page / another worktree's page, after a switch kept it). Rows that cannot arise
 * are tested as such (e.g. the cancel's answer while a decide is sent: no decide is sent after
 * the cancel starts). Each row with a refusal has its negative control (nothing held: it goes).
 *
 * Positive controls: `rule.off` takes the rule out (`askHandoffClose` answers null, as if no
 * path asked) and the rows of codex review-4227-pr2b P2 1–3 and PM Claude pr2c P3-1・P3-2 go
 * back to what they were: the unit is lost, the dialog closes or is replaced.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SessionKillTarget } from '@/types/terminal-split-pane';

const rule = vi.hoisted(() => ({ off: false }));
vi.mock('@/lib/handoff/close-rule', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/close-rule')>();
  return {
    ...actual,
    askHandoffClose: (...args: Parameters<typeof actual.askHandoffClose>) => (rule.off ? null : actual.askHandoffClose(...args)),
  };
});
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
import { memWriteLockOfOthers, publishMemWriteLock } from '@/components/mem/mem-write-lock';
import type { HandoffProposalView, HandoffReadResponse, HandoffRequestView } from '@/lib/handoff/types';

const A = 'wt-a';
const B = 'wt-b';
const TARGET: SessionKillTarget = { cliToolId: 'claude', instanceId: 'claude', label: 'Claude' };
const OTHER: SessionKillTarget = { cliToolId: 'codex', instanceId: 'codex', label: 'Codex' };
const ATTENDED = { ok: true, mode: 'on', features: { popup: true } };

type Post = { worktree: string; path: string; body: Record<string, unknown> };
let posts: Post[];
let kills: string[];
let modeReads: string[];
let modeAnswer: { status: number; body: unknown };
let request: HandoffRequestView;
let proposals: HandoffProposalView[];
let decideMode: 'ok' | 'lose' | 'hold';
let releaseDecide: (() => void) | null;
let cancelMode: 'ok' | 'hold';
let releaseCancel: (() => void) | null;
let endAnswer: 'ok' | 'session_changed';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const view = (): HandoffReadResponse => ({ ok: true, request: { ...request }, proposals: proposals.map((p) => ({ ...p })), direct: [] });

beforeEach(() => {
  rule.off = false;
  posts = [];
  kills = [];
  modeReads = [];
  modeAnswer = { status: 200, body: ATTENDED };
  request = {
    id: 'r1',
    worktreeId: A,
    instanceId: 'claude',
    cliToolId: 'claude',
    branch: 'feat/x',
    detached: false,
    state: 'reviewing',
    sendState: 'sent',
    endForced: false,
    endToken: null,
    outcome: null,
    outcomeReason: null,
    agentDeadlineAt: '2026-11-10T00:05:00.000Z',
    extensions: 0,
    expiresAt: '2026-11-10T01:00:00.000Z',
    agentDoneAt: '2026-11-10T00:01:00.000Z',
    endedAt: null,
    agentTimedOut: false,
    version: 3,
  };
  proposals = [
    {
      id: 'p1',
      op: 'add',
      itemId: null,
      kind: 'note',
      baseVersion: null,
      revision: 1,
      fingerprint: 'fp-p1',
      state: 'proposed',
      stateReason: null,
      payload: { text: 'text of p1' },
      current: null,
      appliedItemId: null,
      appliedVersion: null,
    },
  ];
  decideMode = 'ok';
  releaseDecide = null;
  cancelMode = 'ok';
  releaseCancel = null;
  endAnswer = 'ok';
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const match = /^\/api\/worktrees\/([^/?]+)(.*)$/.exec(url);
    const worktree = match ? decodeURIComponent(match[1]) : '';
    const rest = match ? match[2] : url;
    if (method === 'POST') posts.push({ worktree, path: rest, body });
    if (rest.startsWith('/mem/mode')) {
      modeReads.push(worktree);
      return reply(modeAnswer.status, modeAnswer.body);
    }
    if (rest.startsWith('/kill-session')) {
      kills.push(url);
      return reply(200, { success: true, message: 'ok' });
    }
    if (rest === '/send') return reply(201, { id: 'm1' });
    if (rest === '/mem/handoff/requests' && method === 'POST') {
      if (worktree !== A) return reply(409, { ok: false, code: 'session_unknown' });
      return reply(201, { ...view(), text: 'the request text' });
    }
    const step = /^\/mem\/handoff\/requests\/r1(\/.*)?$/.exec(rest);
    if (step && worktree === A) {
      switch (step[1]) {
        case undefined:
        case '/sent':
        case '/send-failed':
          return reply(200, view());
        case '/decide': {
          if (body.ifVersion !== request.version) return reply(409, { ...view(), ok: false, code: 'version_conflict' });
          proposals = proposals.map((p) => ({ ...p, state: 'applied' as const }));
          request = { ...request, version: request.version + 2 };
          if (decideMode === 'lose') throw new TypeError('Failed to fetch');
          if (decideMode === 'hold') {
            await new Promise<void>((resolve) => (releaseDecide = resolve));
            throw new TypeError('Failed to fetch');
          }
          return reply(200, { ...view(), results: [{ proposalId: 'p1', result: 'applied' }] });
        }
        case '/cancel':
          if (cancelMode === 'hold') await new Promise<void>((resolve) => (releaseCancel = resolve));
          request = { ...request, state: 'cancelled' };
          return reply(200, view());
        case '/end':
          if (endAnswer === 'session_changed') return reply(409, { ok: false, code: 'session_changed' });
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
  releaseDecide?.();
  releaseCancel?.();
  publishMemWriteLock('mem-items', null);
  vi.restoreAllMocks();
  window.localStorage.clear();
});

let page: ReturnType<typeof useWorktreeDetailController>;
/** The page as `WorktreeDetailRefactored` wires it (the phone's dialog; the PC's is the same props). */
function Page({ worktreeId }: { worktreeId: string }) {
  page = useWorktreeDetailController({ worktreeId });
  return (
    <SessionHandoffDialog
      isOpen={page.handoffTarget !== null}
      worktreeId={worktreeId}
      target={page.handoffTarget}
      onClose={page.closeHandoff}
      onStop={page.stopForHandoff}
    />
  );
}

const press = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const button = (testId: string) => screen.queryByTestId(testId) as HTMLButtonElement | null;
const sent = (suffix: string) => posts.filter((post) => post.path.endsWith(suffix));
const esc = () => fireEvent.keyDown(document, { key: 'Escape' });
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

/** Opens the page on A and the hand-off for TARGET, at the proposals. */
async function opened() {
  const view = render(<Page worktreeId={A} />);
  await waitFor(() => expect(page.loading).toBe(false));
  await act(async () => {
    await page.openEnd(TARGET);
  });
  await screen.findByTestId('handoff-approve-p1');
  const switchTo = (worktreeId: string) => view.rerender(<Page worktreeId={worktreeId} />);
  return { switchTo };
}

type State = 'sending' | 'unknown' | 'cancelling' | 'none';
/** Brings the open dialog to `state`. */
async function reach(state: State): Promise<void> {
  if (state === 'sending' || state === 'unknown') {
    decideMode = state === 'sending' ? 'hold' : 'lose';
    press('handoff-approve-p1');
    press('handoff-confirm');
    if (state === 'sending') await waitFor(() => expect(releaseDecide).not.toBeNull());
    else await screen.findByTestId('handoff-pending');
  } else if (state === 'cancelling') {
    cancelMode = 'hold';
    press('handoff-cancel');
    await waitFor(() => expect(releaseCancel).not.toBeNull());
  }
}

const HELD = ['sending', 'unknown', 'cancelling'] as const;
const NOTICE = { sending: '選んでから閉じてください', unknown: '選んでから閉じてください', cancelling: '取り消しを送っています' } as const;

describe('[#4227 pr2d] path 1 — the person’s (Esc) × state × worktree', () => {
  it.each(HELD)('own page, while %s: stays, nothing (more) cancelled, the reason shown', async (state) => {
    await opened();
    await reach(state);
    const cancels = sent('/cancel').length;
    esc();
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE[state]));
    expect(page.handoffTarget).toEqual(TARGET);
    expect(sent('/cancel')).toHaveLength(cancels);
  });

  it('another worktree’s page (kept over a switch), unknown: stays; closing there never cancels A’s request', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    esc();
    press('handoff-foreign-close');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE.unknown));
    expect(page.handoffTarget).toEqual(TARGET);
    expect(sent('/cancel')).toHaveLength(0);
    press('handoff-pending-drop');
    press('handoff-foreign-close');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(0);
  });

  it('(negative control) nothing held: Esc cancels the request and closes', async () => {
    await opened();
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(1);
  });
});

describe('[#4227 pr2d] path 2 — the cancel’s answer (condition 4: no decide after the cancel starts)', () => {
  it('cancelling × being sent cannot arise: the confirm and the stop are not sent while the cancel waits (codex P2 1)', async () => {
    await opened();
    press('handoff-approve-p1');
    await reach('cancelling');
    expect(button('handoff-confirm')?.disabled).toBe(true);
    press('handoff-confirm');
    press('handoff-stop');
    await settle();
    expect(sent('/decide')).toHaveLength(0);
    expect(sent('/end')).toHaveLength(0);
    await act(async () => releaseCancel?.());
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(memWriteLockOfOthers('mem-items')).toBeNull();
  });

  it('cancelling × unknown cannot arise: with an unknown decide the cancel is not sent', async () => {
    await opened();
    await reach('unknown');
    press('handoff-cancel');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE.unknown));
    expect(sent('/cancel')).toHaveLength(0);
    expect(page.handoffTarget).toEqual(TARGET);
  });

  it('cancelling: a second close waits for the answer; the answer closes once', async () => {
    await opened();
    await reach('cancelling');
    esc();
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE.cancelling));
    expect(sent('/cancel')).toHaveLength(1);
    await act(async () => releaseCancel?.());
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/cancel')).toHaveLength(1);
  });

  it('(negative control) a decide answered before the cancel: the cancel is sent and closes', async () => {
    await opened();
    press('handoff-approve-p1');
    press('handoff-confirm');
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain('確定しました'));
    press('handoff-cancel');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(sent('/decide')).toHaveLength(1);
    expect(sent('/cancel')).toHaveLength(1);
  });
});

describe('[#4227 pr2d] path 3 — the plain stop’s end (codex P2 2): the stop can be pressed, the unit stays', () => {
  /** A stop whose `end` finds the session changed shows the plain stop (with the unit, if any). */
  async function toPlain() {
    endAnswer = 'session_changed';
    press('handoff-stop');
    await screen.findByTestId('handoff-plain');
  }

  it.each(['sending', 'unknown'] as const)('own page, %s: the plain stop runs; the dialog stays with the unit to choose', async (state) => {
    await opened();
    await reach(state);
    await toPlain();
    press('handoff-plain-stop');
    await waitFor(() => expect(kills).toHaveLength(1));
    await settle();
    if (state === 'sending') await act(async () => releaseDecide?.());
    expect(page.handoffTarget).toEqual(TARGET);
    expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
    expect(button('handoff-plain-stop')).toBeNull();
    press('handoff-pending-drop');
    press('handoff-plain-cancel');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(kills).toHaveLength(1);
  });

  it('cancelling: no stop is run while the cancel waits', async () => {
    await opened();
    await reach('cancelling');
    expect(button('handoff-stop')?.disabled).toBe(true);
    press('handoff-stop');
    await settle();
    expect(sent('/end')).toHaveLength(0);
    expect(kills).toHaveLength(0);
  });

  it('another worktree’s page: no stop is offered (the page’s stop is that worktree’s)', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    expect(button('handoff-stop')).toBeNull();
    expect(button('handoff-stop-now')).toBeNull();
    expect(button('handoff-plain-stop')).toBeNull();
    expect(kills).toHaveLength(0);
  });

  it('(negative control) nothing held: the plain stop closes the dialog after the stop', async () => {
    await opened();
    await toPlain();
    press('handoff-plain-stop');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(kills).toHaveLength(1);
  });
});

describe('[#4227 pr2d] path 4 — a switch of worktree (codex P2 3・PM Claude pr2c P3-1)', () => {
  it.each(HELD)('while %s: the dialog stays, as another worktree’s, and makes no request on B', async (state) => {
    const { switchTo } = await opened();
    await reach(state);
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    expect(page.handoffTarget).toEqual(TARGET);
    expect(posts.filter((post) => post.worktree === B && post.path === '/mem/handoff/requests')).toHaveLength(0);
    if (state === 'cancelling') {
      await act(async () => releaseCancel?.());
      await waitFor(() => expect(page.handoffTarget).toBeNull());
    }
    if (state === 'sending') {
      await act(async () => releaseDecide?.());
      expect(await screen.findByTestId('handoff-pending')).toBeTruthy();
      expect(page.handoffTarget).toEqual(TARGET);
    }
  });

  it('unknown, A → B → A: on B the unit is dropped only; back on A the same decide is sent again', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    const first = sent('/decide')[0];
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    expect(screen.getByTestId('handoff-pending-elsewhere')).toBeTruthy();
    expect(button('handoff-pending-resend')?.disabled).toBe(true);
    expect(button('handoff-pending-drop')?.disabled).toBe(false);
    press('handoff-pending-resend');
    await settle();
    expect(sent('/decide')).toHaveLength(1);
    expect(memWriteLockOfOthers('mem-items')).toBe('unknown');
    switchTo(A);
    await waitFor(() => expect(screen.queryByTestId('handoff-foreign')).toBeNull());
    expect(button('handoff-pending-resend')?.disabled).toBe(false);
    press('handoff-pending-resend');
    await waitFor(() => expect(sent('/decide')).toHaveLength(2));
    expect(sent('/decide')[1]).toEqual(first);
  });

  it('(negative control) nothing held: a switch closes the dialog', async () => {
    const { switchTo } = await opened();
    switchTo(B);
    await waitFor(() => expect(page.handoffTarget).toBeNull());
    expect(screen.queryByTestId('handoff-dialog')).toBeNull();
  });
});

describe('[#4227 pr2d] path 5 — the page’s other "end" (PM Claude pr2c P3-2)', () => {
  it.each(HELD)('while %s: another End neither replaces the hand-off nor opens the plain confirmation', async (state) => {
    await opened();
    await reach(state);
    const reads = modeReads.length;
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toEqual(TARGET);
    expect(page.killTarget).toBeNull();
    expect(modeReads).toHaveLength(reads);
    await waitFor(() => expect(screen.getByTestId('handoff-notice').textContent).toContain(NOTICE[state]));
  });

  it('another worktree’s page, unknown: B’s End is ignored as well', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    switchTo(B);
    await screen.findByTestId('handoff-foreign');
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toEqual(TARGET);
    expect(page.killTarget).toBeNull();
  });

  it('a kill in flight: the attended End does not open the hand-off over its confirmation (P3-2 (b))', async () => {
    render(<Page worktreeId={A} />);
    await waitFor(() => expect(page.loading).toBe(false));
    let releaseKill!: () => void;
    const fetchBefore = global.fetch;
    global.fetch = vi.fn((input: unknown, init?: RequestInit) =>
      String(input).includes('/kill-session')
        ? new Promise<Response>((resolve) => (releaseKill = () => resolve(reply(200, { success: true }))))
        : fetchBefore(input as RequestInfo, init)
    ) as unknown as typeof fetch;
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.killTarget).toEqual(OTHER);
    let killing!: Promise<void>;
    act(() => {
      killing = page.handleKillConfirm();
    });
    await waitFor(() => expect(page.isKillPending).toBe(true));
    modeAnswer = { status: 200, body: ATTENDED };
    await act(async () => {
      await page.openEnd(TARGET);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toEqual(OTHER);
    await act(async () => {
      releaseKill();
      await killing;
    });
  });

  it('(negative control) nothing held: another End closes the hand-off and opens the plain confirmation', async () => {
    await opened();
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toEqual(OTHER);
  });
});

describe('[#4227 pr2d] (positive controls) without the rule the rows above go back to the reviews’ findings', () => {
  it('codex P2 3 / P3-1: a switch while unknown closes the dialog (the unit is no longer offered on A)', async () => {
    const { switchTo } = await opened();
    await reach('unknown');
    rule.off = true;
    switchTo(B);
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });

  it('codex P2 2: the plain stop’s end closes the dialog with the unit unchosen', async () => {
    await opened();
    await reach('unknown');
    endAnswer = 'session_changed';
    press('handoff-stop');
    await screen.findByTestId('handoff-plain');
    rule.off = true;
    press('handoff-plain-stop');
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });

  it('P3-2: another End replaces a hand-off that holds an unknown decide', async () => {
    await opened();
    await reach('unknown');
    rule.off = true;
    modeAnswer = { status: 500, body: { ok: false } };
    await act(async () => {
      await page.openEnd(OTHER);
    });
    expect(page.handoffTarget).toBeNull();
    expect(page.killTarget).toEqual(OTHER);
  });

  it('the person’s Esc while unknown closes (the rule of pr2c taken out)', async () => {
    await opened();
    await reach('unknown');
    rule.off = true;
    esc();
    await waitFor(() => expect(page.handoffTarget).toBeNull());
  });
});
