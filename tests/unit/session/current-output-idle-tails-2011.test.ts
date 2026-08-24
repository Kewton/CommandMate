/**
 * The seven live idle Claude panes, at the payload the server publishes
 * (Issue #2011, 受入条件 1–3).
 *
 * The frames are verbatim `tmux capture-pane -p -e` captures of Claude Code
 * 2.1.241 on a 200x1000 pane, three of them with one transcript-tail row
 * substituted — see the README next to them for which and why. What they have in
 * common is the shape the Issue was reported from: a session sitting at its
 * composer with something other than a completion marker as the last thing above
 * the input box.
 *
 * ## Why the payload and not the detector
 *
 * `detectSessionStatus` publishes `evidence`; it does not publish
 * `isUnclassifiedActive`. The flag is derived one layer up and then run through
 * `mergeStructuredStatus`, and #1927's regression lived in exactly that gap — a
 * detector-level suite would have stayed green through all of it. §11 says this
 * in as many words about DR2-003, and it is just as true of the route this Issue
 * fixes.
 *
 * ## The positive control
 *
 * `help-overlay.txt` is a real `/help` overlay: no composer, no status row,
 * nothing any rule can read. It must stay `true`, and it is what stops this file
 * being satisfied by "make the flag false". Mutating the flag's definition to
 * ignore the reason entirely turns this row red — see the mutation table in the
 * commit message.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null), createMessage: vi.fn() }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }) }),
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
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { IDLE_EVIDENCE_ENV_VAR } from '@/config/detection-evidence-config';
import { STATUS_REASON } from '@/lib/detection/status-detector';

const FIXTURE_DIR = path.resolve(__dirname, '../lib/detection/fixtures/claude-live-2011');
const db = {} as Database.Database;

function frame(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf8');
}

async function payloadFor(name: string) {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame(name));
  return buildCurrentOutput(db, 'wt-1', 'claude', 'claude');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  // The idle rule is asked for by name. #2011 put claude back to `observe`,
  // under which `resolveIdleEvidence` publishes `'positive'` for every composer
  // row — and a suite that let it do so here could not tell the fixed build from
  // the broken one, because the broken build derived the flag from the evidence.
  // `enforce` is the worst case for this Issue and therefore the one to pin.
  process.env[IDLE_EVIDENCE_ENV_VAR] = 'claude=enforce';
});

afterEach(() => {
  delete process.env[IDLE_EVIDENCE_ENV_VAR];
});

/**
 * The four tail rows from the Issue's field table, plus the two captured
 * alongside them. Each is a genuinely idle pane whose last transcript row is
 * something other than `✻ <Verb> for <N>s`.
 */
const IDLE_TAILS: ReadonlyArray<[name: string, tailRow: string]> = [
  ['idle-tail-new-task-clear', 'new task? /clear to save 196.1k tokens'],
  ['idle-tail-update-installed', '✔ Update installed · Restart to update'],
  ['idle-tail-tip-memory', 'Tip: Use /memory to view and manage Claude memory'],
  ['idle-tail-model-saved', 'Set model to Opus 5 (1M context) and saved as your default'],
  ['idle-tail-command-result', 'Cancelled memory editing'],
];

describe('[#2011] the fixtures are what they claim to be', () => {
  it.each([...IDLE_TAILS])('%s carries the reported tail row', (name, tailRow) => {
    // Guards the substitution: a derived frame that lost its row, or a base
    // frame renamed by accident, would otherwise pass every assertion below for
    // the wrong reason.
    //
    // Stripped first because Claude colours parts of these rows in their own SGR
    // runs — the model name in `Set model to <b>Opus 5 (1M context)</b>` is bold
    // — so a raw substring match is a silent false negative on a real capture.
    expect(stripAnsi(frame(name))).toContain(tailRow);
  });

  it('holds 1000-row captures with their escape sequences intact', () => {
    for (const [name] of [...IDLE_TAILS, ['help-overlay'], ['idle-turn-complete-marker']]) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      // The geometry is load-bearing: Claude anchors its chrome to the bottom of
      // the pane and leaves hundreds of blank rows above it, so a re-capture at a
      // default height would put the transcript and the chrome in one tail
      // window and the rules would stop being about the rows they name.
      expect(raw.split('\n').length, `${name} is not a 1000-row capture`).toBeGreaterThanOrEqual(
        1000,
      );
    }
  });
});

describe('[#2011] 受入条件 1/2 — an idle composer is classified, with or without proof', () => {
  it.each([...IDLE_TAILS])('%s publishes isUnclassifiedActive: false', async name => {
    const payload = await payloadFor(name);

    // The wire status is unchanged by any of this (DR3-002).
    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    // 受入条件 2: the evidence may stay `'none'`, and under `enforce` it does.
    // Separating the flag is the goal; getting Claude's idle rule to vouch for
    // these frames is a different Issue, and deliberately not attempted here.
    expect(payload.statusEvidence).toBe('none');
    // 受入条件 1, and the regression: on develop every one of these was `true`.
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('the same session with a completion marker on the tail reads positive', async () => {
    // Captured minutes earlier from the same live session, so the difference
    // between this row and the five above is one transcript line. It is what
    // makes the `'none'` assertions above non-vacuous: the rule still works.
    const payload = await payloadFor('idle-turn-complete-marker');

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(payload.statusEvidence).toBe('positive');
    expect(payload.isUnclassifiedActive).toBe(false);
  });
});

describe('[#2011] 受入条件 3 — the positive control', () => {
  it('a real /help overlay is still an unclassified frame', async () => {
    // The frame the flag exists for: Claude paints the overlay over the whole
    // pane, the composer is gone, and the chain runs out at the `default` floor.
    // A human has to press Esc, and `TerminalEscapeHatch` is the only way to
    // send one from the browser.
    const payload = await payloadFor('help-overlay');

    expect(payload.sessionStatus).toBe('running');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.DEFAULT);
    expect(payload.statusEvidence).toBe('none');
    expect(payload.isUnclassifiedActive).toBe(true);
  });

  it('and is not mistaken for a prompt or a selection list', async () => {
    // The `/help` footer reads `Esc to cancel`, which is the row #1497 had to
    // rule out as a selection-list footer. Re-pinned on a 2.1.241 capture.
    const payload = await payloadFor('help-overlay');

    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.isSelectionListActive).toBe(false);
  });
});
