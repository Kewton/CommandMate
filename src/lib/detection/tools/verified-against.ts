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

/** codex-cli these rules were read off (#1628 / #1829 / #1890 fixtures). */
export const CODEX_VERIFIED_AGAINST = {
  version: '0.148.0',
  capturedAt: '2026-08-15',
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
 * agy these rules were read off (#988 / #995 footer + selection rules, re-read
 * against the #2270 live panes).
 *
 * Bumped from `0.4.x` / `2026-07-30` / `inline` because the frames were
 * RE-CAPTURED, not because the binary moved: #2270 drove agy 1.1.25 on a private
 * tmux socket at the production geometry and kept both panes inline in
 * `tests/unit/status-detector-selection.test.ts`
 * (`AGY_1125_PERMISSION_PANE`, `AGY_1125_SWITCH_MODEL_PANE`) under the banner
 * `Antigravity CLI 1.1.25`, trailing pane padding included. The
 * `Do you want to proceed?` + `N. label` rules were measured off those frames,
 * and `ANTIGRAVITY_SELECTION_LIST_PATTERN` (#995 / #997) was re-checked against
 * them and left unchanged.
 *
 * `paneGeometry` leaves `inline` because the 1.1.25 permission dialog draws no
 * composer row at all — it reproduces only at the 200x1000 pane the server
 * captures, and a fixture without the ~970 blank padding rows exercises a
 * different `lastLines` slice than production does. That is a statement about
 * the capture condition, not about agy: the scrollback-retained rendering the
 * `afterThinking` footer rules rest on (#988) is unchanged, and the 1.1.25
 * dialog still ends on `esc to cancel`.
 *
 * What this stamp does NOT claim: #2270 captured `waiting` frames only, so the
 * idle (`? for shortcuts`) and generating (spinner) branches are carried over
 * from the 0.4 captures rather than re-measured. A live IDLE 1.1.25 frame is
 * still uncaptured — see the `readIdleEvidence` note in `antigravity/detect.ts`.
 */
export const ANTIGRAVITY_VERIFIED_AGAINST = {
  version: '1.1.25',
  capturedAt: '2026-09-04',
  paneGeometry: '200x1000',
} as const;

/**
 * Command Code these rules were read off (#2250 fixtures).
 *
 * The frames are `tests/fixtures/command-code-live-2250/`, captured on a private
 * tmux socket at the production geometry — the default pane size does not
 * reproduce the 200-column rules that fence the composer, and the status row
 * drops its `esc to interrupt` tail below 72 columns.
 */
export const COMMAND_CODE_VERIFIED_AGAINST = {
  version: '1.40.1',
  capturedAt: '2026-09-03',
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
