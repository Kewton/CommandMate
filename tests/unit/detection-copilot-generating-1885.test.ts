/**
 * Issue #1885: copilot 1.0.80 draws its turn state in the bottom row, and
 * nothing was reading it.
 *
 * `COPILOT_THINKING_PATTERN` was written against copilot's pre-1.0.79 UI —
 * braille spinners, `(Esc to cancel`, `... Thinking`, `Generating`,
 * `Processing`. 1.0.80 draws none of them: it puts ` ◉ Working · 1.5 KiB esc
 * interrupt` in the status bar at the bottom of the pane and keeps the `❯`
 * composer visible above it the whole time. So the thinking check matched
 * nothing, the always-visible composer won at step 3 of `detectSessionStatus`,
 * and every frame of a generating session was published as
 * `ready`/`input_prompt` — measured 0/44 running frames detected before the fix.
 *
 * The damage is in `wait`, not in the sidebar: its completion check is
 * `sessionStatus === 'ready' && isUnclassifiedActive !== true`, which a false
 * `ready`/`input_prompt` satisfies on the first poll. A worker that had been
 * generating for two seconds was reported `Completed` with
 * `basis=scraper_ready`. That is why both layers are pinned below — the
 * detector's own verdict, and the same verdict after `mergeStructuredStatus`,
 * which is the value `wait` actually reads.
 *
 * The fix rests `ready` on positive evidence per design rule D1
 * (`docs/design/multi-agent-state-architecture.md` §4 D1 decision 1, item 2):
 * the key-hint bar and the working bar are two renderings of ONE row, so seeing
 * the hints is an affirmative observation that copilot is not working. The
 * composer cannot carry that evidence on copilot — measured, it is drawn during
 * generation too — which is the deviation from the design document's copilot
 * example and the reason `❯` is not consulted here at all.
 *
 * Every frame is a live `tmux capture-pane -p -e` of copilot 1.0.80 at the
 * production 200x1000 geometry; see
 * `lib/detection/fixtures/copilot-live-1885/README.md` for provenance. They are
 * raw on purpose and the first test guards that.
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
  readCopilotStatusBar,
  COPILOT_IDLE_STATUS_PATTERN,
  COPILOT_PROMPT_PATTERN,
  COPILOT_WORKING_STATUS_PATTERN,
} from '@/lib/detection/cli-patterns';
import {
  mergeStructuredStatus,
  type ScraperVerdict,
} from '@/lib/session/current-output-builder';

const FIXTURE_DIR = path.resolve(
  __dirname,
  'lib/detection/fixtures/copilot-live-1885',
);

function frame(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

const FRAME_NAMES = [
  'boot-idle',
  'turn-running-early',
  'turn-running-thinking',
  'turn-complete',
  'status-vocabulary-in-response',
  'permission-dialog',
  'model-picker',
] as const;

/** The status detector as every production caller invokes it for copilot. */
function statusOf(raw: string): StatusDetectionResult {
  return detectSessionStatus(raw, 'copilot');
}

/** The Auto-Yes entry point, spelled exactly as `response-checker` spells it. */
function autoYesPromptOf(raw: string) {
  return detectPrompt(
    stripBoxDrawing(stripAnsi(raw)),
    buildDetectPromptOptions('copilot'),
  );
}

/**
 * The scraper half of the current-output payload, derived from a frame exactly
 * as `buildCurrentOutput` derives it — including the `isUnclassifiedActive`
 * formula, which lives inline there (Issue #1497 / #1708).
 */
function scraperVerdictOf(raw: string): ScraperVerdict {
  const status = statusOf(raw);
  // Issue #1924 restated this as `evidence`, with `isUnclassifiedActive`
  // derived from it (`current-output-builder.ts`). Mirrored here in the same
  // shape so the two do not drift: the two `reason`s that mean "the frame said
  // nothing" are the `'none'` half, everything else is `'positive'`.
  const evidence: ScraperVerdict['evidence'] =
    (status.status === 'running' && status.reason === STATUS_REASON.DEFAULT) ||
    (status.status === 'ready' && status.reason === STATUS_REASON.NO_RECENT_OUTPUT)
      ? 'none'
      : 'positive';
  return {
    status: status.status,
    reason: status.reason,
    thinking: status.status === 'running' && status.reason === STATUS_REASON.THINKING_INDICATOR,
    evidence,
    isUnclassifiedActive: evidence === 'none',
  };
}

