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
 * A dialog a tool positively recognised — the seam Issue #1928 fills.
 *
 * Deliberately narrow: `kind` names the dialog family and `options` carries the
 * replies the dialog accepts, which is the pair `respond` and Auto-Yes need. No
 * tool answers anything but `null` in this Issue.
 */
export interface DialogVerdict {
  /** Dialog family, e.g. `permission` / `trust` / `ask_user` / `picker`. */
  kind: string;
  /** The replies the dialog accepts, in the order it draws them. */
  options: readonly string[];
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
  /** D1 決定 4's seam. Issue #1928 implements it; every tool answers null today. */
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
  /** D1 決定 4's seam — always `null` until Issue #1928. */
  detectDialog(frame: NormalizedFrame): DialogVerdict | null;
}
