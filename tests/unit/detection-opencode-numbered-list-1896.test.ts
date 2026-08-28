/**
 * Issue #1896: a numbered list in an opencode ANSWER is transcript, not a prompt.
 *
 * opencode 1.18 answers "list three options and ask which one" the way any
 * model does, and leaves this on the pane:
 *
 * ```
 *      1. On-premises (self-hosted) deployment
 *      2. Cloud-managed platform (AWS/GCP/Azure)
 *      3. Containerized deployment with Kubernetes
 *         Which one do you want?
 *      ▣  Build · GPT-5.6 Luna · 2.8s
 * ```
 *
 * `detectSessionStatus` answered `waiting` / `prompt_detected` /
 * `hasActivePrompt: true` and `detectPrompt` answered `multiple_choice` with
 * those three lines as options, so `resolveAutoAnswer` produced `"1"` — and on
 * opencode a typed `1` lands in the composer and is SENT AS A USER UTTERANCE.
 * `send` was then refused by the prompt guard, `wait --on-prompt agent` exited
 * 10 and the sidebar stayed orange for the rest of the session.
 *
 * ## The fix, and why it is the whole numbered path rather than a barrier
 *
 * Design rule D1 decision 4 (`docs/design/multi-agent-state-architecture.md` §4)
 * names this Issue and says where it has to be stopped: Auto-Yes may fire only
 * on a POSITIVELY detected tool dialog, never on the generic numbered-list
 * inference alone. opencode's interactive surface was measured whole at the
 * production 80x200 geometry and neither half is number-answerable:
 *
 *  - the permission dialog is a `←`/`→` button strip (Issue #1893,
 *    `OPENCODE_PERMISSION_PATTERN`) — typing a number leaves it byte-identical;
 *  - the pickers are `↑`/`↓` fuzzy-search lists (`OPENCODE_SELECTION_LIST_PATTERN`,
 *    `model-picker.txt`) and draw no numbers at all.
 *
 * So a `1. / 2. / 3.` block on an opencode pane is transcript by construction,
 * and `buildDetectPromptOptions('opencode')` now declares
 * `hasNumberedDialogs: false` rather than trying to find a screen position that
 * separates a real one from a fake one. Both real surfaces keep their own
 * positive detection, so nothing that could be answered before stops being
 * answered — `permission-over-numbered.txt` below is the frame that proves it,
 * and it is also the frame that shows the false positive could APPROVE a tool
 * call: the `1` is swallowed by the button strip and the Enter after it confirms
 * the highlighted `Allow once`.
 *
 * The second half of the Issue is `OPENCODE_SELECTION_LIST_PATTERN`, which was
 * the bare phrase `Select model` tested against the whole ~200-row content area.
 * It now requires the picker's own right-aligned `esc` hatch.
 *
 * Every frame here is a live `tmux capture-pane -p -e` of opencode 1.18.21 at
 * 80x200; see `lib/detection/fixtures/opencode-live-1896/README.md` for
 * provenance. They are raw on purpose and the first test in the file guards that.
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
  OPENCODE_SELECTION_LIST_PATTERN,
} from '@/lib/detection/cli-patterns';
import { resolveAutoAnswer } from '@/lib/polling/auto-yes-resolver';
import { deriveWaitingKind } from '@/lib/session/waiting-kind';
import type { CLIToolType } from '@/lib/cli-tools/types';

const FIXTURE_DIR = path.resolve(
  __dirname,
  'lib/detection/fixtures/opencode-live-1896',
);

function frame(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

/** Frames whose pane carries a numbered list somewhere. */
const NUMBERED_FRAMES = [
  'numbered-answer',
  'numbered-answer-running',
  'permission-over-numbered',
  'composer-typed-numbered',
] as const;

/** Frames with no numbered list, kept so the narrowed picker pattern is exercised. */
const PICKER_FRAMES = ['model-picker', 'select-model-in-response', 'command-palette'] as const;

const FRAME_NAMES = [...NUMBERED_FRAMES, ...PICKER_FRAMES] as const;

