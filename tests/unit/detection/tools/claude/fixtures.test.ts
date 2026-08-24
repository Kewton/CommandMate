/**
 * Claude Code's detection fixtures (Issue #1927, 方針書 §11 / §4 D2).
 *
 * Six verbatim `tmux capture-pane -p -e` frames from one live Claude Code
 * 2.1.240 session on a 200x1000 pane — the geometry `src/lib/tmux/tmux.ts` pins
 * for real worktree sessions. Only the operator's email, home path, shell prompt
 * and session id were rewritten; every other byte, including all SGR and the
 * OSC 8 hyperlinks, is as captured.
 *
 * ## Why Claude needed these
 *
 * §4 D1 says a turn may be declared finished only on positive evidence, and the
 * design policy's first draft assumed Claude already had some. It does not: `⏺`
 * is a spinner glyph (RUNNING side) and the `❯` composer is drawn throughout a
 * turn, so the pre-#1927 route to `ready` was the generic composer check — the
 * "absence of a negative" the rule forbids.
 *
 * What the captures established (see `tools/claude/patterns.ts` for the full
 * table): the bottom status row does NOT discriminate. In auto mode it reads
 * `⏵⏵ auto mode on (shift+tab to cycle) · ⇥ for agents` when idle and the same
 * row plus `esc to interrupt` while generating — an idle allowlist built from it
 * would vouch for a generating frame. The TRANSCRIPT discriminates: a finished
 * turn ends with a duration-bearing marker (`✻ Brewed for 14s`), a running one
 * with prose, a tool result, or the present-participle form that carries no
 * duration.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { detectSessionStatus, STATUS_REASON } from '@/lib/detection/status-detector';
import { stripAnsi } from '@/lib/detection/cli-patterns';
import { claudeStatusDetector } from '@/lib/detection/tools/claude/detect';
import { CLAUDE_TURN_COMPLETE_PATTERN } from '@/lib/detection/tools/claude/patterns';
import { runToolFixtureSuite } from '../fixture-sweep';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

function frame(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}.txt`, 'utf8');
}

describe('[#1927] claude detection fixtures', () => {
  runToolFixtureSuite({
    tool: 'claude',
    fixtureDir: FIXTURE_DIR,
    paneRows: 1000,
    busyWord: 'interrupt',
    rewordedBusyWord: 'dismissal',
    idleFrames: [
      'boot-not-started',
      'idle-manual-complete',
      'turn-complete-auto',
      'turn-complete-tool',
    ],
    mutationFrames: ['turn-running-streaming', 'turn-running-start'],
    expectations: [
      // A session that has never opened a turn: the startup banner is on screen
      // and no user turn has been echoed under it. §4 D1 決定 1 item 4.
      {
        frame: 'boot-not-started',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      // Manual mode, turn finished. `⏸ manual mode on · ? for shortcuts`.
      {
        frame: 'idle-manual-complete',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      // Auto mode, turn finished. This is the frame that rules out the status
      // row: its bottom row is byte-identical to `turn-running-streaming`'s
      // except for the `esc to interrupt` token.
      {
        frame: 'turn-complete-auto',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      // A turn that ran a tool. Ends with the same marker as a text-only turn.
      {
        frame: 'turn-complete-tool',
        status: 'ready',
        reason: STATUS_REASON.INPUT_PROMPT,
        evidence: 'positive',
      },
      // Mid-stream: the response is being appended and there is no spinner row
      // at all, so the interrupt hint is the only running signal on the pane.
      {
        frame: 'turn-running-streaming',
        status: 'running',
        reason: STATUS_REASON.THINKING_INDICATOR,
        evidence: 'positive',
      },
      // The first seconds of a turn, before any output: Claude bottom-anchors
      // the spinner and a `⎿ Tip:` row just above the composer.
      {
        frame: 'turn-running-start',
        status: 'running',
        reason: STATUS_REASON.THINKING_INDICATOR,
        evidence: 'positive',
      },
    ],
  });

  it('reads the completion marker off the transcript, not the status row', () => {
    // The measurement that decided the rule, asserted so a future reader does
    // not have to re-run a live session to believe it: in auto mode the bottom
    // row is the same either side of the turn boundary apart from one token.
    const idleRow = bottomRow('turn-complete-auto');
    const runningRow = bottomRow('turn-running-streaming');

    expect(idleRow).toContain('auto mode on (shift+tab to cycle)');
    expect(runningRow).toContain('auto mode on (shift+tab to cycle)');
    expect(runningRow).toContain('esc to interrupt');
    expect(idleRow).not.toContain('esc to interrupt');
    // Which is why an idle allowlist over this row cannot exist: strike the one
    // token from the hint list and the two rows carry the same hints. (The
    // trailing right-aligned segment is padded to the pane width, so the
    // comparison is of the hint list, not of the whole 200-column row.)
    const hints = (row: string) => row.split(/\s{2,}/)[0].trim();
    expect(hints(runningRow).replace(' esc to interrupt ·', '')).toBe(hints(idleRow));
  });

  it('requires the duration, so the in-flight form of the same row is not a completion', () => {
    expect(CLAUDE_TURN_COMPLETE_PATTERN.test('✻ Brewed for 14s')).toBe(true);
    expect(CLAUDE_TURN_COMPLETE_PATTERN.test('✻ Cooked for 8s · 5 messages hidden')).toBe(true);
    expect(CLAUDE_TURN_COMPLETE_PATTERN.test('✻ Brewed for 1m 20s')).toBe(true);
    // The rows a live capture holds while the turn is open. Both name a verb and
    // an elapsed time; neither is in the past tense the marker uses, and this is
    // the distinction the whole rule rests on.
    expect(CLAUDE_TURN_COMPLETE_PATTERN.test('✻ Manifesting… (3s · thinking with xhigh effort)')).toBe(false);
    expect(CLAUDE_TURN_COMPLETE_PATTERN.test('· Enchanting… (5s · thinking with xhigh effort)')).toBe(false);
  });

  it('steps over the bottom-anchored task panel to reach the transcript', () => {
    // #1708's fixture: a finished turn whose completion marker sits ~870 blank
    // rows above a task panel that Claude pins to the bottom of the pane. The
    // panel is chrome, so the transcript tail is above it — a walk that stopped
    // at the first non-blank row would find `… +2 completed` and report no
    // evidence for a session that is plainly done.
    const taskPanelFrame = readFileSync(
      fileURLToPath(
        new URL('../../../lib/detection/fixtures/claude-live-1708/idle-taskpanel.txt', import.meta.url),
      ),
      'utf8',
    );
    expect(stripAnsi(taskPanelFrame)).toContain('7 tasks (2 done, 1 in progress, 4 open)');

    const result = detectSessionStatus(taskPanelFrame, 'claude');
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.evidence).toBe('positive');
  });

  it('records the build it was measured against', () => {
    expect(claudeStatusDetector.verifiedAgainst).toEqual({
      version: '2.1.240',
      capturedAt: '2026-08-23',
      paneGeometry: '200x1000',
    });
  });
});

function bottomRow(name: string): string {
  const rows = stripAnsi(frame(name)).split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trim() !== '') return rows[i].trimEnd();
  }
  throw new Error(`${name} is blank`);
}
