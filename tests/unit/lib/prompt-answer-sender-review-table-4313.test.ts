/**
 * Command Code's `AskUserQuestion` Review page, decided off ONE read of the
 * screen (Issue #4313 B-1, 候補 1) — a table over every axis the sender sees.
 *
 * The invariant: when the screen read is the Review page, the only answers that
 * type anything are the allowed ones, and their keys come from THAT page's
 * cursor and the answer (`1` | `2`) alone. Every other combination with the page
 * on screen throws before the first key (sendKeys / sendSpecialKeys 0 calls).
 *
 * Axes (enabler-return-4313-b1-cause.md §7):
 *  - payload: fresh R (the page's, cursor on Submit), stale R (cursor on
 *    Cancel), S (a stored three-option question), S+AO (`answer_only`), M (an
 *    old `multiSelect` row), C (`[ ]` labels without `multiSelect`), Ø (none);
 *  - frame: F (the caller's), B (none from the caller, this module's read
 *    succeeds), X (none, and the read fails);
 *  - screen: V1 / V2 (the page, cursor on Submit / Cancel), W (the unanswered
 *    warning), U (the page with no readable cursor), O (another screen — a
 *    single-select question);
 *  - answer: 1, 2, 3, free text.
 *
 * Allowed: F + V + (R | stale R | S | S+AO) + 1|2 → `K(c, a)`: Enter on the
 * cursor's row, else one ↓/↑ and Enter. Refused (no key): every other row with
 * V/W/U on screen; R / stale R with O or X. Unchanged (the Review rule says
 * nothing; the existing guards decide, X's fail-open included): every other
 * payload with O or X — and M with B, which takes no read before its toggles
 * (#2755); 再指示 1 refuses it only when the caller says its own read failed
 * (`screenUnread`, `/respond`'s `messageId` shape). A failed first read is
 * `unread` for every check after it: nothing captures again.
 *
 * Built on the 1.54.1 live capture (1.88.2 is not captured: UAT); the other
 * screens are derived from it in memory, no fixture file.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every key that reached the pane, in order (text as typed, special keys by name). */
let delivered: string[] = [];

vi.mock('@/lib/tmux/tmux', () => ({
  // Issue #4303: the agent holds the pane.
  readPaneForeground: async () => 'other' as const,
  capturePane: vi.fn(),
  sendKeys: vi.fn(async (_session: string, keys: string, enter = true) => {
    delivered.push(enter ? `${keys}<Enter>` : keys);
  }),
  sendSpecialKeys: vi.fn(async (_session: string, keys: string[]) => {
    delivered.push(...keys);
  }),
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
// The waits between keys are the transport's; the table only asks which keys.
vi.mock('@/config/cli-tool-timing-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/cli-tool-timing-config')>()),
  TUI_TEXT_INPUT_WAIT_MS: 0,
  TUI_MESSAGE_PROCESSED_WAIT_MS: 0,
}));

