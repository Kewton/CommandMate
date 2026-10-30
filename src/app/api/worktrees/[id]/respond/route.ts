/**
 * API Route: POST /api/worktrees/[id]/respond
 * Send response to CLI tool prompt (Claude/Codex/Gemini)
 */

import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { getDbInstance } from '@/lib/db/db-instance';
import { getMessageById, updatePromptData, getWorktreeById } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { promptAnswerErrorResponse } from '@/lib/prompt-answer-errors';
import { startPolling } from '@/lib/polling/response-poller';
import { getAnswerInput } from '@/lib/detection/prompt-detector';
import { broadcastMessage } from '@/lib/ws-server';
import { createLogger } from '@/lib/logger';
import { getOrInitGlobal } from '@/lib/global-state';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';
import { isAnswerablePromptData } from '@/types/models';
import { buildCompositeKey } from '@/lib/auto-yes-state';
import {
  noteManualAnswerStarted,
  noteManualSendStarting,
  settleManualAnswer,
} from '@/lib/polling/auto-yes-manual-answer';
import { settleManualSendError } from '../prompt-response/answer-delivery';
import { respondByDecisionId, respondToSolePendingDecision } from './structured-decision';
import { screenAtSend } from './screen-at-send';

const logger = createLogger('api/respond');

declare global {
  // eslint-disable-next-line no-var
  var __respondAnswersInFlight: Set<string> | undefined;
}

/**
 * Stored prompt rows whose answer is being sent (Issue #3975). On `globalThis`
 * (`getOrInitGlobal`) so a hot reload keeps it.
 */
const answersInFlight = getOrInitGlobal('__respondAnswersInFlight', () => new Set<string>());

