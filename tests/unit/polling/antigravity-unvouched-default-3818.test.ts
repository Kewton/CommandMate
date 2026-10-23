/**
 * agy's numbered screens are not answered unless something vouches for them
 * (Issue #3818).
 *
 * #3808 declined agy screens the permission reader would not read by listing
 * what was wrong with them (`isAntigravityUnansweredNumberedScreen`), and the
 * list had holes: a run with a number missing (`> 1.` / `3.`) went back to the
 * generic multiple-choice parser, whose single-gap tolerance (S3-010, `[1,3]`)
 * reads it as an answerable prompt. #3818 turns the rule around — the generic
 * reading of an agy numbered screen is kept only for `/feedback` and for a
 * reply's plain `1. … N.` list (#1928's legacy reading); everything else is no
 * prompt.
 *
 * The frames are `antigravity-live-2364/dialog-bash-oneline.txt` (agy 1.1.27,
 * live) with rows removed, written to a temp dir and read back — the shapes a
 * pane that lost rows would show, not screens imagined from scratch. Each is
 * driven through the three entries that could send a key: the shared entry
 * (`detectPromptOnCleanFrame`), the `/prompt-response` route, and the real
 * Auto-Yes poller (`detectAndRespondToPrompt`, with agy's hook receipt in hand
 * so the receipt gate #2849 is not what declines it). The status verdict is not
 * one of them: whether a human is waiting keeps #3808's rule.
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Issue #2865: the poller answers only a session created in the worktree's own
// directory. Ownership itself is covered by tests/unit/tmux/session-ownership.test.ts.
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: vi.fn(async () => ({ verdict: 'owned', sessionPath: null })),
}));
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string }) => {});
vi.mock('@/lib/prompt-answer-sender', async (importOriginal) => {
  // `PromptAnswerRejectedError` is caught by name in the route, so the real
  // class has to survive the mock; only the send is replaced.
  const actual = await importOriginal<typeof import('@/lib/prompt-answer-sender')>();
  return {
    ...actual,
    sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
  };
});

const captured = vi.fn<() => string>(() => '');
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => captured()),
  captureSessionOutputFresh: vi.fn(async () => captured()),
  isSessionRunning: vi.fn(async () => true),
}));

vi.mock('@/lib/polling/response-poller', () => ({ startPolling: vi.fn() }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: vi.fn().mockResolvedValue(undefined),
  broadcastTerminalSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        name: 'Antigravity',
        isRunning: async () => true,
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `cm-${worktreeId}-${instanceId ?? 'antigravity'}`,
      }),
    }),
  },
}));
// The structured layer (#1898) answers over the agent's own API and returns
// before any keystroke. Declined here so the KEYSTROKE path — the one that
// reads the frame — is the path under test.
vi.mock('@/lib/hooks/structured-decision-response', () => ({
  answerStructuredDecision: vi.fn().mockResolvedValue({
    kind: 'not-applicable',
    reason: 'no-pending-decision',
  }),
}));
vi.mock('@/lib/session/agent-event-state', () => ({ getAskUserQuestion: vi.fn(() => null) }));
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

import { POST as promptResponse } from '@/app/api/worktrees/[id]/prompt-response/route';
import { buildDetectPromptOptions, stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectPrompt } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import {
  isAntigravityUnansweredNumberedScreen,
  isAntigravityUnvouchedNumberedScreen,
  readAntigravityNumberedDialog,
} from '@/lib/detection/tools/antigravity/dialog';
import { detectPromptOnCleanFrame } from '@/lib/polling/response-checker';
import { detectAndRespondToPrompt, type AutoYesPollerState } from '@/lib/auto-yes-poller';
import { upsertWorktree } from '@/lib/db';
import {
  recordAntigravityPermissionReceipt,
  resetAntigravityPermissionReceiptsForTests,
} from '@/lib/polling/antigravity-permission-receipts';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import { clearAutoYesPolicyCache } from '@/lib/polling/auto-yes-policy';

const WT = 'wt-3818';
const FIXTURES = path.resolve(__dirname, '../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** agy 1.1.27's measured Bash approval: question, `> 1. Yes` … `4. No`, `tab Amend` footer. */
const PERMISSION = read('antigravity-live-2364/dialog-bash-oneline.txt');

