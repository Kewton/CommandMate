/**
 * Issue #1893: opencode's permission dialog is a decision, not a finished turn.
 *
 * opencode 1.18 asks for tool permission with a bottom-anchored box whose last
 * interactive row is a horizontal button strip — no number, no `(y/n)`, no
 * "press enter to confirm" footer:
 *
 * ```
 *   ┃  △   Permission required
 *   ┃    # Shell command
 *   ┃  $ ls -la
 *   ┃   Allow once   Allow always   Reject  ctrl+f fullscreen  ⇆ select  enter con
 * ```
 *
 * Nothing in the detection layer saw it. `detectPrompt` answered
 * `isPrompt: false`, and the status detector fell through to the `▣ Build ·
 * <model>` row opencode draws for the step that is waiting on this very dialog
 * — a Build marker whose DURATION is missing, which the pre-#1893 pattern
 * treated as optional. A blocked session was therefore published as
 * `ready` / `opencode_response_complete`: `commandmate wait` reported a false
 * completion, the sidebar went idle, the send guard opened, and
 * `isOpenCodeComplete` persisted the dialog body as if it were the answer.
 *
 * The fix is two positive-evidence changes (design rule D1,
 * `docs/design/multi-agent-state-architecture.md` §4 D1 decision 1):
 *
 *  1. the finished-turn marker must carry its duration
 *     (`OPENCODE_TURN_COMPLETE_PATTERN`), so a step that is still open is not
 *     evidence of anything;
 *  2. the dialog itself is detected, ahead of every other opencode branch, from
 *     the affordance a human acts on — the button strip inside the box's gutter
 *     (`OPENCODE_PERMISSION_PATTERN`).
 *
 * ## Why this is a `menu` and not a `prompt`
 *
 * The Issue's "expected behaviour" section asks for `hasActivePrompt: true`
 * with `options = Allow once / Allow always / Reject`. Measured against
 * opencode 1.18.21, that shape would be actively dangerous and this suite pins
 * the safe one instead (the Issue's own "fix proposal" section agrees, and so
 * does the #1786 taxonomy in `waiting-kind.ts`):
 *
 *  - `←`/`→` move the highlight through the three buttons and `Enter` confirms;
 *  - typing `3` does **nothing at all** — the button row is byte-identical
 *    before and after, with `Allow once` still highlighted;
 *  - `sendPromptAnswer` sends a numeric answer to opencode as literal text plus
 *    Enter (`src/lib/prompt-answer-sender.ts` reserves cursor navigation for
 *    claude/antigravity).
 *
 * So publishing three numbered options would make `respond <id> 3` type a
 * swallowed "3" and then confirm the highlighted button: asking to REJECT would
 * APPROVE. The reason therefore joins `SELECTION_LIST_REASONS`, which is how
 * `wait` still stops (exit 10 via `isSelectionListActive`) and how the UI
 * renders NavigationButtons — the arrow keys the strip actually takes.
 *
 * Every frame here is a live `tmux capture-pane -p -e` of opencode 1.18.21 at
 * the production 80x200 geometry; see
 * `lib/detection/fixtures/opencode-live-1893/README.md` for provenance. They are
 * raw on purpose and the first test in the file guards that.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import {
  detectSessionStatus,
  STATUS_REASON,
  SELECTION_LIST_REASONS,
  type StatusDetectionResult,
} from '@/lib/detection/status-detector';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
  OPENCODE_PERMISSION_PATTERN,
  OPENCODE_RESPONSE_COMPLETE,
  OPENCODE_TURN_COMPLETE_PATTERN,
} from '@/lib/detection/cli-patterns';
import { isOpenCodeComplete } from '@/lib/response-extractor';
import { deriveWaitingKind } from '@/lib/session/waiting-kind';

const FIXTURE_DIR = path.resolve(
  __dirname,
  'lib/detection/fixtures/opencode-live-1893',
);

function frame(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

/** Frames with the permission box open. */
const DIALOG_FRAMES = [
  'permission-bash',
  'permission-edit',
  'permission-after-complete',
] as const;

