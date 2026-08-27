/**
 * opencode's status detector (Issue #1927, 方針書 §4 D2).
 *
 * A verbatim lift of the `cliToolId === 'opencode'` block (branches A0–E) out of
 * `detectSessionStatus`. opencode is the only tool with a completion marker of
 * its own (§4 D1 決定 1 item 1) and, since #1883, a gutter-anchored idle
 * composer rule (item 2) — which is why it ships with `enforce`.
 */

import {
  detectThinking,
  stripBoxDrawing,
  OPENCODE_TURN_COMPLETE_PATTERN,
  OPENCODE_PROCESSING_INDICATOR,
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_PERMISSION_PATTERN,
  OPENCODE_SELECTION_LIST_PATTERN,
} from '../../cli-patterns';
import { STATUS_REASON } from '../../status-reason';
import { detectOpenCodeModalOverlay } from '../../opencode-modal-overlay';
import { detectOpenCodeDialog } from './prompt';
import { STATUS_CHECK_LINE_COUNT } from '../frame';
import { createToolStatusDetector } from '../run-detection';
import { OPENCODE_VERIFIED_AGAINST } from '../verified-against';
import { THINKING_TAIL_LINE_COUNT } from '@/config/thinking-constants';
import type { StatusEvidence } from '@/lib/session/status-evidence';
import type { NormalizedFrame, ToolStatusVerdict } from '../types';

/** opencode build these rules were read off (#1883 / #1893 / #1896; value in ../verified-against, #1929). */
export const VERIFIED_AGAINST = OPENCODE_VERIFIED_AGAINST;

/**
 * Where opencode's content area ends in this frame.
 *
 * Extract content area by finding TUI footer boundary dynamically.
 * Footer structure (bottom-up): keybinding hints ("ctrl+t variants..."),
 * ╹▀▀ separator, model info bar ("Build GPT-5-mini GitHub Copilot"), ┃ padding.
 * The keybinding line is the anchor; model bar is 2 lines above it.
 * ┃ padding above the model bar becomes empty after stripBoxDrawing and is
 * skipped by the lastNonEmpty search.
 *
 * `stripBoxDrawing` maps line-for-line — it blanks border-only rows rather than
 * dropping them — so an index taken here is valid in `frame.lines` too, which is
 * what branch E relies on to read the input box's own gutter.
 */
function findContentEnd(frame: NormalizedFrame): { candidates: string[]; lastIndex: number } {
  const strippedForOpenCode = stripBoxDrawing(frame.clean);
  const ocLines = strippedForOpenCode.split('\n');
  let footerBoundary = Math.max(0, ocLines.length - 7); // fallback: skip 7 lines
  for (let i = ocLines.length - 1; i >= Math.max(0, ocLines.length - 10); i--) {
    if (/ctrl\+[tp]/.test(ocLines[i])) {
      // Exclude keybinding line (i), separator (i-1), and model info bar (i-2)
      footerBoundary = Math.max(0, i - 2);
      break;
    }
  }
  const candidates = ocLines.slice(0, footerBoundary);
  let lastIndex = candidates.length - 1;
  while (lastIndex >= 0 && candidates[lastIndex].trim() === '') {
    lastIndex--;
  }
  return { candidates, lastIndex };
}

/**
 * §4 D1 決定 1: opencode's idle evidence.
 *
 * Two positives, both already implemented as branches below and both restated
 * here so the tool table can point at a rule rather than at an ordering
 * accident: the finished-turn marker with a duration (item 1) and the
 * gutter-anchored `Ask anything...` composer (item 2, #1883).
 *
 * Like copilot's, this is belt-and-braces — opencode opts out of the generic
 * composer check, so no `ready` reaches the evidence gate without branch D or E
 * having already vouched for it.
 */
export function readIdleEvidence(frame: NormalizedFrame): StatusEvidence {
  const { candidates, lastIndex } = findContentEnd(frame);
  if (lastIndex < 0) return 'none';
  const window = candidates
    .slice(Math.max(0, lastIndex - STATUS_CHECK_LINE_COUNT + 1), lastIndex + 1)
    .join('\n');
  if (OPENCODE_TURN_COMPLETE_PATTERN.test(window)) return 'positive';
  const composerWindow = frame.lines
    .slice(Math.max(0, lastIndex - STATUS_CHECK_LINE_COUNT + 1), lastIndex + 1)
    .join('\n');
  return OPENCODE_IDLE_COMPOSER_PATTERN.test(composerWindow) ? 'positive' : 'none';
}

