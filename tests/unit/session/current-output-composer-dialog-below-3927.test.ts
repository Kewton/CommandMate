/** @vitest-environment node */

/**
 * Issue #3927: the published `composerText` drops a codex composer that a
 * dialog has opened below.
 *
 * `capture --json`, the HTTP poll and the WebSocket snapshot all read
 * `buildCurrentOutput`. Before the fix it published the old composer's text as
 * `content` on this frame, while the clear (#3906) answered `no_composer` on it
 * — a bar whose [Clear] does nothing and whose [Run] Enter lands in the
 * dialog. Mocks as in `tests/unit/lib/current-output-composer-1879.test.ts`.
 */

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
import {
  CODEX_DIALOG_BELOW_FRAME,
  CODEX_LIVE_COMPOSER_FRAME,
  OLD_COMPOSER_TEXT,
} from '@tests/fixtures/codex-dialog-below-3927';

const capture = (tool: 'claude' | 'codex' | 'gemini') => buildCurrentOutput({} as Database.Database, 'wt-3927', tool);

describe('Issue #3927: the published composer of a codex frame with a dialog below it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isRunning.mockResolvedValue(true);
  });

  it('positive: publishes no composer text (was the old composer as content)', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_DIALOG_BELOW_FRAME);

    const payload = await capture('codex');

    expect(payload.composerText).toBeNull();
    expect(payload.composerState).toBe('no_composer');
  });

  it('negative: the same rows as the live composer are published as before', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_LIVE_COMPOSER_FRAME);

    const payload = await capture('codex');

    expect(payload.composerText).toBe(OLD_COMPOSER_TEXT);
    expect(payload.composerState).toBe('content');
  });

  it('negative: a tool outside the measured set stays unsupported_tool', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(CODEX_DIALOG_BELOW_FRAME);

    const payload = await capture('gemini');

    expect(payload.composerText).toBeNull();
    expect(payload.composerState).toBe('unsupported_tool');
  });
});
