/**
 * `autoYesDecision` on `current-output` (Issue #3821): the decision is about
 * the prompt the SAME response publishes, read off the poller's record by that
 * prompt's screen key, under the grant and the poller the route reads now.
 * `autoYes.lastEnterFallback` stays on the wire, as null.
 *
 * Mocks as in `tests/unit/cli/types/enter-fallback-mirror-3397.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const manager = vi.hoisted(() => ({
  grant: null as AutoYesState | null,
  pollerActive: true,
}));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => manager.grant),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => manager.pollerActive),
  buildCompositeKey: vi.fn(() => 'wt-3821:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { clearAutoYesDecisions, recordAutoYesDecision } from '@/lib/polling/auto-yes-decision-state';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';
import type { PromptData } from '@/types/models';

const WT = 'wt-3821';
const KEY = 'wt-3821:claude';
const GRANT: AutoYesState = { enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };

function promptOnFrame(): PromptData {
  const promptData = detectSessionStatus(buildClaude1000RowPermissionFrame(), 'claude').promptDetection.promptData;
  if (!promptData) throw new Error('the fixture frame carries no prompt');
  return promptData;
}

const build = () => buildCurrentOutput({} as Database.Database, WT, 'claude');

beforeEach(() => {
  vi.clearAllMocks();
  clearAutoYesDecisions();
  manager.grant = null;
  manager.pollerActive = true;
  vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
});

afterEach(() => clearAutoYesDecisions());

describe('[#3821] current-output autoYesDecision', () => {
  it('Auto-Yes off: none', async () => {
    const payload = await build();
    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.autoYesDecision).toMatchObject({ state: 'none', reason: null });
  });

  it('Auto-Yes on, the prompt not judged yet: none (not answering)', async () => {
    manager.grant = GRANT;
    expect((await build()).autoYesDecision?.state).toBe('none');
  });

  it('the poller’s decision about this prompt: published with it', async () => {
    manager.grant = GRANT;
    recordAutoYesDecision(KEY, { state: 'answering', reason: null, promptData: promptOnFrame(), grant: GRANT, epoch: 0 });
    expect((await build()).autoYesDecision?.state).toBe('answering');

    recordAutoYesDecision(KEY, { state: 'withheld', reason: 'deny-pattern', promptData: promptOnFrame(), grant: GRANT, epoch: 0 });
    expect((await build()).autoYesDecision).toMatchObject({ state: 'withheld', reason: 'deny-pattern' });
  });

  it('a decision about another prompt: none', async () => {
    manager.grant = GRANT;
    recordAutoYesDecision(KEY, {
      state: 'answering',
      reason: null,
      promptData: { type: 'yes_no', question: 'Something else?', options: ['yes', 'no'], status: 'pending' },
      grant: GRANT,
      epoch: 0,
    });
    expect((await build()).autoYesDecision?.state).toBe('none');
  });

  it('T3: Auto-Yes on with no poller for the instance: withheld (server-poller-inactive)', async () => {
    manager.grant = GRANT;
    manager.pollerActive = false;
    recordAutoYesDecision(KEY, { state: 'answering', reason: null, promptData: promptOnFrame(), grant: GRANT, epoch: 0 });
    expect((await build()).autoYesDecision).toMatchObject({ state: 'withheld', reason: 'server-poller-inactive' });
  });

  it('observedAt is when the payload was built', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_234_567);
      expect((await build()).autoYesDecision?.observedAt).toBe(1_234_567);
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoYes.lastEnterFallback: the key stays, as null', async () => {
    manager.grant = GRANT;
    const wire = JSON.parse(JSON.stringify(await build())) as { autoYes: Record<string, unknown> };
    expect(wire.autoYes).toHaveProperty('lastEnterFallback', null);
  });
});
