/**
 * The history rows `buildCurrentOutput` writes on its own account: the
 * "detection failed on this frame" row and the "a dialog is open and we could
 * not read it" row, and the push that delivers either to the worktree room
 * (Issue #3215).
 *
 * Moved verbatim out of `current-output-builder`. The comments came along
 * unedited: where one says "this module", it was written about
 * `current-output-builder`.
 *
 * `recordUnclassifiedFrame` and `recordStructuredPrompt` are exported for
 * `buildPayload` and for nothing else; `current-output-builder` does not
 * re-export them.
 */

import type Database from 'better-sqlite3';
import { createMessage } from '@/lib/db';
import {
  OPENCODE_SIDEBAR_RECOVERY_CHORD,
  type OpenCodePaneObstruction,
} from '@/lib/detection/opencode-pane-obstruction';
import { UNCLASSIFIED_PROMPT_TYPE, type ChatMessage, type UnclassifiedFrameRecord } from '@/types/models';
import { createLogger } from '@/lib/logger';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { StructuredPromptWaitingState } from '@/lib/session/agent-event-state';
import {
  buildStructuredPromptHistoryRecord,
  type StructuredPromptFacts,
} from '@/lib/session/structured-prompt';
import type { PromptData } from '@/types/models';

// Issue #3215: the name is the one these lines have always been logged under.
// It is what an operator greps for, so it did not move with the code.
const logger = createLogger('current-output-builder');

/**
 * Write the "detection failed on this frame" row (Issue #1708).
 *
 * Stored as a `prompt` message so `capture --prompts` — the audit trail that
 * exists precisely to answer "why did this stall?" — lists it alongside the
 * prompts that WERE detected. It must never read as one of them, so the
 * promptData carries `type: 'unclassified'` and `status: 'unclassified'`; the
 * latter is also what keeps it out of `markPendingPromptsAsAnswered()`, whose
 * SQL selects `status = 'pending'`. A frame nobody could read must not end up
 * stamped "(answered via terminal)" the moment the flag clears.
 *
 * Not broadcast: this is a record for after the fact, and the prompt-answering
 * UI has nothing to render for a frame with no parsed options.
 *
 * REACH, stated plainly because it is a real limit: this is driven by
 * observation, not by the server's own loops. `buildCurrentOutput` has exactly
 * two callers — the current-output route and `broadcastTerminalSnapshot`, which
 * returns immediately when the room has no subscribers. So a row is written
 * while `commandmate wait` is polling (every POLL_INTERVAL_MS), while a browser
 * has the terminal open, or on a `capture --json`. A stall that nobody is
 * watching at all writes nothing, and `capture --prompts` afterwards will not
 * show it. That is tolerable because the stalls this exists to explain are the
 * ones something WAS waiting on — but it means the Auto-Yes poller running
 * alone is not enough. Feeding the tracker from that loop would need a second
 * producer of `isUnclassifiedActive`, i.e. either duplicating its definition or
 * adding a detectSessionStatus pass to a hot path; deliberately not done here.
 *
 * Best effort — a failed insert must never break the payload the caller is
 * waiting on. The tracker has already marked the run as recorded, so a failure
 * costs this one row, not a retry storm.
 */
/**
 * The sentence that turns "nothing could read this frame" into "here is what is
 * on it, and here is the key that removes it" (Issue #2095).
 *
 * Empty string when there is no obstruction, so every caller can concatenate it
 * unconditionally and the #1708 wording is byte-identical on a frame that has
 * none.
 *
 * English, like the rest of {@link recordUnclassifiedFrame}'s row and unlike the
 * UI banner this pairs with. The row is read in `capture --prompts` as often as
 * in the history pane, and `commandmate` has no locale to read it in.
 */
function describePaneObstruction(obstruction?: OpenCodePaneObstruction | null): string {
  if (!obstruction) return '';
  return (
    ` Cause: opencode's sidebar is sharing rows with the transcript ` +
    `(paneObstruction=${obstruction.id}, second column reads ` +
    `${JSON.stringify(obstruction.matchedText)}), which covers the marker that ends a ` +
    `turn. Press \`${OPENCODE_SIDEBAR_RECOVERY_CHORD}\` in the pane to close it.`
  );
}

/**
 * Push a history row this module just wrote to the worktree room (Issue #2214).
 *
 * Always `'message'`: both callers INSERT a brand-new row, so nothing has been
 * delivered for it before and the client appends rather than replaces.
 *
 * Detached on purpose, and for two reasons that both matter here:
 *
 *  - the `ws-server` import stays dynamic, which is the same bargain
 *    {@link emitChatTurnProgress} strikes — this module's *other* callers (the
 *    `/current-output` route and the terminal push) must not pull the WebSocket
 *    server into their graph just by building a payload;
 *  - the row is already committed when this runs, so a socket write can never
 *    turn a written row into a failed one. The two record functions below are
 *    best-effort by contract and their callers are waiting on a payload.
 *
 * #2214 recorded a limitation here — a route bundle holding its own empty copy
 * of `ws-server`'s `rooms` under `next dev` — and added that "production runs
 * one custom-server bundle and is unaffected". **That last clause was wrong.**
 * `npm run dev` and `npm start` run the *same* custom server (`tsx server.ts`
 * vs `node dist/server/server.js`); what differs is only whether Next evaluates
 * a route handler from a dev compilation or from `.next/server`. Either way the
 * route handler's copy of this module and of `ws-server` is not the custom
 * server's, so this push was silent in production too. #2220 bridged it: the
 * `broadcastMessage` below now reaches the socket owner through
 * `lib/realtime/publisher-registry` regardless of which graph called it.
 */
