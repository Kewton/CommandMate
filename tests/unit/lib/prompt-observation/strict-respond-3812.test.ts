/**
 * The strict `respond` on agy's command permission dialog (Issue #3812): an
 * option below the highlight is reached, because a ↑/↓ moves only the
 * highlight of the screen the keys are checked against — and a stop between
 * keys says where the highlight was left.
 *
 * The pane is a fake over the live dialog of the #3796 UAT
 * (`tests/fixtures/strict-respond-3812/`); every observation and token is the
 * real one (`buildPromptObservation`, the server's appearance tracker, the
 * token module).
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  buildPromptObservation,
  observationBindingOf,
  type ObservationPayload,
} from '@/lib/prompt-observation/observe';
import {
  approvalTargetWithoutHighlight,
  forgetScreenAppearance,
  noteScreenAppearance,
  screenFingerprint,
} from '@/lib/prompt-observation/appearance';
import {
  clearStrictRespondState,
  respondStrictly,
  type StrictRespondDeps,
  type StrictRespondRequest,
} from '@/lib/prompt-observation/strict-respond';
import type { PromptObservation, StrictRespondResult } from '@/lib/prompt-observation/types';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

/** The live dialog as it opened: `> 1. Yes, run command` (the #3796 UAT, item F). */
const PERMISSION = read('strict-respond-3812/permission-run-command.txt');
/** The server's observations of it, before and after one live `Down`. */
const OBSERVED_1 = JSON.parse(read('strict-respond-3812/observation-highlight-1.json')) as PromptObservation;
const OBSERVED_2 = JSON.parse(read('strict-respond-3812/observation-highlight-2.json')) as PromptObservation;
/** The pane after the dialog was answered: agy's composer. */
const COMPOSER = read('antigravity-live-2364/idle-after-deny.txt');
const TRUST = read('prompt-observation-3755/antigravity-trust.txt');

