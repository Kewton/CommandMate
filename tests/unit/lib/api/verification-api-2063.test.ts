/**
 * Browser client additions for Issue #2063.
 *
 * The interesting one is `startVerification`. Its options type has carried
 * `gateIds` since #1816 and every caller sent `{}`, so the field was type-safe,
 * documented, and dead — the pane could only ask for the whole suite. What is
 * pinned below is that a named subset reaches the wire AND that the default
 * still sends no `gateIds` at all: an omitted list and a list naming every gate
 * are different requests to the runner (the scope gate is `implicit` for one and
 * `explicit` for the other), so "send everything you know about" would have been
 * a silent behaviour change on the path nobody asked to change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VerificationApiError,
  cancelVerificationRun,
  fetchVerificationRunHistory,
  startVerification,
} from '@/lib/api/verification-api';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** The body of the single fetch the call under test made, parsed. */
function sentBody(): unknown {
  const init = mockFetch.mock.calls[0][1] as { body?: string };
  return JSON.parse(init.body ?? 'null');
}

describe('startVerification with gateIds (Issue #2063)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('puts the requested gate ids in the POST body', async () => {
    mockFetch.mockResolvedValue(jsonResponse(202, { runId: 42 }));

    await expect(startVerification('wt-1', { gateIds: ['lint', 'work-evidence'] })).resolves.toBe(
      42
    );

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/worktrees/wt-1/verify',
      expect.objectContaining({ method: 'POST' })
    );
    expect(sentBody()).toEqual({ gateIds: ['lint', 'work-evidence'] });
  });

  it('sends no gateIds key at all for a default run', async () => {
    mockFetch.mockResolvedValue(jsonResponse(202, { runId: 43 }));

    await startVerification('wt-1');

    // `{}`, not `{ gateIds: undefined }` and not the full gate list: the
    // absence is the request.
    expect(sentBody()).toEqual({});
    expect(Object.keys(sentBody() as object)).not.toContain('gateIds');
  });

  it('carries gateIds alongside an explicit taskId', async () => {
    mockFetch.mockResolvedValue(jsonResponse(202, { runId: 44 }));

    await startVerification('wt-1', { gateIds: ['unit'], taskId: 'task-9' });

    expect(sentBody()).toEqual({ gateIds: ['unit'], taskId: 'task-9' });
  });
});

describe('cancelVerificationRun (Issue #2063)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('posts to the run-scoped cancel endpoint and returns the closed verdict', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { runId: 7, status: 'cancelled' }));

    await expect(cancelVerificationRun('wt-1', 7)).resolves.toEqual({
      runId: 7,
      status: 'cancelled',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/worktrees/wt-1/verify/runs/7/cancel',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('reports the 202 "signalled, still winding down" answer as running', async () => {
    mockFetch.mockResolvedValue(jsonResponse(202, { runId: 7, status: 'running' }));

    await expect(cancelVerificationRun('wt-1', 7)).resolves.toEqual({
      runId: 7,
      status: 'running',
    });
  });

  it('throws a VerificationApiError carrying the 409 status', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(409, { error: 'Verification run 7 has already finished', status: 'passed' })
    );

    await expect(cancelVerificationRun('wt-1', 7)).rejects.toMatchObject({
      name: 'VerificationApiError',
      status: 409,
    });
    // The caller distinguishes "already finished" from a real fault by status,
    // so the class matters as much as the message.
    await expect(cancelVerificationRun('wt-1', 7)).rejects.toBeInstanceOf(VerificationApiError);
  });

  it('percent-encodes a worktree id so a slash cannot walk the path', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { runId: 1, status: 'cancelled' }));

    await cancelVerificationRun('feature/2063', 1);

    expect(mockFetch.mock.calls[0][0]).toBe(
      '/api/worktrees/feature%2F2063/verify/runs/1/cancel'
    );
  });
});

describe('fetchVerificationRunHistory (Issue #2063)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('hits the cross-worktree endpoint with no filter by default', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { runs: [] }));

    await expect(fetchVerificationRunHistory()).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith('/api/verification/runs', { signal: undefined });
  });

  it('builds the query from the options it was given', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { runs: [{ id: 3 }] }));

    const runs = await fetchVerificationRunHistory({ worktreeId: 'wt-1', days: 7, limit: 20 });

    expect(mockFetch.mock.calls[0][0]).toBe(
      '/api/verification/runs?worktreeId=wt-1&days=7&limit=20'
    );
    expect(runs).toHaveLength(1);
  });

  it('throws rather than returning an empty list when the endpoint fails', async () => {
    // An empty history and a failed read look identical on screen otherwise,
    // and only one of them means "nothing has been verified anywhere".
    mockFetch.mockResolvedValue(jsonResponse(500, { error: 'Failed to list verification runs' }));

    await expect(fetchVerificationRunHistory()).rejects.toMatchObject({ status: 500 });
  });
});
