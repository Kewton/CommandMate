/**
 * Issue #1695: `capture --json` must be able to say a prompt was suppressed.
 *
 * `buildCurrentOutput` is the single producer for both the HTTP pull
 * (`GET /api/worktrees/:id/current-output`) and the WebSocket push, so this is
 * the layer where the tally becomes visible to the CLI. Kept in its own file
 * rather than appended to current-output-builder.test.ts so the module mocks
 * this Issue needs cannot disturb the suites already there.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));

const isRunning = vi.fn(async () => true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...(a as [])) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1695b:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  recordPromptDedupSkip,
  clearPromptDedupSkips,
} from '@/lib/polling/prompt-dedup-state';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';

const WT = 'wt-1695b';

beforeEach(() => {
  vi.clearAllMocks();
  clearPromptDedupSkips();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
});

describe('buildCurrentOutput Issue #1695 prompt dedup visibility', () => {
  it('publishes the skip count and the last skip time for the requested instance', async () => {
    recordPromptDedupSkip(WT, 'claude', 'claude-2', 1_000);
    recordPromptDedupSkip(WT, 'claude', 'claude-2', 4_200);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.promptDedup).toEqual({ skippedCount: 2, lastSkippedAt: 4_200 });
  });

  it('publishes an explicit zero when the guard never suppressed anything', async () => {
    // The other half of the answer: a zero here means the prompt was never
    // suppressed, so a missing prompt message points at the detection layer
    // (Issue #1676) rather than at dedup.
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.promptDedup).toEqual({ skippedCount: 0, lastSkippedAt: null });
  });

  it("does not leak another instance's skips", async () => {
    recordPromptDedupSkip(WT, 'claude', 'claude-3', 1_000);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.promptDedup).toEqual({ skippedCount: 0, lastSkippedAt: null });
  });

  it('still reports the tally after the session has stopped', async () => {
    // Deliberately unlike `model` / `reasoningEffort`, which null out on a dead
    // session: those describe a process that no longer exists, while a skip
    // count describes something that already happened — and an operator asking
    // "where did my prompt go?" usually asks after the session ended.
    recordPromptDedupSkip(WT, 'claude', 'claude-2', 7_000);
    isRunning.mockResolvedValue(false);

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude', 'claude-2');

    expect(payload.isRunning).toBe(false);
    expect(payload.model).toBeNull();
    expect(payload.promptDedup).toEqual({ skippedCount: 1, lastSkippedAt: 7_000 });
  });
});