/** The status detector as every production caller invokes it for opencode. */
function statusOf(raw: string): StatusDetectionResult {
  return detectSessionStatus(raw, 'opencode');
}

/**
 * The Auto-Yes entry point, spelled exactly as `auto-yes-poller` spells it:
 * `captureAndCleanOutput` is `stripBoxDrawing(stripAnsi(...))` and
 * `detectAndRespondToPrompt` hands the result straight to `detectPrompt`.
 * `polling/response-checker.detectPromptWithOptions` is the same three calls.
 */
function autoYesPromptOf(raw: string, cliToolId: CLIToolType = 'opencode') {
  return detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions(cliToolId));
}

/**
 * The same call with the #1896 declaration taken back off — i.e. exactly what
 * `buildDetectPromptOptions('opencode')` returned before this Issue.
 *
 * This is the mutation the whole suite rests on: it re-runs the production
 * pipeline against a real capture with one field removed, so a green above is
 * shown to come from the fix and not from a frame that never matched anything.
 */
function promptWithoutTheDeclaration(raw: string) {
  return detectPrompt(stripBoxDrawing(stripAnsi(raw)), { requireDefaultIndicator: false });
}

/**
 * Delete the picker's right-aligned `esc` hatch from the header row and leave
 * every other byte — the header words, all SGR, every other row — untouched.
 *
 * Non-vacuity for the narrowed picker pattern, injected into a real capture.
 */
function withoutEscHatch(raw: string): string {
  const lines = raw.split('\n');
  const idx = lines.findIndex(line => OPENCODE_SELECTION_LIST_PATTERN.test(stripAnsi(line)));
  if (idx < 0) throw new Error('frame carries no picker header row to mutate');
  lines[idx] = lines[idx].replace(/esc(?=(?:\x1b\[[0-9;]*m|[^\S\n])*$)/, '   ');
  return lines.join('\n');
}

describe('Issue #1896: opencode numbered-list fixtures are raw live captures', () => {
  it('keeps the ANSI and the box drawing every assertion below depends on', () => {
    for (const name of FRAME_NAMES) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      expect(raw, `${name} lost its box drawing`).toContain('┃');
      // 80x200 is the geometry `OPENCODE_PANE_HEIGHT` makes production capture.
      // The false positive only reproduces at full height: it is
      // `normalizeTuiFrameForDetection`'s blank-row compaction that pulls a list
      // at row 8 into the same 50-row window as the footer at row 195.
      expect(
        raw.split('\n').length,
        `${name} is not a full-height (80x200) frame`,
      ).toBeGreaterThanOrEqual(200);
    }
  });

  it('holds the answer the Issue reproduces with', () => {
    const clean = stripAnsi(frame('numbered-answer'));
    expect(clean).toContain('1. On-premises (self-hosted) deployment');
    expect(clean).toContain('2. Cloud-managed platform (AWS/GCP/Azure)');
    expect(clean).toContain('3. Containerized deployment with Kubernetes');
    expect(clean).toContain('Which one do you want?');
    // The turn really did finish — this is not a frame that any completion
    // guard would have rejected on its own.
    expect(clean).toContain('▣  Build · GPT-5.6 Luna · 2.8s');
  });
});

