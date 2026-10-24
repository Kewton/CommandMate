/**
 * Issue #3863: `current-output` publishes the answer mode of the Auto-Yes grant
 * it reads (`autoYesAnswerMode`), beside `autoYes`, while Auto-Yes is on — a
 * grant kept from before the field reads as `recommended`. Off, the key is
 * absent. Mocks as in `current-output-auto-yes-decision-3821.test.ts`.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AutoYesState } from '@/lib/auto-yes-state';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

const manager = vi.hoisted(() => ({ grant: null as AutoYesState | null }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => manager.grant),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-3863:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

const build = () => buildCurrentOutput({} as Database.Database, 'wt-3863', 'claude');
const LIVE: AutoYesState = { enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };

beforeEach(() => {
  vi.clearAllMocks();
  manager.grant = null;
  vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
});

describe('[#3863] current-output autoYesAnswerMode', () => {
  it('the grant’s mode while Auto-Yes is on', async () => {
    manager.grant = { ...LIVE, answerMode: 'careful' };
    expect((await build()).autoYesAnswerMode).toBe('careful');
  });

  it('a grant kept from before the field: recommended', async () => {
    manager.grant = LIVE;
    expect((await build()).autoYesAnswerMode).toBe('recommended');
  });

  it('negative: off (no grant, or a disabled one) — the key is absent', async () => {
    expect(await build()).not.toHaveProperty('autoYesAnswerMode');
    manager.grant = { ...LIVE, enabled: false, answerMode: 'careful' };
    expect(await build()).not.toHaveProperty('autoYesAnswerMode');
  });
});
