/**
 * The strict `respond` (Issue #3756): nothing is sent unless a fresh read
 * still shows the screen the caller observed, keys go one at a time with a
 * read between them, and a retry of the same operation sends nothing twice.
 *
 * The pane is a fake whose frames are the measured agy captures; every
 * observation and token is the real one (`buildPromptObservation`, the
 * server's appearance tracker, the token module).
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildPromptObservation, type ObservationPayload } from '@/lib/prompt-observation/observe';
import { forgetScreenAppearance, noteScreenAppearance } from '@/lib/prompt-observation/appearance';
import {
  clearStrictRespondState,
  respondStrictly,
  type StrictRespondDeps,
  type StrictRespondRequest,
} from '@/lib/prompt-observation/strict-respond';
import type { PromptObservationKind } from '@/lib/prompt-observation/kinds';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(path.join(FIXTURES, rel), 'utf8');

const TRUST = read('prompt-observation-3755/antigravity-trust.txt');
const PERMISSION = read('antigravity-live-2364/dialog-bash-oneline.txt');
const COMPOSER = read('antigravity-live-2364/boot-idle.txt');
const FOLDER = '/Users/agy-user/share/work/github_kewton/CommandAgent-issue-643-tools-bash-cd-next-js-id-635-637';

/** The trust screen with the highlight on `No, exit`. */
const TRUST_ON_NO = TRUST.replace('> Yes, I trust this folder\n  No, exit', '  Yes, I trust this folder\n> No, exit');
/** The trust screen whose folder row is not drawn. */
const TRUST_NO_FOLDER = TRUST.replace(/Accessing workspace:[\s\S]*?(?=Do you trust)/, '');

const SESSION = 'mcbd-antigravity-wt-3756';
const GENERATION = 1_800_000_000_000;

interface FakePane {
  frame: string;
  running: boolean;
  /** What each key does to the frame; unset keys leave it. */
  onKey: (key: string, frame: string) => string;
  keys: string[];
  clock: number;
  failCapture: boolean;
  failObservation: boolean;
  failKey: boolean;
  windowOpen: boolean;
  claimedRecently: boolean;
  autoYes: boolean;
  holds: number;
  releases: number;
  discarded: number;
}

let pane: FakePane;
let instanceSeq = 0;
let instanceId: string;

/** The status layer's verdict as it reads the fixtures: the composer is `ready`, a screen is waiting. */
function payloadOf(frame: string): ObservationPayload {
  const idle = frame === COMPOSER;
  return {
    isRunning: pane.running,
    sessionName: SESSION,
    sessionStatus: idle ? 'ready' : 'waiting',
    sessionStatusReason: idle ? 'input_prompt' : 'antigravity_selection_list',
    fullOutput: frame,
    isPromptWaiting: false,
    promptData: null,
    promptView: null,
    isSelectionListActive: !idle,
    isPagerActive: false,
    isDismissablePanelActive: false,
    isUnclassifiedActive: false,
    startingSince: null,
    autoYes: undefined,
    serverPollerActive: false,
  };
}

/** One observation of the fake pane, through the server's appearance tracker. */
function observe() {
  const instance = { worktreeId: 'wt-3756', cliToolId: 'antigravity', instanceId };
  return buildPromptObservation({
    ...instance,
    resolvedBy: 'roster',
    payload: payloadOf(pane.frame),
    sessionGeneration: GENERATION,
    contract: { policy: null, taskId: null },
    appearance: {
      note: (fingerprint) => noteScreenAppearance(instance, fingerprint, pane.clock),
      forget: () => forgetScreenAppearance(instance),
    },
    now: pane.clock,
  });
}

