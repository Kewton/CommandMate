/**
 * Issue #1883: opencode's idle composer is an input box, not a question.
 *
 * `Ask anything...` was reported as `reason: 'prompt_detected'` /
 * `hasActivePrompt: true`, which is the signal `resolvePromptWaiting` reads as
 * "a human has to answer something first". The consequences were operational,
 * not cosmetic: every `commandmate send … --instance opencode` was refused with
 * `blockedBy: 'scraper'` (exit 2, message never delivered) and the sidebar
 * pinned a freshly started session to `waiting` — pointing the operator at
 * `commandmate respond`, for a dialog that did not exist.
 *
 * The fix reports it the way claude's `❯` and codex's `›` idle rows are
 * reported — `input_prompt` / `hasActivePrompt: false` — and rests that verdict
 * on positive evidence per design rule D1
 * (`docs/design/multi-agent-state-architecture.md` §4 D1, §6.1 row (2)):
 * opencode paints the placeholder only into an EMPTY input buffer, so the
 * placeholder row *inside the input box's gutter* is affirmative evidence that
 * the composer is empty. The phrase reaching the pane any other way is not.
 *
 * Every frame here is a live `tmux capture-pane -p -e` of opencode 1.18.20 at
 * the production 80x200 geometry — see
 * `lib/detection/fixtures/opencode-live-1883/README.md` for provenance. They
 * are raw on purpose and the first test in the file guards that.
 *
 * Both published readers of a frame are pinned, because they are two different
 * call paths and #1883 only broke one of them: `detectSessionStatus` (sidebar,
 * `ls`, `wait`, the send guard) and `detectPrompt` on
 * `stripBoxDrawing(stripAnsi(raw))`, which is what Auto-Yes calls directly —
 * `src/lib/polling/response-checker.ts` never goes through the status detector,
 * so a fix landing in only one of them would leave a wrong auto-answer behind.
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
  type StatusDetectionResult,
} from '@/lib/detection/status-detector';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_PROMPT_PATTERN,
} from '@/lib/detection/cli-patterns';
import { resolvePromptWaiting } from '@/lib/session/prompt-waiting-composition';
import { deriveWaitingKind } from '@/lib/session/waiting-kind';

const FIXTURE_DIR = path.resolve(
  __dirname,
  'lib/detection/fixtures/opencode-live-1883',
);

function frame(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

const FRAME_NAMES = [
  'boot-idle',
  'composer-residual',
  'turn-running',
  'turn-complete',
  'phrase-in-response',
] as const;

/** The status detector as every production caller invokes it for opencode. */
function statusOf(raw: string): StatusDetectionResult {
  return detectSessionStatus(raw, 'opencode');
}

/** The Auto-Yes entry point, spelled exactly as `response-checker` spells it. */
function autoYesPromptOf(raw: string) {
  return detectPrompt(
    stripBoxDrawing(stripAnsi(raw)),
    buildDetectPromptOptions('opencode'),
  );
}

/**
 * Remove the input box's gutter from the composer row, leaving every other byte
 * — including the placeholder text and all SGR — untouched.
 *
 * This is the mutation the gutter anchor exists to reject, applied to a real
 * frame: it is how this suite proves the anchor is load-bearing rather than
 * decorative. `┃` is the heavy vertical the box is drawn with.
 */
function withoutComposerGutter(raw: string): string {
  return raw.replace(/┃(?=(?:\x1b\[[0-9;]*m|[^\S\n])*Ask anything\.\.\.)/, ' ');
}

describe('Issue #1883: opencode fixtures are raw live captures', () => {
  it('keeps the ANSI and the box drawing every assertion below depends on', () => {
    for (const name of FRAME_NAMES) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      expect(raw, `${name} lost its box drawing`).toContain('┃');
      // 80x200 is the geometry `OPENCODE_PANE_HEIGHT` makes production capture,
      // and the whole layout depends on it: the input box sits ~100 rows above
      // the footer, so a frame trimmed to a default pane height would not carry
      // the padding these branches window around.
      expect(
        raw.split('\n').length,
        `${name} is not a full-height (80x200) frame`,
      ).toBeGreaterThanOrEqual(200);
    }
  });
});

