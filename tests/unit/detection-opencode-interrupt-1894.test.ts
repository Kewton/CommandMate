/**
 * Issue #1894: `esc again to interrupt` is opencode still generating.
 *
 * opencode 1.18 needs Escape TWICE to abort a turn. The first press aborts
 * nothing — it re-labels the footer:
 *
 * ```
 *    ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt           6.5K (1%) · $0.00  ctrl+p commands
 *    ⬝■■■■■■⬝  esc again to interrupt  7.2K (1%) · $0.00  ctrl+p commands
 * ```
 *
 * and only a second press inside that label's five-second lifetime ends the
 * turn. `OPENCODE_PROCESSING_INDICATOR` was `/esc interrupt/`, so for those five
 * seconds the one positive busy signal opencode gives the scraper simply was not
 * there — while the model kept generating.
 *
 * ## What the missing five seconds actually published
 *
 * Measured on `esc-again-window.txt`, a live capture of the window (see the
 * fixture README for provenance and for the three turns that established the
 * timings):
 *
 * | | before #1894 | after |
 * |---|---|---|
 * | fresh frame | `running` / `default` (low) | `running` / `opencode_processing_indicator` (high) |
 * | `lastOutputTimestamp` older than `STALE_OUTPUT_THRESHOLD_MS` | **`ready` / `no_recent_output`** | `running` / `opencode_processing_indicator` |
 *
 * Both of the "before" rows are `statusEvidence: 'none'` — a generating
 * session published with no evidence,
 * and on the staleness path published as FINISHED. That is exactly the failure
 * design rule D1 names for this Issue
 * (`docs/design/multi-agent-state-architecture.md` §4 D1, row #1894): the tool
 * changed its vocabulary and `ready` came back through a fallback.
 *
 * The Issue itself predicts a different route to the same harm —
 * `ready` / `opencode_response_complete` via a mid-turn `▣` marker. That route
 * was NOT reproducible on 1.18.21; see the fixture README. The fix is the same
 * either way, because it restores the positive signal rather than blocking one
 * fallback.
 *
 * ## Non-vacuity
 *
 * Every "it is running" assertion below is paired with {@link withoutBusyLabel},
 * which blanks the 22 characters `esc again to interrupt` out of the real
 * capture and leaves every other byte — all SGR, every other row, the whole
 * transcript — untouched. The pre-#1894 verdicts come back on the mutated
 * frames, which is what shows the green above is carried by that row and not by
 * something else on the pane.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  detectSessionStatus,
  STATUS_REASON,
  type StatusDetectionResult,
} from '@/lib/detection/status-detector';
import {
  stripAnsi,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_SKIP_PATTERNS,
  OPENCODE_TURN_COMPLETE_PATTERN,
} from '@/lib/detection/cli-patterns';
import { isOpenCodeComplete } from '@/lib/response-extractor';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';
import { resetDetectPromptCache } from '@/lib/detection/prompt-detector';

const FIXTURE_DIR = path.resolve(__dirname, 'lib/detection/fixtures/opencode-live-1894');

function frame(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');
}

/** The label opencode swaps in for `esc interrupt` after the first Escape. */
const BUSY_LABEL = 'esc again to interrupt';

/** The two live captures taken inside the five-second window. */
const WINDOW_FRAMES = ['esc-again-window', 'esc-again-after-marker'] as const;

const ALL_FRAMES = [...WINDOW_FRAMES, 'double-esc-interrupted'] as const;

/** The status detector as every production caller invokes it for opencode. */
function statusOf(raw: string, lastOutputTimestamp?: Date): StatusDetectionResult {
  return detectSessionStatus(raw, 'opencode', lastOutputTimestamp);
}

/**
 * A `lastOutputTimestamp` older than `STALE_OUTPUT_THRESHOLD_MS` (5 s).
 *
 * Both production callers of `detectSessionStatus` pass one
 * (`current-output-builder`, `worktree-status-helper`), so the staleness branch
 * is not hypothetical: it is what a poller reaches whenever opencode spends more
 * than five seconds between visible changes — which is most of a long
 * generation, the spinner being the only thing moving.
 */
