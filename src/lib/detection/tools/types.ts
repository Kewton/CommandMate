/**
 * The per-tool status detection contract (Issue #1927, 方針書 §4 D2).
 *
 * Until this Issue, every tool's rules lived as `if (cliToolId === '…')` blocks
 * inside one 1000-line `detectSessionStatus`. The blocks were already per-tool —
 * what was missing was a place to say, per tool, **what counts as evidence**.
 * §4 D1 turns on exactly that distinction ("完了は肯定的証拠でのみ宣言する"), and
 * a rule that cannot be named per tool cannot be rolled out per tool either
 * (DR2-002 requires exactly that: one tool at a time, each with its own measured
 * rule and its own fixtures).
 *
 * So a {@link ToolStatusDetector} owns four things for one CLI:
 *
 *  1. the branches that must run **before** the shared prompt detection
 *     ({@link ToolDetectorSpec.beforePrompt}) — a picker or a pager whose body
 *     the generic parser would misread as a numbered dialog;
 *  2. the branches that run **after** it ({@link ToolDetectorSpec.afterPrompt} /
 *     {@link ToolDetectorSpec.afterThinking}) — the tool's own running and
 *     completion markers;
 *  3. {@link ToolDetectorSpec.readIdleEvidence} — the D1 rule: does this frame
 *     carry POSITIVE evidence that the turn is not running, or is the `ready`
 *     it is about to publish only "nothing looked busy"?
 *  4. {@link ToolStatusDetector.detectDialog} — the seam Auto-Yes will read
 *     (D1 決定 4). Declared here and answered `null` by every tool: the per-tool
 *     dialog rules and the `response-checker` wiring are **Issue #1928**, and
 *     landing them here would leave that Issue with nothing to do.
 *
 * `verifiedAgainst` is not decoration. Every rule in a tool module was read off
 * a capture of one specific version at one specific pane geometry; recording
 * which one is what lets a later reader tell "this rule is wrong" from "this
 * rule was right for 1.0.80".
 */

import type { CLIToolType } from '@/lib/cli-tools/types';
import type { PromptDetectionResult } from '../prompt-detector';
import type { SessionStatus, StatusConfidence } from '../status-detector';
import type { StatusEvidence } from '@/lib/session/status-evidence';

/**
 * One captured frame, normalised once and shared by every branch.
 *
 * Built by {@link normalizeFrame}. Every field is a projection of `raw`, kept
 * together so the chain cannot end up with two different ideas of where the
 * content ends — the bug class §4 D2 is written against.
 */
export interface NormalizedFrame {
  /** The capture exactly as it arrived, ANSI intact. SGR-dependent rules need it. */
  readonly raw: string;
  /** `raw` with ANSI stripped and blank runs compacted (`normalizeTuiFrameForDetection`). */
  readonly clean: string;
  /** `clean` split on newlines, trailing blank padding INCLUDED. */
  readonly lines: readonly string[];
  /** {@link lines} with the trailing blank padding removed. */
  readonly contentLines: readonly string[];
  /** The last `STATUS_CHECK_LINE_COUNT` content lines, joined. */
  readonly lastLines: string;
  /** The last `THINKING_TAIL_LINE_COUNT` content lines, joined. */
  readonly thinkingLines: string;
}

/** Which build of which CLI a tool module's rules were measured against. */
export interface DetectorProvenance {
  /** The CLI version string, as its own `--version` prints it. */
  readonly version: string;
  /** ISO date the frames were captured. */
  readonly capturedAt: string;
  /** Pane geometry the frames were captured at, e.g. `200x1000`. */
  readonly paneGeometry: string;
}

/**
 * What a tool branch concluded about a frame.
 *
 * `evidence` is the field this whole refactor exists for: it says whether
 * `status` rests on something the detector positively recognised, or on the
 * absence of a negative (§4 D1 決定 2).
 */
export interface ToolStatusVerdict {
  status: SessionStatus;
  confidence: StatusConfidence;
  reason: string;
  hasActivePrompt: boolean;
  evidence: StatusEvidence;
  /**
   * The prompt detection this branch performed itself.
   *
   * Set only by `beforePrompt` branches, which run before the shared pass and
   * therefore have to do their own. Omitted everywhere else, where the shared
   * result is already the right answer.
   */
  promptDetection?: PromptDetectionResult;
}

/**
 * How a positively recognised dialog takes its answer (Issue #1928).
 *
 * The distinction is a measurement about the tool's own rendering, not a
 * preference, and Auto-Yes cannot be gated without it:
 *
 *  - `'numbered'` — the dialog is driven by typing an option number (or `y`),
 *    which is what {@link resolveAutoAnswer} produces and what
 *    `sendPromptAnswer` sends for codex / gemini / copilot, and what it
 *    *navigates to* for claude / antigravity.
 *  - `'keys'` — the dialog is driven by arrow keys and Enter, and a typed
 *    number does something else entirely. opencode 1.18's permission strip is
 *    the measured case: the `1` is swallowed by the button row and the Enter
 *    after it confirms whatever is highlighted, so asking to REJECT would
 *    APPROVE (Issue #1893 / #1896). Auto-Yes must never answer one of these;
 *    the human drives it through NavigationButtons.
 */
export type DialogAnswerMode = 'numbered' | 'keys';