export const opencodeStatusDetector = createToolStatusDetector({
  tool: 'opencode',
  verifiedAgainst: VERIFIED_AGAINST,

  afterThinking(frame): ToolStatusVerdict | null {
    // 2.5. OpenCode status detection (Issue #379)
    // OpenCode TUI layout: content area (top) | empty padding (~150 lines) | footer status bar (~6 lines at bottom).
    // Standard windowed checks (last N lines) only see footer/padding, never the content area.
    //
    // Detection strategy:
    // A0. Permission dialog button strip → waiting (Issue #1893; first, see below)
    // A. "esc interrupt" in footer → actively processing (running)
    // B. Find footer boundary via "ctrl+t" keybinding line, extract content above it, check for thinking → running
    // C. Same content window, check for a selection list → waiting
    // C2. A modal overlay painted over the transcript → waiting (Issue #2112)
    // D. Same content window, check for ▣ Build completion WITH a duration → ready
    // E. Idle composer placeholder inside the input box gutter → ready (Issue #1883)

    // A0. Permission dialog (Issue #1893) — ahead of every other opencode branch.
    //
    // opencode asks for tool permission with a bottom-anchored box whose button
    // strip reads "Allow once   Allow always   Reject". It has no number, no
    // (y/n) and no "press enter to confirm" footer, so `detectPrompt` answered
    // `isPrompt: false` and this block fell through to branch D — which matched
    // the `▣ Build · <model>` row opencode draws for the step that is WAITING on
    // this very dialog and published the blocked session as
    // `ready`/`opencode_response_complete`. `wait` then reported a false
    // completion, the sidebar went idle and the send guard opened.
    //
    // It is checked before branch A (`esc interrupt`) and before branch D on
    // purpose: a dialog is the agent blocked on a human whatever else is on the
    // pane, and `permission-after-complete.txt` is a live frame where the box is
    // open with a genuinely finished `· 2.3s` marker still in the transcript
    // above it — branch D would win that frame on ordering alone.
    //
    // `hasActivePrompt` stays FALSE and the reason joins SELECTION_LIST_REASONS,
    // which is the `menu` half of the #1786 taxonomy ("only the terminal can
    // drive it") rather than the `prompt` half ("the app can answer this for
    // you"). That is a measurement, not a preference: on opencode 1.18.21 the
    // strip is driven by ←/→ + Enter and typing a number does nothing at all
    // (the button row is byte-identical before and after `3` is sent). Synthesising
    // `1. Allow once / 2. Allow always / 3. Reject` here would have made
    // `respond <id> 3` send the text "3" — swallowed — followed by Enter, which
    // confirms whatever is highlighted: asking to REJECT would have APPROVED.
    // `wait` still stops for it (`isSelectionListActive` → exit 10) and the UI
    // renders NavigationButtons, which send exactly the keys the strip takes.
    if (OPENCODE_PERMISSION_PATTERN.test(frame.lastLines)) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_PERMISSION_PROMPT,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // A. Check footer for processing indicator ("esc interrupt" replaces "ctrl+t variants..." during processing)
    if (OPENCODE_PROCESSING_INDICATOR.test(frame.lastLines)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_PROCESSING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    const { candidates, lastIndex } = findContentEnd(frame);
    if (lastIndex < 0) return null;

    // B. Check last few content lines for thinking indicators
    const contentThinkingWindow = candidates
      .slice(Math.max(0, lastIndex - THINKING_TAIL_LINE_COUNT + 1), lastIndex + 1)
      .join('\n');
    if (detectThinking('opencode', contentThinkingWindow)) {
      return {
        status: 'running',
        confidence: 'high',
        reason: STATUS_REASON.THINKING_INDICATOR,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // C. Check content area for selection list (Issue #473: fuzzy-search list detection)
    // Selection list header ("Select model"/"Select provider") may be far above the
    // last content line when many items are listed, so check all content candidates.
    const contentCheckWindow = candidates
      .slice(Math.max(0, lastIndex - STATUS_CHECK_LINE_COUNT + 1), lastIndex + 1)
      .join('\n');
    if (OPENCODE_SELECTION_LIST_PATTERN.test(candidates.join('\n'))) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_SELECTION_LIST,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // C2. A modal overlay painted over the transcript (Issue #2112).
    //
    // Branch C above only recognises three ALLOWLISTED headings (`Select model`
    // / `Select provider` / `Connect a provider`, narrowed there by #1896), and
    // opencode has five more dialogs drawn in the same chrome. `Select agent`,
    // `Sessions` and `Timeline` all fell through to branch D, which matched the
    // `▣ Build · <model> · 2.8s` marker of the turn BEFORE the dialog was
    // opened and published a pane blocked on a human as `ready` /
    // `opencode_response_complete` — measured on the #2046 fixtures
    // `dialog-{agent-list,session-list,timeline}.txt`.
    //
    // This has to be a GATE ahead of branch D and not a wider allowlist. A
    // wider allowlist fixes only the missing NavigationButtons; the false
    // completion is the `ready` itself, and `ready` is POSITIVE evidence, so
    // the frame never reaches the unclassified path #1017 / #1494 built for
    // unknown overlays. `claude`'s `/help` is the benign shape of the same
    // thing — it lands on `running` / `default`, where the 60-second hatch
    // opens; these landed on `ready`, where `commandmate wait` exits 0.
    //
    // The rule is the LAYOUT, never the heading: a background-painted rectangle
    // whose rows share both edges and whose header carries opencode's own `esc`
    // hatch right-aligned inside it. See `lib/detection/opencode-modal-overlay`
    // for why a word list is not an option here (it is the inference #1883
    // deleted) and for what a non-match does and does not mean.
    //
    // Ordered AFTER branches A0/A/B on purpose. A permission dialog, an `esc
    // interrupt` footer and a spinner all already answer something that is not
    // `ready`, and putting this first would only rename their verdicts.
    //
    // `frame.raw` rather than `frame.clean`: the rectangle is SGR, and every
    // production caller of `detectSessionStatus` passes the `capture-pane -e`
    // bytes (`lib/tmux/tmux.ts` always passes `-e`).
    if (detectOpenCodeModalOverlay(frame.raw) !== null) {
      return {
        status: 'waiting',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_MODAL_OVERLAY,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // D. Check last few content lines for the finished-turn marker.
    //
    // Issue #1893 made the duration mandatory here (OPENCODE_TURN_COMPLETE_PATTERN
    // rather than the line-filter OPENCODE_RESPONSE_COMPLETE). opencode draws
    // `▣ <Action> · <model>` with no duration for a step that is still open —
    // notably the one blocked on a permission dialog — and matching that row
    // was the reported false `ready`. A duration-less row now carries no
    // verdict at all: an aborted turn (`turn-aborted-no-duration.txt`) falls
    // through to the heuristics rather than claiming a completion that never
    // happened, which is what design rule D1 asks for.
    if (OPENCODE_TURN_COMPLETE_PATTERN.test(contentCheckWindow)) {
      return {
        status: 'ready',
        confidence: 'high',
        reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    // E. Idle composer (Issue #473 found the row; Issue #1883 made it positive).
    //
    // `Ask anything...` is a *placeholder*, not a question: opencode paints it
    // only while the input buffer is empty and replaces it with the first
    // typed character. Finding it inside the input box is therefore positive
    // evidence that the composer is empty — the same class of evidence as
    // claude's completion marker or codex's idle row — and this branch is
    // opencode's implementation of design rule D1 ("declare a turn finished
    // only on positive evidence"), not a fallback for "nothing looked busy".
    //
    // The row is matched on `frame.lines` (ANSI stripped, box drawing intact)
    // via OPENCODE_IDLE_COMPOSER_PATTERN, so it must carry the input box's own
    // gutter. The bare phrase reaching the pane inside a response body is not
    // read as an idle composer.
    //
    // D1's other half — "and the footer shows no processing marker" — is
    // branch A above, which has already returned `running` for any frame whose
    // footer carries `esc interrupt`.
    const composerWindow = frame.lines
      .slice(Math.max(0, lastIndex - STATUS_CHECK_LINE_COUNT + 1), lastIndex + 1)
      .join('\n');
    if (OPENCODE_IDLE_COMPOSER_PATTERN.test(composerWindow)) {
      return {
        status: 'ready',
        confidence: 'high',
        reason: STATUS_REASON.INPUT_PROMPT,
        hasActivePrompt: false,
        evidence: 'positive',
      };
    }

    return null;
  },

  // Issue #1883: opencode opts out of the generic composer check. Its
  // promptPattern is the bare phrase `Ask anything...`, so that check is a
  // second, looser copy of branch E which answers `ready` for the phrase
  // appearing anywhere in the last 15 rows — including in a response body, where
  // it is not a composer at all. Leaving it in would also make E's gutter anchor
  // unobservable.
  skipGenericInputPrompt: true,

  readIdleEvidence,

  // §4 D1 決定 4 (Issue #1928). The content window is branch C's, passed rather
  // than recomputed, so the picker the dialog rule reports is the picker the
  // status branch reports.
  detectDialog(frame) {
    const { candidates } = findContentEnd(frame);
    return detectOpenCodeDialog(frame, { contentWindow: candidates.join('\n') });
  },

  // As with copilot: branches A0–E are the only rules that run for opencode, so
  // a frame reaching the floor is one they could not read.
  unreadableReason: STATUS_REASON.UNKNOWN_FRAME,
});