function broadcastRecordedRow(worktreeId: string, message: ChatMessage): void {
  void import('@/lib/ws-server')
    .then(({ broadcastMessage }) => {
      broadcastMessage('message', { worktreeId, message });
    })
    .catch((error: unknown) => {
      logger.warn('history-row-broadcast-failed', {
        worktreeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export function recordUnclassifiedFrame(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    dwellMs: number;
    sessionStatus: string;
    sessionStatusReason: string;
    /** Issue #2095: the second column that explains the frame, when there is one. */
    obstruction?: OpenCodePaneObstruction | null;
  },
): void {
  const dwellSeconds = Math.round(params.dwellMs / 1000);
  const statusReason = `${params.sessionStatus}/${params.sessionStatusReason}`;
  const question =
    `Unclassified interactive frame (${statusReason}) held for ${dwellSeconds}s. ` +
    `The detection layer could not parse it, so no prompt was published and ` +
    `nothing could answer it. Inspect the raw pane with ` +
    `\`commandmate capture ${params.worktreeId} --pane\`.` +
    // Issue #2095: appended rather than substituted. Everything above is still
    // true — the frame really was unreadable — and a caller matching on the
    // #1708 wording keeps matching. What follows turns "we could not read it"
    // into "here is why, and here is the key that fixes it".
    describePaneObstruction(params.obstruction);

  const record: UnclassifiedFrameRecord = {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question,
    options: [],
    dwellSeconds,
    sessionStatusReason: statusReason,
  };

  try {
    const message = createMessage(db, {
      worktreeId: params.worktreeId,
      role: 'assistant',
      content: question,
      messageType: 'prompt',
      // Not a PromptData: nothing may answer this row, which is why the record
      // type is kept out of that union (see UnclassifiedFrameRecord). The column
      // is shared, so the cast is confined to this one write.
      promptData: record as unknown as PromptData,
      timestamp: new Date(),
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
    });
    logger.info('unclassified-frame-recorded', {
      worktreeId: params.worktreeId,
      cliToolId: params.cliToolId,
      dwellSeconds,
      statusReason,
    });
    // `cliToolId` / `instanceId` are already the explicit values passed above —
    // `createMessage` hands back the caller's own object — so the published row
    // addresses the same instance the column does.
    broadcastRecordedRow(params.worktreeId, message);
  } catch (error: unknown) {
    logger.warn('unclassified-frame-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Write the "the agent said a dialog is open and we could not read it" row
 * (Issue #1725, continuing #1708's proposal 2).
 *
 * Written once per waiting episode, and ONLY while the scraper is publishing no
 * prompt of its own. Both halves matter:
 *
 *  - once, because `buildCurrentOutput` runs on every poll and a row per poll
 *    would turn one blocked dialog into a wall of identical history;
 *  - only when the scraper is blind, because when it is not, the existing
 *    prompt writers already record that prompt with its options and its answer.
 *    A second row would double-count the audit trail `capture --prompts` prints
 *    and put a "nobody could read this" line next to the parsed prompt that
 *    proves somebody could.
 *
 * So a row here means exactly one thing, which is the thing #1708 asked to be
 * recorded: a prompt existed and the detection layer did not see it.
 *
 * Best effort, for the same reason as {@link recordUnclassifiedFrame}: the
 * caller is waiting on a payload, and a failed insert must cost this row and
 * nothing else.
 */
export function recordStructuredPrompt(
  db: Database.Database,
  params: {
    worktreeId: string;
    cliToolId: CLIToolType;
    instanceId: string;
    state: StructuredPromptWaitingState;
    facts: StructuredPromptFacts;
  },
): void {
  const record = buildStructuredPromptHistoryRecord(params.worktreeId, params.facts);

  try {
    const message = createMessage(db, {
      worktreeId: params.worktreeId,
      role: 'assistant',
      content: record.question,
      summary: `structured prompt · source=${params.state.source}${
        params.state.toolName ? ` · tool=${params.state.toolName}` : ''
      }`,
      messageType: 'prompt',
      // Not a PromptData: it has no options and nothing may answer it by
      // number. The column is shared, so the cast is confined to this write —
      // the same arrangement UnclassifiedFrameRecord uses.
      promptData: record as unknown as PromptData,
      timestamp: new Date(),
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
    });
    logger.info('structured-prompt-recorded', {
      worktreeId: params.worktreeId,
      cliToolId: params.cliToolId,
      instanceId: params.instanceId,
      source: params.state.source,
      toolName: params.state.toolName,
    });
    broadcastRecordedRow(params.worktreeId, message);
  } catch (error: unknown) {
    logger.warn('structured-prompt-record-failed', {
      worktreeId: params.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
