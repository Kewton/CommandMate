/**
 * Which build of which CLI every tool module's rules were read off (Issue #1929).
 *
 * #1927 gave each tool module a `verifiedAgainst` stamp and declared it inline —
 * claude's in `claude/patterns.ts`, the other four at the top of their
 * `detect.ts`. That is the right place to *read* it when you are looking at a
 * rule, and the wrong place to *collect* it: §4 D2's staleness probe has to
 * compare "the version the rules were measured against" with "the version that
 * is installed", and it needs the first as data, for every tool, at once.
 *
 * So the values move here and each tool module re-exports its own. The stamp
 * still lives one import away from the rules it describes, and there is exactly
 * one copy of it — `tests/unit/detection/tools/detector-contract.test.ts` pins
 * that the detectors' `verifiedAgainst` and this table are the same objects, so
 * the two cannot drift.
 *
 * ## Why this module imports nothing
 *
 * `commandmate status` is one of the two surfaces §4 D2 exposes the staleness
 * on, and `tsconfig.cli.json` compiles the CLI with `"paths": {}`. A module the
 * CLI bundle reaches may therefore not use the `@/` alias — see the same
 * constraint written out in `src/cli/types/api-responses.ts`. `tools/types.ts`
 * (where {@link DetectorProvenance} lives) imports `@/lib/cli-tools/types`, so
 * these constants are left unannotated and match that interface structurally
 * instead of importing it.
 */

/** claude these rules were read off (#1708 / #1927 fixtures). */
export const CLAUDE_VERIFIED_AGAINST = {
  version: '2.1.240',
  capturedAt: '2026-08-23',
  paneGeometry: '200x1000',
} as const;

/**
 * codex-cli these rules were read off (#1628 / #1829 / #1890 fixtures; re-read
 * on 0.155.1 by #2808 / #2818).
 *
 * ## Held back by Issue #2808, advanced to 0.155.1 by Issue #2818
 *
 * #2808 re-captured codex **0.155.1** on a private tmux socket at 200x1000
 * (`tests/fixtures/codex-dialogs-0155/`, 2026-09-21): the command approval,
 * `/model`, `/experimental`, `/keymap` and the directory-trust screen all read
 * `waiting`, each highlighted row the same one-span shape as the 0.146.0-0.153.2
 * captures, and the idle composers read `ready`. The stamp stayed at 0.148.0
 * because one frame of that probe was misread: the idle composer after a
 * declined approval read `running`. From 0.154.0 on the status bar carries the
 * thread's title after the path, `CODEX_STATUS_BAR_PATTERN` wants the path last,
 * so the detector found no bar and its bar-independent branch D read the
 * declined command's lingering `• Ran` row in the 15-row tail.
 *
 * #2818 made the titled bar a boundary (`CODEX_TRAILED_STATUS_BAR_PATTERN`) and
 * probed 0.155.1 again on its own socket (`tests/fixtures/codex-thread-title-probe/`,
 * 2026-09-21): a turn running `sleep 30` under a titled bar, the same turn after
 * the command finished and codex was still working, and the idle composer once
 * it had answered — the last with the `• Ran sleep 30` row still in the tail,
 * which read `running` before the fix. The two running frames read `running`,
 * both idle frames read `ready`, and no other frame in the tree changed its
 * verdict. **The stamp moved to 0.155.1 because every 0.155.1 frame now reads
 * correctly** (`codex-thread-title-bar-2818.test.ts`,
 * `codex-dialogs-0155-2808.test.ts`).
 */
export const CODEX_VERIFIED_AGAINST = {
  version: '0.155.1',
  capturedAt: '2026-09-21',
  paneGeometry: '200x1000',
} as const;

/**
 * copilot-cli these rules were read off (#1885 / #1895 / #2269 fixtures).
 *
 * Bumped from 1.0.80 because the frames were RE-CAPTURED and the rules CHANGED:
 * 1.0.82 redrew the composer's fence (`─` rules became a `╻▄` / `╹▀` half-block
 * frame), dropped the `❯` from the composer in favour of the frame's own `┃`
 * edge, boxed the transcript's echoed prompt between two more half-block
 * dividers, and put a file-type badge in front of most tool rows' verbs. The
 * frames are `tests/unit/lib/detection/fixtures/copilot-live-2269/`, captured on
 * a private tmux socket at the production geometry; the 1.0.80 frames stay where
 * they are and the rules still answer for both builds.
 */
export const COPILOT_VERIFIED_AGAINST = {
  version: '1.0.82',
  capturedAt: '2026-09-04',
  paneGeometry: '200x1000',
} as const;

