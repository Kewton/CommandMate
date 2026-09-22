/**
 * Both JSON surfaces answer the same effort for a codex session at `max`
 * (Issue #2835).
 *
 * The Issue's report, end to end: the status poll captures the pane, extracts,
 * latches (`detectWorktreeSessionStatus` — what `commandmate ls --json` reads as
 * `sessionStatusByInstance`), and `buildCurrentOutput` reads the same latch
 * (what `commandmate instances --json` forwards as `reasoningEffort`). Before
 * the fix the first omitted the key and the second said null.
 *
 * `captureSessionOutput` is mocked; the frame is the recorded 0.147 capture
 * re-pointed at `gpt-5.6-terra max` (asserted, so it cannot silently no-op).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';

vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: vi.fn(),
}));

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
        isRunning: vi.fn().mockResolvedValue(true),
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return {
    ...original,
    get CLI_TOOL_IDS() {
      return ['codex'] as readonly CLIToolType[];
    },
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/cli-tools/session-liveness', () => ({
  probeToolSessionLiveness: vi.fn().mockResolvedValue({ alive: true }),
}));

vi.mock('@/lib/cli-tools/opencode', () => ({ OPENCODE_PANE_HEIGHT: 200 }));
vi.mock('@/lib/cli-tools/gemini', () => ({ GEMINI_PANE_HEIGHT: 200 }));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`
  ),
}));

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { CODEX_FOOTER_CAPTURE_V0_147_ANSI } from '../../fixtures/model-info-captures';

const WT = 'wt-2835-surfaces';
const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;

function terraAt(effort: string): string {
  const replaced = CODEX_FOOTER_CAPTURE_V0_147_ANSI.split('gpt-5.6-sol xhigh').join(`gpt-5.6-terra ${effort}`);
  expect(replaced).not.toBe(CODEX_FOOTER_CAPTURE_V0_147_ANSI);
  return replaced;
}

/** One status poll — the `ls` side — with the pane showing `capture`. */
async function poll(capture: string) {
  vi.mocked(captureSessionOutput).mockResolvedValue(capture);
  return detectWorktreeSessionStatus(
    WT,
    new Set([`codex-${WT}`]),
    mockDb,
    vi.fn().mockReturnValue([]),
    vi.fn(),
    vi.fn(() => [] as AgentInstance[])
  );
}

/** The `instances` side: the current-output payload for the same instance. */
async function currentOutput() {
  return buildCurrentOutput({} as Database.Database, WT, 'codex', 'codex');
}

beforeEach(() => {
  clearAgentStopEvents();
  vi.mocked(captureSessionOutput).mockClear();
});
afterEach(() => {
  clearAgentStopEvents();
});

describe('[#2835] ls and instances agree on the codex effort', () => {
  it('both publish `max` for a session the bar shows at max', async () => {
    const result = await poll(terraAt('max'));
    expect(result.sessionStatusByInstance.codex).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'max',
    });

    const payload = await currentOutput();
    expect(payload.model).toBe('gpt-5.6-terra');
    expect(payload.reasoningEffort).toBe('max');
  });

  it('neither keeps xhigh after the bar moves to an effort it cannot name', async () => {
    await poll(terraAt('xhigh'));
    expect((await currentOutput()).reasoningEffort).toBe('xhigh');

    const result = await poll(terraAt('turbo'));
    expect(result.sessionStatusByInstance.codex?.model).toBe('gpt-5.6-terra');
    expect(result.sessionStatusByInstance.codex).not.toHaveProperty('reasoningEffort');
    expect((await currentOutput()).reasoningEffort).toBeNull();
  });
});
