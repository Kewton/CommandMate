/**
 * Issue #4303 (#4303-A): an answer — `respond`, `/prompt-response`, Auto-Yes —
 * types nothing into a pane whose agent is not known to hold it.
 *
 * Right before the answer's first key, `sendPromptAnswer` reads PR1's
 * `readPaneForeground` (#4300). `shell` (the agent exited and the pane is back
 * at its shell: a `1` or `y` with an Enter would run as a shell command) and
 * `unknown` (it could not be read) both refuse with no key, as a
 * `PromptAnswerNotDeliveredError` (`keysSent: false`, `answer_not_delivered`:
 * the side that may be sent again). `other` (the agent) answers as before.
 *
 * Table-driven over `CLI_TOOL_IDS` (a `Record` keyed by the tool type, so a new
 * tool fails to compile until it has a row), each with its own answer shape:
 * claude / antigravity arrows + Enter, Command Code's checkbox question
 * toggles, every other tool text + Enter. Plus the `answer_only` digit (no
 * Enter, not typed as the input writer).
 *
 * - positive control: the same rows with the foreground `other` send keys on
 *   EVERY row (no row merely stuck before its first key).
 * - preservation: `other` delivers the answer once, exactly as before. A
 *   reader that throws (never the real one; a tmux double that predates it) is
 *   no reading and goes on, as #4300's send check does.
 *
 * Also (PM decision, same PR): the text of an answer is typed as TEXT
 * (`send-keys -l --`), so an answer spelled like a tmux key name (`Enter`,
 * `Escape`, `C-c`) or a flag (`-l`) arrives as those characters.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  foreground: 'other' as 'shell' | 'other' | 'unknown' | 'throws',
  /** Run the real `sendKeys` (its tmux call lands in the `execFile` mock). */
  realSendKeys: false,
  execCalls: [] as Array<{ file: string; args: string[] }>,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((file: string, args: string[], ...rest: unknown[]) => {
    const callback = rest[rest.length - 1] as (e: Error | null, r?: { stdout: string; stderr: string }) => void;
    h.execCalls.push({ file, args });
    callback(null, { stdout: '', stderr: '' });
    return { stdin: { end: () => undefined } };
  });
  return { ...actual, execFile, default: { ...actual, execFile } };
});

vi.mock('@/lib/tmux/tmux', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tmux/tmux')>();
  return {
    ...actual,
    capturePane: vi.fn(async () => ''),
    sendKeys: vi.fn((...args: Parameters<typeof actual.sendKeys>) =>
      h.realSendKeys ? actual.sendKeys(...args) : Promise.resolve()
    ),
    sendSpecialKeys: vi.fn(async () => undefined),
    readPaneForeground: vi.fn(async () => {
      if (h.foreground === 'throws') throw new Error('reader failed (test)');
      return h.foreground;
    }),
  };
});
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));

