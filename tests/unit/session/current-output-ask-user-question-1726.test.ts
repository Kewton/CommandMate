/**
 * `buildCurrentOutput` publishing the agent's own options (Issue #1726).
 *
 * The frame is the live capture of an `AskUserQuestion` picker with the task
 * panel overlaid — the 2026-08-06 failure exactly — so what is asserted here is
 * what a browser and `commandmate capture --json` would actually receive.
 *
 * Two properties have to hold together, and testing either alone would pass with
 * the other broken:
 *
 *  - the options published are the agent's, with the descriptions the pane never
 *    carried and without any option the agent did not offer;
 *  - none of #1723's or #1725's rules move. The structured question decides no
 *    status, the OR composition of `isPromptWaiting` is untouched, and a session
 *    with no hooks gets byte-identical output to before.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const createMessage = vi.fn();
vi.mock('@/lib/db', () => ({
  getSessionState: vi.fn(() => null),
  createMessage: (...args: unknown[]) => createMessage(...args),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: (...a: unknown[]) => isRunning(...a) }) }),
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
import {
  clearAgentStopEvents,
  recordAgentEvent,
  recordAskUserQuestion,
  reportPermissionRequestPending,
} from '@/lib/session/agent-event-state';
import type { AskUserQuestionSpec } from '@/lib/hooks/ask-user-question-payload';
import type { MultipleChoicePromptData } from '@/types/models';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';
import { CANARY_ASKUSERQUESTION_TASK_PANEL } from '../../fixtures/canary/askuserquestion-task-panel';

const db = {} as Database.Database;

/** A frame the scraper reads as `running`/`default` — no prompt in it at all. */
const BUSY_FRAME = 'writing files\nediting src/app/page.tsx\n';

const SPEC: AskUserQuestionSpec = {
  promptId: 'prompt-1',
  questions: [
    {
      question: 'Which task would you like to start with?',
      header: 'First task',
      multiSelect: false,
      choices: [
        { label: 'Clear desk', description: 'Start by clearing the desk surface.' },
        { label: 'Sort papers', description: 'Start by sorting through the papers.' },
        { label: 'Wrangle cables', description: 'Start by wrangling and organizing the cables.' },
      ],
    },
  ],
};

function askQuestion(at: number = Date.now() - 1_000): void {
  recordAgentEvent('wt-1', 'claude', 'claude', {
    event: 'pre_tool_use',
    at,
    detail: 'AskUserQuestion',
    sessionId: 'sess-1',
  });
  recordAskUserQuestion('wt-1', 'claude', 'claude', SPEC, at);
}

/**
 * The dialog record `AskUserQuestion` actually produces.
 *
 * Not a `Notification`: §5.6 measured that the picker emits none. What it does
 * raise is a `PermissionRequest`, which Auto-Yes v2 answers with no-decision
 * (allowing it does not dismiss the picker), and that no-decision is what opens
 * the provisional prompt-waiting record.
 */
function openDialogEvent(at: number = Date.now() - 1_000): void {
  reportPermissionRequestPending('wt-1', 'claude', 'claude', 'AskUserQuestion', at);
}

function build() {
  return buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
}

function asMultipleChoice(value: unknown): MultipleChoicePromptData {
  const data = value as MultipleChoicePromptData;
  if (data?.type !== 'multiple_choice') {
    throw new Error(`expected a multiple_choice prompt, got ${String(data?.type)}`);
  }
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
  vi.mocked(captureSessionOutput).mockResolvedValue(CANARY_ASKUSERQUESTION_TASK_PANEL);
});