describe('Issue #1883: the idle composer is ready, not a prompt', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('reports the boot idle composer as an input prompt, not an active one', () => {
    const result = statusOf(frame('boot-idle'));

    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.confidence).toBe('high');
    // The regression itself: `true` here is what refused every send.
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
  });

  it('lets a send through and leaves the sidebar unwaiting', () => {
    const status = statusOf(frame('boot-idle'));
    const resolution = resolvePromptWaiting({
      worktreeId: 'wt-1883-idle',
      cliToolId: 'opencode',
      instanceId: 'opencode',
      scraper: {
        status: status.status,
        reason: status.reason,
        hasActivePrompt: status.hasActivePrompt,
      },
    });

    expect(resolution.blocksSend).toBe(false);
    expect(resolution.blockedBy).toBeNull();
    expect(resolution.waiting).toBe(false);
    expect(resolution.scraperWaiting).toBe(false);
    expect(
      deriveWaitingKind({
        waiting: resolution.waiting,
        hasActivePrompt: status.hasActivePrompt,
        scraperStatus: status.status,
        scraperReason: status.reason,
      }),
    ).toBeNull();
  });

  it('never reports an answerable prompt to Auto-Yes on any idle frame', () => {
    // Auto-Yes bypasses the status detector entirely (`response-checker.ts`),
    // so `hasActivePrompt: false` alone would not stop a wrong auto-answer.
    for (const name of FRAME_NAMES) {
      const detection = autoYesPromptOf(frame(name));
      expect(detection.isPrompt, `${name} was offered to Auto-Yes`).toBe(false);
      expect(detection.promptData).toBeUndefined();
    }
  });
});

describe('Issue #1883: the rest of an opencode turn is unchanged', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('still reads a generating turn from the footer indicator', () => {
    const result = statusOf(frame('turn-running'));

    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('still reads a finished turn from the completion marker', () => {
    // opencode drops the placeholder for good once a turn has run, so after the
    // first response the completion marker is the only positive evidence left.
    const result = statusOf(frame('turn-complete'));

    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('does not claim a composer holding typed text is an idle one', () => {
    // The placeholder is gone the moment a character is typed, which is exactly
    // why its presence is evidence. Without it there is no positive evidence in
    // this frame, so the detector must not answer `input_prompt` — and it must
    // still not block the send.
    const result = statusOf(frame('composer-residual'));

    expect(result.reason).not.toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.reason).not.toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(false);
  });
});

describe('Issue #1883: the gutter anchor is what makes the verdict positive', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('separates the input box row from the same phrase in a response body', () => {
    // A live frame where opencode was asked to print the phrase: it appears
    // un-guttered in the response, and guttered but not row-initial in the
    // transcript echo of the sent message.
    const raw = stripAnsi(frame('phrase-in-response'));

    expect(OPENCODE_PROMPT_PATTERN.test(raw)).toBe(true);
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(raw)).toBe(false);

    const result = statusOf(frame('phrase-in-response'));
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('stops matching when only the gutter is taken off the real idle frame', () => {
    // Non-vacuity, injected into a real capture: the phrase, the SGR and every
    // other row are byte-identical to `boot-idle`; only the box gutter is gone.
    const mutated = withoutComposerGutter(frame('boot-idle'));

    expect(mutated).not.toBe(frame('boot-idle'));
    expect(stripAnsi(mutated)).toContain('Ask anything...');
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(stripAnsi(mutated))).toBe(false);

    // With the anchor gone there is no positive evidence left, so the frame
    // falls through to the heuristics instead of being re-admitted as `ready`.
    // This also pins the opencode opt-out at step 3 of `detectSessionStatus`:
    // the generic input-prompt check would otherwise answer `input_prompt` here
    // on the bare phrase and make the anchor unobservable.
    const result = statusOf(mutated);
    expect(result.reason).not.toBe(STATUS_REASON.INPUT_PROMPT);
    expect(result.hasActivePrompt).toBe(false);
  });

  it('does not let a gutter on one row pair with the phrase on another', () => {
    // `\s` crosses newlines under the `m` flag; the pattern uses `[^\S\n]`.
    const twoRows = '  ┃\n     Ask anything...';
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test(twoRows)).toBe(false);
    expect(OPENCODE_IDLE_COMPOSER_PATTERN.test('  ┃  Ask anything...')).toBe(true);
    // The transcript echo of a sent message is guttered too, so the phrase has
    // to be the first thing after the gutter.
    expect(
      OPENCODE_IDLE_COMPOSER_PATTERN.test('  ┃  Print this: Ask anything...'),
    ).toBe(false);
  });
});