function deps(): StrictRespondDeps {
  return {
    async read() {
      if (pane.failCapture) return { ok: false, stage: 'capture', error: 'tmux gone' };
      if (pane.failObservation) return { ok: false, stage: 'observation', error: 'state broken' };
      return { ok: true, observation: observe(), frame: pane.frame };
    },
    async sendKey(key) {
      if (pane.failKey) throw new Error('send-keys failed');
      pane.keys.push(key);
      pane.frame = pane.onKey(key, pane.frame);
    },
    async sleep(ms) {
      pane.clock += ms;
    },
    now: () => pane.clock,
    autoYesActive: () => pane.autoYes,
    startup: {
      isWindowOpen: () => pane.windowOpen,
      claimedWithin: () => pane.claimedRecently,
      hold: () => {
        pane.holds++;
        return () => {
          pane.releases++;
        };
      },
      discardDebt: () => {
        pane.discarded++;
      },
    },
  };
}

/** The trust screen's arrows and Enter: Yes → the composer, No → the session ends. */
function trustKeys(key: string, frame: string): string {
  if (key === 'Down') return frame === TRUST ? TRUST_ON_NO : frame;
  if (key === 'Up') return frame === TRUST_ON_NO ? TRUST : frame;
  if (key === 'Enter') {
    if (frame === TRUST_ON_NO) pane.running = false;
    return COMPOSER;
  }
  return frame;
}

/** The token `commandmate prompt` would have printed for the pane as it is now. */
function tokenNow(): string {
  const token = observe().screen?.token;
  if (!token) throw new Error('no token issued for the fixture');
  return token;
}

let opSeq = 0;
function request(over: Partial<StrictRespondRequest> = {}): StrictRespondRequest {
  return {
    worktreeId: 'wt-3756',
    sessionName: SESSION,
    expectScreen: 'antigravity-trust' as PromptObservationKind,
    observationToken: tokenNow(),
    answer: 'Yes',
    expectTarget: FOLDER,
    operationId: `op-3756-${++opSeq}`,
    ...over,
  };
}

beforeEach(() => {
  clearStrictRespondState();
  // A fresh instance per test, so no appearance or used token leaks between them.
  instanceId = `antigravity-${++instanceSeq}`;
  pane = {
    frame: TRUST,
    running: true,
    onKey: trustKeys,
    keys: [],
    clock: GENERATION + 60_000,
    failCapture: false,
    failObservation: false,
    failKey: false,
    windowOpen: false,
    claimedRecently: false,
    autoYes: false,
    holds: 0,
    releases: 0,
    discarded: 0,
  };
});

afterEach(() => {
  clearStrictRespondState();
});

describe('[#3756] the trust screen (positive case)', () => {
  it('answers the label Yes with one Enter and reports the screen advanced', async () => {
    const result = await respondStrictly(request(), deps());

    expect(pane.keys).toEqual(['Enter']);
    expect(result).toMatchObject({
      strictRespond: 1,
      code: 0,
      delivery: 'sent',
      reason: null,
      expectedKind: 'antigravity-trust',
      observedKind: 'antigravity-trust',
      observedTarget: FOLDER,
      answer: { position: 1, label: 'Yes, I trust this folder' },
      keysSent: 1,
      outcome: 'advanced',
      replayed: false,
    });
    // The launch's owed Enter is dropped, and the hold is released.
    expect(pane.discarded).toBe(1);
    expect(pane.holds).toBe(1);
    expect(pane.releases).toBe(1);
  });

  it('navigates to No with Down, reads the highlight, then Enter', async () => {
    const result = await respondStrictly(request({ answer: 'No' }), deps());

    expect(pane.keys).toEqual(['Down', 'Enter']);
    // agy exits on "No, exit": success, but not read as "moved on".
    expect(result).toMatchObject({ code: 0, answer: { position: 2, label: 'No, exit' }, outcome: 'session-ended' });
  });

  it('drops the launch\'s owed Enter only after its own Enter, never on a refusal', async () => {
    let discardedBeforeEnter = -1;
    pane.onKey = (key, frame) => {
      if (key === 'Enter') discardedBeforeEnter = pane.discarded;
      return trustKeys(key, frame);
    };
    await respondStrictly(request(), deps());
    expect(discardedBeforeEnter).toBe(0);
    expect(pane.discarded).toBe(1);

    pane.frame = TRUST;
    expect(await respondStrictly(request({ expectTarget: '/elsewhere' }), deps())).toMatchObject({ code: 40 });
    expect(pane.discarded).toBe(1);
  });
});

