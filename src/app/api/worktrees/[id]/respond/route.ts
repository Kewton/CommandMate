/**
 * API Route: POST /api/worktrees/[id]/respond
 * Send response to CLI tool prompt (Claude/Codex/Gemini)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getMessageById, updatePromptData, getWorktreeById } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { sendPromptAnswer } from '@/lib/prompt-answer-sender';
import { startPolling } from '@/lib/polling/response-poller';
import { getAnswerInput } from '@/lib/detection/prompt-detector';
import { broadcastMessage } from '@/lib/ws-server';
import { createLogger } from '@/lib/logger';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { isAnswerablePromptData } from '@/types/models';
import { respondByDecisionId, respondToSolePendingDecision } from './structured-decision';

const logger = createLogger('api/respond');

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
    const { messageId, decisionId, answer, cliTool: bodyCliTool, instanceId: bodyInstanceId } = await req.json();

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

    // Update prompt data
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

    // Send answer to tmux via shared sendPromptAnswer() (Issue #616)
    try {
      await sendPromptAnswer({
        sessionName,
        answer: input,
        cliToolId,
        promptData: promptData,
      });
      logger.info('sent-answer-to');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${errorMessage}` },
        { status: 500 }
      );
    }

    // Issue #1548: a person answered. This branch needs a stored messageId, so
    // unlike /prompt-response it has no automated caller to be confused with.
    // Issue #2200 retired the legacy chat prompt buttons that were its only
    // caller: the composer's `PromptPanel` reaches this route on the
    // `decisionId` shape and `commandmate respond` on the id-less one, and
    // neither comes through here.
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

    logger.info('resumed-polling-for');

    return NextResponse.json({
      success: true,
      message: updatedMessage,
    });
  } catch (error: unknown) {
    logger.error('failed-to-respond-to-prompt:', { error: error instanceof Error ? error.message : String(error) });
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
