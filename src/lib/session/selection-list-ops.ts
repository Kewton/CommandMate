/**
 * Which controls a selection list gets — decided once, for every surface
 * (Issue #3305).
 *
 * ## Why this is a module of its own
 *
 * Issue #2297 worked out what a selection list OFFERS (`readSelectionListShape`)
 * and then turned that into buttons inside `ChatSurface`'s `case
 * 'selectionList'`. The terminal surface — the PC split's footer and the
 * phone's docked pad — draws a pad for the very same frame and was not told:
 * it kept ▲▼◀▶ Enter Esc. So on claude's `/model`, where `Enter` rewrites
 * `model` in `~/.claude/settings.json` (Issue #1495) and `s` does not, the
 * terminal surface offered the write and not the alternative, with no sentence
 * saying which was which.
 *
 * The defect was not the missing button, it was that two surfaces each decided
 * what to draw for one frame. This function is that decision; `SelectionListKeys`
 * is the one component that draws it; and both surfaces mount that component.
 * A control added for a selection list is added HERE, and then it is on both.
 *
 * ## The places the two surfaces still differ, all of them written here
 *
 *  1. **The unlabelled Enter beside "Set as default".** The terminal surface
 *     drops the pad's `↵` while the labelled commit is drawn — two buttons for
 *     one key, one of them unable to say that it writes a default, is the
 *     thing this Issue removes. The chat card keeps both, because #2297's own
 *     suite pins `↵` under claude's `/model` and this Issue's contract leaves
 *     the card's display alone.
 *  2. **Command Code's plan-review controls** (comment / submit / approve /
 *     cancel, Issue #3139) are drawn on the chat card only. The terminal
 *     surface has had the `Enter` removal since #2809 and nothing else; giving
 *     it the controls is a separate change.
 *  3. **opencode's model chords** are drawn on the chat card only. The
 *     terminal surface already carries them in `OpencodeQuickKeys`, on the same
 *     footer this pad sits in.
 *
 * ## Tool ids
 *
 * The frame says what the dialog offers; the tool id is consulted only to keep
 * a button from being the 400 `/special-keys` answers for a key the tool never
 * declared (Issue #2046). Both lists live in `types/terminal-keys` and are
 * pinned against the registry there.
 *
 * Pure, and browser-safe for the same reason `selection-shape` is: its callers
 * are client components.
 */

import {
  readCommandCodeQuestionRegion,
  readSelectionListShape,
  shouldOfferOptionNumbers,
} from '@/lib/detection/selection-shape';
import { PLAN_APPROVE_KEY_TOOL_IDS, SESSION_SCOPE_KEY_TOOL_IDS } from '@/types/terminal-keys';

/** The two places a selection list's controls are drawn. */
export type SelectionListSurface = 'chat' | 'terminal';

export interface SelectionListOpsInput {
  /** The raw pane the list is on (`PaneTerminalState.output`), or nothing yet. */
  frame: string | null | undefined;
  /** The tool the keys would be sent to. */
  cliToolId: string;
  surface: SelectionListSurface;
  /**
   * The frame is a pager (`isPagerActive`), which the terminal surface draws
   * with this same pad. A pager's text is a transcript — its `1.` `2.` rows are
   * not options and its footer is not a dialog's — so it gets the pad and
   * nothing else. The chat card never passes this: it draws a pager from a
   * branch of its own.
   */
  pager?: boolean;
}

export interface SelectionListOps {
  /** The arrow pad carries its unlabelled `↵`. */
  padEnter: boolean;
  /** `1`…`N` to draw under the pad; `0` for no number row. */
  numberKeyCount: number;
  /**
   * The two labelled commits — "this session only" (`s`) and "set as default"
   * (`Enter`) — or `null` when this frame, on this tool, offers no such pair.
   */
  commitKeys: { commitsDefaultOnEnter: boolean } | null;
  /** Draw Command Code's plan-review controls. */
  planReview: boolean;
  /** Draw opencode's model chords. */
  opencodeModelKeys: boolean;
}

/**
 * Decide the controls for the selection list on `frame`.
 *
 * Every rule below is the one `ChatSurface` applied before this Issue, moved
 * rather than rewritten; the Issues that measured each are named beside it.
 */
export function resolveSelectionListOps({
  frame,
  cliToolId,
  surface,
  pager = false,
}: SelectionListOpsInput): SelectionListOps {
  const shape = readSelectionListShape(frame);

  // Issue #2793 / #2809. On Command Code's plan review `Enter` either opens a
  // comment box or RUNS the focused action (`❯ Approve`), depending on a focus
  // no pad can show — so the pad leaves it out. Not gated on the tool: taking a
  // key away is the safe direction. The approve-with-comments radio is not
  // `offersPlanApprove` and keeps `Enter`, which is its documented confirm.
  const enterIsUnsafe = shape.offersPlanApprove;

  if (pager) {
    return {
      padEnter: !enterIsUnsafe,
      numberKeyCount: 0,
      commitKeys: null,
      planReview: false,
      opencodeModelKeys: false,
    };
  }

  // Issue #2297. The two labelled commits, for a footer that names a
  // session-scoped key — claude's `/model`, and any future screen that grows
  // the same sentence. Gated on the tool DECLARING `s` as well, so the button
  // can never be the 400 the route would answer for a tool that does not.
  const commitKeys =
    shape.offersSessionScope && (SESSION_SCOPE_KEY_TOOL_IDS as readonly string[]).includes(cliToolId)
      ? { commitsDefaultOnEnter: shape.commitsDefaultOnEnter }
      : null;

  // Issue #2521 withholds the row from ONE frame, Command Code's footer-less
  // question screen. `readSelectionListShape` cannot refuse it: it reads
  // `1.`…`4.` off the tail and no filter box, which is exactly the shape that
  // earns a number row everywhere else. What is missing is not in the tail —
  // that screen ends in a `Type something...` option that is a SEPARATE text
  // input in the TUI, and #2521 withdrew the claim that its numbers are
  // answerable keys. So the suppression is scoped to the frame the detector's
  // own reading identifies, and every other numbered list — claude's trust
  // dialog, codex's picker, copilot's `/permissions` — is
  // `shouldOfferOptionNumbers`' call alone. Asked second, because it scans the
  // whole pane and most frames are refused by the shape first.
  const numberKeyCount =
    shouldOfferOptionNumbers(shape) && readCommandCodeQuestionRegion(frame) === null
      ? shape.optionCount
      : 0;

  return {
    // Difference 1 in the header: only the terminal surface drops the
    // unlabelled Enter for the labelled one.
    padEnter: !enterIsUnsafe && !(surface === 'terminal' && commitKeys !== null),
    numberKeyCount,
    commitKeys,
    // Difference 2. Issue #2762 / #3139: the footer names `ctrl+a` as the ONLY
    // way to approve and the arrow pad cannot send it. Gated on the tool
    // declaring the key, exactly as `commitKeys` is.
    planReview:
      surface === 'chat' &&
      shape.offersPlanApprove &&
      (PLAN_APPROVE_KEY_TOOL_IDS as readonly string[]).includes(cliToolId),
    // Difference 3. `OpencodeModelKeys` itself decides which tool and which
    // frame it renders for; this only says which surface mounts it.
    opencodeModelKeys: surface === 'chat',
  };
}
