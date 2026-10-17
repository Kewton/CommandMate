/**
 * One prompt observation (Issue #3755): the kind of the screen, what it asks,
 * the token, and Auto-Yes as two separate items.
 *
 * The positive case is agy's folder trust screen as Issue #3746 recorded it;
 * every other agy screen the detector publishes under the same selection-list
 * reason, and the two "nothing asks" frames, must come out as a DIFFERENT kind
 * (the negative controls). A screen no measured reader names is `unknown`.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildPromptObservation, type ObservationInput, type ObservationPayload } from '@/lib/prompt-observation/observe';
import { classifyScreen } from '@/lib/prompt-observation/classify';
import { PROMPT_OBSERVATION_KINDS, PROMPT_OBSERVATION_SCHEMA_VERSION } from '@/lib/prompt-observation/kinds';
import { verifyObservationToken } from '@/lib/prompt-observation/token';
import { observationTokenBinding } from '@/lib/prompt-observation/observe';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_REASON } from '@/lib/detection/status-reason';
import type { AutoYesPolicySuppression } from '@/lib/polling/auto-yes-suppression-state';
import type { PromptData } from '@/types/models';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const TRUST_3746 = read('prompt-observation-3755/antigravity-trust.txt');
const TRUST_2364 = read('antigravity-live-2364/trust-dialog.txt');
const PERMISSION = read('antigravity-live-2364/dialog-bash-oneline.txt');
const PICKER = read('antigravity-live-2364/picker-switch-model.txt');
const SLASH = read('antigravity-live-2364/popup-slash-commands.txt');
const COMPOSER = read('antigravity-live-2364/boot-idle.txt');
const WORKING = read('prompt-observation-3755/antigravity-working.txt');

const NOW = 1_800_000_000_000;
const FOLDER_3746 = '/Users/agy-user/share/work/github_kewton/CommandAgent-issue-643-tools-bash-cd-next-js-id-635-637';

/** A running agy pane on `frame`, flags as the selection-list reading publishes them. */
function payload(over: Partial<ObservationPayload> = {}): ObservationPayload {
  return {
    isRunning: true,
    sessionName: 'mcbd-antigravity-wt-1',
    sessionStatus: 'waiting',
    sessionStatusReason: STATUS_REASON.ANTIGRAVITY_SELECTION_LIST,
    fullOutput: TRUST_3746,
    isPromptWaiting: false,
    promptData: null,
    promptView: null,
    isSelectionListActive: true,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    startingSince: null,
    autoYes: { enabled: true, expiresAt: NOW + 3_600_000, lastSuppression: null, lastEnterFallback: null },
    serverPollerActive: true,
    ...over,
  };
}

function input(over: Partial<ObservationInput> = {}, payloadOver: Partial<ObservationPayload> = {}): ObservationInput {
  return {
    worktreeId: 'wt-1',
    cliToolId: 'antigravity',
    instanceId: 'antigravity',
    resolvedBy: 'explicit',
    payload: payload(payloadOver),
    sessionGeneration: NOW - 60_000,
    contract: { policy: null, taskId: null },
    now: NOW,
    ...over,
  };
}

const MULTIPLE_CHOICE: PromptData = {
  type: 'multiple_choice',
  question: 'Do you want to proceed?',
  options: [
    { number: 1, label: 'Yes', isDefault: true },
    { number: 2, label: 'No', isDefault: false },
  ],
  status: 'pending',
};

