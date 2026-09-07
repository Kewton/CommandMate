/**
 * Auto-Yes answers agy's wrapped Bash approval (Issue #2368).
 *
 * ## What was measured
 *
 * With Auto-Yes ON against agy 1.1.27, a file creation (`Allow creation of this
 * file?`, two one-row labels) was answered in about five seconds and a Bash
 * approval (`Do you want to proceed?`, four options whose labels carry the
 * command and wrap at column 0) sat unanswered for over seventy seconds — while
 * `/current-output` published that same frame as `waiting` / `prompt_detected`
 * with four options.
 *
 * The cause was one call site. Issue #2364 gave agy its own dialog reader and
 * put three consumers of a frame on it (`detectSessionStatus`, the response
 * poller's `detectPromptWithOptions`, the `prompt-response` re-verification);
 * `detectAndRespondToPrompt` kept calling the generic `detectPrompt`, whose
 * multiple-choice parser folds a wrapped label only when the continuation row is
 * indented, short or path-shaped (#372). agy's are none of those, so the option
 * run broke and the frame came back `isPrompt: false`.
 *
 * ## Why this drives the poller and not the reader
 *
 * `tests/unit/lib/detection/antigravity-numbered-dialog-2364.test.ts` already
 * proves the reader reads these frames. What was broken here is the WIRING, so
 * every assertion below is about `sendPromptAnswer` — the keystrokes the agent
 * actually receives — reached through the real `detectAndRespondToPrompt`. Same
 * argument and same shape as `auto-yes-codex-launch-dialog-1829.test.ts` and
 * `tests/unit/polling/auto-yes-unclassified-frame-1928.test.ts`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
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

// `withContext` is part of the logger contract and the detection layer uses it.
// A mock missing a method the production path calls does not fail as
// "unmocked": it throws inside the poller's catch and every assertion here
// would read `'error'` instead of the verdict under test.
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
}));

import { stripAnsi, stripBoxDrawing, buildDetectPromptOptions } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { detectAntigravityNumberedDialogPrompt } from '@/lib/detection/tools/antigravity/dialog';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';
import { createTask } from '@/lib/db/tasks-db';
import { parseTaskContract } from '@/lib/tasks/contract-parser';

const WORKTREE_ID = 'wt-2368';
const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/antigravity-live-2364');

const frame = (name: string): string => readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');

/**
 * The frame exactly as `captureAndCleanOutput` hands it to
 * `detectAndRespondToPrompt`: ANSI and box drawing removed, nothing else.
 */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

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

/** Every answer `sendPromptAnswer` was asked to type, in order. */
const answersSent = (): string[] => sendPromptAnswer.mock.calls.map(([p]) => p.answer);

/** Drive the real poller over one fixture, the way `pollAutoYes` does. */
async function respondTo(
  name: string,
  state: AutoYesPollerState = pollerState(),
): Promise<'responded' | 'no_prompt' | 'duplicate' | 'no_answer' | 'error'> {
  const clean = asPollerSees(frame(name));
  return detectAndRespondToPrompt(
    WORKTREE_ID,
    state,
    'antigravity',
    clean,
    clean.split('\n'),
    'antigravity',
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  clearPolicySuppressions();
  db.close();
});