/** The frame exactly as `captureAndCleanOutput` hands it to `detectAndRespondToPrompt`. */
const asPollerSees = (raw: string): string => stripBoxDrawing(stripAnsi(raw));

/** Index of the first row of `rows` whose ANSI-stripped text matches `pattern`. */
function rowOf(rows: readonly string[], pattern: RegExp): number {
  const index = rows.findIndex(row => pattern.test(stripAnsi(row)));
  if (index < 0) throw new Error(`no row matches ${pattern}`);
  return index;
}

/**
 * The live frame with rows removed. `keep` gets the rows and the indexes of
 * option 1, option 2 and the footer, and returns what is left on screen.
 */
type Cut = (rows: string[], at: { option1: number; option2: number; footer: number }) => string[];

const NOT_ANSWERED: ReadonlyArray<readonly [string, Cut]> = [
  ['a number missing (`> 1.` / `3.` / `4.`), footer on screen', (rows, at) =>
    rows.filter((_, i) => i !== at.option2)],
  ['a number missing, footer below the pane', (rows, at) =>
    rows.slice(0, at.footer).filter((_, i) => i !== at.option2)],
  ['the `>` row pushed off the top, options 2 onward and the footer left', (rows, at) =>
    rows.slice(at.option1 + 1)],
  ['the `>` row pushed off the top and the footer below the pane (options 2 onward only)', (rows, at) =>
    rows.slice(at.option1 + 1, at.footer)],
  ['the footer below the pane', (rows, at) => rows.slice(0, at.footer)],
];

let tmp: string;

/** The live frame cut by `cut`, written to the temp dir and read back. */
function variant(name: string, cut: Cut): string {
  const rows = PERMISSION.split('\n');
  const at = {
    option1: rowOf(rows, /^\s*>\s*1\.\s/),
    option2: rowOf(rows, /^\s*2\.\s/),
    footer: rowOf(rows, /↑\/↓ Navigate/),
  };
  const edited = cut(rows, at).join('\n');
  if (edited === PERMISSION) throw new Error(`${name}: the cut removed nothing`);
  const file = path.join(tmp, `${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.txt`);
  writeFileSync(file, edited);
  return readFileSync(file, 'utf8');
}

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

/** Drive the real poller over one frame, with agy's hook receipt in hand. */
async function autoYes(raw: string): Promise<string> {
  recordAntigravityPermissionReceipt(WT, 'antigravity', 'antigravity', 'run_command');
  const clean = asPollerSees(raw);
  return detectAndRespondToPrompt(WT, pollerState(), 'antigravity', clean, clean.split('\n'), 'antigravity', raw);
}