describe('[#3756] nothing is sent when the screen does not match (exit 40)', () => {
  it('a trust answer aimed at a command-execution permission dialog is refused with the kind it saw (negative control)', async () => {
    const token = tokenNow();
    pane.frame = PERMISSION;
    const result = await respondStrictly(request({ observationToken: token }), deps());

    expect(pane.keys).toEqual([]);
    expect(result).toMatchObject({
      code: 40,
      delivery: 'not-sent',
      reason: 'kind_mismatch',
      expectedKind: 'antigravity-trust',
      observedKind: 'antigravity-permission',
    });
  });

  it('a token observed before the cursor moved does not verify', async () => {
    const token = tokenNow();
    pane.frame = TRUST_ON_NO;
    const result = await respondStrictly(request({ observationToken: token }), deps());

    expect(pane.keys).toEqual([]);
    expect(result).toMatchObject({ code: 40, reason: 'token_mismatch' });
  });

  it('without --expect-target it returns the folder it saw, sends nothing, and leaves the token usable', async () => {
    const token = tokenNow();
    const refused = await respondStrictly(request({ observationToken: token, expectTarget: null }), deps());
    expect(refused).toMatchObject({ code: 40, reason: 'expect_target_required', observedTarget: FOLDER });
    expect(pane.keys).toEqual([]);

    const answered = await respondStrictly(request({ observationToken: token }), deps());
    expect(answered.code).toBe(0);
  });

  it('another folder, and a trust screen whose folder is unreadable, are refused', async () => {
    expect(await respondStrictly(request({ expectTarget: '/elsewhere' }), deps())).toMatchObject({
      code: 40,
      reason: 'target_mismatch',
    });
    pane.frame = TRUST_NO_FOLDER;
    expect(await respondStrictly(request(), deps())).toMatchObject({ code: 40, reason: 'approval_target_unreadable' });
    expect(pane.keys).toEqual([]);
  });

  it('an option number on the trust screen is refused', async () => {
    expect(await respondStrictly(request({ answer: '1' }), deps())).toMatchObject({
      code: 40,
      reason: 'number_on_unnumbered_screen',
    });
    expect(pane.keys).toEqual([]);
  });

  it('a failed capture and a throwing observation stop before any key', async () => {
    const token = tokenNow();
    pane.failCapture = true;
    expect(await respondStrictly(request({ observationToken: token }), deps())).toMatchObject({
      code: 40,
      reason: 'capture_failed',
      observedKind: null,
    });
    pane.failCapture = false;
    pane.failObservation = true;
    expect(await respondStrictly(request({ observationToken: token }), deps())).toMatchObject({
      code: 40,
      reason: 'observation_failed',
    });
    expect(pane.keys).toEqual([]);
  });

  it('a trust screen quoted in a reply still being generated is not answered (#3755 L3)', async () => {
    pane.frame = `${TRUST.trimEnd()}\n\nThat was the screen agy showed.\nIt asks whether the folder is trusted.\nThe answer is up to you.\nGenerating…\n`;
    const result = await respondStrictly(request(), deps());
    expect(result).toMatchObject({ code: 40, reason: 'screen_not_open', observedKind: 'antigravity-trust' });
    expect(pane.keys).toEqual([]);
  });

  it('defers to the launch while its window is open, and right after its owed Enter was claimed', async () => {
    pane.windowOpen = true;
    expect(await respondStrictly(request(), deps())).toMatchObject({ code: 40, reason: 'startup_window_open' });
    pane.windowOpen = false;
    pane.claimedRecently = true;
    expect(await respondStrictly(request(), deps())).toMatchObject({ code: 40, reason: 'startup_trust_in_flight' });
    expect(pane.keys).toEqual([]);
    expect(pane.holds).toBe(0);
  });

  it('a kind the strict respond does not answer is refused even when it matches', async () => {
    pane.frame = read('antigravity-live-2364/picker-switch-model.txt');
    const result = await respondStrictly(
      request({ expectScreen: 'antigravity-model-picker', observationToken: tokenNow(), expectTarget: null }),
      deps()
    );
    expect(result).toMatchObject({ code: 40, reason: 'unsupported_screen' });
    expect(pane.keys).toEqual([]);
  });
});

