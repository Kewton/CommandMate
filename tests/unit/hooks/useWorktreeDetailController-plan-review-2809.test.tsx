/**
 * useWorktreeDetailController が Plan review かどうかを boolean で公開する（Issue #2809）
 *
 * スマホのドックの矢印パッドは controller の `/current-output` poll で立つ。フレーム本体は
 * mirror しない（#736）ので、同じ poll の中で `realtimeSnippet || fullOutput` を
 * `readSelectionListShape` で読み、`offersPlanApprove` だけを state にする（案 A）。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-2809',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => true,
  MOBILE_BREAKPOINT: 768,
}));

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
  useOptionalWorktreesCacheContext: () => null,
}));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const FIXTURES = path.resolve(__dirname, '../../fixtures');
const capture = (rel: string): string => fs.readFileSync(path.join(FIXTURES, rel), 'utf-8');

const FOCUS_APPROVE = capture('command-code-plan-review-2763/plan-review-action-focus-approve.txt');
const APPROVE_CHOICE = capture('command-code-plan-review-2763/plan-review-approve-choice.txt');

const WORKTREE_ID = 'wt-2809';

let currentOutputCalls = 0;

function stubCurrentOutput(body: Record<string, unknown>): void {
  currentOutputCalls = 0;
  global.fetch = vi.fn((url: string) => {
    if (url.includes('/current-output')) {
      currentOutputCalls += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ isRunning: true, isSelectionListActive: true, ...body }),
      });
    }
    if (url.includes('/messages')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          id: WORKTREE_ID,
          name: 'feature/2809',
          path: '/tmp/wt',
          repositoryPath: '/tmp/repo',
          repositoryName: 'CommandMate',
        }),
    });
  }) as unknown as typeof fetch;
}

/** 最初の `/current-output` 応答が反映されるまで待つ。 */
async function renderController() {
  const hook = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
  await waitFor(() => {
    expect(currentOutputCalls).toBeGreaterThan(0);
    expect(hook.result.current.isSelectionListActive).toBe(true);
  });
  return hook;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2809] useWorktreeDetailController.offersPlanApprove', () => {
  it('poll 前は false', () => {
    stubCurrentOutput({ realtimeSnippet: FOCUS_APPROVE });
    const { result } = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
    expect(result.current.offersPlanApprove).toBe(false);
  });

  it('`realtimeSnippet` が Plan review なら true', async () => {
    stubCurrentOutput({ realtimeSnippet: FOCUS_APPROVE, fullOutput: FOCUS_APPROVE });
    const { result } = await renderController();
    await waitFor(() => expect(result.current.offersPlanApprove).toBe(true));
  });

  it('`realtimeSnippet` が空なら `fullOutput` を読む', async () => {
    stubCurrentOutput({ realtimeSnippet: '', fullOutput: FOCUS_APPROVE });
    const { result } = await renderController();
    await waitFor(() => expect(result.current.offersPlanApprove).toBe(true));
  });

  it('承認確認ラジオ（`enter confirm`）は Plan review ではない', async () => {
    stubCurrentOutput({ realtimeSnippet: APPROVE_CHOICE, fullOutput: APPROVE_CHOICE });
    const { result } = await renderController();
    expect(result.current.offersPlanApprove).toBe(false);
  });

  it('フレームの無い応答では false', async () => {
    stubCurrentOutput({});
    const { result } = await renderController();
    expect(result.current.offersPlanApprove).toBe(false);
  });

  it('フレーム本体は公開しない（#736: output を mirror しない）', async () => {
    stubCurrentOutput({ realtimeSnippet: FOCUS_APPROVE, fullOutput: FOCUS_APPROVE });
    const { result } = await renderController();
    const exposed = Object.values(result.current as Record<string, unknown>);
    expect(exposed).not.toContain(FOCUS_APPROVE);
  });
});
