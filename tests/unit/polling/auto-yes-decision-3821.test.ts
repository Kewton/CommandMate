/**
 * Auto-Yes's decision about the confirmation on screen (Issue #3821, Codex
 * review T1–T3): made by the poller's tick, tied to the grant, the session
 * epoch and the screen it was made for, and published by
 * `publishAutoYesDecision` for `current-output`.
 *
 *  - the record alone (`publishAutoYesDecision`): every way a record stops
 *    being about the prompt on screen reads `none`, never `answering`; a grant
 *    with no poller reads `withheld` (`server-poller-inactive`);
 *  - the tick (`detectAndRespondToPrompt` with its generation, the real grant
 *    and poller): `answering` from the send on, `withheld` with the step's
 *    reason, nothing for a frame with no prompt; a disable → enable or an
 *    expiry with the same screen up drops the old decision before the next
 *    tick decides again;
 *  - the concurrent poller limit: an instance the poller refused shows its
 *    confirmation as `withheld` (`server-poller-inactive`).
 *
 * Transport stubbed at both ends, as in `auto-yes-enter-fallback-3397.test.ts`.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Held open by a test while the state moves under a tick waiting on it. */
let ownershipGate: Promise<void> | null = null;
vi.mock('@/lib/cli-tools/worktree-session-ownership', () => ({
  checkWorktreeSessionOwnership: async () => {
    if (ownershipGate) await ownershipGate;
    return { verdict: 'owned', sessionPath: null };
  },
}));

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { PromptData } from '@/types/models';
import type { AutoYesPolicy } from '@/lib/polling/auto-yes-resolver';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

/** Runs inside the send, so a test can read what is published mid-send. */
let duringSend: (params: { stillCurrent?: () => boolean }) => void = () => {};
const sendPromptAnswer = vi.fn(
  async (params: { answer: string; promptData?: PromptData; stillCurrent?: () => boolean }) => {
    duringSend(params);
  },
);
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
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(async () => ''),
  captureSessionOutputFresh: vi.fn(async () => ''),
  getSessionPresence: vi.fn(async () => 'present'),
}));
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

import {
  clearAllPollerStates,
  detectAndRespondToPrompt,
  isPollerActive,
  startAutoYesPolling,
  stopAllAutoYesPolling,
  stopAutoYesPolling,
  type AutoYesPollerState,
  type AutoYesTickGeneration,
} from '@/lib/auto-yes-poller';
import {
  buildCompositeKey,
  clearAllAutoYesStates,
  disableAutoYes,
  getAutoYesState,
  MAX_CONCURRENT_POLLERS,
  setAutoYesEnabled,
  type AutoYesState,
} from '@/lib/auto-yes-state';
import {
  AUTO_YES_DECISION_STALE_MS,
  clearAutoYesDecisions,
  forgetAutoYesDecision,
  getAutoYesDecisionRecord,
  publishAutoYesDecision,
  recordAutoYesDecision,
} from '@/lib/polling/auto-yes-decision-state';
import {
  beginEnterFallbackSession,
  getEnterFallbackSessionEpoch,
} from '@/lib/polling/auto-yes-enter-fallback';
import { clearPolicySuppressions } from '@/lib/polling/auto-yes-suppression-state';
import {
  clearManualAnswers,
  getManualAnswerSeq,
  MANUAL_ANSWER_HOLD_MS,
  noteManualAnswerStarted,
} from '@/lib/polling/auto-yes-manual-answer';
import { DUPLICATE_RETRY_EXPIRY_MS } from '@/lib/auto-yes-state';
import { isAutoYesAnswering, laterAutoYesDecision } from '@/types/auto-yes-decision';
import { stripAnsi, stripBoxDrawing } from '@/lib/detection/cli-patterns';
import { detectSessionStatus } from '@/lib/detection/status-detector';

const WT = 'wt-3821';
const KEY = buildCompositeKey(WT, 'claude');
const ONE_HOUR = 3_600_000 as const;

/** A permission-shaped choice claude's rules read and Auto-Yes answers (`1`). */
const PERMISSION = 'Select an option:\n❯ 1. Yes\n  2. No';
/** A numbered list claude's dialog rules decline (#3397): left to a human. */
const UNRECOGNISED_LIST = [
  '⏺ Pick one',
  '',
  '❯ 1. On-premises deployment',
  '  2. Cloud-managed platform',
  '  3. Kubernetes',
  '',
  '  Which one?',
].join('\n');