function staleTimestamp(): Date {
  return new Date(Date.now() - 60_000);
}

/**
 * Blank the busy label out of a real capture, byte for byte otherwise.
 *
 * The mutation the whole suite rests on. Replacing the label with the same
 * number of spaces keeps the row, its SGR runs, the column layout and the rest
 * of the frame exactly as opencode drew them, so what changes between a green
 * and the red below is only whether the busy row is readable.
 */
function withoutBusyLabel(raw: string): string {
  if (!raw.includes(BUSY_LABEL)) {
    throw new Error(`frame carries no ${BUSY_LABEL} row to mutate`);
  }
  return raw.replace(BUSY_LABEL, ' '.repeat(BUSY_LABEL.length));
}

describe('Issue #1894: the interrupt-window fixtures are raw live captures', () => {
  it('keeps the ANSI and the box drawing every assertion below depends on', () => {
    for (const name of ALL_FRAMES) {
      const raw = frame(name);
      expect(raw, `${name} lost its escape sequences`).toContain('\x1b[');
      expect(raw, `${name} lost its box drawing`).toContain('┃');
      // 80x200 is the geometry `OPENCODE_PANE_HEIGHT` makes production capture.
      // opencode anchors its chrome to the BOTTOM of the pane, so a frame taken
      // at a default height puts the footer and the transcript in the same tail
      // window and stops reproducing any of the opencode branches.
      expect(
        raw.split('\n').length,
        `${name} is not a full-height (80x200) frame`,
      ).toBeGreaterThanOrEqual(200);
    }
  });

  it('holds the footer the Issue reproduces with', () => {
    for (const name of WINDOW_FRAMES) {
      const clean = stripAnsi(frame(name));
      expect(clean, `${name} lost the busy label`).toContain(BUSY_LABEL);
      // The label really did replace `esc interrupt` rather than being appended
      // next to it: what makes this a detection bug is that the OLD vocabulary
      // is gone from the frame.
      expect(clean.replace(BUSY_LABEL, '')).not.toContain('esc interrupt');
    }
  });

  it('holds the pane a real two-press interrupt leaves behind', () => {
    const clean = stripAnsi(frame('double-esc-interrupted'));
    expect(clean).toContain('▣  Build · GPT-5.6 Luna · interrupted');
    // Generation stopped mid-sentence — the whole point of the tool-side fix.
    expect(clean).toContain('one of the earliest clear descriptions of a');
    // And opencode is idle again: no busy label in either spelling.
    expect(clean).not.toContain('esc interrupt');
    expect(clean).not.toContain(BUSY_LABEL);
  });
});

describe('Issue #1894: the pattern covers both spellings of the busy footer', () => {
  it('matches the label opencode draws after the first Escape', () => {
    expect(OPENCODE_PROCESSING_INDICATOR.test(BUSY_LABEL)).toBe(true);
  });

  it('still matches the pre-Escape spelling', () => {
    // The widening is additive: nothing that was running before stops being
    // running now. `response-poller-opencode.test.ts` pins this too.
    expect(OPENCODE_PROCESSING_INDICATOR.test('esc interrupt')).toBe(true);
  });

  it('matches the real footer rows verbatim, not a hand-typed approximation', () => {
    for (const name of WINDOW_FRAMES) {
      const footer = stripAnsi(frame(name))
        .split('\n')
        .find(line => line.includes(BUSY_LABEL));
      expect(footer, `${name} has no footer row`).toBeDefined();
      expect(OPENCODE_PROCESSING_INDICATOR.test(footer as string)).toBe(true);
    }
  });

  it('does not match an `esc` and an `interrupt` that are merely on the same row', () => {
    // `(?:again to )?` rather than `.*`: the optional group spells the one
    // measured variant and nothing else, so an answer that happens to use both
    // words is not read as a busy footer.
    expect(OPENCODE_PROCESSING_INDICATOR.test('press esc twice to interrupt')).toBe(false);
    expect(OPENCODE_PROCESSING_INDICATOR.test('esc again interrupt')).toBe(false);
  });
});