/** Drive the `/prompt-response` route over one frame. */
async function respond(raw: string): Promise<{ status: number; body: Record<string, unknown> }> {
  captured.mockReturnValue(raw);
  const res = await promptResponse(
    { json: async () => ({ answer: '1', cliTool: 'antigravity' }) } as unknown as NextRequest,
    { params: Promise.resolve({ id: WT }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cm-3818-'));
  db = new Database(':memory:');
  runMigrations(db);
  upsertWorktree(db, {
    id: WT,
    name: 'agy-3818',
    path: '/tmp/agy-3818',
    branch: 'fix/3818',
    repositoryPath: '/tmp/agy-3818-repo',
    repositoryName: 'agy-3818-repo',
    cliToolId: 'antigravity',
  });
  vi.clearAllMocks();
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  clearAutoYesPolicyCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetAntigravityPermissionReceiptsForTests();
  clearPolicySuppressions();
  db.close();
});

describe('[#3818] the hole: the generic parser answers a run with a number missing', () => {
  it('reads `> 1.` / `3.` / `4.` as a multiple_choice prompt, and agy\'s reader declines it', () => {
    const clean = asPollerSees(variant('gap', NOT_ANSWERED[0][1]));
    expect(readAntigravityNumberedDialog(clean.split('\n'))).toBeNull();
    const generic = detectPrompt(clean, buildDetectPromptOptions('antigravity'));
    expect(generic.promptData?.type).toBe('multiple_choice');
    if (generic.promptData?.type !== 'multiple_choice') throw new Error('shape');
    expect(generic.promptData.options.map(o => o.number)).toEqual([1, 3, 4]);
  });
});

describe('[#3818] numbered agy screens nothing vouches for get no answer (negative)', () => {
  it.each(NOT_ANSWERED)('%s: unanswered', (label, cut) => {
    expect(isAntigravityUnansweredNumberedScreen(asPollerSees(variant(label, cut)))).toBe(true);
  });

  it.each(NOT_ANSWERED)('%s: the shared entry reads no prompt', (label, cut) => {
    const raw = variant(label, cut);
    const clean = asPollerSees(raw);
    const result = detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw);
    expect(result.isPrompt).toBe(false);
    expect(result.promptData).toBeUndefined();
  });

  it.each(NOT_ANSWERED)('%s: /prompt-response refuses and sends no key', async (label, cut) => {
    // The route's #161 refusal contract: 200 with `success: false`.
    const { status, body } = await respond(variant(label, cut));
    expect(status).toBe(200);
    expect(body).toEqual({ success: false, reason: 'prompt_no_longer_active', answer: '1' });
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it.each(NOT_ANSWERED)('%s: the Auto-Yes poller sends nothing', async (label, cut) => {
    expect(await autoYes(variant(label, cut))).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('the status verdict keeps #3808\'s narrower rule: a `❯` list still reads as someone waiting', () => {
    // "Not answered" is the rule of the surfaces that send a key, not of the
    // status verdict (the sidebar's waiting, the push): the frame
    // `tests/unit/session/opencode-v2-body-numbered-list-2991.test.ts` pins as
    // waiting is declined for answering and still published as a prompt.
    const frame = ['Pick one:', '❯ 1. Yes', '  2. No', ''].join('\n');
    expect(isAntigravityUnansweredNumberedScreen(frame)).toBe(true);
    expect(isAntigravityUnvouchedNumberedScreen(frame)).toBe(false);
    const status = detectSessionStatus(frame, 'antigravity');
    expect(status.status).toBe('waiting');
    expect(status.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
  });
});

/**
 * The cursor below what the pane shows (#3818 review): the footer is off the
 * pane and so is the `>` row (option 3 or 4), so the rows left — `1.`, `2.`
 * (`3.`), none wearing `>` — have the shape of a reply's list. What tells them
 * apart is agy's permission heading above them.
 */
const CURSOR_BELOW: ReadonlyArray<readonly [string, () => string]> = [
  ['dialog-bash-oneline, `>` on 4, cut after option 3', () => cursorOnFourCutAfter(3)],
  ['dialog-bash-oneline, `>` on 4, cut after option 2', () => cursorOnFourCutAfter(2)],
  ['dialog-bash-wrapped-highlight-4, cut after option 2', () => {
    const raw = read('antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt');
    const rows = raw.split('\n');
    return writeVariant('highlight-4-cut-after-2', rows.slice(0, rowOf(rows, /^\s*3\.\s/)).join('\n'));
  }],
];

function writeVariant(name: string, edited: string): string {
  const file = path.join(tmp, `${name}.txt`);
  writeFileSync(file, edited);
  return readFileSync(file, 'utf8');
}

/** dialog-bash-oneline with the `>` moved from option 1 to option 4, then the rows from `next.` down dropped. */
function cursorOnFourCutAfter(last: number): string {
  const rows = PERMISSION.split('\n');
  const one = rowOf(rows, /^\s*>\s*1\.\s/);
  const four = rowOf(rows, /^\s*4\.\s/);
  const moved = rows.map((row, i) =>
    i === one ? row.replace('> 1.', '  1.') : i === four ? row.replace('  4.', '> 4.') : row);
  if (moved[one] === rows[one] || moved[four] === rows[four]) throw new Error('the cursor did not move');
  const cut = rowOf(moved, new RegExp(`^\\s*>?\\s*${last + 1}\\.\\s`));
  return writeVariant(`cursor-4-cut-after-${last}`, moved.slice(0, cut).join('\n'));
}

describe('[#3818] the cursor below the visible options: no answer (negative)', () => {
  it.each(CURSOR_BELOW)('%s: no `>` and no footer are left on screen', (_label, make) => {
    const clean = asPollerSees(make());
    expect(clean).not.toMatch(/^\s*>\s*\d+\./m);
    expect(clean).not.toContain('↑/↓');
    expect(isAntigravityUnansweredNumberedScreen(clean)).toBe(true);
  });

  it.each(CURSOR_BELOW)('%s: the shared entry reads no prompt', (_label, make) => {
    const raw = make();
    const clean = asPollerSees(raw);
    const result = detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw);
    expect(result.isPrompt).toBe(false);
    expect(result.promptData).toBeUndefined();
  });

  it.each(CURSOR_BELOW)('%s: /prompt-response refuses and sends no key', async (_label, make) => {
    const { status, body } = await respond(make());
    expect(status).toBe(200);
    expect(body).toEqual({ success: false, reason: 'prompt_no_longer_active', answer: '1' });
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it.each(CURSOR_BELOW)('%s: the Auto-Yes poller sends nothing', async (_label, make) => {
    expect(await autoYes(make())).toBe('no_prompt');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('a reply list with no permission heading above it is still answered (control)', () => {
    const reply = ['  Here are the options:', '', '  1. Keep the branch', '  2. Rebase onto develop', '', '  Which one?'].join('\n');
    expect(isAntigravityUnansweredNumberedScreen(reply)).toBe(false);
    expect(detectPromptOnCleanFrame(reply, 'antigravity').isPrompt).toBe(
      detectPrompt(reply, buildDetectPromptOptions('antigravity')).isPrompt,
    );
  });
});

describe('[#3818] screens that are vouched for are still answered (positive)', () => {
  it.each([
    'antigravity-live-2364/dialog-bash-oneline.txt',
    'antigravity-live-2364/dialog-create-file.txt',
  ])('%s (agy 1.1.27 permission dialog): every entry answers `1`', async (rel) => {
    const raw = read(rel);
    const clean = asPollerSees(raw);
    expect(isAntigravityUnansweredNumberedScreen(clean)).toBe(false);
    expect(detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw).isPrompt).toBe(true);

    const { status, body } = await respond(raw);
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    sendPromptAnswer.mockClear();
    expect(await autoYes(raw)).toBe('responded');
    expect(sendPromptAnswer.mock.calls.map(([p]) => p.answer)).toEqual(['1']);
  });

  it('`/feedback` keeps the generic reading on every entry', async () => {
    const raw = read('antigravity-live-2364/dialog-feedback-category.txt');
    const clean = asPollerSees(raw);
    expect(isAntigravityUnansweredNumberedScreen(clean)).toBe(false);
    expect(detectPromptOnCleanFrame(clean, 'antigravity', clean.split('\n'), raw).isPrompt).toBe(true);

    const { status, body } = await respond(raw);
    expect(status).toBe(200);
    expect(body.success).toBe(true);

    sendPromptAnswer.mockClear();
    expect(await autoYes(raw)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('a reply\'s `1. / 2. / 3.` list with no cursor keeps #1928\'s legacy reading', () => {
    // The shape `auto-yes-unclassified-frame-1928.test.ts` pins as answered on
    // agy (`legacy` in the rollout table): no `>` on any option, no number
    // missing, no `↑/↓` footer under it.
    const reply = [
      '⏺ Here are the options:',
      '',
      '  1. On-premises (self-hosted) deployment',
      '  2. Cloud-managed platform',
      '  3. Containerized deployment with Kubernetes',
      '',
      '  Which one do you want?',
    ].join('\n');
    expect(isAntigravityUnansweredNumberedScreen(reply)).toBe(false);
    expect(detectPromptOnCleanFrame(reply, 'antigravity')).toEqual(
      detectPrompt(reply, buildDetectPromptOptions('antigravity')),
    );
  });

  it('a reply list that wears the `>` cursor, or misses a number, is no longer the reply shape', () => {
    const base = ['  Here are the options:', '', '  1. Keep the branch', '  2. Rebase onto develop', '  3. Squash', '', '  Which one?'];
    const cursor = base.map(row => row.replace('  1. Keep', '> 1. Keep'));
    const gap = base.filter(row => !row.includes('2. Rebase'));
    expect(isAntigravityUnansweredNumberedScreen(base.join('\n'))).toBe(false);
    expect(isAntigravityUnansweredNumberedScreen(cursor.join('\n'))).toBe(true);
    expect(isAntigravityUnansweredNumberedScreen(gap.join('\n'))).toBe(true);
  });
});
