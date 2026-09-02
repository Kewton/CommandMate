/**
 * The `promptData` shapes a chat row can carry that are NOT answerable prompts
 * (Issue #2245).
 *
 * Hand-built rather than captured, and deliberately so: the antigravity and
 * codex captures beside this file contain only the two shapes those two tools
 * happened to produce that afternoon, while `chat_messages.prompt_data` is
 * typed {@link StoredPromptData} and the column has carried all of these since
 * #1708 / #1725. The chip has to survive every one of them, because a throw in a
 * transcript row is a white screen for the whole conversation — live region,
 * composer and terminal banner included.
 *
 * The shapes, in the order the union declares them:
 *
 *  - `null` / absent — pre-#1685 rows, and anything an older schema wrote;
 *  - `UnclassifiedFrameRecord` (#1708) — the detectors failed on the frame.
 *    `type` is the {@link UNCLASSIFIED_PROMPT_TYPE} sentinel, which is
 *    deliberately outside `PromptType`, and `options` is empty by construction;
 *  - `StructuredPromptHistoryRecord` (#1725) — only the structured layer saw a
 *    dialog, so there is a `source` and no parsed options.
 *
 * `isAnswerablePromptData` narrows away the last two and says nothing about the
 * first, which is exactly why the chip reads every field defensively instead.
 */

import type { ChatMessage } from '@/types/models';
import { UNCLASSIFIED_PROMPT_TYPE } from '@/types/models';

const WORKTREE_ID = 'wt-2245-degraded';
const T0 = Date.UTC(2026, 8, 2, 14, 0, 0);

function row(id: string, offsetSeconds: number, extra: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    worktreeId: WORKTREE_ID,
    role: 'assistant',
    content: 'pane dump that must never be rendered',
    timestamp: new Date(T0 + offsetSeconds * 1000),
    messageType: 'prompt',
    archived: false,
    cliToolId: 'claude',
    ...extra,
  };
}

/** A prompt row with no `promptData` field at all. */
export const promptRowWithoutPromptData: ChatMessage = row('deg-absent', 0, {});

/** A prompt row whose `promptData` is explicitly null. */
export const promptRowWithNullPromptData: ChatMessage = row('deg-null', 1, {
  promptData: null as unknown as ChatMessage['promptData'],
});

/** #1708's failure record: nothing was parsed, and nothing may answer it. */
export const promptRowWithUnclassifiedRecord: ChatMessage = row('deg-unclassified', 2, {
  promptData: {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'unclassified',
    question: 'Unclassified interactive frame — open the terminal to look at it',
    options: [],
    dwellSeconds: 42,
    sessionStatusReason: 'running/default',
  } as unknown as ChatMessage['promptData'],
});

/** #1725's structured-only record: a dialog the scraper never saw on the pane. */
export const promptRowWithStructuredRecord: ChatMessage = row('deg-structured', 3, {
  promptData: {
    type: UNCLASSIFIED_PROMPT_TYPE,
    status: 'pending',
    question: 'Approve Write?',
    source: 'structured',
    options: [],
  } as unknown as ChatMessage['promptData'],
});

/** A prompt row whose `promptData` is a primitive — no schema ever wrote this. */
export const promptRowWithGarbagePromptData: ChatMessage = row('deg-garbage', 4, {
  summary: 42 as unknown as string,
  promptData: 'not an object' as unknown as ChatMessage['promptData'],
});

/** Every degraded row, in the order above. */
export const degradedPromptRows: ChatMessage[] = [
  promptRowWithoutPromptData,
  promptRowWithNullPromptData,
  promptRowWithUnclassifiedRecord,
  promptRowWithStructuredRecord,
  promptRowWithGarbagePromptData,
];