import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import {
  PromptAnswerAgentNotInForegroundError,
  PromptAnswerNotDeliveredError,
  sendPromptAnswer,
  type SendPromptAnswerParams,
} from '@/lib/prompt-answer-sender';
import { ANSWER_NOT_DELIVERED_REASON, promptAnswerErrorResponse } from '@/lib/prompt-answer-errors';
import { attemptResultOfThrow } from '@/lib/auto-yes-poller-tick';
import { capturePane, readPaneForeground, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { readCommandCodeQuestionDialog } from '@/lib/detection/tools/command-code/dialog';
import type { MultipleChoicePromptData, PromptData } from '@/types/models';

const RULE = '─'.repeat(200);

/** A Command Code 1.54.1 checkbox question (the shape of `prompt-answer-sender-multiselect-2755`). */
function commandCodeCheckboxFrame(ticked: readonly number[]): string {
  const labels = ['node_modules', 'dist', 'coverage'];
  const rows = labels.map((label, index) => {
    const number = index + 1;
    return `${number === 1 ? '❯' : ' '} ${number}. ${ticked.includes(number) ? '[✔]' : '[ ]'} ${label}`;
  });
  return [
    '# Command Code v1.54.1',
    '',
    RULE,
    '',
    '● Cleanup | ◯ Review',
    '',
    'Which caches should I clear?',
    '',
    ...rows,
    '  Submit',
    '',
    'Enter to select | Arrow keys to navigate | 1-9 quick select | n notes | c chat | Esc to cancel',
    '',
  ].join('\n');
}

function commandCodeCheckboxPayload(): MultipleChoicePromptData {
  const reading = readCommandCodeQuestionDialog(commandCodeCheckboxFrame([]));
  const data = reading.kind === 'prompt' ? reading.prompt.promptData : undefined;
  if (data?.type !== 'multiple_choice') throw new Error(`fixture is not a readable checkbox question: ${reading.kind}`);
  return data;
}

const CHOICE: PromptData = {
  type: 'multiple_choice',
  question: 'Choose:',
  options: [
    { number: 1, label: 'Option A', isDefault: true },
    { number: 2, label: 'Option B', isDefault: false },
  ],
  status: 'pending',
};

const YES_NO: PromptData = { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' };

type Shape = 'arrows+Enter' | 'toggles' | 'text+Enter';

interface Row {
  shape: Shape;
  params: (sessionName: string) => SendPromptAnswerParams;
}

const textRow = (cliToolId: CLIToolType): Row => ({
  shape: 'text+Enter',
  params: (sessionName) => ({ sessionName, answer: 'y', cliToolId, promptData: YES_NO }),
});
const arrowRow = (cliToolId: CLIToolType): Row => ({
  shape: 'arrows+Enter',
  params: (sessionName) => ({ sessionName, answer: '2', cliToolId, promptData: CHOICE }),
});

/** Every tool, with the shape its answer takes. */
const ROWS: Record<CLIToolType, Row> = {
  claude: arrowRow('claude'),
  antigravity: arrowRow('antigravity'),
  'command-code': {
    shape: 'toggles',
    params: (sessionName) => ({
      sessionName,
      answer: '1,3',
      cliToolId: 'command-code',
      promptData: commandCodeCheckboxPayload(),
    }),
  },
  codex: textRow('codex'),
  gemini: textRow('gemini'),
  'vibe-local': textRow('vibe-local'),
  opencode: textRow('opencode'),
  copilot: textRow('copilot'),
  'opencode-v2': textRow('opencode-v2'),
};

const TOOLS = [...CLI_TOOL_IDS];

/** Every key call that reached the (mocked) pane. */
function keyCalls(): number {
  return vi.mocked(sendKeys).mock.calls.length + vi.mocked(sendSpecialKeys).mock.calls.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.foreground = 'other';
  h.realSendKeys = false;
  h.execCalls = [];
  vi.mocked(capturePane).mockResolvedValue('');
});

describe('[#4303] the table covers every tool', () => {
  it('has one row per CLI_TOOL_IDS entry', () => {
    expect(Object.keys(ROWS).sort()).toEqual([...TOOLS].sort());
  });
});

describe.each(['shell', 'unknown'] as const)('[#4303] foreground %s: no key, not delivered', (foreground) => {
  it.each(TOOLS)('%s: sendKeys / sendSpecialKeys are never called, and the answer is not delivered', async (tool) => {
    h.foreground = foreground;
    const row = ROWS[tool];
    const error = await sendPromptAnswer(row.params(`mcbd-${tool}-wt-4303`)).then(
      () => null,
      (e: unknown) => e
    );

    expect(keyCalls()).toBe(0);
    expect(readPaneForeground).toHaveBeenCalledWith(`mcbd-${tool}-wt-4303`);
    expect(error).toBeInstanceOf(PromptAnswerAgentNotInForegroundError);
    expect(error).toBeInstanceOf(PromptAnswerNotDeliveredError);
    const refused = error as PromptAnswerAgentNotInForegroundError;
    expect(refused.name).toBe('PromptAnswerNotDeliveredError');
    expect(refused.keysSent).toBe(false);
    expect(refused.reason).toBe(ANSWER_NOT_DELIVERED_REASON);
    expect(refused.foreground).toBe(foreground);
  });
});

describe('[#4303] a reader that throws is no reading (a tmux double without it): the answer goes on', () => {
  it('claude: Down + Enter as before', async () => {
    h.foreground = 'throws';
    await sendPromptAnswer(ROWS.claude.params('mcbd-claude-wt-4303'));
    expect(vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1])).toEqual([['Down', 'Enter']]);
  });
});