describe('Issue #1894: the interrupt window is running, on positive evidence', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  it.each(WINDOW_FRAMES)('reports %s as running with the processing indicator', name => {
    const result = statusOf(frame(name));

    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
    expect(result.confidence).toBe('high');
    expect(result.hasActivePrompt).toBe(false);
    // Issue #2011: read off the detector, which has been the producer since
    // #1927. The downstream re-derivation this line used to call is gone.
    expect(result.evidence).toBe('positive');
  });

  it.each(WINDOW_FRAMES)('does not let a stale poll turn %s into a completion', name => {
    // The false `ready` this Issue is really about. `no_recent_output` degrades
    // an unreadable frame to `ready` after five seconds, and five seconds is
    // exactly how long the window lasts.
    const result = statusOf(frame(name), staleTimestamp());

    expect(result.status).toBe('running');
    expect(result.reason).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
  });

  it.each(WINDOW_FRAMES)('brings the pre-#1894 verdicts back when %s loses its busy row', name => {
    // Non-vacuity, injected into the real capture: with the label blanked out
    // the frame is the one the narrow pattern saw, and both halves of the
    // regression reappear.
    const mutated = withoutBusyLabel(frame(name));

    const fresh = statusOf(mutated);
    expect(fresh.reason).not.toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);

    const stale = statusOf(mutated, staleTimestamp());
    expect(stale.reason).not.toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
  });

  it('publishes the reproduction frame with no evidence once the busy row is gone', () => {
    // The exact pair of verdicts the fixture README records for
    // `esc-again-window.txt`, spelled out rather than left as "not running":
    // this is the regression, reproduced from the fixed code.
    const mutated = withoutBusyLabel(frame('esc-again-window'));

    const fresh = statusOf(mutated);
    expect(fresh.status).toBe('running');
    // Issue #1927: opencode's floor is `unknown_frame`, not `default`. opencode
    // opts out of the generic composer check, so its own branches (A0-E) are the
    // only rules that run — a frame that reaches the floor is one THEY could not
    // read, which is a different (and actionable) statement from "no pattern
    // matched anywhere". Both are `running` with `evidence: 'none'`.
    expect(fresh.reason).toBe(STATUS_REASON.UNKNOWN_FRAME);
    expect(fresh.evidence).toBe('none');

    // Issue #1927 (§4 D1 決定 3): the 5-second staleness heuristic no longer
    // says `ready`. "Nothing repainted for five seconds" is the absence of a
    // completion, and publishing `ready` for it is what let a stalled worker be
    // reported as Completed. The reason code stays for diagnosis.
    const stale = statusOf(mutated, staleTimestamp());
    expect(stale.status).toBe('running');
    expect(stale.reason).toBe(STATUS_REASON.NO_RECENT_OUTPUT);
    expect(stale.evidence).toBe('none');
  });
});