const HIGHLIGHT_ROW = /^(?:\x1b\[94m> | {2})(\d+)\. (.*?)(?:\x1b\[39m)?$/;

/** The dialog with agy's `\x1b[94m> ` gutter on option `position` (1-based); no other byte moves. */
function withHighlight(position: number, frame: string = PERMISSION): string {
  return frame
    .split('\n')
    .map(line => {
      const row = HIGHLIGHT_ROW.exec(line);
      if (row === null) return line;
      const text = `${row[1]}. ${row[2]}`;
      return Number(row[1]) === position ? `\x1b[94m> ${text}\x1b[39m` : `  ${text}`;
    })
    .join('\n');
}

const PERSIST = "Yes, and always allow for commands that start with 'pwd' (Persist to settings.json)";

const SESSION = 'mcbd-antigravity-wt-3812';
const GENERATION = 1_800_000_000_000;

interface FakePane {
  frame: string;
  /** What each key does to the frame. */
  onKey: (key: string, frame: string) => string;
  keys: string[];
  clock: number;
}

let pane: FakePane;
let instanceSeq = 0;
let instanceId: string;

function payloadOf(frame: string): ObservationPayload {
  const idle = frame === COMPOSER;
  return {
    isRunning: true,
    sessionName: SESSION,
    sessionStatus: idle ? 'ready' : 'waiting',
    sessionStatusReason: idle ? 'input_prompt' : 'prompt_detected',
    fullOutput: frame,
    isPromptWaiting: !idle,
    promptData: null,
    promptView: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    startingSince: null,
    autoYes: undefined,
    serverPollerActive: false,
  };
}

function observe(): PromptObservation {
  const instance = { worktreeId: 'wt-3812', cliToolId: 'antigravity', instanceId };
  return buildPromptObservation({
    ...instance,
    resolvedBy: 'roster',
    payload: payloadOf(pane.frame),
    sessionGeneration: GENERATION,
    contract: { policy: null, taskId: null },
    appearance: {
      note: fingerprint => noteScreenAppearance(instance, fingerprint, pane.clock),
      forget: () => forgetScreenAppearance(instance),
    },
    now: pane.clock,
  });
}

function deps(): StrictRespondDeps {
  return {
    async read() {
      return { ok: true, observation: observe(), frame: pane.frame };
    },
    async sendKey(key) {
      pane.keys.push(key);
      pane.frame = pane.onKey(key, pane.frame);
    },
    async sleep(ms) {
      pane.clock += ms;
    },
    now: () => pane.clock,
    autoYesActive: () => false,
    startup: {
      isWindowOpen: () => false,
      claimedWithin: () => false,
      hold: () => () => {},
      discardDebt: () => {},
    },
  };
}

/** The highlight row of a frame (1-based), as the fake reads it back. */
function highlightOf(frame: string): number {
  const index = frame.split('\n').findIndex(line => line.startsWith('\x1b[94m> ') && HIGHLIGHT_ROW.test(line));
  const row = HIGHLIGHT_ROW.exec(frame.split('\n')[index]);
  return Number(row?.[1]);
}

/** agy's dialog: ↑/↓ move the `>` within the four options, Enter answers it. */
function dialogKeys(key: string, frame: string): string {
  if (key === 'Enter') return COMPOSER;
  const at = highlightOf(frame);
  if (key === 'Down') return withHighlight(Math.min(4, at + 1), frame);
  if (key === 'Up') return withHighlight(Math.max(1, at - 1), frame);
  return frame;
}

function tokenNow(): string {
  const token = observe().screen?.token;
  if (!token) throw new Error('no token issued for the fixture');
  return token;
}

let opSeq = 0;
function request(answer: string): StrictRespondRequest {
  return {
    worktreeId: 'wt-3812',
    sessionName: SESSION,
    expectScreen: 'antigravity-permission',
    observationToken: tokenNow(),
    answer,
    expectTarget: null,
    operationId: `op-3812-${++opSeq}`,
  };
}

beforeEach(() => {
  clearStrictRespondState();
  instanceId = `antigravity-${++instanceSeq}`;
  pane = { frame: PERMISSION, onKey: dialogKeys, keys: [], clock: GENERATION + 60_000 };
});

describe('[#3812] the fixture', () => {
  it('moving the gutter to row 1 gives the live frame back byte for byte', () => {
    expect(withHighlight(1)).toBe(PERMISSION);
    expect(withHighlight(4)).not.toBe(PERMISSION);
  });

  it('the live dialog is the permission kind, highlight 1, four options with the persisting one third', () => {
    const screen = observe().screen;
    expect(screen?.kind).toBe('antigravity-permission');
    expect(screen?.selectedPosition).toBe(1);
    expect(screen?.options.map(option => option.label)).toEqual([
      'Yes, run command',
      "Yes, and always allow in this conversation for commands that start with 'pwd'",
      PERSIST,
      'No, cancel',
    ]);
    // The approval target published to the caller still shows the highlight.
    expect(screen?.approvalTarget).toContain('> 1. Yes, run command');
  });
});

describe('[#3812] the cause: the highlight reached the binding through the approval target', () => {
  it('the live observations before and after one Down differ in approvalTarget only by the `>`', () => {
    const before = OBSERVED_1.screen;
    const after = OBSERVED_2.screen;
    expect(before?.approvalTarget).not.toBe(after?.approvalTarget);
    expect(approvalTargetWithoutHighlight(before?.approvalTarget ?? null)).toBe(
      approvalTargetWithoutHighlight(after?.approvalTarget ?? null)
    );
  });

  it('their token bindings now differ in selectedPosition (and the live appearedAt) only', () => {
    const before = observationBindingOf(OBSERVED_1);
    const after = observationBindingOf(OBSERVED_2);
    expect(before).not.toBeNull();
    expect({ ...before, selectedPosition: null, screenAppearedAt: 0 }).toEqual({
      ...after,
      selectedPosition: null,
      screenAppearedAt: 0,
    });
    expect([before?.selectedPosition, after?.selectedPosition]).toEqual([1, 2]);
  });

  it('a moved highlight is the same appearance: one screenAppearedAt across the Down', () => {
    const first = observe().screen?.appearedAt;
    pane.clock += 5_000;
    pane.frame = withHighlight(3);
    expect(observe().screen?.appearedAt).toBe(first);
  });

  it('the fingerprint still tells the command apart (negative control)', () => {
    const parts = { sessionName: SESSION, sessionGeneration: GENERATION, kind: 'antigravity-permission', question: 'Run this command?', options: ['Yes'] };
    expect(screenFingerprint({ ...parts, approvalTarget: 'Command\n   pwd\n> 1. Yes' })).toBe(
      screenFingerprint({ ...parts, approvalTarget: 'Command\n   pwd\n  1. Yes' })
    );
    expect(screenFingerprint({ ...parts, approvalTarget: 'Command\n   pwd\n> 1. Yes' })).not.toBe(
      screenFingerprint({ ...parts, approvalTarget: 'Command\n   ls\n> 1. Yes' })
    );
  });

  it('a target with no numbered row (the trust screen\'s folder) is left as it is', () => {
    expect(approvalTargetWithoutHighlight('/Users/agy-user/project')).toBe('/Users/agy-user/project');
    expect(approvalTargetWithoutHighlight(null)).toBeNull();
  });
});

describe('[#3812] an option other than the highlighted one is answered (positive)', () => {
  it('"No, cancel" from option 1: three Downs, each read back, then the Enter (exit 0)', async () => {
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({
      code: 0,
      delivery: 'sent',
      reason: null,
      answer: { position: 4, label: 'No, cancel' },
      keysSent: 4,
      outcome: 'advanced',
      highlightLeftAt: null,
    });
    expect(pane.keys).toEqual(['Down', 'Down', 'Down', 'Enter']);
  });

  it('position 2 by number: one Down, then the Enter', async () => {
    const result = await respondStrictly(request('2'), deps());
    expect(result).toMatchObject({ code: 0, keysSent: 2, outcome: 'advanced' });
    expect(pane.keys).toEqual(['Down', 'Enter']);
  });

  it('upwards: from option 4 to "Yes, run command" with three Ups', async () => {
    pane.frame = withHighlight(4);
    const result = await respondStrictly(request('Yes, run command'), deps());
    expect(result).toMatchObject({ code: 0, keysSent: 4, outcome: 'advanced' });
    expect(pane.keys).toEqual(['Up', 'Up', 'Up', 'Enter']);
  });
});

describe('[#3812] anything but the highlight moving still stops the keys (negative)', () => {
  /** The dialog after the first Down, with `change` applied to it. */
  function changesAfterFirstDown(change: (frame: string) => string): void {
    pane.onKey = (key, frame) => {
      const moved = dialogKeys(key, frame);
      return key === 'Down' && pane.keys.length === 1 ? change(moved) : moved;
    };
  }

  it('an option relabelled', async () => {
    changesAfterFirstDown(frame => frame.replace('4. No, cancel', '4. No, deny'));
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({ code: 41, delivery: 'partial', reason: 'screen_moved_mid_send', keysSent: 1 });
    expect(pane.keys).toEqual(['Down']);
  });

  it('an option dropped (three options)', async () => {
    changesAfterFirstDown(frame =>
      frame
        .replace(/\n {2}2\. Yes, and always allow in this conversation[^\n]*/, '')
        .replace('3. Yes, and always allow for', '2. Yes, and always allow for')
        .replace('4. No, cancel', '3. No, cancel')
    );
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({ code: 41, reason: 'screen_moved_mid_send', keysSent: 1 });
  });

  it('another question', async () => {
    changesAfterFirstDown(frame => frame.replace('Run this command?', 'Allow this command?'));
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({ code: 41, reason: 'screen_moved_mid_send', keysSent: 1 });
  });

  it('another command asked about, with the same options', async () => {
    changesAfterFirstDown(frame => frame.replace(/(\n[^\n]*) {3}pwd/, '$1   ls'));
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({ code: 41, reason: 'screen_moved_mid_send', keysSent: 1 });
  });

  it('another screen altogether (the trust screen)', async () => {
    changesAfterFirstDown(() => TRUST);
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({ code: 41, reason: 'screen_moved_mid_send', keysSent: 1, highlightLeftAt: null });
  });
});

describe('[#3812] a stop between keys says where the highlight was left', () => {
  it('on the persisting option, when the highlight stops there: in the result and in its message', async () => {
    // The fourth row never takes the highlight.
    pane.onKey = (key, frame) => (key === 'Down' && highlightOf(frame) === 3 ? frame : dialogKeys(key, frame));
    const result: StrictRespondResult = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({
      code: 41,
      delivery: 'partial',
      reason: 'highlight_not_reached',
      keysSent: 3,
      outcome: null,
      highlightLeftAt: { position: 3, label: PERSIST },
    });
    expect(result.message).toContain(`The highlight was left on option 3: ${PERSIST}.`);
    // The field reaches the caller as the CLI prints it (`--json` is the result as is).
    expect(JSON.parse(JSON.stringify(result)).highlightLeftAt).toEqual({ position: 3, label: PERSIST });
    expect(pane.keys).toEqual(['Down', 'Down', 'Down']);
  });

  it('on the first option when the first arrow never moved it', async () => {
    pane.onKey = (key, frame) => (key === 'Down' ? frame : dialogKeys(key, frame));
    const result = await respondStrictly(request('No, cancel'), deps());
    expect(result).toMatchObject({
      code: 41,
      reason: 'highlight_not_reached',
      keysSent: 1,
      highlightLeftAt: { position: 1, label: 'Yes, run command' },
    });
  });

  it('null when nothing was sent (exit 40), and when the answer went through (exit 0)', async () => {
    const refused = await respondStrictly({ ...request('Maybe'), operationId: 'op-3812-refused' }, deps());
    expect(refused).toMatchObject({ code: 40, reason: 'label_not_found', highlightLeftAt: null });
    expect(refused.message).not.toContain('highlight was left');
    const answered = await respondStrictly(request('No, cancel'), deps());
    expect(answered).toMatchObject({ code: 0, highlightLeftAt: null });
  });
});
