/**
 * Issue #3757 (P2): Auto-Yes did not answer agy's trust screen, and the prompt
 * Push kept saying it was about to.
 *
 * Where it fell out, measured below on the live trust screen: the poller's
 * prompt reading (`detectPromptOnCleanFrame`). The screen is unnumbered, so
 * agy's dialog reader declines it and so does the generic parser — the tick
 * returns `no_prompt` and never reaches the dialog gate or the Enter fallback.
 * Nothing was recorded, and `decidePromptPush` read "nothing recorded" as
 * `auto-yes-answering` for as long as the wait lasted.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: unknown) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params),
}));
const sendSpecialKeys = vi.fn(async (_s: string, _k: string[]) => {});
vi.mock('@/lib/tmux/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux')>()),
  sendSpecialKeys: (s: string, k: string[]) => sendSpecialKeys(s, k),
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  captureSessionOutputFresh: vi.fn(),
  getSessionPresence: vi.fn(),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: (id: string) => `cm-${id}-antigravity`, name: 'Antigravity' }),
    }),
  },
}));

const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: logWarn,
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
}));

import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { resetAntigravityPermissionReceiptsForTests } from '@/lib/polling/antigravity-permission-receipts';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearAllAutoYesStates, setAutoYesEnabled } from '@/lib/auto-yes-state';
import { AUTO_YES_ANSWER_GRACE_MS, decidePromptPush } from '@/lib/push/prompt-push-gate';
import {
  beginStartupWindow,
  clearStartupTrust,
  endStartupWindow,
  markStartupTrustPending,
} from '@/lib/cli-tools/antigravity-startup-trust';

const WT = 'wt-3757';
/** What the mocked CLIToolManager names this worktree's agy session. */
const SESSION = `cm-${WT}-antigravity`;
const LIVE_2364 = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');
const frame = (name: string): string => readFileSync(path.join(LIVE_2364, `${name}.txt`), 'utf8');

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    consecutiveErrors: 0,
    currentInterval: 2000,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One tick of the real poller over a fixture, raw capture included, as `pollAutoYes` passes it. */
function tick(name: string, state: AutoYesPollerState = pollerState()) {
  const raw = frame(name);
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, 'antigravity', clean, clean.split('\n'), 'antigravity', raw);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
  clearAllAutoYesStates();
  clearStartupTrust();
});

afterEach(() => {
  clearStartupTrust();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAllAutoYesStates();
  db.close();
});

describe('where the trust screen fell out of the poller', () => {
  it('the prompt reading the poller makes reads no prompt on it (so no dialog gate, no Enter fallback)', () => {
    const raw = frame('trust-dialog');
    const clean = stripBoxDrawing(stripAnsi(raw));
    const reading = detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw, {
      worktreeId: WT,
      instanceId: 'antigravity',
    });
    expect(reading.isPrompt).toBe(false);
    // Ungated (the status / Push producers' reading) it is no prompt either.
    expect(detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw).isPrompt).toBe(false);
  });
});