/** claude's AskUserQuestion picker (#2486): a question, left to a human (#3822 / #3861). */
const ASK_USER_QUESTION = readFileSync(
  path.resolve(__dirname, '../../fixtures/claude-live-2486/tabs-q1.txt'),
  'utf8',
);

/** The prompt the status API publishes for a frame. */
function statusPrompt(raw: string): PromptData {
  const promptData = detectSessionStatus(raw, 'claude').promptDetection.promptData;
  if (!promptData) throw new Error('the frame carries no prompt');
  return promptData;
}

function enable(): AutoYesState {
  const grant = setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
  expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
  return grant;
}

function generationOf(state: AutoYesPollerState): AutoYesTickGeneration {
  return {
    manualAnswerSeq: getManualAnswerSeq(KEY),
    compositeKey: KEY,
    worktreeId: WT,
    cliToolId: 'claude',
    instanceId: undefined,
    pollerState: state,
    grant: getAutoYesState(WT, 'claude')!,
    sessionEpoch: getEnterFallbackSessionEpoch(KEY),
    startedAt: Date.now(),
  };
}

/** One tick of the running poller over `raw`, as `pollAutoYes` hands it over. */
function tick(raw: string): Promise<string> {
  const state = globalThis.__autoYesPollerStates!.get(KEY)!;
  const clean = stripBoxDrawing(stripAnsi(raw));
  return detectAndRespondToPrompt(WT, state, 'claude', clean, clean.split('\n'), undefined, raw, generationOf(state));
}

/** What `current-output` publishes for `raw` now. */
function published(raw: string) {
  return publishAutoYesDecision({
    compositeKey: KEY,
    grant: getAutoYesState(WT, 'claude'),
    promptData: statusPrompt(raw),
    pollerActive: isPollerActive(KEY),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_800_000_000_000);
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  duringSend = () => {};
  ownershipGate = null;
  policy = null;
  clearManualAnswers();
  clearAllAutoYesStates();
  clearAllPollerStates();
  clearPolicySuppressions();
  clearAutoYesDecisions();
});

