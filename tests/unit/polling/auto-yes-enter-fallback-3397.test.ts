/**
 * Auto-Yes sends ONE Enter to a choice screen CommandMate cannot read
 * (Issue #3397).
 *
 * Driven through the real `detectAndRespondToPrompt`, with the transport
 * stubbed at both ends, and asserted on the keystroke the agent would receive:
 * `sendSpecialKeys(session, ['Enter'])`. `sendPromptAnswer` (the digit path) is
 * asserted NOT to be used, so a frame that slipped past the dialog gate cannot
 * pass for this feature.
 *
 * The frames, each one the Issue's acceptance criteria name:
 *
 *  - claude, `unsupported_dialog_layout`: the #2486 picker caught without its
 *    bottom border (the frame `prompt-response-askuserquestion-2486.test.ts`
 *    uses for the same refusal);
 *  - claude / codex, `prompt_no_longer_active` with the input box off screen:
 *    a numbered list under a cursor, which the tool's `detectDialog` declines;
 *  - the #1896 shape with the input box ON screen — empty, ghost, holding text —
 *    and the live #2457 / #2997 reply captures: nothing is sent;
 *  - the #2457 reply caught mid-repaint (`no_composer` for one tick): nothing
 *    is sent, because the Enter needs the screen on two ticks in a row.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ownership = vi.fn(async (): Promise<{ verdict: string; sessionPath: string | null } | null> => ({
  verdict: 'owned',
  sessionPath: null,
}));
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: () => ownership(),
}));

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const sendPromptAnswer = vi.fn(async (_params: { answer: string; promptData?: PromptData }) => {});
vi.mock('@/lib/prompt-answer-sender', () => ({
  sendPromptAnswer: (params: unknown) => sendPromptAnswer(params as { answer: string }),
}));

const sendSpecialKeys = vi.fn(async (_session: string, _keys: string[]) => {});
vi.mock('@/lib/tmux/tmux', () => ({
  sendSpecialKeys: (session: string, keys: string[]) => sendSpecialKeys(session, keys),
}));

let policy: AutoYesPolicy | null = null;
vi.mock('@/lib/polling/auto-yes-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/auto-yes-policy')>();
  return { ...actual, getSessionAutoYesPolicy: () => policy };
});

const recordAnsweredPrompt = vi.fn();
vi.mock('@/lib/db/chat-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/chat-db')>();
  return {
    ...actual,
    recordAnsweredPrompt: (...args: Parameters<typeof actual.recordAnsweredPrompt>) => {
      recordAnsweredPrompt(...args);
      return actual.recordAnsweredPrompt(...args);
    },
  };
});

vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn(async () => '') }));
const startPolling = vi.fn();
vi.mock('@/lib/polling/response-poller', () => ({ startPolling: (...a: unknown[]) => startPolling(...a) }));
const broadcastAfterInteraction = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshotAfterInteraction: (...a: unknown[]) => broadcastAfterInteraction(...a),
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
const warn = vi.fn();
const info = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const self: Record<string, unknown> = {
      debug: vi.fn(),
      info: (...args: unknown[]) => info(...args),
      warn: (...args: unknown[]) => warn(...args),
      error: vi.fn(),
    };
    self.withContext = () => self;
    return self;
  },
}));

import {
  AUTO_YES_ENTER_FALLBACK_ANSWER,
  detectAndRespondToPrompt,
  type AutoYesPollerState,
} from '@/lib/auto-yes-poller';
import { POLLING_INTERVAL_MS, DUPLICATE_RETRY_EXPIRY_MS } from '@/lib/auto-yes-state';
import { clearPolicySuppressions, getLastPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import {
  AUTO_YES_ENTER_FALLBACK_ENV_VAR,
  clearEnterFallbacks,
  getLastEnterFallback,
  judgeEnterFallback,
} from '@/lib/polling/auto-yes-enter-fallback';
import {
  assessPromptAnswerability,
  PROMPT_NO_LONGER_ACTIVE_REASON,
  UNSUPPORTED_DIALOG_LAYOUT_REASON,
} from '@/lib/polling/auto-yes-dialog-gate';
import { extractComposerText } from '@/lib/detection/composer-text';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { enterFallbackScreenKey } from '@/lib/polling/auto-yes-enter-fallback';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import type { CLIToolType } from '@/lib/cli-tools/types';

const WT = 'wt-3397';
const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** claude: an AskUserQuestion picker whose bottom border is not drawn (#2486). */
const CLAUDE_UNSUPPORTED_LAYOUT = read('tests/fixtures/claude-live-2486/tabs-preview-q1.txt')
  .split('\n')
  .filter((row) => !/^\s*└─+┘\s*$/.test(row.replace(/\x1b\[[0-9;]*m/g, '')))
  .join('\n');

/** claude: a numbered list under a `❯` cursor, no input box, no dialog chrome. */
const CLAUDE_UNRECOGNISED_LIST = [
  '⏺ Pick one',
  '',
  '❯ 1. On-premises deployment',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Which one?',
].join('\n');

/** codex: the same, with codex's bold `›` on the selected row (not its composer glyph). */
const CODEX_UNRECOGNISED_LIST = [
  '  Pick a deployment target',
  '',
  '\x1b[1m\x1b[38;5;6m› 1. On-premises deployment\x1b[0m',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Press space to choose',
].join('\n');

/** The #1896 shape (an agent's reply listing options), with no cursor. */
const AGENT_WROTE_A_LIST = [
  '⏺ Here are the options:',
  '',
  '  1. On-premises (self-hosted) deployment',
  '  2. Cloud-managed platform',
  '  3. Containerized deployment with Kubernetes',
  '',
  '  Which one do you want?',
].join('\n');

/** The bottom `rows` rows of a live claude capture: its input box and status row. */
function claudeComposerTail(name: string, rows = 6): string {
  const lines = read(`tests/unit/lib/detection/fixtures/claude-live-1879/${name}.txt`)
    .replace(/\n+$/, '')
    .split('\n');
  return lines.slice(-rows).join('\n');
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
function tick(state: AutoYesPollerState, raw: string, withRaw = true): Promise<string> {
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(
    WT,
    state,
    state.cliToolId,
    clean,
    clean.split('\n'),
    undefined,
    withRaw ? raw : undefined,
  );
}

/** `n` ticks over the same frame; the results in order. */
async function ticks(state: AutoYesPollerState, raw: string, n: number): Promise<string[]> {
  const results: string[] = [];
  for (let i = 0; i < n; i++) results.push(await tick(state, raw));
  return results;
}

/** Let the duplicate guard (#306) expire, as the clock would. */
function expireDuplicateGuard(state: AutoYesPollerState): void {
  if (state.lastAnsweredAt !== null) state.lastAnsweredAt -= DUPLICATE_RETRY_EXPIRY_MS + 1;
}

const enterCalls = () => sendSpecialKeys.mock.calls.filter(([, keys]) => keys.length === 1 && keys[0] === 'Enter');

const originalEnv = process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  ownership.mockImplementation(async () => ({ verdict: 'owned', sessionPath: null }));
  policy = null;
  clearPolicySuppressions();
  clearEnterFallbacks();
  delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
});

