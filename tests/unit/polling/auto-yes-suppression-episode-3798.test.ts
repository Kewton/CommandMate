/**
 * Issue #3798 (PR 3): a policy-suppression record names the waiting episode it
 * was written for, and `current-output` publishes it next to the episode open
 * now (`docs/design/issue-3798-waiting-episode.md` §6.4).
 *
 * The writer stamps the episode open at the moment it writes — unless the
 * caller carries one over from an earlier record of the same dialog (the agy
 * receipt log's re-stamp) — and stamps nothing while no wait is open, so the
 * readers (the push gate, `cmate wait`) fall back to the record's time.
 *
 * `current-output` mocks as in `tests/unit/session/current-output-auto-yes-decision-3821.test.ts`.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => ({ enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER })),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-3798-sup:claude'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
  recordPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import {
  clearWaitingEpisodes,
  closeEpisode,
  openEpisode,
} from '@/lib/session/waiting-episode-state';
import { autoYesPollerStates } from '@/lib/polling/auto-yes-poller-generation';
import type { AutoYesPollerState } from '@/lib/polling/auto-yes-poller-state';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

const WT = 'wt-3798-sup';
const PARTS = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude' };
const WITHHELD = { reason: 'deny-pattern' as const, mode: 'allow-listed' as const, promptType: 'yes_no' as const };

function openWait() {
  const at = Date.now();
  return openEpisode(
    PARTS,
    {
      since: at,
      kind: 'prompt',
      binding: { kind: 'unattributed', generation: { kind: 'none' }, lastClosedTurnId: null },
      openedBy: 'response-checker',
    },
    at,
  );
}

beforeEach(() => {
  clearPolicySuppressions();
  clearWaitingEpisodes();
  vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());
});

afterEach(() => {
  clearPolicySuppressions();
  clearWaitingEpisodes();
});

describe('[#3798] recordPolicySuppression names the wait', () => {
  it('stamps the episode open when it writes', () => {
    const wait = openWait();
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    expect(getLastPolicySuppression(WT, 'claude', 'claude')).toMatchObject({ ...WITHHELD, episodeId: wait.episodeId });
  });

  it('negative: no wait open, no id (the readers fall back to the time)', () => {
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    expect(getLastPolicySuppression(WT, 'claude', 'claude')).not.toHaveProperty('episodeId');
  });

  it('an id the caller carries over is kept over the wait open now', () => {
    const first = openWait();
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    const carried = getLastPolicySuppression(WT, 'claude', 'claude')!;
    closeEpisode(PARTS, first.episodeId, 'screen-cleared', Date.now());
    const second = openWait();

    const { at: _at, ...again } = carried;
    recordPolicySuppression(WT, 'claude', 'claude', again);
    expect(getLastPolicySuppression(WT, 'claude', 'claude')?.episodeId).toBe(first.episodeId);
    // Control: a fresh write names the wait open now.
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    expect(getLastPolicySuppression(WT, 'claude', 'claude')?.episodeId).toBe(second.episodeId);
  });
});

describe('[#3798] current-output publishes the wait next to the record', () => {
  it('autoYes.waitingEpisodeId is the episode open now; lastSuppression.episodeId the one it was written for', async () => {
    const first = openWait();
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD);
    closeEpisode(PARTS, first.episodeId, 'screen-cleared', Date.now());
    const second = openWait();

    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.waitingEpisodeId).toBe(second.episodeId);
    expect(payload.autoYes?.lastSuppression?.episodeId).toBe(first.episodeId);
  });

  it('no wait open: null', async () => {
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.waitingEpisodeId).toBeNull();
  });
});

describe('[#3798] current-output says whether Auto-Yes answered the wait after the record (review N3)', () => {
  const KEY = 'wt-3798-sup:claude';
  const T = 1_800_000_000_000;

  function answered(episodeId: string, at: number): void {
    autoYesPollerStates.set(KEY, { lastAnswer: { episodeId, screenKey: 'k', at } } as unknown as AutoYesPollerState);
  }

  afterEach(() => {
    autoYesPollerStates.delete(KEY);
  });

  it('positive: the record of the open wait, written before the answer to it — lastSuppressionAnswered', async () => {
    const wait = openWait();
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD, T);
    answered(wait.episodeId, T + 1);
    const payload = await buildCurrentOutput({} as Database.Database, WT, 'claude');
    expect(payload.autoYes?.lastSuppressionAnswered).toBe(true);
    // The record itself is still published, as history.
    expect(payload.autoYes?.lastSuppression).toMatchObject({ episodeId: wait.episodeId, at: T });
  });

  it('negative: no answer, an answer at or before the record, or to another wait — false', async () => {
    const wait = openWait();
    recordPolicySuppression(WT, 'claude', 'claude', WITHHELD, T);
    const read = async () => (await buildCurrentOutput({} as Database.Database, WT, 'claude')).autoYes?.lastSuppressionAnswered;
    expect(await read()).toBe(false);
    answered(wait.episodeId, T);
    expect(await read()).toBe(false);
    answered(wait.episodeId, T - 1);
    expect(await read()).toBe(false);
    answered('another-episode', T + 1);
    expect(await read()).toBe(false);
  });

  it('negative: no record — false', async () => {
    const wait = openWait();
    answered(wait.episodeId, T + 1);
    expect((await buildCurrentOutput({} as Database.Database, WT, 'claude')).autoYes?.lastSuppressionAnswered).toBe(false);
  });
});