/** Frames with no box open, kept so the fix is shown not to fire everywhere. */
const NON_DIALOG_FRAMES = ['turn-aborted-no-duration', 'turn-complete-short'] as const;

const FRAME_NAMES = [...DIALOG_FRAMES, ...NON_DIALOG_FRAMES] as const;

/** The status detector as every production caller invokes it for opencode. */
function statusOf(raw: string): StatusDetectionResult {
  return detectSessionStatus(raw, 'opencode');
}

/** The Auto-Yes entry point, spelled exactly as `response-checker` spells it. */
function autoYesPromptOf(raw: string) {
  return detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('opencode'));
}

/** `response-checker` hands `isOpenCodeComplete` an ANSI-stripped frame, gutters intact. */
function completionOf(raw: string): boolean {
  return isOpenCodeComplete(stripAnsi(raw));
}

/**
 * Take the box gutter off the button row and leave every other byte — the three
 * labels, all SGR, every other row — untouched.
 *
 * This is the mutation the gutter anchor exists to reject, applied to a real
 * frame: it is how this suite proves the anchor is load-bearing rather than
 * decorative, in the same shape #1883 used for the composer row.
 */
function withoutButtonGutter(raw: string): string {
  return raw.replace(/┃(?=(?:\x1b\[[0-9;]*m|[^\S\n])*Allow once)/, ' ');
}

/**
 * Give the duration-less `▣ Build · <model>` row a duration, leaving the frame
 * otherwise byte-identical.
 *
 * The inverse mutation: it shows that the duration is what branch D reads, so a
 * green "this frame is not a completion" is not a green that would survive any
 * edit to the pattern.
 */
function withInjectedDuration(raw: string): string {
  const lines = raw.split('\n');
  const idx = lines.findIndex(line => {
    const clean = stripAnsi(line);
    return /▣\s+\w+\s+·\s+\S/.test(clean) && !OPENCODE_TURN_COMPLETE_PATTERN.test(clean);
  });
  if (idx < 0) throw new Error('frame carries no duration-less Build marker to mutate');
  // Appended after the row's trailing SGR reset, so the only difference the
  // detector can see is the duration itself.
  lines[idx] = `${lines[idx]} · 4.2s`;
  return lines.join('\n');
}

describe('Issue #1893: opencode permission fixtures are raw live captures', () => {
  it('keeps the ANSI and the box drawing every assertion below depends on', () => {
    for (const name of FRAME_NAMES) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      expect(raw, `${name} lost its box drawing`).toContain('┃');
      // 80x200 is the geometry `OPENCODE_PANE_HEIGHT` makes production capture.
      // opencode anchors the dialog box ~180 rows below the transcript it belongs
      // to, so a frame trimmed to a default pane height would not carry the
      // padding these branches window around.
      expect(
        raw.split('\n').length,
        `${name} is not a full-height (80x200) frame`,
      ).toBeGreaterThanOrEqual(200);
    }
  });

  it('holds the duration-less Build marker that made the session look finished', () => {
    // The Issue's root cause, in the bytes: the row above the dialog is the
    // step that is WAITING on it, and it has no duration.
    for (const name of ['permission-bash', 'permission-edit', 'turn-aborted-no-duration'] as const) {
      const clean = stripAnsi(frame(name));
      expect(clean, `${name} lost its Build marker`).toMatch(/▣\s+Build\s+·\s+GPT-5\.6 Luna/);
      expect(OPENCODE_TURN_COMPLETE_PATTERN.test(clean), `${name} gained a duration`).toBe(false);
    }
  });
});

