/**
 * The shared priority chain every {@link ToolStatusDetector} runs
 * (Issue #1927, 方針書 §4 D2).
 *
 * The order below is the order `detectSessionStatus` has always used; what moved
 * is where the per-tool steps live. Each tool module now owns its own branches
 * and hands them back through {@link ToolDetectorSpec}, so the shared middle —
 * prompt detection, the thinking window, the composer check, the two
 * heuristics — is written once instead of being interleaved with seven tools'
 * special cases.
 *
 * ```
 *  0.x  spec.beforePrompt      tool pickers / pagers / status bars
 *  1    detectPrompt           shared, with spec.isStalePrompt as the #1160 guard
 *  1.5  spec.afterPrompt       tool selection-list footers
 *  2    detectThinking         shared, 5-line window
 *  2.x  spec.afterThinking     tool running + completion markers
 *  3    promptPattern          shared composer check, gated by D1 evidence
 *  4    staleness heuristic    `no_recent_output`
 *  5    floor                  `unknown_frame` / `default`
 * ```
 *
 * Steps 4 and 5 are where §4 D1 決定 3 lands: neither may say `ready` any more.
 * A frame that reached them carries no evidence at all, and `ready` is the one
 * word that must not be published on no evidence — it is what makes `wait`
 * report a stalled worker as Completed (#1900) and what closes the send guard
 * on a session that never finished.
 */

import {
  stripBoxDrawing,
  detectThinking,
  getCliToolPatterns,
  buildDetectPromptOptions,
} from '../cli-patterns';
import { detectPrompt } from '../prompt-detector';
import { STATUS_REASON } from '../status-reason';
import { resolveIdleEvidenceMode } from '@/config/detection-evidence-config';
import { recordIdleEvidenceObservation } from '../idle-evidence-observation';
import type { StatusEvidence } from '@/lib/session/status-evidence';
import type {
  NormalizedFrame,
  ToolDetectionContext,
  ToolDetectorSpec,
  ToolStatusDetector,
  ToolStatusVerdict,
} from './types';

/**
 * Time threshold (in ms) for considering output as "stale".
 *
 * Unchanged since #54. What changed in #1927 is the verdict it produces: the
 * same five seconds now mean "nothing has moved and I cannot read this frame",
 * which is `running` with no evidence, not `ready`.
 */
const STALE_OUTPUT_THRESHOLD_MS: number = 5000;

/**
 * Which tools hand the FULL frame to `detectPrompt` instead of the 15-line tail.
 *
 * Their multiple-choice prompts with descriptions can exceed 15 lines: Codex
 * approval prompts with long file lists, Claude "Yes, and don't ask again for:
 * git commit -m …" options that embed full commit messages. `detectPrompt`
 * applies its own 50-line window internally.
 */
const FULL_FRAME_PROMPT_TOOLS: ReadonlySet<string> = new Set([
  'opencode',
  'codex',
  'claude',
  'copilot',
]);

/**
 * Resolve the `evidence` for a `ready` / `input_prompt` verdict from the generic
 * composer check (§4 D1 決定 1 item 2).
 *
 * A tool with no measured rule answers `'positive'`, which is the pre-#1927
 * reading — the tool-by-tool rollout DR2-002 requires. A tool in `observe` mode
 * runs its rule, counts the answer and still publishes `'positive'`, so the
 * rollout can be measured before it is turned on (§11).
 */
function resolveIdleEvidence(spec: ToolDetectorSpec, frame: NormalizedFrame): StatusEvidence {
  if (spec.readIdleEvidence === undefined) return 'positive';

  const mode = resolveIdleEvidenceMode(spec.tool);
  if (mode === 'legacy') return 'positive';

  const evidence = spec.readIdleEvidence(frame);
  recordIdleEvidenceObservation(spec.tool, mode, evidence);
  return mode === 'observe' ? 'positive' : evidence;
}

