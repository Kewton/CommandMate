/**
 * Issue #2046: what pressing an opencode quick key actually does to a frame.
 *
 * Every fixture here is a raw `capture-pane` of a live opencode 1.18.22 driven
 * by the keys this Issue publishes (and by the two it refuses), taken at the
 * **80 columns `resolveOpencodePaneWidth()` defaults to** — the width real panes
 * run at, not a width chosen to make a point. Harness and provenance:
 * `tests/fixtures/opencode-live-2046/README.md` and §22 of
 * `docs/design/opencode-server-live-verification.md`.
 *
 * The suite answers three questions, and only the first is an acceptance
 * criterion. The other two are the record of why the strip is missing a button.
 *
 * 1. **`Tab` cycles the agent.** The composer status line reads `Build · …`
 *    before and `Plan · …` after, and a second `Tab` returns the frame to the
 *    byte the first one started from.
 * 2. **`ctrl+x b` breaks detection at 80 columns.** #2047 established that
 *    opencode paints its sidebar at ≥121 columns and that the sidebar shares
 *    capture ROWS with the transcript. What this Issue measured is that the
 *    explicit toggle IGNORES that gate: at 80 columns the sidebar comes on, and
 *    the same session then reads `running` / `unknown_frame` with the sidebar
 *    text saved as the assistant's reply.
 * 3. **Before the first turn the chord falls through into the composer.**
 *    `sidebar_toggle` is session-scoped, so on opencode's home screen the leader
 *    does not consume the letter and a literal `b` is typed instead — which also
 *    flips `ready` / `input_prompt` to `running` / `unknown_frame`.
 *
 * Together (2) and (3) are why `b` is not in `OPENCODE_LEADER_CHORD_VALUES` and
 * why the four session-scoped chords that ARE published are disabled until the
 * pane reports a session.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import { detectSessionStatus, type StatusDetectionResult } from '@/lib/detection/status-detector';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
  OPENCODE_IDLE_COMPOSER_PATTERN,
} from '@/lib/detection/cli-patterns';
import { isOpenCodeComplete, sliceOpenCodeTurn } from '@/lib/response-extractor';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';
import { OPENCODE_PANE_WIDTH, OPENCODE_SIDEBAR_MIN_WIDTH } from '@/config/tmux-pane-config';
import { OPENCODE_LEADER_CHORD_VALUES } from '@/types/terminal-keys';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/opencode-live-2046/w80');

const FRAME_NAMES = [
  'agent-build',
  'agent-plan',
  'dialog-agent-list',
  'dialog-command-palette',
  'dialog-session-list',
  'dialog-timeline',
  'home-idle',
  'home-leader-b-fallthrough',
  'sidebar-off',
  'sidebar-on',
] as const;
type FrameName = (typeof FRAME_NAMES)[number];

function frame(name: FrameName): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

/** Every published verdict one frame produces, in one comparable object. */
function verdictOf(raw: string) {
  resetDetectPromptCache();
  const status: StatusDetectionResult = detectSessionStatus(raw, 'opencode');
  resetDetectPromptCache();
  const prompt = detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('opencode'));
  const clean = stripAnsi(raw);

  return {
    status: status.status,
    reason: status.reason,
    hasActivePrompt: status.hasActivePrompt,
    isPrompt: prompt.isPrompt,
    idleComposerPattern: OPENCODE_IDLE_COMPOSER_PATTERN.test(clean),
    turnComplete: isOpenCodeComplete(clean),
  };
}

/** The reply `sliceOpenCodeTurn` + `cleanOpenCodeResponse` would save. */
function savedReply(raw: string): string {
  return cleanOpenCodeResponse(stripAnsi(sliceOpenCodeTurn(raw))).replace(/\s+/g, ' ').trim();
}

