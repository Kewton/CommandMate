/**
 * Issue #3881 acceptance (1) (2) (4): one live frame, read once, through every
 * path — frame → Claude's own reader → the generic representation → the saved
 * row → `toToolApprovalEntry` — and the Auto-Yes poller on the same frame.
 *
 * The frame is `tests/fixtures/claude-confirm-live-3791/tab-row-wrapped-16x1000.txt`,
 * a verbatim claude-cli 2.1.310 capture of the `Ready to submit your answers?`
 * page at 16 columns. Option 1 wraps (`❯ 1. Submit` / `     answers`), so the
 * generic parser stores the option as `Submit`, and the `● …` review list is
 * above the rows the stored question keeps. Before #3881 the chat transcript
 * re-classified the row from those strings and drew it as a tool approval,
 * while the poller left the very same page to a human as
 * `question-confirm-page`.
 *
 * 陽性対照: the row saved the pre-#3881 way (the detection's `promptData`, no
 * reading) is still read as an approval — the defect, reproduced on the fixture
 * — and the lookalike AskUserQuestion is still read as a confirmation by the
 * compatibility rules. 陰性対照: a live Bash approval whose command prints the
 * page's rows is a permission everywhere, answered `1` as before.
 *
 * Saved through a real SQLite file under `os.tmpdir()` (removed after each
 * test), so the reading crosses the same JSON column a running server uses.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { ChatMessage, PromptData } from '@/types/models';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) =>
    sendPromptAnswer(params as { answer: string; promptData?: PromptData }),
}));
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        name: cliToolId,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? cliToolId}`,
      }),
    }),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  detectAndRespondToPrompt,
  clearAllPollerStates,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, clearAllAutoYesStates } from '@/lib/auto-yes-state';
import { createMessage, getMessages, upsertWorktree } from '@/lib/db';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import {
  clearPolicySuppressions,
  getLastPolicySuppression,
} from '@/lib/polling/auto-yes-suppression-state';
import { isAutoYesDeclinedConfirmPage } from '@/lib/polling/auto-yes-confirm-page';
import { isClaudeAskUserQuestionConfirmPage } from '@/lib/detection/tools/claude/detect';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { extractResponse, isNumberedDialogVouched } from '@/lib/polling/response-checker';
import { promptDataForStorage, readPromptScreen } from '@/lib/polling/prompt-screen-reading';
import { buildToolApprovalEntries, toToolApprovalEntry } from '@/lib/chat/chat-tool-approvals';
import type { PromptDetectionResult } from '@/lib/detection/types';

const WT = 'wt-3881-reading';
const LIVE = path.resolve(__dirname, '../../../fixtures/claude-confirm-live-3791');
const live = (name: string): string => readFileSync(path.join(LIVE, name), 'utf8');

const PAGE_16 = 'tab-row-wrapped-16x1000.txt';
const LOOKALIKE_QUESTION = 'lookalike-askuserquestion-200x60.txt';
const LOOKALIKE_BASH = 'lookalike-bash-approval-200x60.txt';
const LOOKALIKE_QUOTED = 'lookalike-bash-output-quoted-200x60.txt';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cmate-3881-'));
  db = new Database(path.join(tmpDir, 'chat.sqlite'));
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'wt-3881',
    path: path.join(tmpDir, 'wt'),
    branch: 'fix/3881',
    repositoryPath: path.join(tmpDir, 'repo'),
    repositoryName: 'repo',
    cliToolId: 'claude',
  });
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearAutoYesPolicyCache();
  clearPolicySuppressions();
  sendPromptAnswer.mockClear();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The detection the response poller saves from: `extractResponse`'s, as `checkForResponse` takes it. */
function savedDetection(raw: string): PromptDetectionResult {
  const result = extractResponse(raw, 0, 'claude');
  const detection = result?.promptDetection;
  if (!detection?.isPrompt) throw new Error('fixture drifted: no prompt extracted');
  // The #2457 gate the save sits behind: an unvouched candidate is never saved.
  expect(isNumberedDialogVouched('claude', detection, raw)).toBe(true);
  return detection;
}