describe('[#3756] Auto-Yes and the permission dialog', () => {
  it('a permission dialog is refused while Auto-Yes is on, with nothing sent', async () => {
    pane.frame = PERMISSION;
    pane.autoYes = true;
    const result = await respondStrictly(
      request({ expectScreen: 'antigravity-permission', observationToken: tokenNow(), expectTarget: null }),
      deps()
    );
    expect(result).toMatchObject({ code: 40, reason: 'auto_yes_active', observedKind: 'antigravity-permission' });
    expect(pane.keys).toEqual([]);
  });

  it('the same permission answer goes through with Auto-Yes off (negative control)', async () => {
    pane.frame = PERMISSION;
    pane.onKey = () => COMPOSER;
    const result = await respondStrictly(
      request({ expectScreen: 'antigravity-permission', observationToken: tokenNow(), expectTarget: null }),
      deps()
    );
    expect(result).toMatchObject({ code: 0, answer: { position: 1, label: 'Yes' } });
    expect(pane.keys).toEqual(['Enter']);
  });

  it('the trust screen, which Auto-Yes never answers, is answered with Auto-Yes on', async () => {
    pane.autoYes = true;
    expect(await respondStrictly(request(), deps())).toMatchObject({ code: 0, outcome: 'advanced' });
    expect(pane.keys).toEqual(['Enter']);
  });
});

describe('[#3756] once a key is sent, failures are exit 41', () => {
  it('stops before the Enter when the screen changes after the arrow', async () => {
    pane.onKey = (key) => (key === 'Down' ? PERMISSION : COMPOSER);
    const result = await respondStrictly(request({ answer: 'No' }), deps());

    expect(pane.keys).toEqual(['Down']);
    expect(result).toMatchObject({ code: 41, delivery: 'partial', reason: 'screen_moved_mid_send', keysSent: 1, outcome: null });
    expect(pane.releases).toBe(1);
  });

  it('stops before the Enter when the highlight never arrives', async () => {
    pane.onKey = (_key, frame) => frame;
    const result = await respondStrictly(request({ answer: 'No' }), deps());
    expect(pane.keys).toEqual(['Down']);
    expect(result).toMatchObject({ code: 41, reason: 'highlight_not_reached' });
  });

  it('a screen that stays after the Enter is reported unchanged, and not answered again', async () => {
    pane.onKey = (_key, frame) => frame;
    const result = await respondStrictly(request(), deps());
    expect(pane.keys).toEqual(['Enter']);
    expect(result).toMatchObject({ code: 41, delivery: 'sent', reason: 'outcome_unchanged', outcome: 'unchanged' });
  });

  it('a key tmux refused is counted as possibly sent', async () => {
    pane.failKey = true;
    const result = await respondStrictly(request(), deps());
    expect(result).toMatchObject({ code: 41, reason: 'send_failed', keysSent: 1 });
  });

  it('the token is used up before the keys: a second answer to the same appearance is refused', async () => {
    pane.onKey = (_key, frame) => frame;
    const token = tokenNow();
    await respondStrictly(request({ observationToken: token }), deps());
    const second = await respondStrictly(request({ observationToken: tokenNow() }), deps());

    expect(second).toMatchObject({ code: 40, reason: 'token_consumed' });
    expect(pane.keys).toEqual(['Enter']);
  });
});