/** The composer's status line, which is where opencode names the active agent. */
function agentLine(raw: string): string {
  const line = stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('┃') && l.includes('GitHub Copilot'));
  return line ?? '';
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('Issue #2046: the fixtures are raw 80-column captures of a live opencode', () => {
  it.each(FRAME_NAMES)('%s keeps its escape sequences, its gutter and its full height', (name) => {
    const raw = frame(name);
    expect(raw).toContain('\x1b[');
    expect(raw).toContain('┃');
    expect(raw.split('\n').length).toBeGreaterThanOrEqual(200);
  });

  it('was captured at the width production actually runs opencode at', () => {
    // If the default ever moves, this suite's premise ("at 80 columns…") stops
    // being about production and the fixtures have to be re-taken.
    expect(OPENCODE_PANE_WIDTH).toBe(80);
    // …and below the width #2047 measured the sidebar auto-appearing at, which
    // is what makes the ctrl+x b result below a finding rather than a tautology.
    expect(OPENCODE_PANE_WIDTH).toBeLessThan(OPENCODE_SIDEBAR_MIN_WIDTH);
  });
});

describe('Issue #2046 acceptance: Tab flips the agent between build and plan', () => {
  it('reads Build before the Tab and Plan after it', () => {
    expect(agentLine(frame('agent-build'))).toContain('Build ·');
    expect(agentLine(frame('agent-plan'))).toContain('Plan ·');
  });

  it('changes nothing else — same model, same provider, same everything the detectors read', () => {
    expect(agentLine(frame('agent-build'))).toBe(
      agentLine(frame('agent-plan')).replace('Plan ·', 'Build ·')
    );
    expect(verdictOf(frame('agent-plan'))).toEqual(verdictOf(frame('agent-build')));
    expect(savedReply(frame('agent-plan'))).toBe(savedReply(frame('agent-build')));
  });

  it('is an involution at the frame level: Tab twice returns the identical bytes', () => {
    // `agent-build` was captured after the second Tab, `sidebar-off` before the
    // first. They are the same file byte for byte, which is a stronger statement
    // than "the label went back" — nothing else moved either.
    expect(frame('agent-build')).toBe(frame('sidebar-off'));
  });
});

describe('Issue #2046: why `ctrl+x b` is not published — the 80-column measurement', () => {
  it('turns the sidebar on at 80 columns, below the width #2047 measured it appearing at', () => {
    const on = stripAnsi(frame('sidebar-on'));
    const off = stripAnsi(frame('sidebar-off'));

    // #2047's finding: no sidebar under 121 columns. That holds — until someone
    // presses the toggle, which is the whole point of this fixture pair.
    for (const marker of ['Context', 'LSPs are disabled', 'tokens']) {
      expect(off).not.toContain(marker);
      expect(on).toContain(marker);
    }
  });

  it('steals about half the pane: the transcript is truncated mid-line', () => {
    // 80 columns minus the sidebar leaves ~37 for the transcript, so opencode's
    // own turn footer stops mid-word. Nothing downstream can recover the rest.
    expect(stripAnsi(frame('sidebar-off'))).toContain('▣  Build · Claude Sonnet 4.6 · 2.8s');
    expect(stripAnsi(frame('sidebar-on'))).not.toContain('▣  Build · Claude Sonnet 4.6 · 2.8s');
  });

  it('flips a finished turn to `running` / `unknown_frame` and un-completes it', () => {
    expect(verdictOf(frame('sidebar-off'))).toMatchObject({
      status: 'ready',
      reason: 'opencode_response_complete',
      turnComplete: true,
    });
    expect(verdictOf(frame('sidebar-on'))).toMatchObject({
      status: 'running',
      reason: 'unknown_frame',
      turnComplete: false,
    });
  });

  it('saves the sidebar as the assistant’s reply', () => {
    expect(savedReply(frame('sidebar-off'))).toBe('OK2046');

    const polluted = savedReply(frame('sidebar-on'));
    expect(polluted).not.toBe('OK2046');
    for (const fragment of ['tokens', 'spent', 'LSPs are disabled']) {
      expect(polluted).toContain(fragment);
    }
  });

  it('is therefore absent from the published chord letters', () => {
    expect(OPENCODE_LEADER_CHORD_VALUES as readonly string[]).not.toContain('b');
  });
});