describe('the picker with the task panel on screen (Issue #1726)', () => {
  it('publishes the agent’s labels and descriptions', async () => {
    askQuestion();

    const promptData = asMultipleChoice((await build()).promptData);

    expect(promptData.question).toBe('Which task would you like to start with?');
    expect(promptData.options.map((o) => `${o.number}. ${o.label}`)).toEqual([
      '1. Clear desk',
      '2. Sort papers',
      '3. Wrangle cables',
      '4. Type something.',
      '5. Chat about this',
    ]);
    expect(promptData.options[0].description).toBe('Start by clearing the desk surface.');
    expect(promptData.askUserQuestion).toMatchObject({ header: 'First task', questionCount: 1 });
  });

  it('publishes no option the agent did not offer and the picker did not add', async () => {
    askQuestion();

    const promptData = asMultipleChoice((await build()).promptData);

    expect(promptData.options.some((o) => /tasks?\s*\(/.test(o.label))).toBe(false);
    expect(promptData.options.some((o) => o.number > 5)).toBe(false);
  });

  it('still reports waiting, from the scraper — the structured layer adds no status', async () => {
    askQuestion();

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(true);
    expect(payload.sessionStatus).toBe('waiting');
    // The scraper's reason, not a `hook_` one: this frame is one the screen can
    // be read on, and #1723's rule that a scraper `waiting` always wins holds.
    expect(payload.sessionStatusReason).not.toMatch(/^hook_/);
    expect(payload.structuredEvents.lastEventType).toBe('pre_tool_use');
  });

  it('falls back to the scraper’s own options when no hook ever fired', async () => {
    // The unconfigured machine. Nothing about this payload may change.
    const promptData = asMultipleChoice((await build()).promptData);

    expect(promptData.options.map((o) => o.label)).toEqual([
      'Clear desk',
      'Sort papers',
      'Wrangle cables',
      'Type something.',
      'Chat about this',
    ]);
    expect(promptData.options.every((o) => o.description === undefined)).toBe(true);
    expect(promptData.askUserQuestion).toBeUndefined();
    expect(promptData.question).toContain("I'll load the TaskCreate tool schema first");
  });

  it('falls back once the call is over, even while the pane still shows it', async () => {
    // A stale record is the harm: it would check `respond` against the options
    // of a question that has been answered.
    askQuestion();
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'stop',
      at: Date.now(),
      detail: null,
      sessionId: 'sess-1',
    });

    expect(asMultipleChoice((await build()).promptData).askUserQuestion).toBeUndefined();
  });
});

describe('a picker only the agent can see (Issue #1726)', () => {
  it('names what was asked instead of only saying a dialog is open', async () => {
    // The #1725 degraded form, with the question in it. `options` stays empty:
    // one tool call walks through a screen per question and then a `1. Submit
    // answers` confirmation with no event at any transition, so a layer that
    // cannot see the pane cannot know which screen a number would land on.
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    askQuestion();
    openDialogEvent();

    const payload = await build();
    const promptData = payload.promptData as { type: string; options: unknown[]; question: string };

    expect(payload.isPromptWaiting).toBe(true);
    expect(promptData.type).toBe(UNCLASSIFIED_PROMPT_TYPE);
    expect(promptData.options).toEqual([]);
    expect(promptData.question).toContain('Which task would you like to start with?');
    expect(promptData.question).toContain('Clear desk');
  });

  it('writes the question into the prompt-history row too', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    askQuestion();
    openDialogEvent();

    await build();

    const rows = createMessage.mock.calls
      .map(([, row]) => row as Record<string, unknown>)
      .filter((row) => (row.promptData as { source?: string } | undefined)?.source !== undefined);
    expect(rows).toHaveLength(1);
    expect((rows[0].promptData as { question: string }).question).toContain(
      'Which task would you like to start with?',
    );
  });

  it('says nothing about a question when none is in flight', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    openDialogEvent();

    const promptData = (await build()).promptData as { question: string };

    expect(promptData.question).not.toContain('The agent asked');
  });

  it('keeps naming it while the picker’s own Notification arrives', async () => {
    // The live timeline: the picker's `Notification(permission_prompt)` lands
    // ~6 s after the invocation, with the screen unchanged. Treating it as the
    // end of the call switched this feature off on every real session.
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    askQuestion();
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'notification',
      at: Date.now(),
      detail: 'permission_prompt',
      sessionId: 'sess-1',
      message: 'Claude needs your permission to use AskUserQuestion',
    });

    const promptData = (await build()).promptData as { question: string };

    expect(promptData.question).toContain('Which task would you like to start with?');
  });

  it('stops naming it once the agent says it is back at the composer', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    askQuestion();
    openDialogEvent();
    recordAgentEvent('wt-1', 'claude', 'claude', {
      event: 'notification',
      at: Date.now(),
      detail: 'idle_prompt',
      sessionId: 'sess-1',
      message: 'Claude is waiting for your input',
    });

    expect((await build()).promptData).toBeNull();
  });

  it('does not make a session waiting on its own', async () => {
    // The role table this Issue is built on: the scraper detects the screen, the
    // payload describes its contents. An invocation with nothing corroborating
    // it must leave the session exactly as it was.
    vi.mocked(captureSessionOutput).mockResolvedValue(BUSY_FRAME);
    askQuestion();

    const payload = await build();

    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.promptData).toBeNull();
    expect(payload.sessionStatus).toBe('running');
  });
});