/** Save a `prompt` row with `promptData` and read it back from the database. */
function saveAndReload(promptData: PromptData | undefined, content: string): ChatMessage {
  const saved = createMessage(db, {
    worktreeId: WT,
    role: 'assistant',
    content,
    messageType: 'prompt',
    promptData,
    timestamp: new Date('2026-10-24T10:00:00.000Z'),
    cliToolId: 'claude',
    instanceId: 'claude',
  });
  const [row] = getMessages(db, WT, { messageType: 'prompt' }).filter((m) => m.id === saved.id);
  return row;
}

function pollerState(): AutoYesPollerState {
  return {
    timerId: null,
    cliToolId: 'claude',
    instanceId: 'claude',
    consecutiveErrors: 0,
    currentInterval: POLLING_INTERVAL_MS,
    lastServerResponseTimestamp: null,
    lastAnsweredPromptKey: null,
    lastAnsweredAt: null,
    stopCheckBaselineLength: -1,
  };
}

/** One poller tick on `raw`, spelled the way `capturePollerFrame` hands it over. */
function respondTo(raw: string): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, pollerState(), 'claude', clean, clean.split('\n'), 'claude', raw);
}

describe('[#3881] (1) the 16-column confirm page is a confirmation on every path', () => {
  it('frame → Claude’s own reader: the page', () => {
    expect(isClaudeAskUserQuestionConfirmPage(normalizeFrame(live(PAGE_16), 'claude'))).toBe(true);
  });

  it('generic representation: what the stored strings say — `Submit`, no review list', () => {
    // The cut-down strings the compatibility rules had to decide from. Pinned
    // so the 陽性対照 below keeps reproducing the defect on this fixture.
    const promptData = savedDetection(live(PAGE_16)).promptData!;
    expect(promptData.type).toBe('multiple_choice');
    expect(promptData.type === 'multiple_choice' && promptData.options.map((o) => o.label)).toEqual(['Submit', 'Cancel']);
    expect(promptData.question).not.toContain('●');
  });

  it('reading: confirmation, from the confirm-page reader, with the live rows', () => {
    const detection = savedDetection(live(PAGE_16));
    const reading = readPromptScreen('claude', live(PAGE_16), detection);
    expect(reading).toMatchObject({
      version: 1,
      kind: 'confirmation',
      phase: 'confirmation',
      evidence: ['confirm-page-reader'],
    });
    expect(reading?.liveRange).toEqual({
      startRow: detection.approvalContext!.startRow,
      endRow: detection.approvalContext!.endRow,
    });
    expect(reading?.approvalTarget).toBe(detection.approvalContext!.completeness);
  });

  it('saved → reloaded → toToolApprovalEntry: a question’s confirmation, from the stored reading', () => {
    const detection = savedDetection(live(PAGE_16));
    const row = saveAndReload(promptDataForStorage('claude', live(PAGE_16), detection), detection.rawContent!);

    expect((row.promptData as unknown as Record<string, unknown>).reading).toMatchObject({ kind: 'confirmation' });
    expect(toToolApprovalEntry(row)).toMatchObject({
      kind: 'question',
      phase: 'confirmation',
      classifiedFrom: 'reading',
    });
    expect(buildToolApprovalEntries([row])).toHaveLength(1);
  });

  it('the status sweep keeps the reading (it spreads the stored row)', () => {
    const detection = savedDetection(live(PAGE_16));
    const row = saveAndReload(promptDataForStorage('claude', live(PAGE_16), detection), detection.rawContent!);
    db.prepare(`UPDATE chat_messages SET prompt_data = json_set(prompt_data, '$.status', 'answered') WHERE id = ?`).run(row.id);
    const [reloaded] = getMessages(db, WT, { messageType: 'prompt' });
    expect(toToolApprovalEntry(reloaded)).toMatchObject({ kind: 'question', phase: 'confirmation' });
  });

  it('陽性対照: the same row saved without a reading (pre-#3881) is still drawn as an approval', () => {
    const detection = savedDetection(live(PAGE_16));
    const row = saveAndReload(detection.promptData, detection.rawContent!);
    const entry = toToolApprovalEntry(row);
    expect(entry.kind).toBe('approval');
    expect(entry.classifiedFrom).toBeUndefined();
  });

  it('the poller leaves the same frame to a human as `question-confirm-page`', async () => {
    expect(isAutoYesDeclinedConfirmPage('claude', normalizeFrame(live(PAGE_16), 'claude'))).toBe(true);
    expect(await respondTo(live(PAGE_16))).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude', 'claude')).toMatchObject({ reason: 'question-confirm-page' });
  });
});