describe('Issue #1893: the permission dialog is waiting, not ready', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it.each(DIALOG_FRAMES)('reports %s as a pending permission decision', name => {
    const result = statusOf(frame(name));

    // The regression itself: every one of these was `ready` /
    // `opencode_response_complete` before #1893.
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PERMISSION_PROMPT);
    expect(result.confidence).toBe('high');
  });

  it('wins over a genuine completion marker left in the transcript above it', () => {
    // `permission-after-complete` is a live frame where the box is open and the
    // PREVIOUS turn's `▣ Build · GPT-5.6 Luna · 2.3s` is still on screen. Making
    // the duration mandatory does not cover this frame — only the ordering does,
    // which is why the dialog branch sits ahead of branch D.
    const clean = stripAnsi(frame('permission-after-complete'));
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(clean)).toBe(true);

    expect(statusOf(frame('permission-after-complete')).reason).toBe(
      STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
    );
  });

  it('publishes the dialog as a menu, never as options a number could answer', () => {
    // Measured on opencode 1.18.21: ←/→ move the highlight, Enter confirms, and
    // typing `3` leaves the button row byte-identical. `sendPromptAnswer` would
    // send a numeric answer to opencode as text + Enter, so three synthesised
    // options would turn `respond <id> 3` (Reject) into an approval.
    for (const name of DIALOG_FRAMES) {
      const result = statusOf(frame(name));

      expect(result.hasActivePrompt, `${name} offered PromptPanel`).toBe(false);
      expect(result.reason, `${name} was published as an answerable prompt`).not.toBe(
        STATUS_REASON.PROMPT_DETECTED,
      );
      expect(result.promptDetection.isPrompt).toBe(false);
      expect(result.promptDetection.promptData).toBeUndefined();
    }
  });

  it('drives the same surfaces a selection list drives', () => {
    // Membership is what `current-output-builder` publishes as
    // `isSelectionListActive` — `wait` exits 10 on it instead of polling a
    // stopped agent, and the UI renders NavigationButtons (←/→ + Enter), which
    // are exactly the keys this strip takes.
    expect(SELECTION_LIST_REASONS.has(STATUS_REASON.OPENCODE_PERMISSION_PROMPT)).toBe(true);

    for (const name of DIALOG_FRAMES) {
      const result = statusOf(frame(name));
      expect(
        result.status === 'waiting' && SELECTION_LIST_REASONS.has(result.reason),
        `${name} would not have opened the nav hatch`,
      ).toBe(true);
      expect(
        deriveWaitingKind({
          waiting: true,
          hasActivePrompt: result.hasActivePrompt,
          scraperStatus: result.status,
          scraperReason: result.reason,
        }),
      ).toBe('menu');
    }
  });

  it('never offers the dialog to Auto-Yes as an answerable prompt', () => {
    // Auto-Yes bypasses the status detector entirely (`response-checker.ts` calls
    // `detectPrompt` directly), so `hasActivePrompt: false` alone would not stop
    // a wrong auto-answer. If this ever goes red, the numeric-answer hazard above
    // is live again on the `respond` route too — it re-detects with this exact
    // call — and the send path has to be fixed before the options are published.
    for (const name of FRAME_NAMES) {
      const detection = autoYesPromptOf(frame(name));
      expect(detection.isPrompt, `${name} was offered to Auto-Yes`).toBe(false);
      expect(detection.promptData).toBeUndefined();
    }
  });

  it('pins the reason string the CLI and the skills branch on', () => {
    expect(STATUS_REASON.OPENCODE_PERMISSION_PROMPT).toBe('opencode_permission_prompt');
  });
});