import {
  CommandCodeReviewPageAnswerRejectedError,
  PromptAnswerNotDeliveredError,
  PromptAnswerRejectedError,
  sendPromptAnswer,
} from '@/lib/prompt-answer-sender';
import { capturePane, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import {
  readCommandCodeQuestionDialog,
  readCommandCodeReviewPagePrompt,
} from '@/lib/detection/tools/command-code/dialog';
import { resetInstanceInputLocks, withInstanceInputLock } from '@/lib/session/instance-input-lock';
import type { PromptData } from '@/types/models';

const SESSION = 'cm-wt-4313-table-command-code';
const DIR = path.resolve(__dirname, '../../fixtures/command-code-askuserquestion-2754');
const fixture = (name: string): string => readFileSync(path.join(DIR, `${name}.txt`), 'utf8');

const V1 = fixture('review-page-submit-cancel');
const W = fixture('review-page-unanswered-warning');
const O = fixture('singleselect-initial-unanswered-tabs');

/** The live capture with its two rows rewritten: `❯` on `cursor` (none when null). */
function withCursor(raw: string, cursor: 1 | 2 | null): string {
  const rows = raw.split('\n');
  const submit = rows.findIndex((row) => /^\s*(?:❯\s*)?1\. Submit\s*$/.test(stripAnsi(row)));
  const cancel = rows.findIndex((row) => /^\s*(?:❯\s*)?2\. Cancel\s*$/.test(stripAnsi(row)));
  if (submit < 0 || cancel !== submit + 1) throw new Error('the Review rows were not found');
  rows[submit] = cursor === 1 ? '❯ 1. Submit' : '  1. Submit';
  rows[cancel] = cursor === 2 ? '❯ 2. Cancel' : '  2. Cancel';
  return rows.join('\n');
}

const V2 = withCursor(V1, 2);
const U = withCursor(V1, null);

type Screen = 'V1' | 'V2' | 'W' | 'U' | 'O';
const SCREENS: Record<Screen, string> = { V1, V2, W, U, O };
/** Where the `❯` rests on each readable page. */
const CURSOR: Partial<Record<Screen, 1 | 2>> = { V1: 1, V2: 2 };

function reviewPayloadOf(frame: string): PromptData {
  const promptData = readCommandCodeReviewPagePrompt(frame)?.promptData;
  if (promptData === undefined) throw new Error('not a Review page');
  return promptData;
}

function questionPayloadOf(name: string): PromptData {
  const reading = readCommandCodeQuestionDialog(fixture(name));
  if (reading.kind !== 'prompt' || reading.prompt.promptData === undefined) throw new Error(`${name}: ${reading.kind}`);
  return reading.prompt.promptData;
}

const S: PromptData = {
  type: 'multiple_choice',
  question: 'Which option?',
  options: [
    { number: 1, label: 'Alpha', isDefault: true },
    { number: 2, label: 'Beta', isDefault: false },
    { number: 3, label: 'Gamma', isDefault: false },
  ],
  status: 'pending',
  isAskUserQuestion: true,
} as PromptData;

type Payload = 'R' | 'staleR' | 'S' | 'S+AO' | 'M' | 'C' | 'Ø';
const PAYLOADS: Record<Payload, PromptData | undefined> = {
  R: reviewPayloadOf(V1),
  staleR: reviewPayloadOf(V2),
  S,
  'S+AO': { ...S, submitMode: 'answer_only' } as PromptData,
  M: questionPayloadOf('multiselect-initial'),
  C: {
    type: 'multiple_choice',
    question: 'Which files should I update?',
    options: [
      { number: 1, label: '[ ] calc.js', isDefault: true },
      { number: 2, label: '[ ] README.md', isDefault: false },
      { number: 3, label: '[ ] docs', isDefault: false },
    ],
    status: 'pending',
  } as PromptData,
  'Ø': undefined,
};

type Frame = 'F' | 'B' | 'X';
type Answer = '1' | '2' | '3' | 'looks good';

/** What the table expects of one row. */
type Expected = { keys: string[] } | { refused: true } | { unchanged: true };

/** `K(c, a)`: Enter on the cursor's row, else one ↓/↑ and Enter. */
function reviewKeys(cursor: 1 | 2, answer: '1' | '2'): string[] {
  const target = Number(answer);
  if (target === cursor) return ['Enter'];
  return [target > cursor ? 'Down' : 'Up', 'Enter'];
}

function expected(payload: Payload, frame: Frame, screen: Screen, answer: Answer): Expected {
  const reviewPayload = payload === 'R' || payload === 'staleR';
  // X: no screen at all. O: a screen that is not the page.
  if (frame === 'X' || screen === 'O') return reviewPayload ? { refused: true } : { unchanged: true };
  // The checkbox arm takes no read of its own without a caller frame (#2755).
  if (payload === 'M' && frame === 'B' && /^\d+$/.test(answer)) return { unchanged: true };
  // The page (readable or not) is on the screen read for this answer.
  if (answer !== '1' && answer !== '2') return { refused: true };
  if (screen !== 'V1' && screen !== 'V2') return { refused: true };
  if (frame !== 'F') return { refused: true };
  if (payload === 'M' || payload === 'C' || payload === 'Ø') return { refused: true };
  return { keys: reviewKeys(CURSOR[screen] as 1 | 2, answer) };
}

const ROWS = (Object.keys(PAYLOADS) as Payload[]).flatMap((payload) =>
  (['F', 'B', 'X'] as Frame[]).flatMap((frame) =>
    (Object.keys(SCREENS) as Screen[]).flatMap((screen) =>
      (['1', '2', '3', 'looks good'] as Answer[]).map((answer) => ({
        payload, frame, screen, answer, want: expected(payload, frame, screen, answer),
      })),
    ),
  ),
);

function send(payload: Payload, frame: Frame, screen: Screen, answer: Answer): Promise<void> {
  if (frame === 'X') vi.mocked(capturePane).mockRejectedValue(new Error('no server running'));
  else vi.mocked(capturePane).mockResolvedValue(SCREENS[screen]);
  return sendPromptAnswer({
    sessionName: SESSION,
    answer,
    cliToolId: 'command-code',
    promptData: PAYLOADS[payload],
    ...(frame === 'F' ? { frame: SCREENS[screen] } : {}),
  });
}

beforeEach(() => {
  delivered = [];
  vi.mocked(capturePane).mockReset();
  vi.mocked(sendKeys).mockClear();
  vi.mocked(sendSpecialKeys).mockClear();
  resetInstanceInputLocks();
});

afterEach(() => {
  resetInstanceInputLocks();
});

describe('[#4313 B-1] the derived screens read as the table says', () => {
  it('V1 / V2 are the page with the cursor on Submit / Cancel; W and U are not readable pages; O is not the page', () => {
    expect(readCommandCodeReviewPagePrompt(V1)?.promptData).toMatchObject({
      options: [{ label: 'Submit', isDefault: true }, { label: 'Cancel', isDefault: false }],
    });
    expect(readCommandCodeReviewPagePrompt(V2)?.promptData).toMatchObject({
      options: [{ label: 'Submit', isDefault: false }, { label: 'Cancel', isDefault: true }],
    });
    expect(readCommandCodeReviewPagePrompt(W)).toBeNull();
    expect(readCommandCodeReviewPagePrompt(U)).toBeNull();
    for (const frame of [W, U, V1]) {
      const reading = readCommandCodeQuestionDialog(frame);
      expect(reading.kind === 'unsupported' && reading.reason === 'review-page').toBe(true);
    }
    expect(readCommandCodeReviewPagePrompt(O)).toBeNull();
    expect(readCommandCodeQuestionDialog(O).kind).toBe('prompt');
  });
});

describe('[#4313 B-1] payload × frame × screen × answer', () => {
  const allowed = ROWS.filter((row) => 'keys' in row.want);
  const refused = ROWS.filter((row) => 'refused' in row.want);
  const unchanged = ROWS.filter((row) => 'unchanged' in row.want);

  it('the table covers every row', () => {
    expect(allowed.length + refused.length + unchanged.length).toBe(7 * 3 * 5 * 4);
    expect(allowed.length).toBe(4 * 2 * 2);
  });

  it.each(allowed)('allowed: $payload / $frame / $screen / $answer → the page cursor’s keys', async (row) => {
    await send(row.payload, row.frame, row.screen, row.answer);
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual((row.want as { keys: string[] }).keys);
  });

  it.each(refused)('refused: $payload / $frame / $screen / $answer → no key', async (row) => {
    const error = await send(row.payload, row.frame, row.screen, row.answer).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(CommandCodeReviewPageAnswerRejectedError);
    // Every caller already answers it as "nothing was sent" and records nothing.
    expect(error).toBeInstanceOf(PromptAnswerRejectedError);
    expect(error).toMatchObject({ name: 'PromptAnswerRejectedError', reason: 'answer_mode_keys' });
    expect(vi.mocked(sendKeys)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSpecialKeys)).not.toHaveBeenCalled();
  });

  it.each(unchanged)('unchanged: $payload / $frame / $screen / $answer → not a Review refusal', async (row) => {
    const error = await send(row.payload, row.frame, row.screen, row.answer).then(() => null, (e: unknown) => e);
    expect(error).not.toBeInstanceOf(CommandCodeReviewPageAnswerRejectedError);
  });
});

