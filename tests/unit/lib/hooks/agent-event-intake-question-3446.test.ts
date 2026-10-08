/**
 * A question asked outside any turn is not filed, and the lines that decide it
 * name the sender (Issue #3446).
 *
 * The measured sequence is #3437's (production, 2026-10-07): `UserPromptSubmit`
 * 23:40:24, `Stop` 23:41:32.759, then `PreToolUse(AskUserQuestion)`
 * 23:41:35.219 with no prompt between — absent from the session's transcript,
 * no picker on the pane. #3441 stopped it opening a turn; it still filed a
 * question. Every case below is a positive or a negative control on the same
 * condition #3437 reads, and the question inside a turn (#1726) is unchanged.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentStopEvents,
  clearAskUserQuestion,
  getAskUserQuestion,
  shortSessionTag,
} from '@/lib/session/agent-event-state';
import {
  applyAgentEventToState,
  hookSenderTags,
  recordQuestionIfAsked,
  type AgentEventLogger,
  type ResolvedAgentEvent,
} from '@/lib/hooks/agent-event-intake';
import { getAgentEventSource } from '@/lib/hooks/sources';
import type { AgentEventType } from '@/lib/hooks/agent-event-types';
import type { Worktree } from '@/types/models';

const WT = 'wt-3446';
const SESSION = '07a5ddd9-46df-42c1-be1c-a6e35209c4a3';
const AGENT_ID = 'a1b2c3d4e5f6';
const TRANSCRIPT = '/Users/someone/.claude/projects/x/07a5ddd9.jsonl';
const TOOL_USE_ID = 'toolu_01ABCDEF';
const PROMPT_AT = 1_791_416_424_052;
const STOP_AT = 1_791_416_492_759;
const PRE_AT = 1_791_416_495_219;

/** The captured `PreToolUse(AskUserQuestion)` payload (#1721), with this test's ids. */
function questionPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const captured = JSON.parse(
    readFileSync(
      join(process.cwd(), 'tests/fixtures/hooks/claude/pre-tool-use-ask-user-question.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  return {
    ...captured,
    session_id: SESSION,
    transcript_path: TRANSCRIPT,
    tool_use_id: TOOL_USE_ID,
    ...extra,
  };
}

function makeLogger(): AgentEventLogger & { info: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
}

function ctxOf(event: AgentEventType, at: number, detail: string | null): ResolvedAgentEvent {
  return {
    worktree: { id: WT } as Worktree,
    tool: 'claude',
    source: getAgentEventSource('claude'),
    instanceParam: 'claude',
    event,
    sessionId: SESSION,
    receivedAt: at,
    detail,
    normalized: { model: null },
  } as unknown as ResolvedAgentEvent;
}

/** What the route does with one delivery, minus the HTTP. */
function deliver(
  event: AgentEventType,
  at: number,
  detail: string | null,
  payload: Record<string, unknown> = {},
  logger: AgentEventLogger = makeLogger(),
): void {
  const ctx = ctxOf(event, at, detail);
  applyAgentEventToState(ctx, payload, false, logger);
  recordQuestionIfAsked(ctx, payload, logger);
}

function lines(logger: ReturnType<typeof makeLogger>, name: string): Record<string, unknown>[] {
  return logger.info.mock.calls.filter(([n]) => n === name).map(([, data]) => data);
}

beforeEach(() => {
  clearAgentStopEvents();
  clearAskUserQuestion(WT, 'claude', 'claude');
});

describe('[#3446] AskUserQuestion after the agent\'s own stop', () => {
  it('is not filed as a question (the measured sequence)', () => {
    deliver('user_prompt_submit', PROMPT_AT, null);
    deliver('stop', STOP_AT, null);

    const logger = makeLogger();
    deliver('pre_tool_use', PRE_AT, 'AskUserQuestion', questionPayload(), logger);

    expect(getAskUserQuestion(WT, 'claude', 'claude', PRE_AT + 1)).toBeNull();
    expect(lines(logger, 'ask-user-question-recorded')).toHaveLength(0);
    expect(lines(logger, 'ask-user-question-outside-turn')).toEqual([
      expect.objectContaining({
        worktreeId: WT,
        questionCount: 2,
        session: shortSessionTag(SESSION),
        transcript: shortSessionTag(TRANSCRIPT),
        toolUse: shortSessionTag(TOOL_USE_ID),
      }),
    ]);
    expect(lines(logger, 'agent-event-pre-tool-use-outside-turn')).toEqual([
      expect.objectContaining({ detail: 'AskUserQuestion', session: shortSessionTag(SESSION) }),
    ]);
  });

  it('is filed when a post_tool_use reopened the turn after the stop (negative control)', () => {
    // A Stop hook that blocks keeps the agent working, and its tool call
    // reports `post_tool_use`, which opens the turn (#3437).
    deliver('user_prompt_submit', PROMPT_AT, null);
    deliver('stop', STOP_AT, null);
    deliver('post_tool_use', STOP_AT + 500, 'Bash');

    const logger = makeLogger();
    deliver('pre_tool_use', PRE_AT, 'AskUserQuestion', questionPayload(), logger);

    expect(getAskUserQuestion(WT, 'claude', 'claude', PRE_AT + 1)?.spec.questions).toHaveLength(2);
    expect(lines(logger, 'ask-user-question-outside-turn')).toHaveLength(0);
    expect(lines(logger, 'agent-event-pre-tool-use-outside-turn')).toHaveLength(0);
  });

  it('is filed when a new prompt opened a turn after the stop (negative control)', () => {
    deliver('user_prompt_submit', PROMPT_AT, null);
    deliver('stop', STOP_AT, null);
    deliver('user_prompt_submit', STOP_AT + 1000, null);

    deliver('pre_tool_use', PRE_AT, 'AskUserQuestion', questionPayload());

    expect(getAskUserQuestion(WT, 'claude', 'claude', PRE_AT + 1)).not.toBeNull();
  });
});

describe('[#3446] AskUserQuestion inside a turn (#1726, unchanged)', () => {
  it('is filed and logged with the sender tags', () => {
    deliver('user_prompt_submit', PROMPT_AT, null);

    const logger = makeLogger();
    deliver(
      'pre_tool_use',
      PRE_AT,
      'AskUserQuestion',
      questionPayload({ agent_id: AGENT_ID, agent_type: 'general-purpose' }),
      logger,
    );

    expect(getAskUserQuestion(WT, 'claude', 'claude', PRE_AT + 1)?.at).toBe(PRE_AT);
    expect(lines(logger, 'ask-user-question-recorded')).toEqual([
      expect.objectContaining({
        questionCount: 2,
        optionCounts: [3, 2],
        session: shortSessionTag(SESSION),
        agent: shortSessionTag(AGENT_ID),
        agentType: 'general-purpose',
      }),
    ]);
    expect(lines(logger, 'agent-event-pre-tool-use-outside-turn')).toHaveLength(0);
  });

  it('is released by the stop that ends the turn, as before', () => {
    deliver('user_prompt_submit', PROMPT_AT, null);
    deliver('pre_tool_use', PRE_AT - 10_000, 'AskUserQuestion', questionPayload());
    deliver('stop', STOP_AT + 10_000, null);

    expect(getAskUserQuestion(WT, 'claude', 'claude', STOP_AT + 10_001)).toBeNull();
  });
});

describe('[#3446] hookSenderTags', () => {
  it('never carries the session id, the transcript path or the tool call id as themselves', () => {
    const tags = hookSenderTags(
      { agent_id: AGENT_ID, transcript_path: TRANSCRIPT, tool_use_id: TOOL_USE_ID },
      SESSION,
    );
    const written = JSON.stringify(tags);

    for (const secret of [SESSION, TRANSCRIPT, TOOL_USE_ID, AGENT_ID]) {
      expect(written).not.toContain(secret);
    }
    expect(Object.values(tags).every((v) => v === null || /^[0-9a-f]{8}$/.test(v))).toBe(true);
  });

  it('gives null for fields the payload does not carry, and drops an agent_type that is not a name', () => {
    expect(hookSenderTags({ agent_type: 'not a name / with a path' }, undefined)).toEqual({
      session: null,
      agent: null,
      agentType: null,
      transcript: null,
      toolUse: null,
    });
  });
});
