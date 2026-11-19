/**
 * A refused Auto-Yes enabling (409 TOOL_POLICY_DENIED) reaches the toggle as a
 * ToolPolicyRefusalError and leaves the state OFF; other failures behave as
 * before (Issue #4436).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { AutoYesToggleParams } from '@/types/auto-yes';

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn(),
  }),
  usePathname: () => '/worktrees/wt-3863',
  useSearchParams: () => nav.search,
}));

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => false, MOBILE_BREAKPOINT: 768 }));

vi.mock('@/contexts/SidebarContext', () => ({
  useSidebarContext: () => ({
    isOpen: true, width: 288, isMobileDrawerOpen: false,
    toggle: vi.fn(), setWidth: vi.fn(), openMobileDrawer: vi.fn(), closeMobileDrawer: vi.fn(),
  }),
}));
vi.mock('@/components/providers/WorktreesCacheProvider', () => ({ useOptionalWorktreesCacheContext: () => null }));

import { useWorktreeDetailController } from '@/hooks/useWorktreeDetailController';


import { ToolPolicyRefusalError } from '@/lib/tool-policy/refusal-view';

const WORKTREE_ID = 'wt-4436';
const links = { terms: 'https://antigravity.google/terms', faq: 'https://antigravity.google/docs/faq' };
let armed = false;
let postAnswer: { ok: boolean; status: number; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status, redirected: false,
    url: `http://localhost/api/worktrees/${WORKTREE_ID}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  armed = false;
  window.localStorage.clear();
  nav.search = new URLSearchParams();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (/\/auto-yes(\?|$)/.test(url) && init?.method === 'POST') {
      armed = postAnswer.ok;
      return jsonResponse(postAnswer.body, postAnswer.status);
    }
    if (/\/auto-yes(\?|$)/.test(url)) {
      return jsonResponse({ enabled: armed, expiresAt: null, agents: {}, instances: { claude: { enabled: armed, expiresAt: armed ? Date.now() + 3_600_000 : null } } });
    }
    if (url.includes('/messages')) return jsonResponse([]);
    if (url.includes('/current-output')) return jsonResponse({ isRunning: true });
    return jsonResponse({
      id: WORKTREE_ID, name: 'feature/4436', path: '/repo/4436', repositoryPath: '/repo', repositoryName: 'Repo',
      selectedAgents: ['claude'], agentInstances: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Result {
  autoYesStateMap: Map<string, { enabled: boolean }>;
  rosterReady: boolean;
  makeAutoYesToggleHandler: (cliToolId: 'claude', instanceId?: string) => (params: AutoYesToggleParams) => Promise<void>;
}

async function mountReady() {
  const result = renderHook(() => useWorktreeDetailController({ worktreeId: WORKTREE_ID }) as unknown as Result).result;
  await waitFor(() => expect(result.current.rosterReady).toBe(true));
  return result;
}

const enableParams: AutoYesToggleParams = { enabled: true, duration: 3600000 as never };

describe('useWorktreeDetailController: Auto-Yes tool-policy refusal (#4436)', () => {
  it('T3: 409 TOOL_POLICY_DENIED rejects with the reason and the links as given; the state stays OFF', async () => {
    postAnswer = {
      ok: false, status: 409,
      body: { code: 'TOOL_POLICY_DENIED', error: 'why', reason: 'ANTIGRAVITY_CONSUMER_TERMS', links, cliToolId: 'claude', instanceId: 'claude' },
    };
    const result = await mountReady();
    let caught: unknown;
    await act(async () => {
      await result.current.makeAutoYesToggleHandler('claude', 'claude')(enableParams).catch((e: unknown) => { caught = e; });
    });
    expect(caught).toBeInstanceOf(ToolPolicyRefusalError);
    expect((caught as ToolPolicyRefusalError).view).toEqual({ message: 'why', links });
    expect(result.current.autoYesStateMap.get('claude')?.enabled ?? false).toBe(false);
  });

  it('T4: a 409 of another code, and a 500, resolve without a refusal (as before)', async () => {
    const result = await mountReady();
    for (const answer of [
      { ok: false, status: 409, body: { code: 'SESSION_OWNED_BY_OTHER_SERVER', error: 'x', links } },
      { ok: false, status: 500, body: { error: 'x' } },
    ]) {
      postAnswer = answer;
      await act(async () => {
        await expect(result.current.makeAutoYesToggleHandler('claude', 'claude')(enableParams)).resolves.toBeUndefined();
      });
    }
  });

  it('T4: an accepted enabling resolves and turns the state ON', async () => {
    postAnswer = { ok: true, status: 200, body: { enabled: true, expiresAt: Date.now() + 3_600_000 } };
    const result = await mountReady();
    await act(async () => {
      await expect(result.current.makeAutoYesToggleHandler('claude', 'claude')(enableParams)).resolves.toBeUndefined();
    });
    await waitFor(() => expect(result.current.autoYesStateMap.get('claude')?.enabled).toBe(true));
  });
});
