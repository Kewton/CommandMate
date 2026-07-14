/** @vitest-environment node */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-1:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';

describe('buildCurrentOutput Issue #1167 frame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
  });

  it('surfaces prompt data and never exposes the unclassified fallback', async () => {
    const payload = await buildCurrentOutput(
      {} as Database.Database,
      'wt-1',
      'claude',
      'claude-2',
    );

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.promptData?.type).toBe('multiple_choice');
    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe('prompt_detected');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});