/**
 * opencode these rules were read off (#1883 / #1893 / #1896 fixtures; re-measured
 * against 1.18.22 by the canary in #2050).
 *
 * Bumped from 1.18.21 because the frames were RE-CAPTURED, not because the
 * version number moved: `npm run canary -- --tool opencode` drove 1.18.22 into
 * all five states branches A0-E read (idle composer / `esc interrupt` /
 * `Allow once   Allow always   Reject` / `/models` picker / `▣ … · <duration>`)
 * at the production 80x200 geometry and every rule answered as it did on
 * 1.18.21. The frames are `tests/fixtures/canary/opencode-*.ts` and the run is
 * written up in `docs/design/opencode-server-live-verification.md` §18.
 */
export const OPENCODE_VERIFIED_AGAINST = {
  version: '1.18.22',
  capturedAt: '2026-08-26',
  paneGeometry: '80x200',
} as const;

/**
 * agy these rules were read off (#988 / #995 footer + selection rules, #2270's
 * numbered-dialog carve-out, re-measured and re-captured by #2364).
 *
 * Bumped from 1.1.25 because the frames were RE-CAPTURED and the rules CHANGED:
 * #2364 drove agy 1.1.27 on a private tmux socket at the production geometry and
 * kept the frames in `tests/fixtures/antigravity-live-2364/` — the file-creation
 * menu (`Allow creation of this file?`, two options), the Bash approval whose
 * option labels wrap onto three rows each, the one-row Bash approval #2270 had
 * measured on 1.1.25, the `/model` picker, the folder-trust screen, the
 * slash-command popup, and the first live IDLE agy frame. The numbered-dialog
 * discriminator (`isAntigravityNumberedDialog`) was rewritten off those frames
 * from a question-line match to the footer + numbered-row structure, and the
 * dialogs are now read by `tools/antigravity/dialog.ts` rather than by the
 * generic multiple-choice parser. `ANTIGRAVITY_SELECTION_LIST_PATTERN`
 * (#995 / #997) was re-checked against every frame and left unchanged.
 *
 * The #2270 1.1.25 panes stay where they are
 * (`tests/unit/status-detector-selection.test.ts`) and the rules still answer
 * for both builds.
 *
 * What this stamp does NOT claim: the generating (spinner) branch is still
 * carried over from the 0.4 captures rather than re-measured, and the
 * post-answer survey (`[1] Good … [0] Skip`) was seen once on the production
 * server and reconstructed from its cleaned rows — the raw frame is not in the
 * fixture directory (see its README).
 */
export const ANTIGRAVITY_VERIFIED_AGAINST = {
  version: '1.1.27',
  capturedAt: '2026-09-06',
  paneGeometry: '200x1000',
} as const;