describe('[#4303] the answer_only digit (no Enter, typed outside the input writer) is gated too', () => {
  const params = (): SendPromptAnswerParams => ({
    sessionName: 'mcbd-codex-wt-4303',
    answer: '1',
    cliToolId: 'codex',
    promptData: { ...CHOICE, submitMode: 'answer_only' } as PromptData,
  });

  it('shell: no key', async () => {
    h.foreground = 'shell';
    await expect(sendPromptAnswer(params())).rejects.toBeInstanceOf(PromptAnswerAgentNotInForegroundError);
    expect(keyCalls()).toBe(0);
  });

  it('other: the digit alone, once', async () => {
    await sendPromptAnswer(params());
    expect(vi.mocked(sendKeys).mock.calls).toEqual([['mcbd-codex-wt-4303', '1', false, { literal: true }]]);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });
});

describe('[#4303] positive control: with the agent in the foreground every row sends keys', () => {
  it.each(TOOLS)('%s: keys reach the pane', async (tool) => {
    vi.mocked(capturePane).mockResolvedValue(commandCodeCheckboxFrame([1, 3]));
    const row = ROWS[tool];
    // Command Code's checkbox arm reads the pane back after its toggles; what
    // follows them is not this file's concern, only that keys went out.
    await sendPromptAnswer(row.params(`mcbd-${tool}-wt-4303`)).catch(() => undefined);
    expect(keyCalls()).toBeGreaterThan(0);
    if (row.shape === 'toggles') {
      expect(vi.mocked(sendSpecialKeys).mock.calls[0][1]).toEqual(['1', '3']);
    }
  });
});

describe('[#4303] preservation: the agent in the foreground gets the answer once, as before', () => {
  it('claude: Down + Enter, one call', async () => {
    await sendPromptAnswer(ROWS.claude.params('mcbd-claude-wt-4303'));
    expect(vi.mocked(sendSpecialKeys).mock.calls.map((call) => call[1])).toEqual([['Down', 'Enter']]);
    expect(sendKeys).not.toHaveBeenCalled();
    expect(readPaneForeground).toHaveBeenCalledTimes(1);
  });

  it.each(['codex', 'gemini', 'vibe-local', 'opencode', 'copilot', 'opencode-v2'] as const)(
    '%s: the text once, then one Enter',
    async (tool) => {
      const session = `mcbd-${tool}-wt-4303`;
      await sendPromptAnswer(ROWS[tool].params(session));
      expect(vi.mocked(sendKeys).mock.calls).toEqual([
        [session, 'y', false, { literal: true }],
        [session, '', true],
      ]);
      expect(sendSpecialKeys).not.toHaveBeenCalled();
      expect(readPaneForeground).toHaveBeenCalledTimes(1);
    }
  );
});

describe('[#4303] the refusal is the not-delivered one on every caller', () => {
  it('respond 409 / prompt-response 200 refusal with answer_not_delivered, keysSent false; Auto-Yes ledger no-keys-sent', () => {
    const error = new PromptAnswerAgentNotInForegroundError('shell', 'mcbd-claude-wt-4303');
    expect(promptAnswerErrorResponse(error, 'respond')).toEqual({
      status: 409,
      body: expect.objectContaining({ reason: ANSWER_NOT_DELIVERED_REASON, keysSent: false }),
    });
    expect(promptAnswerErrorResponse(error, 'prompt-response')).toEqual({
      status: 200,
      body: expect.objectContaining({ success: false, reason: ANSWER_NOT_DELIVERED_REASON, keysSent: false }),
    });
    expect(attemptResultOfThrow(error.keysSent)).toBe('no-keys-sent');
    expect(error.message).toContain('Nothing was typed');
  });
});

describe('[#4303] the text of an answer is typed as text, not as a tmux key name', () => {
  it.each(['Enter', 'Escape', 'C-c', '-l'])('%s reaches tmux as `send-keys -l -- <text>`', async (answer) => {
    h.realSendKeys = true;
    await sendPromptAnswer({ sessionName: 'mcbd-gemini-wt-4303', answer, cliToolId: 'gemini', promptData: YES_NO });
    const sends = h.execCalls.filter((call) => call.file === 'tmux' && call.args[0] === 'send-keys');
    // The text, as text; then the Enter that submits it, as a key.
    expect(sends[0].args).toEqual(['send-keys', '-t', expect.any(String), '-l', '--', answer]);
    expect(sends[1].args).toEqual(['send-keys', '-t', expect.any(String), '', 'C-m']);
    expect(sends).toHaveLength(2);
  });
});