afterEach(() => {
  stopAllAutoYesPolling();
  clearAllAutoYesStates();
  clearAutoYesDecisions();
  clearPolicySuppressions();
  db.close();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

describe('[#3821] publishAutoYesDecision: what a record is tied to', () => {
  const grantA: AutoYesState = { enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
  const prompt = (): PromptData => statusPrompt(PERMISSION);
  const record = (state: 'answering' | 'withheld', grant: AutoYesState = grantA, epoch = getEnterFallbackSessionEpoch(KEY)) =>
    recordAutoYesDecision(KEY, { state, reason: state === 'withheld' ? 'mode-off' : null, promptData: prompt(), grant, epoch });
  const publish = (overrides: Partial<Parameters<typeof publishAutoYesDecision>[0]> = {}) =>
    publishAutoYesDecision({ compositeKey: KEY, grant: grantA, promptData: prompt(), pollerActive: true, ...overrides });

  it('陽性: a record made under this grant, session and screen is published', () => {
    record('answering');
    expect(publish()).toMatchObject({ state: 'answering', reason: null });
    record('withheld');
    expect(publish()).toMatchObject({ state: 'withheld', reason: 'mode-off' });
  });

  it('no record (never judged, the ledger down, nothing observed): none — never answering', () => {
    expect(publish().state).toBe('none');
  });

  it('no prompt on screen, or Auto-Yes off: none', () => {
    record('answering');
    expect(publish({ promptData: null }).state).toBe('none');
    expect(publish({ grant: null }).state).toBe('none');
    expect(publish({ grant: { ...grantA, enabled: false } }).state).toBe('none');
  });

  it('T1: another grant object (off → on, or the expiry) with the same screen: none', () => {
    record('answering');
    expect(publish({ grant: { ...grantA } }).state).toBe('none');
  });

  it('T1: a relaunch (the session epoch moved): none', () => {
    record('answering');
    beginEnterFallbackSession(WT, 'claude');
    expect(publish().state).toBe('none');
  });

  it('another screen: none', () => {
    record('answering');
    expect(publish({ promptData: statusPrompt(UNRECOGNISED_LIST) }).state).toBe('none');
  });

  it('a record no tick refreshed for longer than the window: none', () => {
    record('answering');
    expect(publish({ now: Date.now() + AUTO_YES_DECISION_STALE_MS }).state).toBe('answering');
    expect(publish({ now: Date.now() + AUTO_YES_DECISION_STALE_MS + 1 }).state).toBe('none');
  });

  it('T3: no poller for the instance: withheld (server-poller-inactive), whatever the record said', () => {
    record('answering');
    expect(publish({ pollerActive: false })).toMatchObject({ state: 'withheld', reason: 'server-poller-inactive' });
    forgetAutoYesDecision(KEY);
    expect(publish({ pollerActive: false })).toMatchObject({ state: 'withheld', reason: 'server-poller-inactive' });
  });

  it('a forgotten record (a person answered, the poller stopped): none', () => {
    record('withheld');
    forgetAutoYesDecision(KEY);
    expect(publish().state).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

describe('[#3821] the tick decides', () => {
  it('answering from the send on, and while the answered screen is still up', async () => {
    enable();
    let midSend: string | null = null;
    duringSend = () => {
      midSend = published(PERMISSION).state;
    };
    expect(await tick(PERMISSION)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
    expect(midSend).toBe('answering');
    expect(published(PERMISSION).state).toBe('answering');

    // The duplicate guard: answered, not redrawn yet.
    expect(await tick(PERMISSION)).toBe('duplicate');
    expect(published(PERMISSION).state).toBe('answering');
  });

  it('withheld with the step’s reason: the contract', async () => {
    enable();
    policy = { mode: 'off', allowPromptTypes: [], denyPatterns: [] };
    expect(await tick(PERMISSION)).toBe('no_answer');
    expect(published(PERMISSION)).toMatchObject({ state: 'withheld', reason: 'mode-off' });
  });

  it('withheld with the step’s reason: a screen nothing here can read (no Enter)', async () => {
    enable();
    expect(await tick(UNRECOGNISED_LIST)).toBe('no_answer');
    expect(sendSpecialKeys).not.toHaveBeenCalled();
    expect(published(UNRECOGNISED_LIST)).toMatchObject({ state: 'withheld', reason: 'unclassified-frame' });
  });

  it('withheld with the step’s reason: a question to the operator (#3822, unchanged)', async () => {
    enable();
    expect(await tick(ASK_USER_QUESTION)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(published(ASK_USER_QUESTION)).toMatchObject({ state: 'withheld', reason: 'question-left-to-human' });
  });

  it('a frame with no prompt: no decision', async () => {
    enable();
    await tick(UNRECOGNISED_LIST);
    expect(getAutoYesDecisionRecord(KEY)).not.toBeNull();
    expect(await tick('just some output\n')).toBe('no_prompt');
    expect(getAutoYesDecisionRecord(KEY)).toBeNull();
  });

  it('T1: off → on with the same screen up: the old decision is not published, the next tick decides again', async () => {
    enable();
    await tick(UNRECOGNISED_LIST);
    expect(published(UNRECOGNISED_LIST).state).toBe('withheld');

    disableAutoYes(WT, 'claude');
    stopAutoYesPolling(KEY);
    enable();
    // Same screen, same session epoch — another grant.
    expect(published(UNRECOGNISED_LIST).state).toBe('none');

    await tick(UNRECOGNISED_LIST);
    expect(published(UNRECOGNISED_LIST).state).toBe('withheld');
  });

  it('T1: off → on keeps an earlier answering from being read as answering for the new grant', async () => {
    enable();
    await tick(PERMISSION);
    expect(published(PERMISSION).state).toBe('answering');

    disableAutoYes(WT, 'claude');
    enable();
    expect(published(PERMISSION).state).toBe('none');
  });

  it('T1: the grant expires with the screen up: not published as answering', async () => {
    enable();
    await tick(PERMISSION);
    expect(published(PERMISSION).state).toBe('answering');

    vi.setSystemTime(Date.now() + ONE_HOUR + 1);
    // `getAutoYesState` stores a disabled grant on the read past its window.
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(false);
    expect(published(PERMISSION).state).toBe('none');
  });

  it('a tick that lost its grant mid-send records nothing for the new one', async () => {
    enable();
    duringSend = () => {
      disableAutoYes(WT, 'claude');
      setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    };
    await tick(PERMISSION);
    // The old tick's `answering` was made under the old grant.
    expect(published(PERMISSION).state).not.toBe('answering');
  });
});

// ---------------------------------------------------------------------------
// The concurrent poller limit
// ---------------------------------------------------------------------------

describe('[#3821] T3: an instance the poller limit refused', () => {
  function fillPollers(): void {
    for (let i = 0; i < MAX_CONCURRENT_POLLERS; i++) {
      setAutoYesEnabled(`wt-fill-${i}`, 'claude', true, ONE_HOUR);
      expect(startAutoYesPolling(`wt-fill-${i}`, 'claude').started).toBe(true);
    }
  }

  it.each([
    ['the primary', undefined],
    ['an alias instance', 'claude-2'],
  ])('%s: enabled, no poller — its readable confirmation is withheld (server-poller-inactive)', (_label, instanceId) => {
    fillPollers();
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR, undefined, instanceId);
    expect(startAutoYesPolling(WT, 'claude', instanceId)).toMatchObject({
      started: false,
      reason: 'max concurrent pollers reached',
    });
    const key = buildCompositeKey(WT, 'claude', instanceId);
    expect(isPollerActive(key)).toBe(false);

    expect(
      publishAutoYesDecision({
        compositeKey: key,
        grant: getAutoYesState(WT, 'claude', instanceId),
        promptData: statusPrompt(PERMISSION),
        pollerActive: isPollerActive(key),
      }),
    ).toMatchObject({ state: 'withheld', reason: 'server-poller-inactive' });
  });

  it('control: under the limit the poller starts, and a confirmation not judged yet is none', () => {
    setAutoYesEnabled(WT, 'claude', true, ONE_HOUR);
    expect(startAutoYesPolling(WT, 'claude').started).toBe(true);
    expect(published(PERMISSION).state).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Review 2: a person's answer and a tick under way
// ---------------------------------------------------------------------------

describe('[#3821] a person’s answer stops a tick already under way', () => {
  /** A promise and the function that settles it. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it('waiting on the ownership check: a manual answer begins, the tick sends nothing', async () => {
    enable();
    const held = gate();
    ownershipGate = held.promise;
    const pending = tick(PERMISSION);
    await Promise.resolve();

    noteManualAnswerStarted(KEY);
    held.open();

    expect(await pending).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(published(PERMISSION).state).not.toBe('answering');
  });

  it('control: waiting on the ownership check with no manual answer, the tick answers', async () => {
    enable();
    const held = gate();
    ownershipGate = held.promise;
    const pending = tick(PERMISSION);
    await Promise.resolve();
    held.open();

    expect(await pending).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('in the middle of the send: the sender is told the tick is no longer current', async () => {
    enable();
    const seen: boolean[] = [];
    duringSend = ({ stillCurrent }) => {
      seen.push(stillCurrent?.() ?? true);
      noteManualAnswerStarted(KEY);
      seen.push(stillCurrent?.() ?? true);
    };
    await tick(PERMISSION);
    // Before the person: current. After: the sender stops before its next key.
    expect(seen).toEqual([true, false]);
    expect(published(PERMISSION).state).not.toBe('answering');
  });

  it('the next ticks leave the screen to the person for the hold, then answer again (Auto-Yes stays on)', async () => {
    enable();
    noteManualAnswerStarted(KEY);

    expect(await tick(PERMISSION)).toBe('no_answer');
    expect(sendPromptAnswer).not.toHaveBeenCalled();
    expect(published(PERMISSION)).toMatchObject({ state: 'withheld', reason: 'answered-by-human' });
    expect(getAutoYesState(WT, 'claude')?.enabled).toBe(true);

    vi.setSystemTime(Date.now() + MANUAL_ANSWER_HOLD_MS);
    expect(await tick(PERMISSION)).toBe('responded');
    expect(sendPromptAnswer).toHaveBeenCalledTimes(1);
  });

  it('another instance’s manual answer leaves this one’s tick alone', async () => {
    enable();
    const held = gate();
    ownershipGate = held.promise;
    const pending = tick(PERMISSION);
    await Promise.resolve();
    noteManualAnswerStarted(buildCompositeKey(WT, 'claude', 'claude-2'));
    held.open();
    expect(await pending).toBe('responded');
  });
});

// ---------------------------------------------------------------------------
// Review 2: the duplicate guard is not evidence of answering
// ---------------------------------------------------------------------------

describe('[#3821] the duplicate guard keeps answering only for the confirmation sent to', () => {
  /** The same question, other options: the duplicate guard (type + question) calls it the same. */
  const SAME_QUESTION_OTHER_OPTIONS = 'Select an option:\n❯ 1. Allow\n  2. Deny';

  it('the same question with other options within the guard: not answering', async () => {
    enable();
    expect(await tick(PERMISSION)).toBe('responded');
    expect(await tick(SAME_QUESTION_OTHER_OPTIONS)).toBe('duplicate');
    expect(published(SAME_QUESTION_OTHER_OPTIONS).state).toBe('none');
    // Nor is the earlier answering kept for the screen that was answered.
    expect(getAutoYesDecisionRecord(KEY)).toBeNull();
  });

  it('the record dropped (a person answered) and the guard still on: not brought back', async () => {
    enable();
    expect(await tick(PERMISSION)).toBe('responded');
    forgetAutoYesDecision(KEY);
    expect(await tick(PERMISSION)).toBe('duplicate');
    expect(published(PERMISSION).state).toBe('none');
  });

  it('after a manual answer, the same screen within the guard is the person’s, not answering', async () => {
    enable();
    expect(await tick(PERMISSION)).toBe('responded');
    noteManualAnswerStarted(KEY);
    expect(await tick(PERMISSION)).toBe('no_answer');
    expect(published(PERMISSION)).toMatchObject({ state: 'withheld', reason: 'answered-by-human' });
  });

  it('control: the confirmation that was sent to, within the guard: still answering', async () => {
    enable();
    expect(await tick(PERMISSION)).toBe('responded');
    vi.setSystemTime(Date.now() + DUPLICATE_RETRY_EXPIRY_MS - 1);
    expect(await tick(PERMISSION)).toBe('duplicate');
    expect(published(PERMISSION).state).toBe('answering');
  });
});

// ---------------------------------------------------------------------------
// Review 2: what is being approved is part of the confirmation
// ---------------------------------------------------------------------------

describe('[#3821] a decision is not carried to another approval target', () => {
  /** agy 1.1.27's file-creation dialog: the file is named only in the approval target. */
  const CREATE_FILE = readFileSync(
    path.resolve(__dirname, '../../fixtures/antigravity-live-2364/dialog-create-file.txt'),
    'utf8',
  );
  const CREATE_OTHER_FILE = CREATE_FILE.replaceAll('hello-agy.txt', 'other-file.txt').replaceAll(
    'hello from antigravity',
    'something else',
  );
  const agyPrompt = (raw: string): PromptData => {
    const promptData = detectSessionStatus(raw, 'antigravity').promptDetection.promptData;
    if (!promptData) throw new Error('the frame carries no prompt');
    return promptData;
  };
  /** The same screen read with fewer rows, cut from the top (the status API and the poller differ so). */
  const fewerRows = (raw: string, firstRow: string): string => {
    const rows = raw.split('\n');
    return rows.slice(rows.findLastIndex((row) => row.includes(firstRow))).join('\n');
  };
  const key = buildCompositeKey(WT, 'antigravity');
  const grant: AutoYesState = { enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
  const publishFor = (promptData: PromptData, callId: string | null = null) =>
    publishAutoYesDecision({ compositeKey: key, grant, promptData, callId, pollerActive: true });
  const record = (promptData: PromptData, callId: string | null = null) =>
    recordAutoYesDecision(key, {
      state: 'answering',
      reason: null,
      promptData,
      callId,
      grant,
      epoch: getEnterFallbackSessionEpoch(key),
    });

  it('non-vacuous: the two dialogs share the question and the options, not the target', () => {
    const a = agyPrompt(CREATE_FILE);
    const b = agyPrompt(CREATE_OTHER_FILE);
    expect(b.question).toBe(a.question);
    expect(JSON.stringify(b.type === 'multiple_choice' ? b.options : [])).toBe(
      JSON.stringify(a.type === 'multiple_choice' ? a.options : []),
    );
    expect(b.approvalTarget).not.toBe(a.approvalTarget);
  });

  it('the approval target differs only: none', () => {
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(agyPrompt(CREATE_OTHER_FILE)).state).toBe('none');
  });

  // Review 3: the exception that let a reading cut from the top match under
  // the same hook call is gone (the call known now may be an earlier
  // dialog's). A target that cannot be compared to its end is not the same
  // confirmation: none, the panel opens.
  it.each([
    ['from the file row', '~/agy2364-probe/hello-agy.txt'],
    ['from the diff row', 'hello from antigravity'],
  ])('the same dialog read with fewer rows (%s), even under the same hook call: none, both ways', (_label, firstRow) => {
    const fewer = agyPrompt(fewerRows(CREATE_FILE, firstRow));
    expect(fewer.approvalTarget).not.toBe(agyPrompt(CREATE_FILE).approvalTarget);
    record(agyPrompt(CREATE_FILE), 'call-1');
    expect(publishFor(fewer, 'call-1').state).toBe('none');
    // And the other way round: the poller read fewer rows than the status API.
    record(fewer, 'call-1');
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-1').state).toBe('none');
  });

  it('control: the same dialog read whole under the same hook call: still the decision', () => {
    record(agyPrompt(CREATE_FILE), 'call-1');
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-1').state).toBe('answering');
  });

  /** The same dialog for another file: the file row differs, the diff row is the same. */
  const CREATE_RENAMED_FILE = CREATE_FILE.replaceAll('hello-agy.txt', 'renamed-agy.txt');

  it('non-vacuous: the renamed dialog read from the diff row reads the same rows as the original', () => {
    expect(agyPrompt(CREATE_RENAMED_FILE).approvalTarget).not.toBe(agyPrompt(CREATE_FILE).approvalTarget);
    expect(agyPrompt(fewerRows(CREATE_RENAMED_FILE, 'hello from antigravity')).approvalTarget).toBe(
      agyPrompt(fewerRows(CREATE_FILE, 'hello from antigravity')).approvalTarget,
    );
  });

  it('only the file name differs: none', () => {
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(agyPrompt(CREATE_RENAMED_FILE)).state).toBe('none');
  });

  it('only the file name differs, one reading cut to the diff row (nothing names the file): none', () => {
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(agyPrompt(fewerRows(CREATE_RENAMED_FILE, 'hello from antigravity'))).state).toBe('none');
    record(agyPrompt(fewerRows(CREATE_FILE, 'hello from antigravity')));
    expect(publishFor(agyPrompt(CREATE_RENAMED_FILE)).state).toBe('none');
  });

  it.each([
    ['from the file row', '~/agy2364-probe/hello-agy.txt'],
    ['from the diff row', 'hello from antigravity'],
  ])('a reading cut from the top (%s) with no hook call to tie it: none, both ways', (_label, firstRow) => {
    const fewer = agyPrompt(fewerRows(CREATE_FILE, firstRow));
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(fewer).state).toBe('none');
    record(fewer);
    expect(publishFor(agyPrompt(CREATE_FILE)).state).toBe('none');
  });

  it('B (only the file name differs) under A’s accepted call, read whole or cut: A’s decision is not published', () => {
    // The builder may still read A's call for B's screen before the next tick (review 3, R3).
    record(agyPrompt(CREATE_FILE), 'call-1');
    expect(publishFor(agyPrompt(CREATE_RENAMED_FILE), 'call-1').state).toBe('none');
    expect(publishFor(agyPrompt(fewerRows(CREATE_RENAMED_FILE, 'hello from antigravity')), 'call-1').state).toBe(
      'none',
    );
    record(agyPrompt(fewerRows(CREATE_FILE, 'hello from antigravity')), 'call-1');
    expect(publishFor(agyPrompt(CREATE_RENAMED_FILE), 'call-1').state).toBe('none');
  });

  it('a decision recorded with no hook call is not published under one, nor the other way', () => {
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-1').state).toBe('none');
    record(agyPrompt(CREATE_FILE), 'call-1');
    expect(publishFor(agyPrompt(CREATE_FILE)).state).toBe('none');
  });

  it('confirmation and the match follow one rule: same key exactly when the record is published', () => {
    const readings: Array<[PromptData, string | null]> = [
      [agyPrompt(CREATE_FILE), null],
      [agyPrompt(CREATE_FILE), 'call-1'],
      [agyPrompt(fewerRows(CREATE_FILE, '~/agy2364-probe/hello-agy.txt')), 'call-1'],
      [agyPrompt(fewerRows(CREATE_FILE, 'hello from antigravity')), 'call-1'],
      [agyPrompt(CREATE_RENAMED_FILE), 'call-1'],
      [agyPrompt(fewerRows(CREATE_RENAMED_FILE, 'hello from antigravity')), 'call-1'],
    ];
    for (const [recorded, recordedCall] of readings) {
      record(recorded, recordedCall);
      const recordedKey = publishFor(recorded, recordedCall).confirmation;
      for (const [shown, shownCall] of readings) {
        const out = publishFor(shown, shownCall);
        expect(out.state === 'answering').toBe(out.confirmation === recordedKey);
      }
    }
    // Non-vacuous: the whole and the cut readings of one dialog carry different keys.
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-1').confirmation).not.toBe(
      publishFor(agyPrompt(fewerRows(CREATE_FILE, 'hello from antigravity')), 'call-1').confirmation,
    );
  });

  it('PC: a newer withheld, then an older answering about the same dialog: the decision does not go back', () => {
    const newer = (() => {
      vi.setSystemTime(5_000);
      recordAutoYesDecision(key, {
        state: 'withheld',
        reason: 'mode-off',
        promptData: agyPrompt(CREATE_FILE),
        grant,
        epoch: getEnterFallbackSessionEpoch(key),
      });
      return publishFor(agyPrompt(CREATE_FILE));
    })();
    vi.setSystemTime(3_000);
    record(agyPrompt(CREATE_FILE));
    const olderWhole = publishFor(agyPrompt(CREATE_FILE));
    const olderCut = publishFor(agyPrompt(fewerRows(CREATE_FILE, 'hello from antigravity')));
    expect(newer).toMatchObject({ state: 'withheld', observedAt: 5_000 });
    expect(olderWhole).toMatchObject({ state: 'answering', observedAt: 3_000 });
    // The same reading: compared by time, the newer withheld stays.
    expect(laterAutoYesDecision(newer, olderWhole)).toBe(newer);
    // A cut reading of it is never answering, so nothing hides the panel either way.
    expect(olderCut.state).toBe('none');
    expect(isAutoYesAnswering(laterAutoYesDecision(newer, olderCut))).toBe(false);
  });

  it('control: the same dialog read the same way, no hook call: still the decision', () => {
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(agyPrompt(CREATE_FILE)).state).toBe('answering');
  });

  it('confirmation: the same dialog names the same one, another file another', () => {
    const key = publishFor(agyPrompt(CREATE_FILE)).confirmation;
    expect(typeof key).toBe('string');
    expect(publishFor(agyPrompt(CREATE_FILE)).confirmation).toBe(key);
    expect(publishFor(agyPrompt(CREATE_RENAMED_FILE)).confirmation).not.toBe(key);
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-1').confirmation).not.toBe(key);
  });

  it('a target one reading has and the other has not: none', () => {
    const withoutTarget = { ...agyPrompt(CREATE_FILE), approvalTarget: undefined };
    record(agyPrompt(CREATE_FILE));
    expect(publishFor(withoutTarget).state).toBe('none');
  });

  it('agy: a decision tied to a hook call reads none for another call, or when no call is known now', () => {
    record(agyPrompt(CREATE_FILE), 'call-1');
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-1').state).toBe('answering');
    expect(publishFor(agyPrompt(CREATE_FILE), 'call-2').state).toBe('none');
    expect(publishFor(agyPrompt(CREATE_FILE), null).state).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Review 3 (R3): the body is read as it is, as #3817 reads it
// ---------------------------------------------------------------------------

describe('[#3821] the approval target keeps the body: #3817’s three bodies', () => {
  const RULE = '─'.repeat(60);
  /** claude's Bash permission with `command` as its body and the cursor on `cursorAt` (#3817's fixture). */
  const claudeBash = (command: readonly string[], cursorAt = 1): string => {
    const option = (n: number, label: string): string => `${n === cursorAt ? ' ❯' : '  '} ${n}. ${label}`;
    return [
      '⏺ Writing the notes.',
      RULE,
      ' Bash command',
      '',
      ...command,
      '   Write the notes file',
      '   from the template',
      '   into the repository root',
      '   without staging it',
      '',
      ' Do you want to proceed?',
      option(1, 'Yes'),
      option(2, "Yes, and don't ask again for cat commands in /repo"),
      option(3, 'No'),
      '',
      ' Esc to cancel · Tab to amend',
    ].join('\n');
  };
  const QUOTED = claudeBash(["   cat <<'EOF' > notes.md", '   > rm -rf build', '   EOF']);
  const UNQUOTED = claudeBash(["   cat <<'EOF' > notes.md", '   rm -rf build', '   EOF']);
  const INDENTED = claudeBash(["   cat <<'EOF' > notes.md", '       rm -rf build', '   EOF']);
  const QUOTED_CURSOR_ON_2 = claudeBash(["   cat <<'EOF' > notes.md", '   > rm -rf build', '   EOF'], 2);
  const grant: AutoYesState = { enabled: true, enabledAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
  const record = (raw: string) =>
    recordAutoYesDecision(KEY, {
      state: 'answering',
      reason: null,
      promptData: statusPrompt(raw),
      grant,
      epoch: getEnterFallbackSessionEpoch(KEY),
    });
  const publishFor = (raw: string) =>
    publishAutoYesDecision({ compositeKey: KEY, grant, promptData: statusPrompt(raw), pollerActive: true });

  it('non-vacuous: the same question and options, the bodies differ only by a `>` or an indent', () => {
    for (const other of [UNQUOTED, INDENTED]) {
      expect(statusPrompt(other).question).toBe(statusPrompt(QUOTED).question);
      expect(JSON.stringify(statusPrompt(other).type === 'multiple_choice' ? statusPrompt(other).options : null)).toBe(
        JSON.stringify(statusPrompt(QUOTED).type === 'multiple_choice' ? statusPrompt(QUOTED).options : null),
      );
      expect(statusPrompt(other).approvalTarget).not.toBe(statusPrompt(QUOTED).approvalTarget);
    }
    expect(statusPrompt(QUOTED_CURSOR_ON_2).approvalTarget).not.toBe(statusPrompt(QUOTED).approvalTarget);
  });

  it.each([
    ['a `>`', QUOTED, UNQUOTED],
    ['a `>` (the other way)', UNQUOTED, QUOTED],
    ['an indent', INDENTED, UNQUOTED],
    ['an indent (the other way)', UNQUOTED, INDENTED],
  ])('record → publish: bodies that differ by %s are another confirmation (none)', (_label, recorded, shown) => {
    record(recorded);
    expect(publishFor(shown).state).toBe('none');
    expect(publishFor(shown).confirmation).not.toBe(publishFor(recorded).confirmation);
  });

  it('control — record → publish: only the cursor moved: still the decision, the same confirmation', () => {
    record(QUOTED);
    expect(publishFor(QUOTED_CURSOR_ON_2).state).toBe('answering');
    expect(publishFor(QUOTED_CURSOR_ON_2).confirmation).toBe(publishFor(QUOTED).confirmation);
  });

  it.each([
    ['a `>`', UNQUOTED],
    ['an indent', INDENTED],
  ])('the duplicate guard: a body that differs by %s within the guard is not answering', async (_label, other) => {
    enable();
    expect(await tick(QUOTED)).toBe('responded');
    expect(published(QUOTED).state).toBe('answering');
    expect(await tick(other)).toBe('duplicate');
    expect(published(other).state).toBe('none');
  });

  it('control — the duplicate guard: only the cursor moved, within the guard: still answering', async () => {
    enable();
    expect(await tick(QUOTED)).toBe('responded');
    expect(await tick(QUOTED_CURSOR_ON_2)).toBe('duplicate');
    expect(published(QUOTED_CURSOR_ON_2).state).toBe('answering');
  });
});