afterEach(() => {
  db.close();
  clearPolicySuppressions();
  clearEnterFallbacks();
  if (originalEnv === undefined) delete process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR];
  else process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = originalEnv;
});

// ---------------------------------------------------------------------------
// The frames are what the tests say they are
// ---------------------------------------------------------------------------

describe('[#3397] the fixtures read as the Issue describes them', () => {
  it('claude, picker without its bottom border: unsupported_dialog_layout, no input box', () => {
    expect(assessPromptAnswerability('claude', CLAUDE_UNSUPPORTED_LAYOUT).refusal?.reason).toBe(
      UNSUPPORTED_DIALOG_LAYOUT_REASON,
    );
    expect(extractComposerText(CLAUDE_UNSUPPORTED_LAYOUT, 'claude').state).toBe('no_composer');
  });

  it.each([
    ['claude', CLAUDE_UNRECOGNISED_LIST],
    ['codex', CODEX_UNRECOGNISED_LIST],
  ] as const)('%s, unrecognised list: prompt_no_longer_active, no input box', (tool, raw) => {
    expect(assessPromptAnswerability(tool, raw).refusal?.reason).toBe(PROMPT_NO_LONGER_ACTIVE_REASON);
    expect(extractComposerText(raw, tool).state).toBe('no_composer');
  });

  it.each(['composer-empty', 'composer-ghost-suggestion', 'composer-residual-plain'])(
    'the #1896 list above a live claude input box (%s) is refused and shows the box',
    (name) => {
      const raw = `${AGENT_WROTE_A_LIST}\n\n${claudeComposerTail(name)}`;
      expect(assessPromptAnswerability('claude', raw).refusal).not.toBeNull();
      expect(['empty', 'ghost', 'content']).toContain(extractComposerText(raw, 'claude').state);
    },
  );
});

