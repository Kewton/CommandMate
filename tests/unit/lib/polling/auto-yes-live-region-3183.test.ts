/**
 * Auto-Yes reads the live region the status chain reads (Issue #3183).
 *
 * Three things, each through the real poller entry `detectAndRespondToPrompt`
 * with only the transport stubbed at both ends:
 *
 *  1. **One frame.** The poller normalises the tick's capture ONCE, from the
 *     raw spelling, and the very same object reaches the dialog gate — so the
 *     prompt reading and the gate cannot locate two different live regions.
 *  2. **The 14 frames** of `tests/unit/detection/tools/live-region-quoted-dialog.test.ts`:
 *     a real dialog is answered (opencode v1's `keys` strip is vouched for and
 *     still not typed into — design doc §6 item 1), the quotation is not.
 *  3. **The declaration is load-bearing on both sides at once.** Swap
 *     antigravity's composer marker for one that finds nothing and the quoted
 *     dialog flips to `waiting` on the status side AND to answered on the
 *     Auto-Yes side; put it back and both flip back. A rule only one of the two
 *     read would make the pair disagree.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn(async () => '') }));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (id: string) => ({
        name: id,
        getSessionName: (worktreeId: string, instanceId?: string) => `cm-${worktreeId}-${instanceId ?? id}`,
      }),
    }),
  },
}));
vi.mock('@/lib/logger', () => {
  const logger = (): Record<string, unknown> => {
    const self: Record<string, unknown> = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    self.withContext = () => self;
    return self;
  };
  return { createLogger: logger };
});

// Pass-through spies: the real functions run, and the calls are recorded.
vi.mock('@/lib/detection/tools/frame', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/detection/tools/frame')>();
  return { ...actual, normalizeFrame: vi.fn(actual.normalizeFrame) };
});
vi.mock('@/lib/polling/auto-yes-dialog-gate', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-dialog-gate')>();
  return { ...actual, evaluateAutoYesDialogGate: vi.fn(actual.evaluateAutoYesDialogGate) };
});

import { detectAndRespondToPrompt, clearAllPollerStates, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import { evaluateAutoYesDialogGate } from '@/lib/polling/auto-yes-dialog-gate';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { LIVE_REGION_SPECS } from '@/lib/detection/tools/live-region-specs';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { LiveRegionSpec } from '@/lib/detection/tools/types';

const WT = 'wt-3183-live-region';
const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** The 14 frames, the same list the status-side test reads (design doc §4.2). */
/**
 * What Auto-Yes does with the real dialog:
 *  - `responded` — the poller types the answer;
 *  - `vouched-keys` — the gate vouches for the dialog and refuses to type,
 *    because it is driven by ←/→ + Enter (opencode v1, design doc §6 item 1);
 *  - `vouched-numbered` — the gate vouches for a numbered dialog and would let
 *    the answer through, but the screen path has nothing to answer: opencode-v2
 *    answers its questions through the agent's own API (#2945), and the generic
 *    parser does not read the gutter-drawn form.
 */
type AutoYesOutcome = 'responded' | 'vouched-keys' | 'vouched-numbered';

const PAIRS: ReadonlyArray<{ tool: CLIToolType; positive: string; negative: string; autoYes: AutoYesOutcome }> = [
  {
    tool: 'claude',
    positive: 'tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt',
    negative: 'tests/fixtures/claude-idle-numbered-list-2457/live-2997/claude-reply-numbered-list-21284.txt',
    autoYes: 'responded',
  },
  {
    tool: 'codex',
    positive: 'tests/fixtures/codex-dialogs-0157/approval.txt',
    negative: 'tests/fixtures/codex-dialogs-0157/quoted-approval-idle.txt',
    autoYes: 'responded',
  },
  {
    tool: 'antigravity',
    positive: 'tests/fixtures/antigravity-live-2364/dialog-bash-oneline.txt',
    negative: 'tests/fixtures/live-region-3183/quoted-dialog-idle-antigravity.txt',
    autoYes: 'responded',
  },
  {
    tool: 'command-code',
    positive: 'tests/fixtures/command-code-live-2250/dialog-shell-command.txt',
    negative: 'tests/fixtures/live-region-3183/quoted-dialog-idle-command-code.txt',
    autoYes: 'responded',
  },
  {
    tool: 'copilot',
    positive: 'tests/unit/lib/detection/fixtures/copilot-live-1885/permission-dialog.txt',
    negative: 'tests/fixtures/live-region-3183/quoted-dialog-idle-copilot.txt',
    autoYes: 'responded',
  },
  {
    tool: 'opencode',
    positive: 'tests/unit/lib/detection/fixtures/opencode-live-1893/permission-bash.txt',
    negative: 'tests/fixtures/opencode-agent-health-3021/quoted-dialog-reply-done.txt',
    // Every opencode v1 dialog takes ←/→ + Enter: a typed digit would approve
    // whatever is highlighted (#1893). Vouched for, never typed into.
    autoYes: 'vouched-keys',
  },
  {
    tool: 'opencode-v2',
    positive: 'tests/fixtures/opencode-v2-dialogs-2984/question.txt',
    negative: 'tests/fixtures/opencode-v2-dialogs-2984/quoted-dialog-reply.txt',
    autoYes: 'vouched-numbered',
  },
];