describe('[#2368] the wrapped four-option Bash approval is answered', () => {
  it('sends the highlighted default `1` for dialog-bash-wrapped', async () => {
    // 受入条件 1: the very frame that produced 70+ seconds of silence.
    expect(await respondTo('dialog-bash-wrapped')).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('sends the four-option prompt, not a two-option misread, to the sender', async () => {
    await respondTo('dialog-bash-wrapped');

    const [params] = sendPromptAnswer.mock.calls[0] as unknown as [
      { promptData: { type: string; question: string; options: { number: number }[] } },
    ];
    expect(params.promptData.type).toBe('multiple_choice');
    // The reader's question, not the generic parser's five joined rows.
    expect(params.promptData.question).toBe('Do you want to proceed?');
    expect(params.promptData.options.map((o) => o.number)).toEqual([1, 2, 3, 4]);
  });

  it('never picks an "always allow" option — it follows the `>` gutter', async () => {
    // agy 1.1.27 puts `2. Yes, and always allow in this conversation …` and
    // `3. … (Persist to settings.json)` between Yes and No. The default is the
    // row wearing the `>`, and on this frame that is option 1.
    await respondTo('dialog-bash-wrapped');
    expect(answersSent()).toEqual(['1']);

    sendPromptAnswer.mockClear();
    // The same dialog with the cursor moved to `4. No` answers 4, which proves
    // the `1` above came from the gutter and not from "first option wins".
    expect(await respondTo('dialog-bash-wrapped-highlight-4')).toBe('responded');
    expect(answersSent()).toEqual(['4']);
  });

  it('folds the six-option repeat-denial menu too', async () => {
    expect(await respondTo('dialog-bash-wrapped-six')).toBe('responded');
    expect(answersSent()).toEqual(['1']);
  });

  it('keeps answering the one-row variants that already worked', async () => {
    expect(await respondTo('dialog-create-file')).toBe('responded');
    expect(await respondTo('dialog-bash-oneline', pollerState())).toBe('responded');
    expect(answersSent()).toEqual(['1', '1']);
  });
});

describe('[#2368] the answer is still gated by everything after detection', () => {
  it('answers the same frame once — the #306 duplicate key still holds', async () => {
    const state = pollerState();
    expect(await respondTo('dialog-bash-wrapped', state)).toBe('responded');
    expect(await respondTo('dialog-bash-wrapped', state)).toBe('duplicate');
    expect(answersSent()).toEqual(['1']);
  });

  it('withholds when the contract denies the command in the option labels (#1699)', async () => {
    // The deny pattern is matched against `approvalTarget`, which agy's reader
    // fills from the `Requesting permission for:` block and the labels. A
    // wrapped dialog nobody could read had no approvalTarget to judge, so this
    // protection only starts existing once the frame is readable.
    createTask(db, {
      worktreeId: WORKTREE_ID,
      cliToolId: 'antigravity',
      instanceId: null,
      contractPath: '.commandmate/tasks/t.yaml',
      contract: parseTaskContract(
        `version: 1
title: a task
goal: do the thing
scope:
  allow: ["src/**"]
autoYes:
  mode: 'safe'
  denyPatterns:
    - 'platform\\.python_version'
`,
        'task.yaml',
      ),
      status: 'running',
    });

    expect(await respondTo('dialog-bash-wrapped')).toBe('no_answer');
    expect(answersSent()).toEqual([]);
  });
});

describe('[#2368] the frames that must stay silent, stay silent', () => {
  // 受入条件 4. The Switch Model picker (#995) carries no numbered rows, so
  // neither agy's reader nor the generic pass finds a prompt on it, and Auto-Yes
  // has nothing to answer. Asserted through the poller rather than through the
  // reader because the poller is what could type into the picker.
  it.each([
    ['picker-switch-model', 'the Switch Model picker (#995)'],
    ['trust-dialog', "agy's trust screen"],
    ['popup-slash-commands', 'the slash-command popup'],
    ['boot-idle', 'an idle pane'],
    ['idle-after-deny', 'an idle pane after a denial'],
    ['survey-after-deny.reconstructed', 'the `[1] Good … [0] Skip` survey (#2364)'],
  ])('sends nothing on %s — %s', async (name) => {
    expect(await respondTo(name)).toBe('no_prompt');
    expect(answersSent()).toEqual([]);
  });
});

describe('[#2368] `/feedback` is left exactly where #2364 left it', () => {
  /**
   * agy's `/feedback` category menu has a `1-6 Select` footer and no
   * `↑/↓ Navigate`, so agy's reader declines it and #2364 deliberately left it
   * to the generic parser — which is what keeps it drawn as an answerable panel
   * for a human.
   *
   * That means the generic parser reads it as a `multiple_choice` prompt on
   * BOTH sides of this Issue, and `antigravity` is `legacy` in the Auto-Yes
   * dialog gate's rollout table (`AUTO_YES_DIALOG_GATE_DEFAULT_MODE`), so the
   * gate does not judge it either. This suite pins that #2368 did not change
   * that reading in either direction: the new entry hands this frame to exactly
   * the same parser the old call site did.
   *
   * Making Auto-Yes withhold here needs the gate row moved from `legacy` to
   * `enforce`, which is a change to `auto-yes-dialog-gate.ts` and to the #1928
   * suite that pins agy as ungated — both outside this Issue.
   */
  it('reads through the generic parser, unchanged by the new entry', () => {
    const clean = asPollerSees(frame('dialog-feedback-category'));

    // agy's own reader declines it — this frame never reaches the #2364 path.
    expect(detectAntigravityNumberedDialogPrompt(clean)).toBeNull();
    // So the entry the poller now uses returns what the old direct call returned.
    expect(detectPromptOnCleanFrame(clean, 'antigravity')).toEqual(
      detectPrompt(clean, buildDetectPromptOptions('antigravity')),
    );
  });
});
