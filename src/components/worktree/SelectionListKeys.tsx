'use client';

/**
 * SelectionListKeys — the controls a selection list gets, on every surface
 * (Issue #3305).
 *
 * One component, mounted in four places for the same frame:
 *
 *  - the chat surface's dialog card (`ChatSurface`, `case 'selectionList'`);
 *  - the PC split's footer (`TerminalSplitPaneContent`), terminal surface;
 *  - the phone's docked pad (`WorktreeDetailRefactored`), terminal surface;
 *  - a `/sessions` tile's terminal surface (`SessionTile`, Issue #3336).
 *
 * Before this Issue each of them chose its own controls. The card had learned
 * (Issue #2297) that claude's `/model` needs "this session only" (`s`) beside
 * "set as default" (`Enter`) and that a numbered list deserves `1`…`N`; the two
 * terminal mounts were still the bare arrow pad, so the only commit they
 * offered on `/model` was the one that rewrites `~/.claude/settings.json`.
 *
 * What is drawn is decided by `lib/session/selection-list-ops` and nowhere
 * else. This file adds no rule of its own — it is the arrow pad, then whatever
 * `resolveSelectionListOps()` returned, in the order the card has always drawn
 * them. The three places the surfaces still differ are listed in that module's
 * header.
 *
 * ## `frame` or `reading`
 *
 * A mount that holds the pane's frame passes it (`frame`) and this component
 * reads it. The phone's docked pad holds none — its screen's poll keeps no pane
 * text (Issue #736) — so that poll does the reading itself, off the response
 * its `isSelectionListActive` came from, and the pad passes the result
 * (`reading`). Either way it is `readSelectionListFrame()` over the frame the
 * mount's own selection-list flag was raised for.
 */

import { useMemo } from 'react';
import { NavigationButtons } from '@/components/worktree/NavigationButtons';
import {
  SelectionCommitKeys,
  SelectionNumberKeys,
  type SelectionKeysProps,
} from '@/components/worktree/PromptAnswerKeys';
import { OpencodeModelKeys } from '@/components/worktree/OpencodeQuickKeys';
import { PlanReviewControls } from '@/components/worktree/PlanReviewControls';
import {
  readSelectionListFrame,
  resolveSelectionListOps,
  type SelectionListReading,
  type SelectionListSurface,
} from '@/lib/session/selection-list-ops';

export interface SelectionListKeysProps extends SelectionKeysProps {
  /**
   * The raw pane the list is on — `PaneTerminalState.output`, the frame the
   * surface itself is showing. Read here unless `reading` is given; with
   * neither, the arrow pad is drawn alone.
   */
  frame?: string | null;
  /**
   * `readSelectionListFrame()` of that frame, from a caller that read it
   * already and has no frame to pass. Used instead of reading `frame`.
   */
  reading?: SelectionListReading;
  /** Which surface this mount is on. See `resolveSelectionListOps`. */
  surface: SelectionListSurface;
  /**
   * Issue #1017: the frame is a pager. Appends PgUp/PgDn/Home/End/q to the pad
   * and draws nothing under it — a pager's rows are a transcript, not options.
   */
  showPagerKeys?: boolean;
}

export function SelectionListKeys({
  worktreeId,
  cliToolId,
  instanceId,
  onKeysSent,
  frame,
  reading,
  surface,
  showPagerKeys = false,
}: SelectionListKeysProps) {
  const read = useMemo(() => reading ?? readSelectionListFrame(frame), [reading, frame]);
  const ops = useMemo(
    () => resolveSelectionListOps({ reading: read, cliToolId, surface, pager: showPagerKeys }),
    [read, cliToolId, surface, showPagerKeys],
  );
  const keyProps = { worktreeId, cliToolId, instanceId, onKeysSent };

  return (
    <div className="space-y-2">
      {/* The arrow pad stays FIRST and unconditional — it is the one control
          every measured selection list answers to. */}
      <NavigationButtons {...keyProps} showPagerKeys={showPagerKeys} hideEnterKey={!ops.padEnter} />
      {ops.numberKeyCount > 0 ? (
        <SelectionNumberKeys {...keyProps} optionCount={ops.numberKeyCount} />
      ) : null}
      {ops.commitKeys ? (
        <SelectionCommitKeys
          {...keyProps}
          commitsDefaultOnEnter={ops.commitKeys.commitsDefaultOnEnter}
        />
      ) : null}
      {/* Issue #3139: comment / Submit review / Approve (confirmed) / Cancel
          through `/prompt-response`'s `planReviewAction`. */}
      {ops.planReview ? <PlanReviewControls {...keyProps} /> : null}
      {/* opencode has no numbered `/model` at all — switching models is
          `ctrl+t` or a `ctrl+x` chord. Rendered for opencode, and for OpenCode
          V2 while the frame shows one of its dialogs (#2983); the component
          decides. */}
      {ops.opencodeModelKeys ? <OpencodeModelKeys {...keyProps} frame={frame} /> : null}
    </div>
  );
}