function pollerState(tool: CLIToolType): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: tool,
    instanceId: tool,
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One poller tick over `raw`, exactly as `pollAutoYes` hands it over. */
async function tick(tool: CLIToolType, raw: string): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, pollerState(tool), tool, clean, clean.split('\n'), undefined, raw);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'live-region-3183',
    path: '/tmp/live-region-3183',
    branch: 'feature/3183',
    repositoryPath: '/tmp/live-region-3183-repo',
    repositoryName: 'live-region-3183-repo',
    cliToolId: 'claude',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  resetAntigravityPermissionReceiptsForTests();
  // agy dialogs are answered only after agy asked CommandMate about the call (#2849).
  recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command', Date.now());
  sendPromptAnswer.mockClear();
  vi.mocked(normalizeFrame).mockClear();
  vi.mocked(evaluateAutoYesDialogGate).mockClear();
});

afterEach(() => {
  db.close();
});

describe('[#3183] the poller normalises once, and the gate reads that frame', () => {
  it('normalizeFrame runs once per tick, on the RAW capture, and its result is what the gate is handed', async () => {
    const raw = read(PAIRS[0].positive);
    expect(await tick('claude', raw)).toBe('responded');

    const normalize = vi.mocked(normalizeFrame);
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(normalize.mock.calls[0]).toEqual([raw, 'claude']);

    const gate = vi.mocked(evaluateAutoYesDialogGate);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate.mock.calls[0][2]).toBe(normalize.mock.results[0].value);
  });

  it('the region the gate saw is the one the status chain locates for the same capture', async () => {
    const raw = read(PAIRS[1].negative);
    await tick('codex', raw);
    const polled = vi.mocked(normalizeFrame).mock.results[0].value;
    const status = normalizeFrame(raw, 'codex');
    expect(polled.liveRegion).toEqual(status.liveRegion);
    expect(polled.liveRegion.composerAtBottom).toBe(true);
  });
});

describe('[#3183] seven tools: the real dialog is answered, its quotation is not', () => {
  it.each(PAIRS)('$tool: positive', async ({ tool, positive, autoYes }) => {
    const result = await tick(tool, read(positive));
    if (autoYes === 'responded') {
      expect(result).toBe('responded');
      expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
      return;
    }
    expect(result).not.toBe('responded');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    const verdict = evaluateAutoYesDialogGate(tool, 'multiple_choice', normalizeFrame(read(positive), tool));
    expect(verdict.gated).toBe(true);
    if (autoYes === 'vouched-keys') {
      expect(verdict.dialog?.kind).toBe('permission');
      expect(verdict.dialog?.answerMode).toBe('keys');
      expect(verdict.allowed).toBe(false);
    } else {
      expect(verdict.dialog?.kind).toBe('question');
      expect(verdict.dialog?.answerMode).toBe('numbered');
      expect(verdict.allowed).toBe(true);
    }
  });

  it.each(PAIRS)('$tool: the gate does not vouch for the negative', ({ tool, negative }) => {
    const verdict = evaluateAutoYesDialogGate(tool, 'multiple_choice', normalizeFrame(read(negative), tool));
    expect(verdict.dialog).toBeNull();
  });

  it.each(PAIRS)('$tool: negative', async ({ tool, negative }) => {
    const result = await tick(tool, read(negative));
    expect(result).not.toBe('responded');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });
});

describe('[#3183] mutation: one declaration moves the status chain and Auto-Yes together', () => {
  const pair = PAIRS.find(p => p.tool === 'antigravity')!;
  const specs = LIVE_REGION_SPECS as Partial<Record<CLIToolType, LiveRegionSpec>>;
  const original = specs.antigravity!;

  afterEach(() => {
    specs.antigravity = original;
  });

  it('as declared: ready, and not answered', async () => {
    expect(detectSessionStatus(read(pair.negative), 'antigravity').status).toBe('ready');
    expect(await tick('antigravity', read(pair.negative))).not.toBe('responded');
  });

  it('with a composer marker that finds nothing: waiting, and answered', async () => {
    specs.antigravity = { ...original, composer: { locate: () => null } };
    const status = detectSessionStatus(read(pair.negative), 'antigravity');
    expect(status.status).toBe('waiting');
    expect(status.hasActivePrompt).toBe(true);
    expect(await tick('antigravity', read(pair.negative))).toBe('responded');
  });
});