/**
 * POST /api/worktrees/[id]/respond
 *
 * Request body — one of three shapes (Issue #1932, #2040):
 * {
 *   "messageId": "uuid",       // a stored prompt row; answered at the pane
 *   "answer": "yes" | "no"
 * }
 * {
 *   "decisionId": "per_…",     // an approval the agent is holding; answered
 *   "answer": "1",             // over the agent's own API, no keys sent
 *   "cliTool": "opencode",     // optional; defaults to the worktree's tool
 *   "instanceId": "opencode-2" // optional; defaults to the primary
 * }
 * {
 *   "answer": "3",             // Issue #2040: the ONE decision this instance is
 *   "cliTool": "opencode",     // holding, whichever it is. 404 when it holds
 *   "instanceId": "opencode-2" // none, 409 when it holds more than one — and
 * }                            // neither refusal touches the pane.
 *
 * Response:
 * {
 *   "success": true,
 *   "message": ChatMessage     // messageId shape only
 * }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const parsed = await readJsonObjectBody(req);
    if (!parsed.ok) return parsed.response;
    const { messageId, decisionId, answer, cliTool: bodyCliTool, instanceId: bodyInstanceId } = parsed.body;

    // Validation. Issue #1932 made `messageId` optional when a `decisionId` is
    // offered; Issue #2040 makes both optional, so the one field every shape
    // needs is an answer.
    //
    // The refusal wording is unchanged for every request that already got one:
    // a body with no `decisionId` still reads `messageId and answer are
    // required` whether or not it carried a `messageId`, because the Web UI's
    // existing flow reads that string. What #2040 widened is what is ACCEPTED —
    // a bare `{ answer }` is no longer a malformed stored-message request — not
    // what a rejection says.
    if (!answer) {
      return NextResponse.json(
        decisionId
          ? { error: 'answer is required' }
          : { error: 'messageId and answer are required' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Issue #1932: the structured path. Taken only when no `messageId` was
    // sent, so a request carrying both goes on being the stored-message request
    // it has always been.
    if (!messageId) {
      // Issue #2040: an answer with neither id names the ONE decision this
      // instance is holding — and refuses, without sending anything anywhere,
      // when that count is not one. Split here rather than inside the module so
      // the two shapes stay two functions with two contracts.
      return decisionId
        ? await respondByDecisionId({
            db,
            worktreeId: id,
            decisionId,
            answer,
            cliToolParam: bodyCliTool,
            instanceParam: bodyInstanceId,
          })
        : await respondToSolePendingDecision({
            db,
            worktreeId: id,
            answer,
            cliToolParam: bodyCliTool,
            instanceParam: bodyInstanceId,
          });
    }

    // Get message
    const message = getMessageById(db, messageId);

    if (!message) {
      return NextResponse.json(
        { error: 'Message not found' },
        { status: 404 }
      );
    }

    // Issue #1932 (S6b): the row must belong to the worktree in the URL.
    // Without this, `POST /api/worktrees/<any-worktree>/respond` answered any
    // message id in the database — the id is a UUID, so it was not a browsable
    // hole, but the route then resolved the session from THIS worktree and typed
    // the answer into a pane the prompt never came from. Answered as "not
    // found" rather than "forbidden": a message in another worktree is not
    // addressable here, and saying which ids exist is not this route's job.
    if (message.worktreeId !== id) {
      return NextResponse.json(
        { error: 'Message not found' },
        { status: 404 }
      );
    }

    if (message.messageType !== 'prompt') {
      return NextResponse.json(
        { error: 'Message is not a prompt' },
        { status: 400 }
      );
    }

    if (!message.promptData) {
      return NextResponse.json(
        { error: 'Prompt data not found' },
        { status: 400 }
      );
    }

    if (message.promptData.status === 'answered') {
      return NextResponse.json(
        { error: 'Prompt already answered' },
        { status: 400 }
      );
    }

    // Issue #1738: `chat_messages.prompt_data` is shared with two degraded
    // records — #1708's "the detectors failed on this frame" row and #1725's
    // "only the structured layer saw this dialog" row. Both carry
    // `type: 'unclassified'` and no options, and neither may be answered: they
    // are audit records, and the answer, if one comes, is written by the
    // ordinary prompt writer against its own row. Without this the row fell
    // through to the yes/no branch below, which would have typed an arbitrary
    // string into the pane on behalf of a prompt nobody could read.
    //
    // #3184: kept as a type narrowing at the server's send gate — the branches
    // below need the closed `PromptData` union — not a display decision.
    if (!isAnswerablePromptData(message.promptData)) {
      return NextResponse.json(
        { error: 'Prompt cannot be answered: the frame was never classified' },
        { status: 400 }
      );
    }
    const promptData = message.promptData;

    // Validate answer based on prompt type
    let input: string;

    // For multiple choice, check if answer is an option number or custom text
    if (promptData.type === 'multiple_choice') {
      // Issue #2755: this route cannot deliver a CHECKBOX answer, and the way
      // it failed was silent. `parseInt("1,3", 10)` is `1`, so a request naming
      // two boxes reached `sendPromptAnswer` as the single number `1` — one box
      // ticked, the question still on screen, and this route answering
      // `success: true`. Refused instead, and pointed at the route that has the
      // toggle-and-confirm arm (`POST /api/worktrees/[id]/prompt-response`,
      // which takes `answers: [1,3]` or `answer: "1,3"`).
      //
      // Scoped to a payload that SAYS it is a checkbox question, which is the
      // minimal correction 確定仕様 5 asks for here: a comma in an answer to
      // any other prompt is free text and still passes through as it always did.
      if (promptData.multiSelect === true && answer.includes(',')) {
        return NextResponse.json(
          {
            error:
              'This prompt is a checkbox question and this endpoint cannot answer one: the numbers '
              + 'would be sent as a single choice. POST the same worktree\'s '
              + '/prompt-response with { "answers": [1, 3] } instead.',
          },
          { status: 400 }
        );
      }

      const answerNum = parseInt(answer, 10);

      // If answer is a number, validate it's one of the available options
      if (!isNaN(answerNum)) {
        const validNumbers = promptData.options.map(opt => opt.number);
        if (!validNumbers.includes(answerNum)) {
          return NextResponse.json(
            { error: `Invalid choice: ${answer}. Valid options are: ${validNumbers.join(', ')}` },
            { status: 400 }
          );
        }

        // Use the number as input
        input = answerNum.toString();
      } else {
        // If answer is not a number, it's custom text input
        // Use it as-is (no validation needed)
        input = answer;
      }
    } else {
      // For yes/no prompts, use the standard validation
      try {
        input = getAnswerInput(answer, promptData.type);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
          { error: `Invalid answer: ${errorMessage}` },
          { status: 400 }
        );
      }
    }

    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
        { status: 404 }
      );
    }

    // Use the CLI tool ID from the message (the tool that asked the prompt)
    const cliToolId = message.cliToolId || worktree.cliToolId || 'claude';

    // Issue #868: respond to the same agent instance that asked the prompt. The
    // message's instanceId defaults to cliToolId (primary) for legacy messages.
    const instanceId = message.instanceId ?? cliToolId;

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Get session name for the CLI tool
    const sessionName = cliTool.getSessionName(id, instanceId);

    // Issue #3975: the row is recorded as answered only after the send, so the
    // `answered` check above no longer covers the send itself. Claimed here —
    // synchronously after that check, before the first await — so a second
    // request for the same row while this one is typing is refused rather than
    // typing its answer at whatever screen follows.
    if (answersInFlight.has(messageId)) {
      return NextResponse.json(
        { error: 'Prompt is already being answered' },
        { status: 409 }
      );
    }
    answersInFlight.add(messageId);
    try {
      // Issue #2865: a same-named session another CommandMate server created is
      // not this prompt's pane. Refused before anything is typed or recorded.
      const ownership = await checkSessionOwnership(sessionName, worktree.path);
      if (ownership.verdict === 'foreign') {
        return NextResponse.json(foreignSessionErrorBody(sessionName, ownership.sessionPath), { status: 409 });
      }

      // Issue #3907: a person is answering at the pane, as on `/prompt-response`
      // (#3821 / #3880): before the first key a poller tick under way sends no
      // further key and the next ticks leave the screen to the person, and how
      // this answer ENDS decides what becomes of an answer Auto-Yes holds at the
      // confirmation (`settleManualAnswer` below). Without it a send here that
      // timed out with its keys on the pane left the confirmation free for
      // Auto-Yes to type at again, and one that went through left Auto-Yes's own
      // unknown send held.
      const manualAnswer = noteManualAnswerStarted(buildCompositeKey(id, cliToolId, instanceId));

      // Send answer to tmux via shared sendPromptAnswer() (Issue #616)
      // Issue #3907 (review P2): registered at the screen read right before the
      // first key, as `/prompt-response` does — not at the stored row's — and
      // that same frame is what the sender judges the answer against, so the
      // screen registered is the screen the keys go to.
      const atSend = await screenAtSend(id, cliToolId, instanceId);
      noteManualSendStarting(manualAnswer, atSend.promptData);
      try {
        await sendPromptAnswer({
          sessionName,
          answer: input,
          cliToolId,
          promptData: promptData,
          frame: atSend.frame,
          // Issue #3952 review P2-1: the mark taken before that frame's capture.
          readMark: atSend.readMark,
        });
        logger.info('prompt-answer-sent');
      } catch (error: unknown) {
        settleManualSendError(manualAnswer, error);
        // Issue #3982: the table `/prompt-response` answers by too, so both
        // routes give every answer error the same `reason` and `keysSent`.
        // Issue #3952: waited for a send holding the session's input, then not
        // typed — nothing reached the pane, which a 500 would not say (409).
        // Issue #3975: stopped part-way — some keys are on the pane. Still a
        // 500, with the reason, so a caller can say "look before answering again".
        const mapped = promptAnswerErrorResponse(error, 'respond');
        if (mapped !== null) {
          return NextResponse.json(mapped.body, { status: mapped.status });
        }
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
          { error: `Failed to send answer to tmux: ${errorMessage}` },
          { status: 500 }
        );
      }
      settleManualAnswer(manualAnswer, 'answered');

      // Update prompt data — only now that every key of the answer went out
      // (Issue #3975), as `/prompt-response` records its answer after the send. A
      // send refused (409) or failed (500) leaves the row pending, so the chat
      // still offers the prompt and it can be answered again.
      //
      // Issue #3881: the row's `reading` (what the screen was read as when it was
      // saved) travels through the spread untouched. A row saved before #3881
      // has none, and none is made here: a reading is read off the frame, and
      // this route holds only the stored strings — reading those again is the
      // very re-derivation #3881 removed (a 16-column confirm page would come
      // back `unknown` and draw as a tool approval). So an old row stays an old
      // row, and the chat surface reads it with its compatibility rules
      // (`lib/chat/chat-tool-approvals`), exactly as before it was answered.
      const updatedPromptData = {
        ...promptData,
        status: 'answered' as const,
        answer,
        answeredAt: new Date().toISOString(),
        // Issue #1685: audit attribution — this route is only reached from an
        // explicit human reply (chat prompt buttons).
        answeredBy: 'human' as const,
      };
      updatePromptData(db, messageId, updatedPromptData);

      // Issue #1548: a person answered. This branch needs a stored messageId, so
      // unlike /prompt-response it has no automated caller to be confused with.
      // Issue #2200 retired the legacy chat prompt buttons that were its only
      // caller: the composer's `PromptPanel` reaches this route on the
      // `decisionId` shape and `commandmate respond` on the id-less one, and
      // neither comes through here.
      // Issue #3907: kept rather than retired — it is the public body shape the
      // route's suites and integration tests post — and so it reports its end to
      // Auto-Yes (`settleManualAnswer` above) like `/prompt-response` does.
      applyEventToActiveTask(db, id, cliToolId, instanceId, 'prompt_answered_human', {
        promptType: promptData.type,
      });

      // Broadcast updated message
      const updatedMessage = {
        ...message,
        promptData: updatedPromptData,
      };

      broadcastMessage('message_updated', {
        worktreeId: id,
        message: updatedMessage,
      });

      // Resume polling for CLI tool's next response
      startPolling(id, cliToolId, instanceId);
      void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId);

      logger.info('polling-resumed-after-answer');

      return NextResponse.json({
        success: true,
        message: updatedMessage,
      });
    } finally {
      answersInFlight.delete(messageId);
    }
  } catch (error: unknown) {
    logger.error('failed-to-respond-to-prompt:', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