describe('[#4313 B-1] the refusal says which case it is', () => {
  it.each([
    ['answer', 'R', 'F', 'V1', '3'],
    ['blocked-page', 'R', 'F', 'W', '1'],
    ['blocked-page', 'S', 'F', 'U', '2'],
    ['checkbox-payload', 'M', 'F', 'V1', '1'],
    ['checkbox-payload', 'C', 'F', 'V1', '1'],
    ['unverified', 'S', 'B', 'V1', '1'],
    ['unverified', 'Ø', 'F', 'V1', '1'],
    ['unverified', 'staleR', 'F', 'O', '1'],
    ['unverified', 'R', 'X', 'V1', '1'],
  ] as const)('%s: %s / %s / %s / %s', async (refusal, payload, frame, screen, answer) => {
    const error = await send(payload, frame, screen, answer).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ refusal });
  });

  it('the checkbox payload on the page points at /prompt-response, which reads the page again', async () => {
    const error = await send('M', 'F', 'V1', '1').then(() => null, (e: unknown) => e);
    expect((error as Error).message).toContain('/prompt-response');
    expect((error as Error).message).toContain('Nothing was sent.');
  });
});

/** A message send holding the session's composer until `release` (#3952). */
function holdSend(): { release: () => void; done: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = withInstanceInputLock(SESSION, async () => {
    delivered.push('<send>');
    await gate;
  });
  return { release, done };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('[#4313 B-1] the screen read again under the input lock is judged the same way', () => {
  async function answerAcrossASend(answer: '1' | '2', after: string): Promise<unknown> {
    vi.mocked(capturePane).mockResolvedValue(V1);
    const held = holdSend();
    const pending = sendPromptAnswer({
      sessionName: SESSION,
      answer,
      cliToolId: 'command-code',
      promptData: PAYLOADS.S,
      frame: V1,
    }).then(() => null, (e: unknown) => e);
    await flush();
    vi.mocked(capturePane).mockResolvedValue(after);
    held.release();
    await held.done;
    return pending;
  }

  it('the cursor moved to Cancel while the answer waited: 1 is ↑ and Enter, from the fresh cursor', async () => {
    expect(await answerAcrossASend('1', V2)).toBeNull();
    expect(delivered).toEqual(['<send>', 'Up', 'Enter']);
  });

  it('陰性対照: the same page after the wait: 2 is ↓ and Enter', async () => {
    expect(await answerAcrossASend('2', V1)).toBeNull();
    expect(delivered).toEqual(['<send>', 'Down', 'Enter']);
  });

  it.each([
    ['the unanswered warning', W],
    ['an unreadable cursor', U],
    ['another screen', O],
  ])('%s after the wait: nothing is typed', async (_name, after) => {
    const error = await answerAcrossASend('1', after);
    expect(error).toBeInstanceOf(PromptAnswerNotDeliveredError);
    expect(error).toMatchObject({ keysSent: false });
    expect(delivered).toEqual(['<send>']);
  });
});

describe('[#4313 B-1 再指示 1] one read, shared: a failed first read is `unread` for every check after it', () => {
  /** The first capture fails, the next one would show the Review page. */
  function failThenReview(): void {
    vi.mocked(capturePane)
      .mockRejectedValueOnce(new Error('no server running'))
      .mockResolvedValue(V1);
  }

  it.each([
    ['S', '1', ['1', '<Enter>']],
    ['S', '3', ['3', '<Enter>']],
    ['S+AO', '2', ['2']],
    ['Ø', '1', ['1', '<Enter>']],
  ] as const)('%s / %s: captured once, and sent as with no screen (the later capture decides nothing)', async (payload, answer, keys) => {
    failThenReview();
    await sendPromptAnswer({ sessionName: SESSION, answer, cliToolId: 'command-code', promptData: PAYLOADS[payload] });
    expect(vi.mocked(capturePane)).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(keys);
  });

  it('R / 1: captured once and refused as unverified (the later capture is not used to send it)', async () => {
    failThenReview();
    const error = await sendPromptAnswer({
      sessionName: SESSION, answer: '1', cliToolId: 'command-code', promptData: PAYLOADS.R,
    }).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ refusal: 'unverified' });
    expect(vi.mocked(capturePane)).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([]);
  });
});