describe('Issue #1896: an answer that ends in a numbered list is a finished turn', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('reports the reproduction frame as ready, not as a pending prompt', () => {
    const result = statusOf(frame('numbered-answer'));

    // The regression itself: `waiting` / `prompt_detected` / true before the fix.
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
    expect(result.promptDetection.promptData).toBeUndefined();
  });

  it('leaves a turn that is still generating on running', () => {
    // Worse than what the Issue reports, and why "ignore a list that sits above
    // a finished-turn marker" was not the fix: this frame's footer still reads
    // `esc interrupt` and its `▣ Build · GPT-5.6 Luna` row has no duration, yet
    // the half-streamed list was already published as an answerable prompt.
    const raw = frame('numbered-answer-running');
    expect(stripAnsi(raw)).toContain('esc interrupt');

    const result = statusOf(raw);
    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('does not read numbers typed into the composer as options', () => {
    // The repro text sitting UNSENT in the input box. It never was a prompt and
    // must not become one now that the box is what separates the two regions.
    const result = statusOf(frame('composer-typed-numbered'));
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
  });

  it('never offers any of these frames to Auto-Yes', () => {
    // Auto-Yes bypasses the status detector entirely (D1 decision 4: it calls
    // `detectPrompt` directly), so `hasActivePrompt: false` alone would not stop
    // a wrong auto-answer. The `respond` route re-detects with this exact call
    // too, so a red here means `respond <id> 1` can type into the composer again.
    for (const name of FRAME_NAMES) {
      const detection = autoYesPromptOf(frame(name));
      expect(detection.isPrompt, `${name} was offered to Auto-Yes`).toBe(false);
      expect(detection.promptData).toBeUndefined();
    }
  });
});

describe('Issue #1896: opencode’s real dialogs are still detected', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('surfaces a permission dialog that a stale numbered list used to hide', () => {
    // This frame is the sharp end. The #1893 permission branch sits BELOW
    // priority 1 in `detectSessionStatus`, so the previous turn's numbered list
    // won the frame and the session was published as `prompt_detected` with the
    // wrong options. `resolveAutoAnswer` then produced "1": swallowed by the
    // button strip, followed by an Enter that confirms the highlighted
    // `Allow once`. The false positive could approve a tool call nobody saw.
    const raw = frame('permission-over-numbered');
    const clean = stripAnsi(raw);
    expect(clean).toContain('1. On-premises (self-hosted) deployment');
    expect(clean).toContain('Allow once');

    const result = statusOf(raw);
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PERMISSION_PROMPT);
    expect(result.hasActivePrompt).toBe(false);

    // …and it still drives the surfaces a menu drives: `wait` exits 10 through
    // `isSelectionListActive` and the UI renders NavigationButtons (←/→ + Enter),
    // which are the keys the strip actually takes.
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
    expect(
      deriveWaitingKind({
        waiting: true,
        hasActivePrompt: result.hasActivePrompt,
        scraperStatus: result.status,
        scraperReason: result.reason,
      }),
    ).toBe('menu');
  });

  it('still stops on the real /models picker', () => {
    // The guard in the other direction for the narrowed pattern. Note the
    // overlay is NOT numbered — `●` marks the current entry — which is half the
    // measurement behind `hasNumberedDialogs: false`.
    const raw = frame('model-picker');
    expect(stripAnsi(raw)).toMatch(/^\s*Select model\s{2,}esc\s*$/m);

    const result = statusOf(raw);
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
    expect(result.hasActivePrompt).toBe(false);
    expect(SELECTION_LIST_REASONS.has(result.reason)).toBe(true);
  });

  it('stops calling a response that mentions "Select model" a picker', () => {
    // The Issue's second symptom: the pattern was the bare phrase and
    // `status-detector` tests it against the WHOLE content area, so one line of
    // prose parked the session on `waiting` / `opencode_selection_list`.
    const raw = frame('select-model-in-response');
    expect(stripAnsi(raw)).toContain('Select model to continue:');

    const result = statusOf(raw);
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  it('never reads the ctrl+p command palette as a completion', () => {
    // A gap this Issue deliberately did not close: opencode draws the same
    // picker chrome under a `Commands` header, which the allowlist does not
    // cover — before or after #1896. It landed on the "no positive evidence"
    // side, which #1708's unclassified path already handles (`wait` stops after
    // the dwell), so it was safe to leave to a change that could bring its own
    // live frames. Issue #2112 was that change: the palette is now
    // `waiting` / `opencode_modal_overlay`, read off the rectangle it is painted
    // as rather than off its heading.
    //
    // The assertion is deliberately unchanged. What it has always been about is
    // that this frame must not be read as a finished turn, and that is true
    // under both answers — which is what makes it a regression pin rather than a
    // restatement of whichever rule happens to be answering.
    const result = statusOf(frame('command-palette'));
    expect(result.status).not.toBe('ready');
    expect(result.hasActivePrompt).toBe(false);
  });
});

describe('Issue #1896: the guards are load-bearing (mutation-injected)', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('goes back to answering "1" when only hasNumberedDialogs is taken away', () => {
    // Non-vacuity for the declaration, injected into the real capture: same
    // frame, same pipeline, one field removed from the options object. This is
    // the pre-#1896 behaviour and the harm in one assertion.
    const before = promptWithoutTheDeclaration(frame('numbered-answer'));

    expect(before.isPrompt).toBe(true);
    expect(before.promptData?.type).toBe('multiple_choice');
    const labels = (before.promptData?.options ?? []).map(o =>
      typeof o === 'string' ? o : o.label,
    );
    expect(labels).toEqual([
      'On-premises (self-hosted) deployment',
      'Cloud-managed platform (AWS/GCP/Azure)',
      'Containerized deployment with Kubernetes',
    ]);
    expect(resolveAutoAnswer(before.promptData!)).toBe('1');

    // …and the shipped call refuses the same bytes.
    expect(autoYesPromptOf(frame('numbered-answer')).isPrompt).toBe(false);
  });

  it('would have auto-approved the permission dialog without the declaration', () => {
    const before = promptWithoutTheDeclaration(frame('permission-over-numbered'));

    expect(before.isPrompt).toBe(true);
    expect(resolveAutoAnswer(before.promptData!)).toBe('1');
    expect(autoYesPromptOf(frame('permission-over-numbered')).isPrompt).toBe(false);
  });

  it('stops recognising the picker when only the esc hatch is removed', () => {
    // Non-vacuity for the narrowed pattern: `Select model` and every other byte
    // of the overlay are still there; only the right-aligned hatch is gone.
    const original = frame('model-picker');
    const mutated = withoutEscHatch(original);

    expect(mutated).not.toBe(original);
    expect(stripAnsi(mutated)).toContain('Select model');
    expect(OPENCODE_SELECTION_LIST_PATTERN.test(stripAnsi(original))).toBe(true);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test(stripAnsi(mutated))).toBe(false);

    expect(statusOf(mutated).reason).not.toBe(STATUS_REASON.OPENCODE_SELECTION_LIST);
  });

  it('keeps the picker pattern matching the header rows opencode actually draws', () => {
    // Measured header rows, and the prose that used to match them.
    expect(
      OPENCODE_SELECTION_LIST_PATTERN.test(
        '              Select model                                     esc',
      ),
    ).toBe(true);
    expect(
      OPENCODE_SELECTION_LIST_PATTERN.test(
        '              Select provider                                  esc',
      ),
    ).toBe(true);
    expect(
      OPENCODE_SELECTION_LIST_PATTERN.test(
        '              Connect a provider                               esc',
      ),
    ).toBe(true);

    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Select model to continue:')).toBe(false);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('Select model')).toBe(false);
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('  Select provider  ')).toBe(false);

    // `[^\S\n]` rather than `\s`: the header and the hatch have to be on the
    // SAME row. With plain `\s` under the `m` flag a header on one row pairs up
    // with an `esc` several rows below it (the #1883 lesson).
    expect(OPENCODE_SELECTION_LIST_PATTERN.test('  Select model\n  esc')).toBe(false);
  });
});

describe('Issue #1896: the declaration is scoped to opencode', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('is set for opencode and left unset for every other tool', () => {
    expect(buildDetectPromptOptions('opencode')).toEqual({
      requireDefaultIndicator: false,
      hasNumberedDialogs: false,
    });

    for (const tool of ['claude', 'codex', 'gemini', 'copilot', 'antigravity'] as const) {
      expect(
        buildDetectPromptOptions(tool)?.hasNumberedDialogs,
        `${tool} opted out of numbered prompts`,
      ).toBeUndefined();
    }
  });

  it('leaves the same numbered block detectable on a tool that does use numbers', () => {
    // Same bytes, read as claude — whose permission dialogs really are numbered.
    // This is what keeps the fix from being "numbered prompts are broken now".
    const asClaude = autoYesPromptOf(frame('numbered-answer'), 'claude');

    expect(asClaude.isPrompt).toBe(true);
    expect(asClaude.promptData?.type).toBe('multiple_choice');
    expect(asClaude.promptData?.options).toHaveLength(3);
  });
});