// ---------------------------------------------------------------------------
// The Enter is sent
// ---------------------------------------------------------------------------

describe('[#3397] Enter goes to an unreadable choice screen, once', () => {
  it.each([
    ['claude', 'unsupported_dialog_layout', CLAUDE_UNSUPPORTED_LAYOUT],
    ['claude', 'prompt_no_longer_active', CLAUDE_UNRECOGNISED_LIST],
    ['codex', 'prompt_no_longer_active', CODEX_UNRECOGNISED_LIST],
  ] as const)('%s, %s: one Enter, never a digit', async (tool, refusalReason, raw) => {
    const state = pollerState(tool);

    // First sight: not yet (a frame caught mid-repaint must not get an Enter).
    expect(await tick(state, raw)).toBe('no_answer');
    expect(enterCalls()).toHaveLength(0);

    // Second tick, same screen: the Enter.
    expect(await tick(state, raw)).toBe('responded');
    expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
    expect(sendSpecialKeys).toHaveBeenCalledWith(`cm-${WT}-${tool}`, ['Enter']);
    expect(sendPromptAnswer).not.toHaveBeenCalled();

    const record = getLastEnterFallback(WT, tool);
    expect(record).toMatchObject({ outcome: 'sent', promptType: 'multiple_choice', refusalReason });
  });

  it('the record names the screen the status API publishes, so the window can say so', async () => {
    // The prompt window shows "Auto-Yes sent Enter" only for a record whose
    // screen matches the prompt `current-output` publishes. The poller and the
    // status chain read different row counts; the key must survive that.
    const status = detectSessionStatus(CLAUDE_UNSUPPORTED_LAYOUT, 'claude');
    expect(status.hasActivePrompt).toBe(true);
    expect(assessPromptAnswerability('claude', CLAUDE_UNSUPPORTED_LAYOUT).refusal).not.toBeNull();

    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNSUPPORTED_LAYOUT, 2);
    expect(getLastEnterFallback(WT, 'claude')?.screenKey).toBe(
      enterFallbackScreenKey(status.promptDetection.promptData!),
    );
  });

  it('does what an answered prompt does afterwards: audit row, response poller, push', async () => {
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 2);

    expect(recordAnsweredPrompt).toHaveBeenCalledTimes(1);
    expect(recordAnsweredPrompt.mock.calls[0][1]).toMatchObject({
      answer: AUTO_YES_ENTER_FALLBACK_ANSWER,
      answeredBy: 'auto',
    });
    expect(AUTO_YES_ENTER_FALLBACK_ANSWER).not.toMatch(/^\d+$/);
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(broadcastAfterInteraction).toHaveBeenCalledTimes(1);
    expect(state.lastAnsweredPromptKey).not.toBeNull();
    expect(info.mock.calls.some(([event]) => event === 'poller:auto-yes-enter-fallback-sent')).toBe(true);
  });

  it('the screen still up after the Enter: no second Enter, and `no-effect` is recorded', async () => {
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNSUPPORTED_LAYOUT, 2);
    expect(enterCalls()).toHaveLength(1);

    // Inside the duplicate guard's window: untouched.
    expect(await tick(state, CLAUDE_UNSUPPORTED_LAYOUT)).toBe('duplicate');

    // Past it, the same screen, many times over: never another Enter.
    expireDuplicateGuard(state);
    expect(await ticks(state, CLAUDE_UNSUPPORTED_LAYOUT, 3)).toEqual(['no_answer', 'no_answer', 'no_answer']);
    expect(enterCalls()).toHaveLength(1);

    expect(getLastEnterFallback(WT, 'claude')?.outcome).toBe('no-effect');
    expect(warn.mock.calls.some(([event]) => event === 'poller:auto-yes-enter-fallback-no-effect')).toBe(true);
  });

  it('the same screen after a frame with no prompt is still not sent a second Enter', async () => {
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 2);
    await tick(state, 'just some output\n');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 3);
    expect(enterCalls()).toHaveLength(1);
  });

  it('a different screen afterwards gets its own Enter', async () => {
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 2);
    await tick(state, 'just some output\n');
    const other = CLAUDE_UNRECOGNISED_LIST.replace('Kubernetes', 'Bare metal');
    await ticks(state, other, 2);
    expect(enterCalls()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The Enter is NOT sent
// ---------------------------------------------------------------------------

describe('[#3397] nothing is sent where the input box is on screen (#1896)', () => {
  it.each(['composer-empty', 'composer-ghost-suggestion', 'composer-residual-plain'])(
    'claude reply list above the input box (%s)',
    async (name) => {
      const state = pollerState('claude');
      const raw = `${AGENT_WROTE_A_LIST}\n\n${claudeComposerTail(name)}`;
      await ticks(state, raw, 3);
      expect(sendSpecialKeys).not.toHaveBeenCalled();
      expect(sendPromptAnswer).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['claude', 'tests/fixtures/claude-idle-numbered-list-2457/live-2997/claude-reply-numbered-list-21284.txt'],
    ['claude', 'tests/fixtures/claude-idle-numbered-list-2457/reply-numbered-list-composer-text.txt'],
    ['codex', 'tests/fixtures/claude-idle-numbered-list-2457/live-2997/codex-reply-numbered-list-01571.txt'],
    ['codex', 'tests/fixtures/claude-idle-numbered-list-2457/live-2997/codex-reply-dialog-glyph-01571.txt'],
    ['codex', 'tests/fixtures/codex-dialogs-0157/quoted-approval-idle.txt'],
  ] as const)('%s live reply %s', async (tool, rel) => {
    const state = pollerState(tool);
    await ticks(state, read(rel), 3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('the #2457 reply caught before its footer was redrawn, then redrawn', async () => {
    // `no_composer` on the first tick only: the stability rule is what keeps it.
    const repaint = read('tests/fixtures/claude-idle-numbered-list-2457/reply-numbered-list-repaint.txt');
    const idle = read('tests/fixtures/claude-idle-numbered-list-2457/reply-numbered-list-idle.txt');
    const state = pollerState('claude');
    await tick(state, repaint);
    await tick(state, idle);
    await tick(state, repaint);
    await tick(state, idle);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('the #2457 reply mid-stream (the agent is still generating)', async () => {
    const raw = read('tests/fixtures/claude-idle-numbered-list-2457/reply-numbered-list-generating-repaint.txt');
    const state = pollerState('claude');
    await ticks(state, raw, 3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });
});

describe('[#3397] the contract policy still decides', () => {
  const base: AutoYesPolicy = { mode: null, allowPromptTypes: [], denyPatterns: [] };

  it.each([
    ['mode: off', { ...base, mode: 'off' as const }, 'mode-off'],
    ['mode: safe', { ...base, mode: 'safe' as const }, 'type-not-allowed'],
    ['allow-listed without multiple_choice', { ...base, mode: 'allow-listed' as const, allowPromptTypes: ['yes_no' as const] }, 'type-not-allowed'],
    ['a deny pattern on an option', { ...base, denyPatterns: ['Kubernetes'] }, 'deny-pattern'],
    ['a deny pattern on the question', { ...base, denyPatterns: ['Which one'] }, 'deny-pattern'],
  ])('%s: nothing is sent, and the reason is recorded', async (_label, p, reason) => {
    policy = p;
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')?.reason).toBe(reason);
    expect(getLastEnterFallback(WT, 'claude')).toBeNull();
  });

  it.each([
    ['allow-listed with multiple_choice', { ...base, mode: 'allow-listed' as const, allowPromptTypes: ['multiple_choice' as const] }],
    ['a deny pattern that does not match', { ...base, denyPatterns: ['rm -rf'] }],
  ])('control — %s: the Enter is sent', async (_label, p) => {
    policy = p;
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 2);
    expect(enterCalls()).toHaveLength(1);
  });
});

describe('[#3397] other guards', () => {
  it.each([
    ['foreign', { verdict: 'foreign', sessionPath: '/elsewhere' }],
    ['worktree_not_found', null],
  ] as const)('another server\'s session (%s): nothing is sent', async (_label, verdict) => {
    ownership.mockImplementation(async () => verdict);
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(getLastEnterFallback(WT, 'claude')).toBeNull();
  });

  it.each([
    ['launch dialog (update available)', 'tests/fixtures/codex-update-dialog-2068/update-dialog-01491.txt'],
    ['/model picker', 'tests/fixtures/codex-dialogs-0157/model-picker.txt'],
    ['/model picker, effort stage', 'tests/fixtures/codex-dialogs-0157/model-picker-effort.txt'],
  ])('codex %s: the existing exclusion wins, nothing is sent', async (_label, rel) => {
    const state = pollerState('codex');
    await ticks(state, read(rel), 3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(sendPromptAnswer).not.toHaveBeenCalled();
  });

  it('without the raw capture the composer cannot be read: nothing is sent', async () => {
    const state = pollerState('claude');
    await tick(state, CLAUDE_UNRECOGNISED_LIST, false);
    await tick(state, CLAUDE_UNRECOGNISED_LIST, false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    // Recorded exactly as before #3397.
    expect(getLastPolicySuppression(WT, 'claude')?.reason).toBe('unclassified-frame');
  });

  it.each(['claude=disabled', '*=disabled'])('%s in %s: nothing is sent', async (value) => {
    process.env[AUTO_YES_ENTER_FALLBACK_ENV_VAR] = value;
    const state = pollerState('claude');
    await ticks(state, CLAUDE_UNRECOGNISED_LIST, 3);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(getLastPolicySuppression(WT, 'claude')?.reason).toBe('unclassified-frame');
  });
});

describe('[#3397] judgeEnterFallback', () => {
  /** An environment with no switch set. */
  const NO_ENV = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  it.each(['copilot', 'opencode', 'opencode-v2', 'gemini', 'antigravity', 'vibe-local', 'command-code'] as const)(
    '%s is disabled by default',
    (tool) => {
      expect(judgeEnterFallback(tool, CLAUDE_UNRECOGNISED_LIST, NO_ENV)).toMatchObject({
        eligible: false,
        reason: 'tool-disabled',
      });
    },
  );

  it('the env switch enables a disabled tool, and a specific entry beats `*`', () => {
    expect(
      judgeEnterFallback('claude', CLAUDE_UNRECOGNISED_LIST, {
        ...NO_ENV,
        [AUTO_YES_ENTER_FALLBACK_ENV_VAR]: '*=disabled,claude=enabled',
      }).eligible,
    ).toBe(true);
    expect(
      judgeEnterFallback('claude', CLAUDE_UNRECOGNISED_LIST, {
        ...NO_ENV,
        [AUTO_YES_ENTER_FALLBACK_ENV_VAR]: 'claude=bogus',
      }).eligible,
    ).toBe(true);
  });

  it.each(['composer-empty', 'composer-ghost-suggestion', 'composer-residual-plain'])(
    'an input box on screen (%s) refuses even a refused frame',
    (name) => {
      const raw = `${AGENT_WROTE_A_LIST}\n\n${claudeComposerTail(name)}`;
      expect(judgeEnterFallback('claude', raw, NO_ENV)).toMatchObject({ eligible: false, reason: 'composer-visible' });
    },
  );

  it('an answerable frame is not this module\'s case', () => {
    const raw = read('tests/unit/lib/detection/fixtures/claude-live-1708/bash-approval-taskpanel.txt');
    expect(judgeEnterFallback('claude', raw, NO_ENV)).toMatchObject({ eligible: false, reason: 'answerable' });
  });

  it('a list above a shell prompt (the agent exited) is refused', () => {
    const raw = read('tests/fixtures/tool-liveness-2070/codex-exited-01491.txt');
    expect(judgeEnterFallback('codex', raw, NO_ENV)).toMatchObject({ eligible: false, reason: 'tool-exited' });
  });

  it('a list while the agent is generating is refused', () => {
    const raw = read('tests/fixtures/claude-idle-numbered-list-2457/reply-numbered-list-generating-repaint.txt');
    expect(judgeEnterFallback('claude', raw, NO_ENV)).toMatchObject({ eligible: false, reason: 'thinking' });
  });

  it('control: the three screens of the Issue are eligible', () => {
    expect(judgeEnterFallback('claude', CLAUDE_UNSUPPORTED_LAYOUT, NO_ENV).eligible).toBe(true);
    expect(judgeEnterFallback('claude', CLAUDE_UNRECOGNISED_LIST, NO_ENV).eligible).toBe(true);
    expect(judgeEnterFallback('codex', CODEX_UNRECOGNISED_LIST, NO_ENV).eligible).toBe(true);
  });
});