describe('Issue #1894: a turn cannot complete inside the interrupt window', () => {
  it.each(WINDOW_FRAMES)('keeps isOpenCodeComplete false for %s', name => {
    // `response-checker` reads this, not `detectSessionStatus`. The busy guard
    // in `isOpenCodeComplete` is the same shared constant, so the window closes
    // the completion path too — including on `esc-again-after-marker.txt`,
    // whose tail carries the PREVIOUS turn's genuine `· 16.3s` marker.
    expect(isOpenCodeComplete(stripAnsi(frame(name)))).toBe(false);
  });

  it('is the busy row that holds the completion path shut', () => {
    // Non-vacuity for the assertion above: `esc-again-after-marker.txt` has a
    // duration-carrying marker on it, so with the busy row blanked the only
    // thing left to stop a completion is #1911's turn-region bound.
    const marker = stripAnsi(frame('esc-again-after-marker'));
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(marker)).toBe(true);
    expect(OPENCODE_PROCESSING_INDICATOR.test(marker)).toBe(true);
    expect(OPENCODE_PROCESSING_INDICATOR.test(withoutBusyLabel(marker))).toBe(false);
  });

  it('does not read an interrupted turn as a finished one', () => {
    // `· interrupted` is not a duration, so it is not a completion marker. This
    // is the treatment Issue #1893 deliberately gave an aborted turn, and the
    // tool-side fix makes the state reachable in practice for the first time —
    // so it is pinned here rather than left to be discovered.
    const clean = stripAnsi(frame('double-esc-interrupted'));

    const interruptedRow = clean
      .split('\n')
      .find(line => line.includes('· interrupted')) as string;
    expect(interruptedRow).toBeDefined();
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(interruptedRow)).toBe(false);

    // And the frame as a whole does not complete the turn, even though earlier
    // turns left genuine duration-carrying markers further up the transcript —
    // that is #1911's turn-region bound doing its job on top of this.
    expect(isOpenCodeComplete(clean)).toBe(false);
  });
});

describe('Issue #1894: the widened row is dropped from a saved answer', () => {
  it('is covered by the shared OPENCODE_SKIP_PATTERNS', () => {
    // `OPENCODE_SKIP_PATTERNS` holds the same constant, so widening the busy
    // pattern widens response cleaning with it. Asserted through the array
    // rather than the constant, because the array is what the three cleaners
    // (`response-cleaner`, `tui-accumulator`, `polling/response-checker`) read.
    expect(OPENCODE_SKIP_PATTERNS.some(p => p.test(BUSY_LABEL))).toBe(true);
  });

  it('never reaches a cleaned opencode response', () => {
    const footer = stripAnsi(frame('esc-again-window'))
      .split('\n')
      .find(line => line.includes(BUSY_LABEL)) as string;

    const cleaned = cleanOpenCodeResponse(
      ['The answer body.', footer, 'More answer body.'].join('\n'),
    );

    expect(cleaned).not.toContain(BUSY_LABEL);
    expect(cleaned).toContain('The answer body.');
    expect(cleaned).toContain('More answer body.');
  });
});

describe('Issue #1894: the frames #1893 / #1896 / #1911 fixed still read the same', () => {
  beforeEach(() => {
    resetDetectPromptCache();
  });

  const NEIGHBOURS: ReadonlyArray<
    readonly [dir: string, file: string, status: string, reason: string]
  > = [
    // #1893: a permission dialog outranks everything, busy row or not.
    ['opencode-live-1893', 'permission-bash', 'waiting', STATUS_REASON.OPENCODE_PERMISSION_PROMPT],
    [
      'opencode-live-1893',
      'permission-after-complete',
      'waiting',
      STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
    ],
    // #1893: a genuinely finished turn is still finished.
    [
      'opencode-live-1893',
      'turn-complete-short',
      'ready',
      STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
    ],
    // #1896: an answer that ends in a numbered list is still a finished turn,
    // and a half-streamed one is still running on the NARROW spelling.
    ['opencode-live-1896', 'numbered-answer', 'ready', STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
    [
      'opencode-live-1896',
      'numbered-answer-running',
      'running',
      STATUS_REASON.OPENCODE_PROCESSING_INDICATOR,
    ],
    // #1883: the idle composer is still idle.
    ['opencode-live-1883', 'boot-idle', 'ready', STATUS_REASON.INPUT_PROMPT],
    ['opencode-live-1883', 'turn-running', 'running', STATUS_REASON.OPENCODE_PROCESSING_INDICATOR],
  ];

  it.each(NEIGHBOURS)('%s/%s stays %s / %s', (dir, file, status, reason) => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, 'lib/detection/fixtures', dir, `${file}.txt`),
      'utf-8',
    );
    const result = statusOf(raw);
    expect(result.status).toBe(status);
    expect(result.reason).toBe(reason);
  });
});
