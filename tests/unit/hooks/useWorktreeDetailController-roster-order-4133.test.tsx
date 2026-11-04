/**
 * A late poll answer must not put an old roster back (Issue #4133).
 *
 * `rosterRevision` is a hash, so it cannot say which of two rosters is newer. What
 * can: the order the requests left in, and whether a save landed since one left.
 *
 * Positive controls: the two "old answer" tests fail on the code before this Issue.
 * Negative controls: answers in order, an answer after a failed newer request and a
 * read made after a save are all still taken.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { AgentInstance } from '@/lib/cli-tools/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/worktrees/wt-4133',
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
  return { ...actual, useToast: () => ({ showToast: vi.fn() }) };
});

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';

const WORKTREE_ID = 'wt-4133';

const roster = (...ids: string[]): AgentInstance[] =>
  ids.map((id, order) => ({ id, cliTool: 'claude', alias: id, order }));

function jsonReply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const worktreeBody = (agentInstances: AgentInstance[]): unknown => ({
  id: WORKTREE_ID,
  name: 'feature/4133',
  path: '/path/to/wt',
  repositoryPath: '/path/to/repo',
  repositoryName: 'MyRepo',
  status: 'in_progress',
  agentInstances,
});

/** Every worktree GET waits here until the test answers it, in whatever order it likes. */
function stubFetch(): Array<(reply: Response) => void> {
  const pending: Array<(reply: Response) => void> = [];
  global.fetch = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/current-output')) return Promise.resolve(jsonReply(200, { isRunning: false }));
    if (url.includes('/messages')) return Promise.resolve(jsonReply(200, []));
    if (url.includes('/auto-yes')) return Promise.resolve(jsonReply(200, { instances: {} }));
    if (url.endsWith(`/api/worktrees/${WORKTREE_ID}`)) {
      return new Promise<Response>((resolve) => pending.push(resolve));
    }
    return Promise.resolve(jsonReply(404, {}));
  }) as unknown as typeof fetch;
  return pending;
}

async function mounted() {
  const pending = stubFetch();
  const hook = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }));
  await waitFor(() => expect(pending).toHaveLength(1));
  return { ...hook, pending };
}

/** Leave one more request, unanswered. */
async function issueAnother(hook: { result: { current: { handleRetry: () => Promise<void> } } }, pending: unknown[]): Promise<void> {
  const before = pending.length;
  void act(() => {
    void hook.result.current.handleRetry();
  });
  await waitFor(() => expect(pending.length).toBe(before + 1));
}

async function answer(pending: Array<(reply: Response) => void>, index: number, reply: Response): Promise<void> {
  await act(async () => {
    pending[index](reply);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const ids = (hook: { result: { current: { agentInstances: AgentInstance[] } } }): string[] =>
  hook.result.current.agentInstances.map((inst) => inst.id);

afterEach(() => vi.restoreAllMocks());

describe('[#4133] the roster from the detail poll', () => {
  it('two reads crossing: the older answer does not put the old roster back', async () => {
    const hook = await mounted();
    await issueAnother(hook, hook.pending);
    await answer(hook.pending, 1, jsonReply(200, worktreeBody(roster('claude', 'claude-2'))));
    expect(ids(hook)).toEqual(['claude', 'claude-2']);
    await answer(hook.pending, 0, jsonReply(200, worktreeBody(roster('claude'))));
    expect(ids(hook)).toEqual(['claude', 'claude-2']);
  });

  it('a read from before a save, answered after it: the saved roster stays', async () => {
    const hook = await mounted();
    act(() => hook.result.current.handleAgentInstancesChange(roster('claude', 'saved')));
    expect(ids(hook)).toEqual(['claude', 'saved']);
    await answer(hook.pending, 0, jsonReply(200, worktreeBody(roster('claude'))));
    expect(ids(hook)).toEqual(['claude', 'saved']);
  });

  it('answers in order are all taken (negative control)', async () => {
    const hook = await mounted();
    await answer(hook.pending, 0, jsonReply(200, worktreeBody(roster('first'))));
    expect(ids(hook)).toEqual(['first']);
    await issueAnother(hook, hook.pending);
    await answer(hook.pending, 1, jsonReply(200, worktreeBody(roster('second'))));
    expect(ids(hook)).toEqual(['second']);
  });

  it('a newer request that failed does not throw away the older answer (negative control)', async () => {
    const hook = await mounted();
    await issueAnother(hook, hook.pending);
    await answer(hook.pending, 1, jsonReply(500, {}));
    await answer(hook.pending, 0, jsonReply(200, worktreeBody(roster('older'))));
    expect(ids(hook)).toEqual(['older']);
  });

  it('a read made after a save is taken: another client may have changed it since (negative control)', async () => {
    const hook = await mounted();
    await answer(hook.pending, 0, jsonReply(200, worktreeBody(roster('claude'))));
    act(() => hook.result.current.handleAgentInstancesChange(roster('claude', 'saved')));
    await issueAnother(hook, hook.pending);
    await answer(hook.pending, 1, jsonReply(200, worktreeBody(roster('claude', 'saved', 'elsewhere'))));
    expect(ids(hook)).toEqual(['claude', 'saved', 'elsewhere']);
  });

  it('a discarded roster leaves the rest of the answer alone', async () => {
    const hook = await mounted();
    act(() => hook.result.current.handleAgentInstancesChange(roster('claude', 'saved')));
    await answer(hook.pending, 0, jsonReply(200, worktreeBody(roster('claude'))));
    expect(hook.result.current.worktree?.name).toBe('feature/4133');
  });
});
