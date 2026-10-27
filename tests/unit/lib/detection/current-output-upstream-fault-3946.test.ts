/** @vitest-environment node */

/**
 * Issue #3946: on codex 0.160's split screen the capture payload publishes the
 * capacity row from the transcript's last row, through `buildCurrentOutput` —
 * the same entry (`matchPaneUpstreamFault`) the push poller calls. The frames
 * are SYNTHETIC (tests/fixtures/upstream-faults/README.md).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: { getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning }) }) },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => null),
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => false),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { buildRealtimeSnippet } from '@/lib/realtime-snippet';

const FIXTURES = join(__dirname, '../../../fixtures/upstream-faults');
const CAPACITY_FRAME = readFileSync(join(FIXTURES, 'codex-0.160.0-model-capacity-3946.txt'), 'utf8');
const NEXT_TURN_FRAME = readFileSync(join(FIXTURES, 'codex-0.160.0-model-capacity-next-turn-3946.txt'), 'utf8');

const capture = () => buildCurrentOutput({} as Database.Database, 'wt-3946', 'codex');

describe('capture payload on codex 0.160 split screen (Issue #3946)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRunning.mockResolvedValue(true);
  });

  it('publishes model-capacity from the row above the window; realtimeSnippet is unchanged', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(CAPACITY_FRAME);
    const payload = await capture();

    expect(payload.upstreamFault?.id).toBe('model-capacity');
    expect(payload.upstreamFault?.matchedText).toBe('■ Selected model is at capacity. Please try a different model.');
    expect(payload.realtimeSnippet).toBe(buildRealtimeSnippet(CAPACITY_FRAME));
    expect(payload.realtimeSnippet).not.toContain('Selected model is at capacity');
  });

  it('past turn: a healthy next turn publishes null', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(NEXT_TURN_FRAME);
    const payload = await capture();

    expect(payload.upstreamFault).toBeNull();
  });
});