/**
 * A dialog a tool positively recognised — the seam Issue #1927 declared and
 * Issue #1928 fills.
 *
 * Deliberately narrow: `kind` names the dialog family, `options` carries the
 * replies the dialog draws, and {@link answerMode} says whether those replies
 * can be sent as text at all. That triple is what `respond` and the Auto-Yes
 * gate need, and nothing here is derived from the generic numbered-list
 * inference — a `DialogVerdict` exists only where a tool's own measured rule
 * said "this frame is my dialog".
 */
export interface DialogVerdict {
  /** Dialog family, e.g. `permission` / `trust` / `ask_user` / `picker`. */
  kind: string;
  /** The replies the dialog accepts, in the order it draws them. */
  options: readonly string[];
  /** How the dialog takes its answer (§4 D1 決定 4's gate reads this). */
  answerMode: DialogAnswerMode;
}

/**
 * What a tool module declares. {@link createToolStatusDetector} turns it into a
 * {@link ToolStatusDetector} by binding the shared priority chain around it.
 */
export interface ToolDetectorSpec {
  readonly tool: CLIToolType;
  readonly verifiedAgainst: DetectorProvenance;
  /** Priority 0.x — runs before the shared prompt detection. */
  beforePrompt?(frame: NormalizedFrame): ToolStatusVerdict | null;
  /**
   * Whether a prompt the shared pass matched is dead scrollback rather than an
   * active dialog (codex's answered-approval block, Issue #1160). Returning
   * true neutralises the detection and lets the chain continue.
   */
  isStalePrompt?(frame: NormalizedFrame, prompt: PromptDetectionResult): boolean;
  /** Priority 1.5 — runs after prompt detection, before the thinking window. */
  afterPrompt?(frame: NormalizedFrame, prompt: PromptDetectionResult): ToolStatusVerdict | null;
  /** Priority 2.5–2.9 — runs after the shared thinking window. */
  afterThinking?(frame: NormalizedFrame, prompt: PromptDetectionResult): ToolStatusVerdict | null;
  /**
   * Whether this tool opts out of the generic `promptPattern` idle check.
   *
   * True for the tools whose composer is drawn during generation as well as
   * after it, so matching it says nothing (opencode #1883, copilot #1885).
   * Their idle evidence is an `afterThinking` branch instead.
   */
  readonly skipGenericInputPrompt?: boolean;
  /**
   * §4 D1 決定 1 item 2: does this frame positively show that the turn is not
   * running?
   *
   * Consulted **only** where the chain is about to publish `ready` /
   * `input_prompt` off the generic composer check. Omitted by a tool whose rule
   * has not been measured yet — that tool keeps the pre-#1927 reading
   * (`'positive'`), which is the tool-by-tool rollout DR2-002 requires.
   */
  readIdleEvidence?(frame: NormalizedFrame): StatusEvidence;
  /**
   * The reason code for a frame this tool's own chain could not read.
   *
   * `STATUS_REASON.UNKNOWN_FRAME` for a tool whose positive chain is complete;
   * omitted (→ `STATUS_REASON.DEFAULT`) for a tool that has no chain of its own,
   * where "nothing matched" is the generic floor rather than a statement about
   * the tool's rules.
   */
  readonly unreadableReason?: string;
  /**
   * §4 D1 決定 4: does this frame POSITIVELY carry one of this tool's dialogs?
   *
   * Declaring it is what puts the tool inside the Auto-Yes gate
   * (`lib/polling/auto-yes-dialog-gate.ts`): from then on the generic
   * numbered-list inference is not enough to send an answer, and a frame this
   * returns `null` for is recorded as `unclassified-frame` instead of being
   * typed into. A tool that omits it keeps the pre-#1928 behaviour, which is the
   * same tool-by-tool rollout {@link readIdleEvidence} follows.
   *
   * The implementation must read the frame through `stripBoxDrawing(frame.clean)`
   * or plain text only: Auto-Yes hands the detector a capture that has ALREADY
   * had its ANSI and its box drawing removed (`captureAndCleanOutput`), so a
   * rule anchored on a gutter glyph or an SGR attribute would answer `null` on
   * the one path this seam exists for.
   */
  detectDialog?(frame: NormalizedFrame): DialogVerdict | null;
}

/** Extra inputs the chain needs that are not part of the frame. */
export interface ToolDetectionContext {
  /** Last time the poller saw the output change, for the staleness heuristic. */
  lastOutputTimestamp?: Date;
}

/** The per-tool detector §4 D2 specifies. */
export interface ToolStatusDetector extends ToolDetectorSpec {
  readonly tool: CLIToolType;
  readonly verifiedAgainst: DetectorProvenance;
  /** Run the whole priority chain over one frame. */
  detect(frame: NormalizedFrame, context?: ToolDetectionContext): ToolStatusVerdict;
  /** D1 決定 4's seam. See {@link ToolDetectorSpec.detectDialog}. */
  detectDialog(frame: NormalizedFrame): DialogVerdict | null;
  /**
   * Whether this tool DECLARED {@link detectDialog} (Issue #1928).
   *
   * {@link createToolStatusDetector} substitutes a `() => null` for a tool that
   * did not, so the function's presence cannot be used to tell "this tool has
   * measured dialog rules and this frame is not one of them" from "nobody has
   * measured this tool yet". The Auto-Yes gate needs exactly that distinction:
   * the first must suppress, the second must not.
   */
  readonly hasDialogRules: boolean;
}