describe('[#3755] the trust screen (positive case)', () => {
  it('reads #3746\'s pane as antigravity-trust with the folder, the options and a token', () => {
    const observation = buildPromptObservation(input());

    expect(observation.schemaVersion).toBe(PROMPT_OBSERVATION_SCHEMA_VERSION);
    expect(observation.status).toBe('observed');
    expect(observation.screen).toMatchObject({
      kind: 'antigravity-trust',
      question: 'Do you trust the contents of this project?',
      approvalTarget: FOLDER_3746,
      options: [
        { position: 1, label: 'Yes, I trust this folder' },
        { position: 2, label: 'No, exit' },
      ],
      selectedPosition: 1,
      // agy's arrow screens carry no prompt `respond` can answer today.
      answerVia: 'terminal',
    });
    expect(observation.screen?.token).toMatch(/^po1\./);
    expect(observation.screen?.tokenExpiresAt).toBeGreaterThan(NOW);
  });

  it('reads the raw 2364 capture (ANSI, 1000 rows) the same way', () => {
    const classified = classifyScreen({ cliToolId: 'antigravity', fullOutput: TRUST_2364, sessionStatus: 'waiting' });
    expect(classified).toEqual({
      kind: 'antigravity-trust',
      question: 'Do you trust the contents of this project?',
      approvalTarget: '~/agy2364-probe',
      options: ['Yes, I trust this folder', 'No, exit'],
      selectedIndex: 0,
    });
  });

  it('binds the token to what the screen asks', () => {
    const observation = buildPromptObservation(input());
    const token = observation.screen?.token as string;
    const binding = observationTokenBinding(
      { worktreeId: 'wt-1', cliToolId: 'antigravity', instanceId: 'antigravity', sessionGeneration: NOW - 60_000, sessionName: 'mcbd-antigravity-wt-1' },
      {
        kind: 'antigravity-trust',
        question: 'Do you trust the contents of this project?',
        options: ['Yes, I trust this folder', 'No, exit'],
        approvalTarget: FOLDER_3746,
      },
    );
    expect(verifyObservationToken(token, binding, NOW + 1000)).toEqual({ ok: true, issuedAt: NOW });
    expect(verifyObservationToken(token, { ...binding, kind: 'antigravity-permission' }, NOW + 1000)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('does not read a trust screen the composer is drawn under (quoted / scrollback)', () => {
    const quoted = `${TRUST_3746}\n────────\n>\n────────\n? for shortcuts`;
    const classified = classifyScreen({ cliToolId: 'antigravity', fullOutput: quoted, sessionStatus: 'ready' });
    expect(classified.kind).toBe('composer');
  });

  it('leaves the detector\'s own reading of the frame alone (kinds are not mixed into it)', () => {
    // The status layer still publishes the trust screen as a selection list
    // with no prompt; the observation's kind is a value of its own.
    const status = detectSessionStatus(TRUST_2364, 'antigravity');
    expect(status.reason).toBe(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(status.hasActivePrompt).toBe(false);
    expect(PROMPT_OBSERVATION_KINDS).not.toContain(STATUS_REASON.ANTIGRAVITY_SELECTION_LIST);
    expect(PROMPT_OBSERVATION_KINDS).not.toContain('multiple_choice');
    expect(PROMPT_OBSERVATION_KINDS).not.toContain('yes_no');
  });
});

describe('[#3755] negative controls: each other screen is a different result', () => {
  const cases: Array<{ name: string; snapshot: Partial<ObservationPayload>; kind: string }> = [
    {
      name: 'command execution approval (numbered dialog)',
      snapshot: { fullOutput: PERMISSION, isSelectionListActive: false, isPromptWaiting: true, promptData: MULTIPLE_CHOICE },
      kind: 'antigravity-permission',
    },
    { name: '/model picker', snapshot: { fullOutput: PICKER }, kind: 'antigravity-model-picker' },
    { name: 'slash-command popup', snapshot: { fullOutput: SLASH }, kind: 'antigravity-slash-menu' },
    {
      name: 'input box only',
      snapshot: { fullOutput: COMPOSER, sessionStatus: 'ready', sessionStatusReason: 'input_prompt', isSelectionListActive: false },
      kind: 'composer',
    },
    {
      name: 'no confirmation (working)',
      snapshot: { fullOutput: WORKING, sessionStatus: 'running', sessionStatusReason: 'thinking_indicator', isSelectionListActive: false },
      kind: 'none',
    },
  ];

  it.each(cases)('$name → $kind', ({ snapshot, kind }) => {
    expect(buildPromptObservation(input({}, snapshot)).screen?.kind).toBe(kind);
  });

  it('gives every control a kind of its own, none of them the trust screen\'s', () => {
    const kinds = cases.map(({ snapshot }) => buildPromptObservation(input({}, snapshot)).screen?.kind);
    expect(new Set(kinds).size).toBe(cases.length);
    expect(kinds).not.toContain('antigravity-trust');
  });

  it('reads the permission dialog\'s question, options and command', () => {
    const screen = buildPromptObservation(
      input({}, { fullOutput: PERMISSION, isSelectionListActive: false, isPromptWaiting: true, promptData: MULTIPLE_CHOICE }),
    ).screen;
    expect(screen?.question).toBe('Do you want to proceed?');
    expect(screen?.options.map((o) => o.label)).toHaveLength(4);
    expect(screen?.options[0]).toEqual({ position: 1, label: 'Yes' });
    expect(screen?.selectedPosition).toBe(1);
    expect(screen?.approvalTarget).toContain('python3 -c');
    expect(screen?.answerVia).toBe('screen');
  });

  it('reads the picker\'s models with the highlighted one', () => {
    const screen = buildPromptObservation(input({}, { fullOutput: PICKER })).screen;
    expect(screen?.question).toBe('Switch Model');
    expect(screen?.options[0].label).toBe('Gemini 3.8 Flash (current)');
    expect(screen?.options.map((o) => o.label)).toContain('Claude Opus 4.6 (Thinking)');
    expect(screen?.options.map((o) => o.label)).not.toContain(expect.stringContaining('Effort'));
    expect(screen?.selectedPosition).toBe(1);
  });

  it('issues no token when nothing asks', () => {
    for (const kind of ['composer', 'none']) {
      const snapshot = kind === 'composer'
        ? { fullOutput: COMPOSER, sessionStatus: 'ready', isSelectionListActive: false }
        : { fullOutput: WORKING, sessionStatus: 'running', isSelectionListActive: false };
      const screen = buildPromptObservation(input({}, snapshot)).screen;
      expect(screen?.kind).toBe(kind);
      expect(screen?.token).toBeNull();
      expect(screen?.answerVia).toBe('none');
    }
  });
});

describe('[#3755] unmeasured screens are unknown', () => {
  it('an agy selection screen no reader names', () => {
    const frame = 'Pick a theme\n> Dark\n  Light\n\n  ↑/↓ Navigate · enter Select';
    expect(buildPromptObservation(input({}, { fullOutput: frame })).screen?.kind).toBe('unknown');
  });

  it('an unclassified frame of another tool', () => {
    const observation = buildPromptObservation(
      input({ cliToolId: 'codex', instanceId: 'codex' }, {
        fullOutput: 'anything',
        sessionStatus: 'running',
        isSelectionListActive: false,
        isUnclassifiedActive: true,
      }),
    );
    expect(observation.screen?.kind).toBe('unknown');
    expect(observation.screen?.token).toMatch(/^po1\./);
  });

  it('a parsed prompt of a tool with no measured kind: unknown, with what the prompt says', () => {
    const screen = buildPromptObservation(
      input({ cliToolId: 'claude', instanceId: 'claude' }, {
        fullOutput: 'Do you want to proceed?\n❯ 1. Yes\n  2. No',
        isSelectionListActive: false,
        isPromptWaiting: true,
        promptData: MULTIPLE_CHOICE,
      }),
    ).screen;
    expect(screen?.kind).toBe('unknown');
    expect(screen?.question).toBe('Do you want to proceed?');
    expect(screen?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(screen?.answerVia).toBe('screen');
  });

  it('a session that is not running is unavailable, not "no confirmation"', () => {
    const observation = buildPromptObservation(
      input({}, { isRunning: false, fullOutput: undefined, autoYes: undefined, serverPollerActive: false }),
    );
    expect(observation.status).toBe('unavailable');
    expect(observation.unavailableReason).toBe('session-not-running');
    expect(observation.screen).toBeNull();
    expect(observation.autoYes.enabled).toBeNull();
    expect(observation.autoYes.contractEvaluation).toEqual({
      state: 'not-evaluated',
      because: 'session-not-running',
      contract: null,
    });
  });
});

describe('[#3755] the poller record and the contract re-evaluation are separate items', () => {
  const record = (over: Partial<AutoYesPolicySuppression> = {}): AutoYesPolicySuppression => ({
    reason: 'deny-pattern',
    mode: 'safe',
    promptType: 'multiple_choice',
    pattern: 'rm -rf',
    at: NOW - 5_000,
    ...over,
  });

  it('a fresh record is published as a record, not as the reason for this screen', () => {
    // `wait` reads a record under a minute old as "the reason". Here it is the
    // poller's record, with a correlation that is `unknown` — the record names
    // no screen — and the contract evaluated now is a separate item that can
    // disagree with it (the deny pattern is no longer in the contract).
    const observation = buildPromptObservation(
      input({}, {
        fullOutput: PERMISSION,
        isSelectionListActive: false,
        isPromptWaiting: true,
        promptData: MULTIPLE_CHOICE,
        autoYes: { enabled: true, expiresAt: null, lastSuppression: record(), lastEnterFallback: null },
      }),
    );
    expect(observation.autoYes.pollerRecord).toEqual({
      reason: 'deny-pattern',
      mode: 'safe',
      promptType: 'multiple_choice',
      pattern: 'rm -rf',
      at: NOW - 5_000,
      ageSeconds: 5,
      screenCorrelation: 'unknown',
    });
    expect(observation.autoYes.contractEvaluation).toEqual({ state: 'policy-permits', contract: null });
  });

  it('re-evaluates the contract now, in AutoYesSuppressionReason words', () => {
    const observation = buildPromptObservation(
      input({ contract: { policy: { mode: 'safe', allowPromptTypes: [], denyPatterns: [] }, taskId: 'task-1' } }, {
        fullOutput: PERMISSION,
        isSelectionListActive: false,
        isPromptWaiting: true,
        promptData: MULTIPLE_CHOICE,
      }),
    );
    expect(observation.autoYes.pollerRecord).toBeNull();
    expect(observation.autoYes.contractEvaluation).toEqual({
      state: 'policy-withholds',
      reason: 'type-not-allowed',
      contract: { taskId: 'task-1', mode: 'safe' },
    });
  });

  it('says a record was made on a prompt of another type when it was', () => {
    const observation = buildPromptObservation(
      input({}, {
        fullOutput: PERMISSION,
        isSelectionListActive: false,
        isPromptWaiting: true,
        promptData: MULTIPLE_CHOICE,
        autoYes: { enabled: true, expiresAt: null, lastSuppression: record({ promptType: 'yes_no' }), lastEnterFallback: null },
      }),
    );
    expect(observation.autoYes.pollerRecord?.screenCorrelation).toBe('type-mismatch');
  });

  it('says nothing asks when the record outlived its screen', () => {
    const observation = buildPromptObservation(
      input({}, {
        fullOutput: COMPOSER,
        sessionStatus: 'ready',
        isSelectionListActive: false,
        autoYes: { enabled: true, expiresAt: null, lastSuppression: record(), lastEnterFallback: null },
      }),
    );
    expect(observation.autoYes.pollerRecord?.screenCorrelation).toBe('no-prompt-on-screen');
  });

  it('a missing record on the trust screen is not "Auto-Yes can answer"', () => {
    // #3746 P2: Auto-Yes on, no record, the trust screen up for 55 minutes.
    const observation = buildPromptObservation(input());
    expect(observation.autoYes.enabled).toBe(true);
    expect(observation.autoYes.pollerRecord).toBeNull();
    expect(observation.autoYes.contractEvaluation.state).toBe('not-evaluated');
    expect(observation.autoYes.contractEvaluation).toMatchObject({ because: 'no-parsed-prompt' });
    expect(observation.autoYes.pollerActive).toBe(true);
  });
});