describe('[#4313 B-1 再指示 1] a checkbox row the caller could not read the screen for (`screenUnread`)', () => {
  it('Command Code, multiSelect payload, no frame, 1: refused before any toggle, nothing captured', async () => {
    vi.mocked(capturePane).mockResolvedValue(V1);
    const error = await sendPromptAnswer({
      sessionName: SESSION, answer: '1', cliToolId: 'command-code', promptData: PAYLOADS.M, screenUnread: true,
    }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(PromptAnswerRejectedError);
    expect(error).toMatchObject({ refusal: 'unread-checkbox' });
    expect((error as Error).message).toContain('/prompt-response');
    expect(vi.mocked(capturePane)).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
  });

  it('陰性対照: the same payload with no `screenUnread` keeps #2755’s arm (its toggle is typed)', async () => {
    vi.mocked(capturePane).mockResolvedValue(O);
    await sendPromptAnswer({
      sessionName: SESSION, answer: '1', cliToolId: 'command-code', promptData: PAYLOADS.M,
    }).catch(() => undefined);
    expect(delivered[0]).toBe('1');
  });

  it('陰性対照: another CLI’s checkbox payload with `screenUnread` is sent as before', async () => {
    vi.mocked(capturePane).mockRejectedValue(new Error('no server running'));
    const error = await sendPromptAnswer({
      sessionName: 'cm-wt-4313-table-claude',
      answer: '1',
      cliToolId: 'claude',
      promptData: { ...(PAYLOADS.M as PromptData), isAskUserQuestion: true } as PromptData,
      screenUnread: true,
    }).then(() => null, (e: unknown) => e);
    expect(error).toBeNull();
    expect(delivered.length).toBeGreaterThan(0);
  });
});

describe('[#4313 B-1 再指示 1] 陰性対照: every capture fails (X02〜X07) — sent as before (fail-open)', () => {
  it.each([
    ['S', '1', ['1', '<Enter>']],
    ['S+AO', '1', ['1']],
    ['C', '2', ['2', '<Enter>']],
    ['Ø', '2', ['2', '<Enter>']],
  ] as const)('%s / %s', async (payload, answer, keys) => {
    vi.mocked(capturePane).mockRejectedValue(new Error('no server running'));
    await sendPromptAnswer({ sessionName: SESSION, answer, cliToolId: 'command-code', promptData: PAYLOADS[payload] });
    expect(delivered).toEqual(keys);
  });

  it('M / 1 (X06): the toggle is typed as before, and the unread check after it stops the confirm', async () => {
    vi.mocked(capturePane).mockRejectedValue(new Error('no server running'));
    const error = await sendPromptAnswer({
      sessionName: SESSION, answer: '1', cliToolId: 'command-code', promptData: PAYLOADS.M,
    }).then(() => null, (e: unknown) => e);
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(CommandCodeReviewPageAnswerRejectedError);
    expect(delivered).toEqual(['1']);
  });
});
