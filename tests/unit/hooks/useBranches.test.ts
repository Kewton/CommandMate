/**
 * Tests for useBranches (Issue #781, extracted in #922).
 *
 * Owns the Branches list + checkout / create / delete. Key contracts: it fetches
 * by include filter on mount and on include change; a checkout runs the injected
 * `onCheckoutCascade` (HEAD moved) alongside its own branch refetch; create /
 * delete only refetch branches (HEAD unchanged).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useBranches } from '@/hooks/useBranches';
import type { BranchInfo } from '@/types/git';

type MockFetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

const okJson = (data: unknown): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: true, status: 200, json: async () => data });
const errJson = (data: unknown, status: number): Promise<MockFetchResponse> =>
  Promise.resolve({ ok: false, status, json: async () => data });

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const BRANCH: BranchInfo = {
  name: 'feature/x',
  isCurrent: false,
  isRemote: false,
  isDefault: false,
  upstream: null,
  aheadBehind: null,
  checkedOutWorktreePath: null,
};

describe('useBranches (Issue #781)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let onCheckoutCascade: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    mockFetch = vi.fn((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/branches')) return okJson({ branches: [BRANCH] });
      return okJson({ success: true });
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    onCheckoutCascade = vi.fn(() => Promise.resolve());
  });
  afterEach(() => vi.restoreAllMocks());

  const setup = () => renderHook(() => useBranches('w-1', { onCheckoutCascade }));

  it('fetches the local branch list on mount', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.branchesLoading).toBe(false));
    const call = mockFetch.mock.calls.find((c) => urlOf(c[0]).includes('/git/branches'));
    expect(urlOf(call![0])).toContain('include=local');
    expect(result.current.branches).toEqual([BRANCH]);
  });

  it('refetches with the new filter when include changes', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.branchesLoading).toBe(false));

    act(() => result.current.handleBranchIncludeChange('all'));
    await waitFor(() =>
      expect(mockFetch.mock.calls.some((c) => urlOf(c[0]).includes('include=all'))).toBe(true)
    );
    expect(result.current.branchInclude).toBe('all');
  });

  it('checkout runs onCheckoutCascade (HEAD moved) plus its own branch refetch', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.branchesLoading).toBe(false));
    const before = mockFetch.mock.calls.filter((c) => urlOf(c[0]).includes('/git/branches')).length;

    await act(async () => {
      await result.current.handleCheckout(BRANCH, false);
    });
    expect(mockFetch.mock.calls.some((c) => urlOf(c[0]).includes('/git/checkout'))).toBe(true);
    expect(onCheckoutCascade).toHaveBeenCalledTimes(1);
    const after = mockFetch.mock.calls.filter((c) => urlOf(c[0]).includes('/git/branches')).length;
    expect(after).toBeGreaterThan(before);
  });

  it('create does NOT run the checkout cascade', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.branchesLoading).toBe(false));

    await act(async () => {
      await result.current.handleBranchCreate('feature/y', 'main');
    });
    expect(mockFetch.mock.calls.some((c) => urlOf(c[0]).includes('/git/branch/create'))).toBe(true);
    expect(onCheckoutCascade).not.toHaveBeenCalled();
  });

  it('surfaces the API error on a failed checkout', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/branches')) return okJson({ branches: [BRANCH] });
      if (url.includes('/git/checkout')) return errJson({ error: 'dirty tree' }, 409);
      return okJson({ success: true });
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.branchesLoading).toBe(false));

    await act(async () => {
      await result.current.handleCheckout(BRANCH, false);
    });
    expect(result.current.branchActionError).toBe('dirty tree');
    expect(onCheckoutCascade).not.toHaveBeenCalled();
  });
});
