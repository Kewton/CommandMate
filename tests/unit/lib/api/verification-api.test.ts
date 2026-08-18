/**
 * Unit tests for the verification / task-contract browser client (Issue #1816).
 *
 * The client wraps endpoints that already existed, so what is worth pinning is
 * the *translation*: which HTTP outcomes become data, which become errors, and
 * whether the 202 the verify route answers with is unwrapped into a run id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VerificationApiError,
  fetchLatestTask,
  fetchVerificationRun,
  fetchVerificationRuns,
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

describe('verification-api (Issue #1816)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchLatestTask', () => {
    it('asks for one task and returns it', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(200, { tasks: [{ id: 'task-1', title: 'Issue #1816' }] })
      );

      const task = await fetchLatestTask('wt-1');

      expect(mockFetch).toHaveBeenCalledWith('/api/worktrees/wt-1/tasks?limit=1', {
        signal: undefined,
      });
      expect(task?.id).toBe('task-1');
    });

    it('returns null when the worktree has no task row', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, { tasks: [] }));
      await expect(fetchLatestTask('wt-1')).resolves.toBeNull();
    });

    it('throws on 404 — a missing worktree is a fault, not "no tasks"', async () => {
      mockFetch.mockResolvedValue(jsonResponse(404, { error: "Worktree 'wt-x' not found" }));

      await expect(fetchLatestTask('wt-x')).rejects.toMatchObject({
        name: 'VerificationApiError',
        status: 404,
        message: "Worktree 'wt-x' not found",
      });
    });

    it('encodes the worktree id', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, { tasks: [] }));
      await fetchLatestTask('feature/1816 ui');
      expect(mockFetch.mock.calls[0][0]).toBe(
        '/api/worktrees/feature%2F1816%20ui/tasks?limit=1'
      );
    });
  });

  describe('fetchVerificationRuns', () => {
    it('returns the run list newest-first as the route serves it', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(200, { runs: [{ id: 9 }, { id: 8 }] })
      );

      const runs = await fetchVerificationRuns('wt-1', 10);

      expect(mockFetch.mock.calls[0][0]).toBe('/api/worktrees/wt-1/verify/runs?limit=10');
      expect(runs.map((run) => run.id)).toEqual([9, 8]);
    });

    it('falls back to [] when the payload omits `runs`', async () => {
      mockFetch.mockResolvedValue(jsonResponse(200, {}));
      await expect(fetchVerificationRuns('wt-1')).resolves.toEqual([]);
    });

    it('throws a VerificationApiError carrying the status on failure', async () => {
      mockFetch.mockResolvedValue(jsonResponse(500, { error: 'Failed to list verification runs' }));

      const error = await fetchVerificationRuns('wt-1').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(VerificationApiError);
      expect((error as VerificationApiError).status).toBe(500);
    });
  });

  describe('fetchVerificationRun', () => {
    it('returns the run with its gates', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(200, { run: { id: 9, gates: [{ id: 1, gateId: 'unit' }] } })
      );

      const run = await fetchVerificationRun('wt-1', 9);

      expect(mockFetch.mock.calls[0][0]).toBe('/api/worktrees/wt-1/verify/runs/9');
      expect(run?.gates).toHaveLength(1);
    });

    it('returns null on 404 — a run id can go stale while the pane is open', async () => {
      mockFetch.mockResolvedValue(jsonResponse(404, { error: 'Verification run not found' }));
      await expect(fetchVerificationRun('wt-1', 9)).resolves.toBeNull();
    });

    it('still throws on other failures', async () => {
      mockFetch.mockResolvedValue(jsonResponse(400, { error: 'Invalid run ID format' }));
      await expect(fetchVerificationRun('wt-1', 9)).rejects.toBeInstanceOf(VerificationApiError);
    });
  });

  describe('startVerification', () => {
    it('unwraps the 202 into a run id', async () => {
      mockFetch.mockResolvedValue(jsonResponse(202, { runId: 42 }));

      const runId = await startVerification('wt-1');

      expect(runId).toBe(42);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/worktrees/wt-1/verify');
      expect(init.method).toBe('POST');
      // No trigger: the run is recorded as `api`, which is what a Web UI run is.
      expect(JSON.parse(init.body)).toEqual({});
    });

    it('forwards gateIds / taskId when the caller narrows the run', async () => {
      mockFetch.mockResolvedValue(jsonResponse(202, { runId: 43 }));

      await startVerification('wt-1', { gateIds: ['lint'], taskId: 'task-1' });

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        gateIds: ['lint'],
        taskId: 'task-1',
      });
    });

    it('surfaces the blocking run id on 409', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(409, { error: 'A verification run is already in progress', runningRunId: 7 })
      );

      const error = await startVerification('wt-1').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(VerificationApiError);
      expect((error as VerificationApiError).status).toBe(409);
      expect((error as VerificationApiError).runningRunId).toBe(7);
    });

    it('rejects a 2xx that carried no run id rather than returning NaN', async () => {
      mockFetch.mockResolvedValue(jsonResponse(202, {}));
      await expect(startVerification('wt-1')).rejects.toBeInstanceOf(VerificationApiError);
    });
  });
});
