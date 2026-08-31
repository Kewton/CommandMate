/**
 * `useAgentDefaults` — the state machine behind the agent pane's two "make this
 * the default" actions (Issue #2067).
 *
 * The claims worth pinning here are about WHERE it writes and WHAT it believes
 * afterwards, and all of them are invisible to the component test: that BOTH
 * requests carry the worktree that bounds them to one repository, that the save
 * goes to #2065's endpoint (not a second one this Issue invented), that the
 * client mirror is updated from the RESPONSE rather than from what was sent, and
 * that a 200 carrying the wrong shape is treated as a failure rather than
 * rendered.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useAgentDefaults,
  APPLY_DEFAULT_AGENTS_ENDPOINT,
} from '@/hooks/useAgentDefaults';
import {
  DEFAULT_AGENTS_ENDPOINT,
  getClientDefaultSelectedAgents,
  resetClientDefaultSelectedAgents,
} from '@/config/default-agents';
import type { CLIToolType } from '@/lib/cli-tools/types';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const WORKTREE_ID = 'wt/with space';
const ROSTER: CLIToolType[] = ['codex', 'claude'];

function jsonOk(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function jsonStatus(status: number, body: unknown) {
  return { ok: false, status, json: () => Promise.resolve(body) };
}

describe('useAgentDefaults (Issue #2067)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientDefaultSelectedAgents();
  });

  afterEach(() => {
    resetClientDefaultSelectedAgents();
  });

  it('reads the eligible count from the worktrees apply route', async () => {
    mockFetch.mockResolvedValue(jsonOk({ success: true, eligible: 4 }));
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.refreshEligible()).toBe(4);
    });

    // The worktree is what bounds the answer to ONE repository, and it is
    // encoded: a worktree id may contain characters a bare interpolation would
    // turn into a second query parameter.
    expect(mockFetch).toHaveBeenCalledWith(
      `${APPLY_DEFAULT_AGENTS_ENDPOINT}?worktreeId=wt%2Fwith%20space`,
    );
    expect(result.current.eligible).toBe(4);
    expect(result.current.error).toBeNull();
  });

  it('adopts the repository scope the server names', async () => {
    mockFetch.mockResolvedValue(
      jsonOk({
        success: true,
        eligible: 2,
        repositoryName: 'CommandMate',
        repoDeclaresAgents: false,
      }),
    );
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      await result.current.refreshEligible();
    });

    expect(result.current.repositoryName).toBe('CommandMate');
    expect(result.current.repoDeclaresAgents).toBe(false);
  });

  it('reports a repository that declares its agents, so the panel can say why', async () => {
    mockFetch.mockResolvedValue(
      jsonOk({
        success: true,
        eligible: 0,
        repositoryName: 'CommandMate',
        repoDeclaresAgents: true,
      }),
    );
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.refreshEligible()).toBe(0);
    });

    expect(result.current.repoDeclaresAgents).toBe(true);
  });

  it('treats a 200 without a numeric count as a failure, not as zero', async () => {
    // What a server older than this screen answers: the path resolves, the body
    // is not this route's. Rendering `undefined` as a count would invite a
    // confirmation for an unknown number of branches.
    mockFetch.mockResolvedValue(jsonOk({ notThisRoute: true }));
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.refreshEligible()).toBeNull();
    });

    expect(result.current.eligible).toBeNull();
    expect(result.current.error).toBe('count');
  });

  it('PUTs the roster to the SAME endpoint the More screen uses', async () => {
    mockFetch.mockResolvedValue(
      jsonOk({ success: true, defaultSelectedAgents: ['codex', 'claude'], configured: true })
    );
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.saveAsDefault()).toBe(true);
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(DEFAULT_AGENTS_ENDPOINT);
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      agents: ['codex', 'claude'],
    });
    expect(result.current.savedDefault).toBe(true);
  });

  it('adopts the SERVER answer into the client mirror, not the request body', async () => {
    // The server is entitled to normalize. If the mirror echoed the request it
    // would drift from the row the More screen reads on its next load.
    mockFetch.mockResolvedValue(
      jsonOk({ success: true, defaultSelectedAgents: ['gemini', 'opencode'] })
    );
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      await result.current.saveAsDefault();
    });

    expect(getClientDefaultSelectedAgents()).toEqual(['gemini', 'opencode']);
  });

  it('surfaces a rejected save as error="save" and leaves the mirror alone', async () => {
    mockFetch.mockResolvedValue(jsonStatus(400, { success: false, error: 'Invalid CLI tool ID' }));
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.saveAsDefault()).toBe(false);
    });

    expect(result.current.error).toBe('save');
    expect(result.current.savedDefault).toBe(false);
    expect(getClientDefaultSelectedAgents()).toEqual(['claude', 'codex', 'antigravity']);
  });

  it('POSTs the roster to the apply route and reports the rows written', async () => {
    mockFetch.mockResolvedValue(
      jsonOk({ success: true, updated: 3, updatedIds: ['a', 'b', 'c'], eligible: 0 })
    );
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.applyToUnchanged()).toBe(3);
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(APPLY_DEFAULT_AGENTS_ENDPOINT);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      worktreeId: WORKTREE_ID,
      agents: ['codex', 'claude'],
    });
    expect(result.current.appliedCount).toBe(3);
    // The panel must stop offering to change branches it just changed.
    expect(result.current.eligible).toBe(0);
  });

  it('keeps the previous count when the apply response omits `eligible`', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk({ success: true, eligible: 5 }))
      .mockResolvedValueOnce(jsonOk({ success: true, updated: 5 }));
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      await result.current.refreshEligible();
    });
    await act(async () => {
      await result.current.applyToUnchanged();
    });

    expect(result.current.eligible).toBe(5);
  });

  it('surfaces a failed apply as error="apply" with no applied count', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));

    await act(async () => {
      expect(await result.current.applyToUnchanged()).toBeNull();
    });

    expect(result.current.error).toBe('apply');
    expect(result.current.appliedCount).toBeNull();
  });

  it('clears a stale "saved" badge when an apply starts', async () => {
    mockFetch.mockResolvedValue(
      jsonOk({ success: true, defaultSelectedAgents: ['codex', 'claude'] })
    );
    const { result } = renderHook(() => useAgentDefaults(WORKTREE_ID, ROSTER));
    await act(async () => {
      await result.current.saveAsDefault();
    });
    expect(result.current.savedDefault).toBe(true);

    mockFetch.mockResolvedValue(jsonOk({ success: true, updated: 1, eligible: 0 }));
    await act(async () => {
      await result.current.applyToUnchanged();
    });

    await waitFor(() => expect(result.current.savedDefault).toBe(false));
  });
});