/**
 * `commandmate wait`'s completion check (`src/cli/commands/wait.ts`), applied to
 * the merged verdict a machine with no hooks would publish (`structured: null`,
 * so `mergeStructuredStatus` passes the scraper through untouched).
 *
 * This is the assertion that describes the reported harm. `detectSessionStatus`
 * returning `ready` is only a wrong string; `waitWouldReportCompleted` returning
 * true for a generating agent is exit 0 on a worker that has not finished.
 */
function waitWouldReportCompleted(raw: string): boolean {
  const merged = mergeStructuredStatus(scraperVerdictOf(raw), null);
  return merged.status === 'ready' && merged.isUnclassifiedActive !== true;
}

/**
 * Replace the working vocabulary in the BOTTOM ROW only, leaving every other
 * byte of the frame — including the identical phrase where copilot printed it
 * as body text — untouched.
 *
 * This is the mutation the whole design rests on, applied to a real capture: it
 * is how this suite proves the status-bar row is load-bearing rather than
 * decorative, and that no other branch quietly re-derives `running` from the
 * same words further up the pane.
 */
function rewordBottomRow(raw: string, from: string, to: string): string {
  const rows = raw.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].trim() === '') continue;
    rows[i] = rows[i].replace(from, to);
    break;
  }
  return rows.join('\n');
}

/**
 * Take the interrupt affordance off the status bar and nothing else.
 *
 * The word rather than the phrase: copilot colours `esc` and `interrupt`
 * separately, so `esc\x1b[0m\x1b[38;2;145;152;161m interrupt` is what the raw
 * bytes hold and a phrase-level replace would silently no-op. Each mutation test
 * asserts the reworded text is actually present afterwards for the same reason.
 */
function withoutWorkingStatusBar(raw: string): string {
  return rewordBottomRow(raw, 'interrupt', 'dismissal');
}

/** The same surgery for the idle bar: only the bottom row loses its hints. */
function withoutIdleStatusBar(raw: string): string {
  return rewordBottomRow(rewordBottomRow(raw, 'commands', 'verbs'), 'help', 'aid');
}

describe('Issue #1885: copilot fixtures are raw live captures', () => {
  it('keeps the ANSI and the pane geometry every assertion below depends on', () => {
    for (const name of FRAME_NAMES) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      // 200x1000 is the production geometry for copilot (design §4 D2). The
      // layout depends on it: the status bar is the bottom row of the pane and
      // the transcript sits ~970 rows above it, so a frame re-captured at a
      // default pane height would not reproduce the windowing this suite is
      // about.
      expect(
        raw.split('\n').length,
        `${name} is not a full-height (200x1000) frame`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });

  it('still carries copilot OSC 8 hyperlinks, which stripAnsi does not remove', () => {
    // Issue #1912 owns the removal. Recorded here because these fixtures are the
    // evidence that the sequence is on a real copilot screen, and because a
    // pattern written against a hyperlinked row would see the URL twice.
    const raw = frame('boot-idle');
    expect(raw).toContain('\x1b]8;');
    expect(stripAnsi(raw)).toContain('\x1b]8;');
  });
});

describe('Issue #1885: a generating copilot turn reads as running', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it.each([
    ['turn-running-early', 'the first seconds of a turn, before any output: " ● Working esc interrupt"'],
    ['turn-running-thinking', 'mid-turn, with a byte counter and "⌄ Thinking…" in the transcript'],
  ])('reports %s as running (%s)', (name) => {
    const result = statusOf(frame(name));

    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(result.confidence).toBe('high');
    expect(result.hasActivePrompt).toBe(false);
  });

  it.each(['turn-running-early', 'turn-running-thinking'])(
    'stops `wait` reporting %s as Completed',
    (name) => {
      // The regression itself. Before the fix both frames merged to
      // `ready`/`input_prompt` with no unclassified flag, which is exit 0 with
      // `basis=scraper_ready` on the first poll of a busy agent.
      expect(waitWouldReportCompleted(frame(name))).toBe(false);
      expect(mergeStructuredStatus(scraperVerdictOf(frame(name)), null).thinking).toBe(true);
    },
  );

  it('keeps the composer visible while it does so, which is why `❯` cannot be the evidence', () => {
    // The measurement behind the deviation from the design document's copilot
    // example: `❯` is drawn between its two full-width rules throughout the
    // turn, so a composer-drawn rule would call every generating frame finished.
    for (const name of ['turn-running-early', 'turn-running-thinking'] as const) {
      expect(COPILOT_PROMPT_PATTERN.test(stripAnsi(frame(name)))).toBe(true);
    }
  });
});