describe('[#3881] (2) a quotation of the page is not the confirm page', () => {
  it('a Bash approval whose command prints the page: permission when stored, an approval in chat', () => {
    const detection = savedDetection(live(LOOKALIKE_BASH));
    const row = saveAndReload(promptDataForStorage('claude', live(LOOKALIKE_BASH), detection), detection.rawContent!);
    expect(readPromptScreen('claude', live(LOOKALIKE_BASH), detection)).toMatchObject({
      kind: 'permission',
      evidence: ['permission-option-effect'],
    });
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'approval', classifiedFrom: 'reading' });
  });

  it('an AskUserQuestion that ASKS the sentence: a question’s question screen, not its confirmation', () => {
    const detection = savedDetection(live(LOOKALIKE_QUESTION));
    const row = saveAndReload(promptDataForStorage('claude', live(LOOKALIKE_QUESTION), detection), detection.rawContent!);
    expect(readPromptScreen('claude', live(LOOKALIKE_QUESTION), detection)).toMatchObject({
      kind: 'question',
      phase: 'question',
      evidence: ['question-picker-chrome'],
    });
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'question', classifiedFrom: 'reading' });
  });

  it('陽性対照: that lookalike saved without a reading is still taken for the confirmation by the compatibility rules', () => {
    const detection = savedDetection(live(LOOKALIKE_QUESTION));
    const row = saveAndReload(detection.promptData, detection.rawContent!);
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'confirmation' });
  });

  it('the page quoted in a reply above the idle input box is no prompt to save at all', () => {
    const result = extractResponse(live(LOOKALIKE_QUOTED), 0, 'claude');
    const detection = result?.promptDetection;
    const vouched = detection?.isPrompt === true && isNumberedDialogVouched('claude', detection, live(LOOKALIKE_QUOTED));
    expect(vouched).toBe(false);
  });
});

describe('[#3881] (4) sending and display are separate expectations', () => {
  it('the confirm page: displayed as a confirmation, and nothing is sent', async () => {
    const detection = savedDetection(live(PAGE_16));
    const row = saveAndReload(promptDataForStorage('claude', live(PAGE_16), detection), detection.rawContent!);
    expect(toToolApprovalEntry(row).phase).toBe('confirmation');
    expect(await respondTo(live(PAGE_16))).toBe('no_answer');
  });

  it('陰性対照: the Bash approval lookalike is displayed as an approval and still answered `1`', async () => {
    const detection = savedDetection(live(LOOKALIKE_BASH));
    const row = saveAndReload(promptDataForStorage('claude', live(LOOKALIKE_BASH), detection), detection.rawContent!);
    expect(toToolApprovalEntry(row).kind).toBe('approval');
    expect(await respondTo(live(LOOKALIKE_BASH))).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });

  it('the lookalike question: displayed as a question, and answered under the default `recommended` mode', async () => {
    // Display says "a question"; whether a question is answered is the answer
    // mode's call (#3863), not the display's. Two expectations, not one.
    const detection = savedDetection(live(LOOKALIKE_QUESTION));
    const row = saveAndReload(promptDataForStorage('claude', live(LOOKALIKE_QUESTION), detection), detection.rawContent!);
    expect(toToolApprovalEntry(row)).toMatchObject({ kind: 'question', phase: 'question' });
    expect(await respondTo(live(LOOKALIKE_QUESTION))).toBe('responded');
    expect(sendPromptAnswer.mock.calls[0][0].answer).toBe('1');
  });
});
