/**
 * Tests for useChanges (Issue #780, extracted in #922).
 *
 * Owns the working-tree Changes state + commit form. The behaviorally important
 * contract is the cascade composition: a commit refetches the changes list ITSELF
 * and then calls the injected `onCommitted` (commit history + status); the diff
 * button routes through the injected `onWorkingDiff`; and `commitAndPush` runs the
 * injected push ONLY when the commit succeeds.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useChanges } from '@/hooks/useChanges';

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

describe('useChanges (Issue #780)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let onWorkingDiff: ReturnType<typeof vi.fn<(diff: string, filePath: string) => void>>;
  let onCommitted: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    mockFetch = vi.fn((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/staged')) return okJson({ staged: [], unstaged: [], untracked: [] });
      if (url.includes('/git/commit')) return okJson({ success: true });
      if (url.includes('/git/working-diff')) return okJson({ diff: 'DIFF-TEXT' });
      return okJson({ success: true });
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    onWorkingDiff = vi.fn();
    onCommitted = vi.fn(() => Promise.resolve());
  });
  afterEach(() => vi.restoreAllMocks());

  const setup = () =>
    renderHook(() => useChanges('w-1', { onWorkingDiff, onCommitted }));

  it('fetches the changes list from /git/staged on mount', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));
    expect(mockFetch.mock.calls.some((c) => urlOf(c[0]).includes('/git/staged'))).toBe(true);
    expect(result.current.staged).toEqual({ staged: [], unstaged: [], untracked: [] });
  });

  it('commit() clears the form, refetches changes, and calls onCommitted', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));

    act(() => result.current.setCommitMessage('feat: x'));
    await act(async () => {
      await result.current.commit();
    });

    const commitCall = mockFetch.mock.calls.find((c) => urlOf(c[0]).includes('/git/commit'));
    expect(commitCall).toBeTruthy();
    expect(JSON.parse(commitCall![1].body)).toEqual({ message: 'feat: x', amend: false });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(result.current.commitMessage).toBe('');
    expect(result.current.committing).toBe(false);
  });

  it('commit() surfaces the inline error and does NOT call onCommitted on failure', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/staged')) return okJson({ staged: [], unstaged: [], untracked: [] });
      if (url.includes('/git/commit')) return errJson({ error: 'nothing to commit' }, 400);
      return okJson({ success: true });
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));

    await act(async () => {
      await result.current.commit();
    });
    expect(result.current.changesCommitError).toBe('nothing to commit');
    expect(onCommitted).not.toHaveBeenCalled();
  });

  it('commitAndPush() runs push only when the commit succeeds', async () => {
    const push = vi.fn(() => Promise.resolve());
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));

    await act(async () => {
      await result.current.commitAndPush(push);
    });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('commitAndPush() skips push when the commit fails', async () => {
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.includes('/git/staged')) return okJson({ staged: [], unstaged: [], untracked: [] });
      if (url.includes('/git/commit')) return errJson({ error: 'fail' }, 400);
      return okJson({ success: true });
    });
    const push = vi.fn(() => Promise.resolve());
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));

    await act(async () => {
      await result.current.commitAndPush(push);
    });
    expect(push).not.toHaveBeenCalled();
    expect(result.current.changesCommitError).toBe('fail');
  });

  it('handleChangesDiff routes the working-tree diff through onWorkingDiff', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));

    await act(async () => {
      await result.current.handleChangesDiff('src/a.ts', 'unstaged');
    });
    const diffCall = mockFetch.mock.calls.find((c) => urlOf(c[0]).includes('/git/working-diff'));
    expect(urlOf(diffCall![0])).toContain('mode=unstaged');
    expect(onWorkingDiff).toHaveBeenCalledWith('DIFF-TEXT', 'src/a.ts');
  });

  it('fetchWorkingDiffText returns the raw diff string without routing onWorkingDiff', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.stagedLoading).toBe(false));

    let text: string | null = null;
    await act(async () => {
      text = await result.current.fetchWorkingDiffText('src/a.ts', 'staged');
    });
    expect(text).toBe('DIFF-TEXT');
    expect(onWorkingDiff).not.toHaveBeenCalled();
  });
});
