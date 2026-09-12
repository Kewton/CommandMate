/**
 * `isDismissablePanelActive` reaches the wire (Issue #2369).
 *
 * `buildCurrentOutput` is the single producer for both delivery paths — the
 * HTTP poll (`GET /api/worktrees/:id/current-output`) and the WebSocket push —
 * so this is where the new flag becomes visible to anything outside the server.
 * Issue #2369's own rule is "one miss in the wiring and the chat surface never
 * sees it", and the wiring is only as good as the layer that starts it.
 *
 * The three claims here are the three the surface depends on:
 *
 *  1. the flag is TRUE for the panel, and the older two flags are false — the
 *     card must not become an arrow pad or an 18-key hatch;
 *  2. `isUnclassifiedActive` is false on that same payload, which is the defect
 *     this Issue was raised about, asserted at the layer that publishes it;
 *  3. the flag is FALSE for every other screen, including the picker that
 *     `isSelectionListActive` owns.
 *
 * In its own file rather than appended to `current-output-builder.test.ts` for
 * the reason the #1695 suite gives: the module mocks differ, and a shared file
 * would make one Issue's stubs another's failure.
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

vi.mock('@/lib/db', () => ({ getSessionState: vi.fn(() => null) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  buildCompositeKey: vi.fn(() => 'wt-2369:command-code'),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { STATUS_REASON } from '@/lib/detection/status-detector';

const WT = 'wt-2369';
const ESC = '\x1b';
const ST = `${ESC}\\`;

/** Command Code's `/usage` panel, painted under a short transcript. */
const USAGE_PANEL = [
  '> what is my usage',
  '',
  '  ✻ Worked for 4s',
  '',
  ' USAGE  Go Plan · active',
  '█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 4% used',
  'Cycle: $9.61 left · 259 requests · 26 days to renewal',
  'Usage limits',
  '5-hour  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 0%',
  'Weekly  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 7% · resets in 2d 23h',
  `Full breakdown at ${ESC}]8;;https://commandcode.ai/Kewton/settings/usage${ST}` +
    `commandcode.ai/Kewton/settings/usage${ESC}]8;;${ST}`,
  'Press Esc to close',
  '',
].join('\n');

/** The `/model` picker footer — the screen `isSelectionListActive` owns. */
const MODEL_PICKER = [
  '  Anthropic',
  '  ❯ Claude Sonnet 5',
  '    Claude Opus 5',
  '',
  '› Type to search models...',
  'type to search · ↑/↓ navigate · enter to select · esc to cancel',
  '',
].join('\n');

/** An ordinary idle composer, which raises none of the three flags. */
const IDLE_COMPOSER = [
  '  ✻ Worked for 4s',
  '',
  '╭────────────────────────────╮',
  '│ ❯ Ask your question...     │',
  '╰────────────────────────────╯',
  '  ? for shortcuts · taste on',
  '',
].join('\n');

async function payloadFor(frame: string) {
  vi.mocked(captureSessionOutput).mockResolvedValue(frame);
  return buildCurrentOutput({} as Database.Database, WT, 'command-code', 'command-code');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('[#2369] buildCurrentOutput publishes isDismissablePanelActive', () => {
  it('raises it — and only it — for the /usage panel', async () => {
    const payload = await payloadFor(USAGE_PANEL);

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.COMMAND_CODE_DISMISSABLE_PANEL);
    expect(payload.isDismissablePanelActive).toBe(true);
    // Disjoint from both, by construction. If either of these ever turns true
    // the chat surface answers the panel with the wrong control set.
    expect(payload.isSelectionListActive).toBe(false);
    expect(payload.isPagerActive).toBe(false);
  });

  it('drops isUnclassifiedActive on that same payload', async () => {
    // The reported defect, asserted at the producer: this flag being true is
    // what put `TerminalEscapeHatch` + `PromptAnswerKeys` on the card.
    const payload = await payloadFor(USAGE_PANEL);

    expect(payload.isUnclassifiedActive).toBe(false);
    expect(payload.statusEvidence).toBe('positive');
  });

  it('leaves the /model picker a selection list with the panel flag false', async () => {
    const payload = await payloadFor(MODEL_PICKER);

    expect(payload.isSelectionListActive).toBe(true);
    expect(payload.isDismissablePanelActive).toBe(false);
  });

  it('publishes an explicit false for an ordinary idle composer', async () => {
    // Explicit rather than absent: `undefined` on the wire means "this server
    // predates the field", and a live server must never say that about itself.
    const payload = await payloadFor(IDLE_COMPOSER);

    expect(payload.isDismissablePanelActive).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'isDismissablePanelActive')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #2521: the footer-less question screen reaches the wire the same way
// ---------------------------------------------------------------------------

/**
 * Command Code's `AskUserQuestion`, as the anonymised live capture drew it.
 *
 * Read from the fixture rather than written inline, because the defect is in the
 * BYTES: the continuation row of option 1's description begins with a single
 * space, which is what took the frame away from the shared prompt parser and
 * left the generic composer check answering `ready` off `❯ 1. Prepare …`.
 *
 * The assertions are the API half of Issue #2521's 確定仕様 C: the flag the chat
 * surface and `wait` both read is true, and the two fields that would make this
 * look answerable stay false / null — `promptData` is #2522's to produce.
 */
const ASK_USER_QUESTION = fs.readFileSync(
  path.join(__dirname, '../../fixtures/command-code-askuserquestion-2521/askuserquestion-wrapped-1530-200x1000.txt'),
  'utf-8',
);

describe('[#2521] buildCurrentOutput publishes the question screen as a selection list', () => {
  it('raises isSelectionListActive and drops the ready verdict', async () => {
    const payload = await payloadFor(ASK_USER_QUESTION);

    expect(payload.sessionStatus).toBe('waiting');
    expect(payload.sessionStatusReason).toBe(STATUS_REASON.COMMAND_CODE_SELECTION_LIST);
    expect(payload.isSelectionListActive).toBe(true);
    expect(payload.statusEvidence).toBe('positive');
  });

  it('publishes no prompt and no payload to answer it with', async () => {
    // The line between #2521 and #2522, asserted at the producer: the card and
    // `wait` get a blocked agent, and nothing gets an options list that was
    // never parsed.
    const payload = await payloadFor(ASK_USER_QUESTION);

    expect(payload.isPromptWaiting).toBe(false);
    expect(payload.promptData).toBeNull();
  });

  it('keeps the other three overlay flags false', async () => {
    // This screen has a moving highlight and no dismiss-only footer, no pager
    // and — now that a rule reads it — nothing unclassified about it.
    const payload = await payloadFor(ASK_USER_QUESTION);

    expect(payload.isDismissablePanelActive).toBe(false);
    expect(payload.isPagerActive).toBe(false);
    expect(payload.isUnclassifiedActive).toBe(false);
  });

  it('still completes a real Command Code idle pane — the verdict this branch must not take', async () => {
    // The control for the new branch, on live bytes rather than the hand-written
    // composer above: `turn-done-1490.txt` ends in Command Code's own
    // rule / `❯ Ask your question...` / rule / hint-row block, so the LAST
    // qualifying rule is the composer's lower one and the region under it is the
    // hint row. A reading that fired on "a rule with rows under it" would have
    // stopped every Command Code turn from ever finishing.
    const payload = await payloadFor(
      fs.readFileSync(
        path.join(__dirname, '../../fixtures/command-code-live-2250/turn-done-1490.txt'),
        'utf-8',
      ),
    );

    expect(payload.sessionStatus).toBe('ready');
    expect(payload.isSelectionListActive).toBe(false);
  });
});
