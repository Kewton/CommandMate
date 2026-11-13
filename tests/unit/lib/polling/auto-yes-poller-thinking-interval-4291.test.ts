/**
 * Issue #4291 (reinstruct 1): the poller's thinking check, end to end from the
 * capture's preprocessing (`capturePollerFrame`: ANSI and box drawing stripped) to
 * the timer the next poll is scheduled with. opencode's position rule needs the
 * box drawing the cleaned frame has lost, so the poller hands it the raw capture
 * with only ANSI stripped.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/tmux/tmux', () => ({ sendKeys: vi.fn(), sendSpecialKeys: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ getSessionName: (id: string) => `x-${id}`, name: 'x' }) }),
  },
}));
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => ({ prepare: () => ({ get: () => undefined }) }),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import {
  clearAllAutoYesStates,
  clearAllPollerStates,
  setAutoYesEnabled,
  startAutoYesPolling,
  stopAllAutoYesPolling,
  POLLING_INTERVAL_MS,
} from '@/lib/polling/auto-yes-manager';
import { THINKING_POLLING_INTERVAL_MS } from '@/config/auto-yes-config';

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Measured open turn: previous turn's `▣ … 16.3s` row (line 184) above the new echo, `⠦ Thinking:` row (line 190). */
const OPEN_TURN = read('../detection/fixtures/opencode-live-1894/esc-again-after-marker.txt');
/** Finished turn whose footer cwd was rewritten to hold `Thinking:` (#4231). */
const DONE_CWD_THINKING = read('../../../fixtures/opencode-live-4231/turn-done-cwd-thinking.txt');

/** The delay the poller scheduled its next poll with after one tick on `capture`. */
async function nextDelayAfterOneTick(cliToolId: 'opencode' | 'claude', capture: string): Promise<number | undefined> {
  const wt = `wt-4291-${cliToolId}`;
  vi.mocked(captureSessionOutput).mockResolvedValue(capture);
  setAutoYesEnabled(wt, cliToolId, true, 3600000);
  startAutoYesPolling(wt, cliToolId);
  const spy = vi.spyOn(globalThis, 'setTimeout');
  await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);
  const pollerDelays = spy.mock.calls
    .map((c) => c[1])
    .filter((d): d is number => typeof d === 'number' && (d === POLLING_INTERVAL_MS || d === THINKING_POLLING_INTERVAL_MS));
  return pollerDelays[0];
}

describe('poller picks the thinking interval from the capture (#4291)', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
    clearAllPollerStates();
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
  });
  afterEach(() => {
    stopAllAutoYesPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('positive: the measured open turn (old ▣ row above, Thinking row below the new echo) polls at the thinking interval', async () => {
    expect(await nextDelayAfterOneTick('opencode', OPEN_TURN)).toBe(THINKING_POLLING_INTERVAL_MS);
  });

  it('negative: a footer cwd holding "Thinking:" polls at the normal interval', async () => {
    expect(await nextDelayAfterOneTick('opencode', DONE_CWD_THINKING)).toBe(POLLING_INTERVAL_MS);
  });

  it('other tools are unchanged: claude still reads the word in the cleaned rows', async () => {
    expect(await nextDelayAfterOneTick('claude', 'Some output\n✻ Thinking… (3s · esc to interrupt)\n')).toBe(
      THINKING_POLLING_INTERVAL_MS
    );
  });

  it('other tools are unchanged: claude without the word polls at the normal interval', async () => {
    expect(await nextDelayAfterOneTick('claude', 'Some output\nplain\n')).toBe(POLLING_INTERVAL_MS);
  });
});