describe('Issue #1885: a finished copilot turn reads as ready', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it.each(['boot-idle', 'turn-complete'])(
    'reports %s as an input prompt on positive evidence',
    (name) => {
      const result = statusOf(frame(name));

      expect(result.status).toBe('ready');
      expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
      expect(result.confidence).toBe('high');
      expect(result.hasActivePrompt).toBe(false);
      // The wire value is unchanged (DR3-002): `ready`/`input_prompt` is what
      // claude's `❯` row and codex's `›` row already publish.
      expect(waitWouldReportCompleted(frame(name))).toBe(true);
    },
  );

  it('is not fooled by copilot printing the working vocabulary in its answer', () => {
    // A live frame: copilot was asked to print these strings and answered
    // " ● Working esc interrupt" / "Thinking…" as body text, which is
    // character-for-character what its own status bar shows. The turn is over —
    // the bottom row carries the key hints — so this must read as finished.
    // A 15-line window match (the shape the pre-fix branch used) would have
    // pinned this session to `running` for the rest of its life.
    const raw = frame('status-vocabulary-in-response');

    expect(stripAnsi(raw)).toContain('● Working esc interrupt');
    expect(stripAnsi(raw)).toContain('Thinking…');

    const result = statusOf(raw);
    expect(result.status).toBe('ready');
    expect(result.reason).toBe(STATUS_REASON.INPUT_PROMPT);
    expect(waitWouldReportCompleted(raw)).toBe(true);
  });
});

describe('Issue #1885: the frames that carry no status bar are left alone', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('still reports a permission dialog as waiting, with its options readable', () => {
    // The ordering risk of putting the running check ahead of `detectPrompt`.
    // copilot draws this dialog as a box over the bottom of the pane, taking the
    // status bar away entirely, so the running branch declines the frame and it
    // reaches step 1 exactly as before.
    const raw = frame('permission-dialog');

    expect(readCopilotStatusBar(stripAnsi(raw).split('\n'))).toBeNull();

    const result = statusOf(raw);
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(STATUS_REASON.PROMPT_DETECTED);
    expect(result.hasActivePrompt).toBe(true);
    expect(autoYesPromptOf(raw).isPrompt).toBe(true);
  });

  it('leaves the /model picker unclassified rather than calling it finished', () => {
    // Issue #1895's subject, pinned here as the blast radius of this change:
    // the picker ends in its own footer, not the status bar, so no positive
    // evidence exists and the frame falls to the heuristics. `wait` then has its
    // exit-10 handoff instead of reporting a human-blocked picker as Completed.
    const raw = frame('model-picker');

    expect(readCopilotStatusBar(stripAnsi(raw).split('\n'))).toBeNull();

    const result = statusOf(raw);
    expect(result.reason).not.toBe(STATUS_REASON.INPUT_PROMPT);
    expect(waitWouldReportCompleted(raw)).toBe(false);
    expect(scraperVerdictOf(raw).isUnclassifiedActive).toBe(true);
  });

  it('never offers an idle or generating frame to Auto-Yes as an answerable prompt', () => {
    // Auto-Yes bypasses the status detector entirely
    // (`src/lib/polling/response-checker.ts`), so `hasActivePrompt: false` alone
    // would not stop a wrong auto-answer.
    for (const name of FRAME_NAMES) {
      if (name === 'permission-dialog') continue;
      const detection = autoYesPromptOf(frame(name));
      expect(detection.isPrompt, `${name} was offered to Auto-Yes`).toBe(false);
      expect(detection.promptData).toBeUndefined();
    }
  });
});