/** Run the whole chain for one tool over one frame. */
export function runToolDetection(
  spec: ToolDetectorSpec,
  frame: NormalizedFrame,
  context: ToolDetectionContext = {},
): ToolStatusVerdict {
  // 0.x — the tool's own pre-prompt branches. A picker, a pager or a status bar
  // whose body the generic parser would misread as a numbered dialog.
  const early = spec.beforePrompt?.(frame) ?? null;
  if (early) return early;

  // 1. Interactive prompt detection (highest shared priority).
  // Apply stripBoxDrawing() for Gemini CLI and OpenCode TUI compatibility:
  // Gemini wraps prompts in box-drawing characters (╭╮╰╯│─) which prevent
  // detectPrompt() from recognizing the prompt content.
  const promptOptions = buildDetectPromptOptions(spec.tool);
  const promptInput = FULL_FRAME_PROMPT_TOOLS.has(spec.tool)
    ? stripBoxDrawing(frame.clean)
    : stripBoxDrawing(frame.lastLines);
  let promptDetection = detectPrompt(promptInput, promptOptions);
  if (promptDetection.isPrompt) {
    if (spec.isStalePrompt?.(frame, promptDetection)) {
      // Issue #1160: an ALREADY-ANSWERED block still inside the scan window.
      // Neutralise it so Auto-Yes and the sidebar never act on a dead prompt,
      // and let the chain continue to the tool's running/idle branches.
      promptDetection = { ...promptDetection, isPrompt: false, promptData: undefined };
    } else {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.PROMPT_DETECTED,
        hasActivePrompt: true,
        evidence: 'positive',
        promptDetection,
      };
    }
  }

  // 1.5 — tool branches that must sit between prompt detection and the thinking
  // window (Claude's selection-list footer).
  const afterPrompt = spec.afterPrompt?.(frame, promptDetection) ?? null;
  if (afterPrompt) return { ...afterPrompt, promptDetection: afterPrompt.promptDetection ?? promptDetection };

  // 2. Thinking indicator detection — THINKING_TAIL_LINE_COUNT window (narrower).
  // CLI tool is actively processing (shows spinner, "Planning...", etc.)
  if (detectThinking(spec.tool, frame.thinkingLines)) {
    return {
      status: 'running',
      confidence: 'high',
      reason: STATUS_REASON.THINKING_INDICATOR,
      hasActivePrompt: false,
      evidence: 'positive',
      promptDetection,
    };
  }

  // 2.x — the tool's own running and completion markers.
  const afterThinking = spec.afterThinking?.(frame, promptDetection) ?? null;
  if (afterThinking) return { ...afterThinking, promptDetection: afterThinking.promptDetection ?? promptDetection };

  // 3. Input prompt detection — the generic composer check.
  //
  // The wire value stays `ready` / `input_prompt` whatever the evidence says
  // (DR3-002). What moves is `statusEvidence`, not `sessionStatus`: flipping
  // this branch to `running` would move `isProcessing` and with it `ls`, the
  // sidebar aggregate, the "queued (session busy)" toast and demo-video's
  // `wait_until_busy` probe, none of which are asking about evidence.
  if (!spec.skipGenericInputPrompt) {
    const { promptPattern } = getCliToolPatterns(spec.tool);
    if (promptPattern.test(frame.lastLines)) {
      return {
        status: 'ready',
        confidence: 'high',
        reason: STATUS_REASON.INPUT_PROMPT,
        hasActivePrompt: false,
        evidence: resolveIdleEvidence(spec, frame),
        promptDetection,
      };
    }
  }

  // 4. Time-based heuristic (§4 D1 決定 3: the `ready` here is abolished).
  //
  // Five seconds without a repaint is not a completion — it is the absence of
  // one, and publishing `ready` for it is what turned a stalled worker into a
  // Completed one. The reason code stays for diagnosis; the status is `running`
  // and the evidence is nothing.
  if (context.lastOutputTimestamp) {
    const elapsed = Date.now() - context.lastOutputTimestamp.getTime();
    if (elapsed > STALE_OUTPUT_THRESHOLD_MS) {
      return {
        status: 'running',
        confidence: 'low',
        reason: STATUS_REASON.NO_RECENT_OUTPUT,
        hasActivePrompt: false,
        evidence: 'none',
        promptDetection,
      };
    }
  }

  // 5. Floor. `running` with no evidence, as before — the safe default when the
  // state cannot be determined.
  //
  // A tool whose positive chain is complete says so with `unknown_frame`: its
  // rules looked at this frame and found nothing, which is a statement about the
  // rules and an instruction to capture the frame as a fixture. `default` stays
  // the answer for a tool that has no chain of its own, where nothing looked.
  return {
    status: 'running',
    confidence: 'low',
    reason: spec.unreadableReason ?? STATUS_REASON.DEFAULT,
    hasActivePrompt: false,
    evidence: 'none',
    promptDetection,
  };
}

/** Bind the shared chain around one tool's declarations. */
export function createToolStatusDetector(spec: ToolDetectorSpec): ToolStatusDetector {
  return {
    ...spec,
    detect: (frame, context) => runToolDetection(spec, frame, context),
    // D1 決定 4's seam. Issue #1928 replaces the constant with the per-tool
    // dialog rules and wires `response-checker` to them; landing anything here
    // now would leave that Issue with nothing to implement.
    detectDialog: spec.detectDialog ?? (() => null),
  };
}