describe('Issue #1893: a Build marker is only evidence with its duration', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('still reads a finished turn — including a 2.3-second one', () => {
    // The pre-#1893 docstring justified the optional duration with "short
    // responses may omit the timing portion". This frame is a two-word answer
    // that took 2.3s and carries `· 2.3s`, so the duration-less branch never had
    // a completed turn to cover.
    const raw = frame('turn-complete-short');
    expect(stripAnsi(raw)).toContain('▣  Build · GPT-5.6 Luna · 2.3s');

    const result = statusOf(raw);
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(result.hasActivePrompt).toBe(false);
    expect(completionOf(raw)).toBe(true);
  });

  it('claims nothing for a turn that ended without one', () => {
    // Live frame taken after answering `Reject`: the box is gone, opencode is
    // idle, and the only Build row it left behind has no duration. The honest
    // answer is that there is no positive evidence here, which is what D1 asks
    // for — `ready` would be a completion nobody observed. `wait` reaches this
    // through the existing unclassified path (evidence: none) rather than
    // reporting a turn that never finished as done.
    const result = statusOf(frame('turn-aborted-no-duration'));

    expect(result.status).not.toBe('ready');
    expect(result.reason).not.toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(result.hasActivePrompt).toBe(false);
    expect(completionOf(frame('turn-aborted-no-duration'))).toBe(false);
  });

  it('keeps the loose Build-line filter matching both forms', () => {
    // `OPENCODE_RESPONSE_COMPLETE` stays deliberately loose: `tui-accumulator`,
    // `response-cleaner` and the turn-boundary counter in `response-checker` use
    // it to DROP the summary row from an extracted response, and the mid-step row
    // has to be dropped too. Tightening it there would leak `▣ Build · <model>`
    // into saved responses (#1911's files). If this goes red, that regression is
    // what changed — not this Issue's verdict.
    const midStep = stripAnsi(frame('turn-aborted-no-duration'));
    expect(OPENCODE_RESPONSE_COMPLETE.test(midStep)).toBe(true);
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(midStep)).toBe(false);

    // A two-word model name is why the old pattern could not require the
    // duration in place: `\S+` stopped at `GPT-5.6` and its optional group could
    // never reach `· 5.2s`.
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test('▣  Build · GPT-5.6 Luna · 5.2s')).toBe(true);
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test('▣  Compaction · qwen3:8b · 1m 4.0s')).toBe(true);
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test('▣  Build · GPT-5.6 Luna')).toBe(false);
  });
});

describe('Issue #1893: response extraction stops treating the dialog as an answer', () => {
  it.each(DIALOG_FRAMES)('refuses to call %s a completed response', name => {
    // `isOpenCodeComplete` is what makes `response-checker` persist a frame as the
    // agent's answer and stop polling. Before #1893 all three of these returned
    // true, so the dialog body was saved as the reply to a question the agent had
    // not answered yet. Shared with #1911.
    expect(completionOf(frame(name))).toBe(false);
  });
});

describe('Issue #1893: the guards are load-bearing (mutation-injected)', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('stops recognising the dialog when only the button row gutter is removed', () => {
    // Non-vacuity for the gutter anchor, injected into a real capture: the three
    // labels, the SGR and every other row are byte-identical to
    // `permission-bash`; only the box gutter in front of `Allow once` is gone.
    const original = frame('permission-bash');
    const mutated = withoutButtonGutter(original);

    expect(mutated).not.toBe(original);
    expect(stripAnsi(mutated)).toContain('Allow once');
    expect(OPENCODE_PERMISSION_PATTERN.test(stripAnsi(original))).toBe(true);
    expect(OPENCODE_PERMISSION_PATTERN.test(stripAnsi(mutated))).toBe(false);

    expect(statusOf(mutated).reason).not.toBe(STATUS_REASON.OPENCODE_PERMISSION_PROMPT);
  });

  it('lets the completion marker back through when the dialog guard is mutated away', () => {
    // Non-vacuity for the SECOND guard in `isOpenCodeComplete`. This frame has a
    // real `· 2.3s` marker from the previous turn, so the duration requirement
    // alone does not save it: with the gutter gone the function goes back to
    // calling an open dialog a finished response.
    const raw = frame('permission-after-complete');
    expect(completionOf(raw)).toBe(false);
    expect(completionOf(withoutButtonGutter(raw))).toBe(true);
  });

  it('flips the aborted turn to ready when a duration is injected into its marker', () => {
    // Non-vacuity for the duration requirement: the frame is otherwise
    // byte-identical, and adding `· 4.2s` to the row is the only difference
    // between "no evidence" and "finished".
    const raw = frame('turn-aborted-no-duration');
    const mutated = withInjectedDuration(raw);

    expect(mutated).not.toBe(raw);
    expect(statusOf(raw).reason).not.toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);

    const result = statusOf(mutated);
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  it('would have reported the reported bug without either fix', () => {
    // The Issue, reconstructed from its own frame: take the dialog anchor away
    // and give the waiting step a duration, and `permission-bash` is
    // `ready` / `opencode_response_complete` again — the exact verdict #1893
    // reports, on the exact frame it was reported from.
    const reconstructed = withInjectedDuration(withoutButtonGutter(frame('permission-bash')));
    const result = statusOf(reconstructed);

    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(result.hasActivePrompt).toBe(false);
  });
});