describe('Issue #1885: the bottom row is what makes both verdicts positive', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it('stops reading running when only the bottom row loses the interrupt hint', () => {
    // Non-vacuity, injected into a real capture: the transcript, the `⌄ Thinking…`
    // row, the SGR and every other byte are identical to `turn-running-thinking`;
    // only the status bar's affordance is reworded. If any other branch were
    // deriving `running` from the words further up the pane, this would stay
    // `running` and the anchor would be decorative.
    const mutated = withoutWorkingStatusBar(frame('turn-running-thinking'));

    expect(mutated).not.toBe(frame('turn-running-thinking'));
    expect(stripAnsi(mutated)).toContain('esc dismissal');
    expect(stripAnsi(mutated)).toContain('⌄ Thinking…');
    expect(stripAnsi(mutated)).toContain('Working');

    // The verdict that goes away is the POSITIVE one. What is left is the
    // D1-correct "no evidence" answer — `running`/`default`, which raises
    // `isUnclassifiedActive` and buys `wait` its exit-10 handoff — not a claim
    // that the agent is busy.
    const result = statusOf(mutated);
    expect(result.reason).not.toBe(STATUS_REASON.THINKING_INDICATOR);
    expect(result.confidence).toBe('low');
    expect(scraperVerdictOf(mutated).isUnclassifiedActive).toBe(true);
  });

  it('stops reading ready when only the bottom row loses its key hints', () => {
    // The other half, and the pin on copilot's opt-out from step 3: with the
    // hints reworded there is no completion evidence left, and the `❯` composer
    // — still drawn, still matching `COPILOT_PROMPT_PATTERN` — must not be
    // allowed to re-admit the frame as `ready`/`input_prompt`. If step 3 still
    // ran for copilot, this assertion would fail and the idle bar would be
    // unobservable.
    const mutated = withoutIdleStatusBar(frame('turn-complete'));

    expect(mutated).not.toBe(frame('turn-complete'));
    expect(stripAnsi(mutated)).toContain('/ verbs');
    expect(stripAnsi(mutated)).toContain('? aid');
    expect(COPILOT_PROMPT_PATTERN.test(stripAnsi(mutated))).toBe(true);

    const result = statusOf(mutated);
    expect(result.reason).not.toBe(STATUS_REASON.INPUT_PROMPT);
    expect(waitWouldReportCompleted(mutated)).toBe(false);
  });

  it('reads only the bottom row, not the rows above it', () => {
    // The positional anchor, stated directly: the same working row placed
    // anywhere but the bottom is transcript, not state.
    const working = ' ◉ Working · 1.5 KiB esc interrupt';
    const idle = ' ← open sidebar · / commands · ? help · tab next tab';

    expect(readCopilotStatusBar([working])).toBe('working');
    expect(readCopilotStatusBar([idle])).toBe('idle');
    expect(readCopilotStatusBar([working, '', '  '])).toBe('working');
    expect(readCopilotStatusBar([working, 'the agent then said something'])).toBeNull();
    expect(readCopilotStatusBar([working, '╰────────────'])).toBeNull();
    expect(readCopilotStatusBar([])).toBeNull();
  });

  it('accepts every spinner glyph and byte-counter form copilot was measured drawing', () => {
    // Measured across 44 live generating frames: the glyph cycles ● ◉ ◎ ○ and
    // the counter appears only once the turn has produced output. Neither is
    // anchored on, so neither can retire this detection the way the 1.0.79
    // rewording retired `COPILOT_THINKING_PATTERN`.
    for (const row of [
      ' ● Working esc interrupt                                        GPT-5.6 Terra',
      ' ◉ Working esc interrupt                                        GPT-5.6 Terra',
      ' ◎ Working esc interrupt                                        GPT-5.6 Terra',
      ' ○ Working · 37 B esc interrupt                                 GPT-5.6 Terra',
      ' ◎ Working · 2.6 KiB esc interrupt                              GPT-5.6 Terra',
    ]) {
      expect(COPILOT_WORKING_STATUS_PATTERN.test(row), row).toBe(true);
      expect(COPILOT_IDLE_STATUS_PATTERN.test(row), row).toBe(false);
      expect(readCopilotStatusBar([row])).toBe('working');
    }
  });

  it('accepts the pre-1.0.79 wording of the idle bar as well as 1.0.80s', () => {
    // "? for shortcuts" is the wording still recorded in COPILOT_SKIP_PATTERNS;
    // 1.0.80 says "? help". Copilot has reworded this row once already, so the
    // slash-command hint is matched independently of the help hint.
    expect(readCopilotStatusBar([' ← open sidebar · / commands · ? help · tab next tab'])).toBe('idle');
    expect(readCopilotStatusBar([' ? for shortcuts                         Claude Sonnet 4.6'])).toBe('idle');
    expect(readCopilotStatusBar([' ← open sidebar · / commands'])).toBe('idle');
    // A picker footer is not the status bar, whichever way it is worded.
    expect(
      readCopilotStatusBar([
        ' ↑/↓ to navigate · ←/→ reasoning effort · enter to select · esc to cancel',
      ]),
    ).toBeNull();
  });
});