describe('Issue #2046: session-scoped chords fall through before the first turn', () => {
  it('types the letter into the composer instead of running the command', () => {
    const home = stripAnsi(frame('home-idle'));
    const after = stripAnsi(frame('home-leader-b-fallthrough'));

    // opencode's home screen shows a placeholder in the box (#1883). After the
    // chord the box holds a literal `b` and the placeholder is gone: the leader
    // did not consume the letter.
    expect(home).toContain('Ask anything...');
    expect(after).not.toContain('Ask anything...');
    expect(after.split('\n').some((l) => l.trim() === '┃  b')).toBe(true);
  });

  it('flips the pane from `ready` / `input_prompt` to `running` / `unknown_frame`', () => {
    expect(verdictOf(frame('home-idle'))).toMatchObject({
      status: 'ready',
      reason: 'input_prompt',
      idleComposerPattern: true,
    });
    expect(verdictOf(frame('home-leader-b-fallthrough'))).toMatchObject({
      status: 'running',
      reason: 'unknown_frame',
      idleComposerPattern: false,
    });
  });
});

describe('Issue #2046: the dialogs the published chords open', () => {
  it.each([
    ['dialog-agent-list', 'Select agent'],
    ['dialog-session-list', 'Sessions'],
    ['dialog-timeline', 'Timeline'],
    ['dialog-command-palette', 'Commands'],
  ] as const)('%s is really on screen (not just a 200 from a headless route)', (name, heading) => {
    // Every one of these was opened with a KEYSTROKE on a live TUI and read back
    // off the pane. §11.3.3 is why that distinction matters: opencode's
    // `/tui/open-*` routes answer `200 true` even with no TUI attached at all,
    // so "the HTTP call succeeded" is not evidence the dialog exists. None of
    // these is wired to an HTTP route.
    expect(stripAnsi(frame(name))).toContain(heading);
  });

  it('is read as a dialog and never as a finished turn (Issue #2112)', () => {
    // What this assertion said until #2112: that `dialog-agent-list`,
    // `dialog-session-list` and `dialog-timeline` were `ready` /
    // `turnComplete: true`, described as the dialogs being harmless because
    // Escape closes them. The verdict was the harm. `ready` is positive
    // evidence, so `commandmate wait` exited 0 on a pane blocked on a human and
    // the unclassified escape hatch never opened — see #2112 and
    // `detection-opencode-modal-overlay-2112.test.ts`.
    //
    // `turnComplete` is still true, and that is the point rather than a
    // leftover: `isOpenCodeComplete` reads the marker of the turn that finished
    // BEFORE the dialog was opened, and it is still on the pane behind the
    // overlay. The gate is what stops that marker being read as this moment's
    // verdict.
    for (const name of ['dialog-agent-list', 'dialog-session-list', 'dialog-timeline'] as const) {
      expect(verdictOf(frame(name)), name).toMatchObject({
        status: 'waiting',
        reason: 'opencode_modal_overlay',
        hasActivePrompt: false,
        turnComplete: true,
      });
    }
  });

  it('reads the ctrl+p palette the same way, which the heading allowlist never did', () => {
    // The palette was `running` / `unknown_frame` — the "no evidence" side,
    // where #1708's dwell already stopped `wait`. It now joins the other three
    // on the positive side, so all four dialogs answer with one reason instead
    // of splitting on whether a heading happened to be allowlisted.
    expect(verdictOf(frame('dialog-command-palette'))).toMatchObject({
      status: 'waiting',
      reason: 'opencode_modal_overlay',
      hasActivePrompt: false,
    });
  });
});