describe('the poller records why it left the trust screen alone', () => {
  it('positive: records `startup-trust-unhandled`, sends nothing', async () => {
    setAutoYesEnabled(WT, 'antigravity', true);
    expect(await tick('trust-dialog')).toBe('no_prompt');

    expect(getLastPolicySuppression(WT, 'antigravity', 'antigravity')).toMatchObject({
      reason: 'startup-trust-unhandled',
      mode: null,
    });
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('the push gate then notifies at once instead of holding it as `auto-yes-answering`', async () => {
    setAutoYesEnabled(WT, 'antigravity', true);
    const since = Date.now() - 1;
    await tick('trust-dialog');

    expect(
      decidePromptPush({ worktreeId: WT, cliToolId: 'antigravity', instanceId: 'antigravity', waitingSince: since }),
    ).toMatchObject({ suppress: false, reason: 'policy-withheld', suppressedBy: 'startup-trust-unhandled' });
  });

  it('warns once per screen, not once per tick', async () => {
    const state = pollerState();
    await tick('trust-dialog', state);
    await tick('trust-dialog', state);
    await tick('trust-dialog', state);
    expect(logWarn.mock.calls.filter(([e]) => e === 'poller:auto-yes-skipped-startup-trust')).toHaveLength(1);
  });

  it('negative: inside the launch window the screen is the launch\'s, and nothing is recorded', async () => {
    setAutoYesEnabled(WT, 'antigravity', true);
    beginStartupWindow(SESSION);
    expect(await tick('trust-dialog')).toBe('no_prompt');
    expect(getLastPolicySuppression(WT, 'antigravity', 'antigravity')).toBeNull();
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(sendPromptAnswer).not.toHaveBeenCalled();

    // The window confirmed it and closed: a later idle pane records nothing either,
    // so the wait it opened stays explained only by the hold (silent, as before).
    endStartupWindow(SESSION);
    await tick('boot-idle');
    expect(getLastPolicySuppression(WT, 'antigravity', 'antigravity')).toBeNull();
  });

  it('positive: once the window has ended (the Enter owed), the screen is recorded', async () => {
    beginStartupWindow(SESSION);
    markStartupTrustPending(SESSION);
    endStartupWindow(SESSION);
    await tick('trust-dialog');
    expect(getLastPolicySuppression(WT, 'antigravity', 'antigravity')?.reason).toBe('startup-trust-unhandled');
  });

  it('negative: an idle pane records nothing', async () => {
    expect(await tick('boot-idle')).toBe('no_prompt');
    expect(getLastPolicySuppression(WT, 'antigravity', 'antigravity')).toBeNull();
  });

  it('negative: the trust question quoted above a live input box is not the screen', async () => {
    // The dismissed screen left in the scrollback, then agy's idle box under it.
    const state = pollerState();
    const raw = `${frame('trust-dialog')}\n${'\n'.repeat(20)}${frame('boot-idle')}`;
    const clean = stripBoxDrawing(stripAnsi(raw));
    await detectAndRespondToPrompt(WT, state, 'antigravity', clean, clean.split('\n'), 'antigravity', raw);
    expect(getLastPolicySuppression(WT, 'antigravity', 'antigravity')).toBeNull();
  });
});

describe('the push gate holds "Auto-Yes is answering" for a few ticks only', () => {
  const since = 1_800_000_000_000;
  // Counted from where the hold began, not from `since` (review of #3757).
  const heldAt = since + 5_500;
  const input = (now: number) => ({
    worktreeId: WT,
    cliToolId: 'claude' as const,
    waitingSince: since,
    now,
    holdStartedAt: heldAt,
  });

  it('holds inside the grace', () => {
    setAutoYesEnabled(WT, 'claude', true);
    expect(decidePromptPush(input(heldAt))).toEqual({ suppress: true, reason: 'auto-yes-answering' });
    expect(decidePromptPush(input(heldAt + AUTO_YES_ANSWER_GRACE_MS - 1)).suppress).toBe(true);
  });

  it('negative: without an origin the hold has no end (the pre-#3757 reading)', () => {
    setAutoYesEnabled(WT, 'claude', true);
    const { holdStartedAt: _unused, ...noOrigin } = input(since + 60 * 60_000);
    expect(decidePromptPush(noOrigin).suppress).toBe(true);
  });

  it('positive: notifies a wait nothing has explained once the grace is over', () => {
    setAutoYesEnabled(WT, 'claude', true);
    expect(decidePromptPush(input(heldAt + AUTO_YES_ANSWER_GRACE_MS))).toEqual({
      suppress: false,
      reason: 'auto-yes-not-answered',
    });
  });

  it('negative: Auto-Yes off notifies as before, whatever the age', () => {
    expect(decidePromptPush(input(since)).reason).toBe('auto-yes-inactive');
  });
});