describe('[#3756] operation ids', () => {
  it('a retry with the same operation id returns the stored result and sends nothing', async () => {
    const first = request();
    const answered = await respondStrictly(first, deps());
    const retried = await respondStrictly(first, deps());

    expect(pane.keys).toEqual(['Enter']);
    expect(retried).toEqual({ ...answered, replayed: true });
  });

  it('the same id with another token, answer or instance is not read as the first one', async () => {
    const first = request();
    await respondStrictly(first, deps());
    expect(pane.keys).toEqual(['Enter']);

    for (const other of [{ observationToken: 'po1.x.y' }, { answer: 'No' }, { expectTarget: '/elsewhere' }]) {
      const conflict = await respondStrictly({ ...first, ...other }, deps());
      expect(conflict).toMatchObject({ code: 41, reason: 'operation_id_conflict', keysSent: 0, replayed: false });
    }
    expect(pane.keys).toEqual(['Enter']);

    // Another instance's session: its own operation, run (and refused here on its own merits).
    const elsewhere = await respondStrictly({ ...first, sessionName: 'mcbd-antigravity-wt-3756-2' }, deps());
    expect(elsewhere.replayed).toBe(false);
    expect(elsewhere.reason).not.toBe('operation_id_conflict');
  });

  it('a refusal (exit 40) is not kept: the same id can be sent again with a corrected answer', async () => {
    const token = tokenNow();
    const first = request({ observationToken: token, answer: '1' });
    expect(await respondStrictly(first, deps())).toMatchObject({ code: 40, reason: 'number_on_unnumbered_screen' });
    // Corrected answer, same id: a new request, not a conflict with a remembered one.
    const corrected = await respondStrictly({ ...first, answer: 'Yes' }, deps());
    expect(corrected).toMatchObject({ code: 0, replayed: false });
    expect(pane.keys).toEqual(['Enter']);
  });

  it('running operations are never forgotten to make room: a full table refuses the new one', async () => {
    pane.failCapture = false;
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const stalled: StrictRespondDeps = { ...deps(), read: async () => (await blocked, deps().read()) };
    const running = Array.from({ length: 1024 }, (_, i) =>
      respondStrictly(request({ sessionName: `s-${i}`, operationId: `op-full-${i}` }), stalled)
    );
    const extra = await respondStrictly(request({ operationId: 'op-full-extra' }), deps());
    expect(extra).toMatchObject({ code: 41, reason: 'operation_table_full', keysSent: 0 });

    // The first of the running ones still refuses a duplicate.
    expect(
      await respondStrictly(request({ sessionName: 's-0', operationId: 'op-full-0' }), deps())
    ).toMatchObject({ reason: expect.stringMatching(/operation_in_progress|operation_id_conflict/) });
    unblock();
    await Promise.all(running);
  });

  it('a duplicate that arrives while the first still runs is exit 41 and sends nothing', async () => {
    const first = request();
    const running = respondStrictly(first, deps());
    const duplicate = await respondStrictly(first, deps());
    await running;

    expect(duplicate).toMatchObject({ code: 41, reason: 'operation_in_progress', delivery: 'indeterminate', keysSent: 0 });
    expect(pane.keys).toEqual(['Enter']);
  });

  it('two answers to one session run one after the other', async () => {
    pane.onKey = (_key, frame) => frame;
    const token = tokenNow();
    const [a, b] = await Promise.all([
      respondStrictly(request({ observationToken: token }), deps()),
      respondStrictly(request({ observationToken: token }), deps()),
    ]);
    // The first used the appearance up; the second, run after it, finds it used.
    expect([a.reason, b.reason]).toEqual(['outcome_unchanged', 'token_consumed']);
    expect(pane.keys).toEqual(['Enter']);
  });
});