/**
 * Command Code these rules were read off (#2250 fixtures).
 *
 * The frames are `tests/fixtures/command-code-live-2250/`, captured on a private
 * tmux socket at the production geometry — the default pane size does not
 * reproduce the 200-column rules that fence the composer, and the status row
 * drops its `esc to interrupt` tail below 72 columns.
 *
 * ## Deliberately NOT advanced by Issues #2521 / #2522
 *
 * Both read the `AskUserQuestion` screen, and both did it from the anonymised
 * capture in `tests/fixtures/command-code-askuserquestion-2521/` — whose rows
 * 410-423 are verbatim from a live pane, but whose version is what the reporting
 * session SAID it was (1.53.0) rather than something re-probed. #2522's own
 * fixture directory is synthetic throughout, and the send mode
 * (`submitMode: 'answer_only'`) was chosen from a STATIC reading of a locally
 * installed 1.53.1 `QuestionPrompt` plus the safe-direction argument in
 * `tools/command-code/dialog.ts` — not from a keystroke sent at a live pane.
 *
 * None of that is the measurement this stamp records. #2304 set the precedent in
 * the other direction: seven frames re-captured live on 1.49.0 changed no rule,
 * and the stamp still says 1.40.1 because that is the build the rules were READ
 * OFF. Advancing it here on a reported version, a synthetic fixture and a
 * package read off disk would make `getDetectorFreshness` claim a measurement
 * nobody took. When a live 1.53.x session is probed — the question screen, the
 * keys it accepts and what one of them advances — bump this to that exact
 * version with its own `capturedAt`.
 *
 * ## Not advanced by Issue #2574 either
 *
 * #2574 did send keys at a live 1.53.1 pane, but at the PERMISSION dialog, not
 * the question screen: a bare digit commits it, which is the `submitMode` its
 * `detectDialog` declares. The rule itself was read off the 1.40.1 and 1.49.0
 * dialog frames above, and no 1.53.1 frame was added to the fixture directory,
 * so the condition in the previous paragraph is still unmet.
 *
 * ## Held back by Issue #2754, advanced to 1.54.1 by Issue #2773
 *
 * #2754 finally did the probe the paragraph above asked for: a live **1.54.1**
 * session on a private tmux socket at 200x1000, twenty-six captures in
 * `tests/fixtures/command-code-askuserquestion-2754/` (`capturedAt` is the day
 * that probe ran, 2026-09-20), and every key in the screen's footer sent ONE AT
 * A TIME with a capture on each side of it. By the letter of that paragraph the
 * stamp could have moved then. It did not, because what the probe measured was
 * that **the rules did not answer for 1.54.1**: nine of the 26 captures came out
 * wrong, and six of those published `ready` / `input_prompt` for a live,
 * unanswered question — #2521's 偽完了 on a real capture. Stamping 1.54.1 over
 * frames the rules demonstrably misread would have made the probe report a
 * measurement that said the opposite of what was measured — the fail-open
 * version of the #2304 precedent rather than an application of it.
 *
 * The defects it found were closed one Issue at a time:
 *
 *  - **#2753** added `COMMAND_CODE_TAB_ANSWERED_MARKERS` (`✔`, U+2714), so a
 *    strip like `✔ Party size | ● Update scope | ◯ Review` passes
 *    `isCommandCodeQuestionTabRow` and eight frames left the generic parser;
 *  - **#2755** closed the rest: (a) a `❯` outside the option list (`❯ Submit`,
 *    `❯ Next`, `❯ notes:`) is named `cursor-outside-options` and hands the human
 *    the screen instead of publishing `ready`; (b) the Review page is named
 *    `review-page` and publishes no payload, so its default can no longer COMMIT
 *    the answers; (c) checkbox lists (`1. [ ] …` / `Submit`) are read as
 *    multi-select with the box off the label and the 1.54.1 footer off the last
 *    option.
 *
 * **The stamp moved to 1.54.1 because all twenty-six frames now read correctly**
 * (`askuserquestion-1541-2754.test.ts` pins each): fifteen publish an answerable
 * payload, six are `cursor-outside-options` and two are `review-page` (both
 * decline on purpose — a human is sent to the screen, Auto-Yes has nothing to
 * send), two are `ready` because the question is gone, and one is `running`
 * because it was caught mid-turn. False completions went from six to zero.
 * The rules were re-read off THESE frames, so 1.54.1 is the build they were read
 * off — not the build that happens to be installed. `getDetectorFreshness`
 * compares this stamp with the CLI installed now and will say `stale` once that
 * is newer, which is the probe doing its job.
 *
 * This stamp answers "which build were these rules read off", and
 * {@link getDetectorFreshness} turns it into "are they current".
 */
export const COMMAND_CODE_VERIFIED_AGAINST = {
  version: '1.54.1',
  capturedAt: '2026-09-20',
  paneGeometry: '200x1000',
} as const;

/**
 * The stamp for a tool whose frames nobody has captured yet.
 *
 * Not a version, on purpose. `parseCliVersion` cannot read `'unmeasured'`, so a
 * tool carrying it is reported by {@link getDetectorFreshness} with a null
 * comparison rather than as fresh — "we never measured this" and "we measured it
 * and it is current" are different answers and must not print the same.
 */
export const UNMEASURED_VERIFIED_AGAINST = {
  version: 'unmeasured',
  capturedAt: 'never',
  paneGeometry: 'unmeasured',
} as const;

/** The shape every entry above satisfies (structurally `DetectorProvenance`). */
export interface VerifiedAgainstStamp {
  readonly version: string;
  readonly capturedAt: string;
  readonly paneGeometry: string;
}

/**
 * Tool id → the build its rules were measured against.
 *
 * Keyed by the catalog / `CLIToolType` id, not by executable name: antigravity's
 * binary is `agy` (DR2-023), and that mapping belongs to the probe table, not
 * here.
 */
export const DETECTOR_VERIFIED_AGAINST: Readonly<Record<string, VerifiedAgainstStamp>> = {
  claude: CLAUDE_VERIFIED_AGAINST,
  codex: CODEX_VERIFIED_AGAINST,
  copilot: COPILOT_VERIFIED_AGAINST,
  opencode: OPENCODE_VERIFIED_AGAINST,
  antigravity: ANTIGRAVITY_VERIFIED_AGAINST,
  'command-code': COMMAND_CODE_VERIFIED_AGAINST,
  gemini: UNMEASURED_VERIFIED_AGAINST,
  'vibe-local': UNMEASURED_VERIFIED_AGAINST,
};
