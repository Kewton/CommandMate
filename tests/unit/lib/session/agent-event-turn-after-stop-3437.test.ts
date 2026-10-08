/**
 * A `pre_tool_use` after the agent's own `Stop`, with no prompt in between,
 * does not open a turn — for a source that reports its prompts (Issue #3437).
 *
 * The measured sequence (production `server.log.1`, worktree
 * `commandmate-issue-3420`, 2026-10-07): `UserPromptSubmit` 23:40:24, `Stop`
 * 23:41:32.759, then `PreToolUse(AskUserQuestion)` 23:41:35.219 with no
 * `UserPromptSubmit`, and no `Stop` after it. The turn it opened was closed by
 * `scraper_evidence`, and a `wait` adopted it and waited on its `stop`.
 *
 * Every case is a positive or a negative control, and the mutation is the
 * declaration (`promptOpensTurns`), never the tool id: a source whose turns
 * begin with a tool event (Command Code's `pre_tool_use`, antigravity's
 * self-resume `post_tool_use`, #2614) keeps opening them.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAgentStopEvents,
  closeAgentTurn,
  getAgentTurn,
  getStructuredSessionState,
  recordAgentEvent,
  type AgentEventRecord,
} from '@/lib/session/agent-event-state';
import { applyAgentEventToState, type ResolvedAgentEvent } from '@/lib/hooks/agent-event-intake';
import { getAgentEventSource } from '@/lib/hooks/sources';
import { SELF_RESUME_PENDING_DETAIL } from '@/lib/hooks/agent-event-types';
import type { CLIToolType } from '@/lib/cli-tools/types';
import type { Worktree } from '@/types/models';

const WT = 'wt-3437';
const SESSION = '07a5ddd9-46df-42c1-be1c-a6e35209c4a3';
/** The prompt of the measured turn, 2026-10-07T23:40:24.052Z. */
const PROMPT_AT = 1_791_416_424_052;
/** Its `Stop`, 23:41:32.759Z. */
const STOP_AT = 1_791_416_492_759;
/** The `PreToolUse(AskUserQuestion)` that opened the turn, 23:41:35.219Z. */
const PRE_AT = 1_791_416_495_219;

beforeEach(() => {
  clearAgentStopEvents();
});

function post(
  tool: CLIToolType,
  record: Partial<AgentEventRecord> & Pick<AgentEventRecord, 'event' | 'at'>,
): void {
  recordAgentEvent(WT, tool, tool, { detail: null, sessionId: SESSION, ...record });
}

const turn = (tool: CLIToolType, now: number) => getAgentTurn(WT, tool, tool, now);
const status = (tool: CLIToolType, now: number) => getStructuredSessionState(WT, tool, tool, now);

describe('[#3437] a pre_tool_use after the agent\'s own stop', () => {
  it('does not open a turn when the source reports its prompts (the measured sequence)', () => {
    post('claude', { event: 'user_prompt_submit', at: PROMPT_AT, promptOpensTurns: true });
    post('claude', { event: 'stop', at: STOP_AT, promptOpensTurns: true });
    const stopped = turn('claude', STOP_AT + 1);
    expect(stopped).toMatchObject({ openedAt: PROMPT_AT, closedAt: STOP_AT, closedBy: 'stop' });

    post('claude', {
      event: 'pre_tool_use',
      at: PRE_AT,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });

    const after = turn('claude', PRE_AT + 1);
    expect(after?.turnId).toBe(stopped?.turnId);
    expect(after).toMatchObject({ openedAt: PROMPT_AT, closedAt: STOP_AT, closedBy: 'stop' });
    expect(after?.displayEvent.event).toBe('stop');
    expect(status('claude', PRE_AT + 1)?.status).toBe('ready');
  });

  it('opens a turn when the source does not say so (negative control: the pre-#3437 reading)', () => {
    post('claude', { event: 'user_prompt_submit', at: PROMPT_AT });
    post('claude', { event: 'stop', at: STOP_AT });
    const stopped = turn('claude', STOP_AT + 1);

    post('claude', { event: 'pre_tool_use', at: PRE_AT, detail: 'AskUserQuestion' });

    const after = turn('claude', PRE_AT + 1);
    expect(after?.turnId).not.toBe(stopped?.turnId);
    expect(after).toMatchObject({ openedAt: PRE_AT, closedAt: null });
    expect(status('claude', PRE_AT + 1)?.status).toBe('running');
  });

  it('still opens a turn for Command Code, whose turns begin with pre_tool_use', () => {
    post('command-code', { event: 'pre_tool_use', at: PROMPT_AT, detail: 'shell_command' });
    post('command-code', { event: 'stop', at: STOP_AT });

    post('command-code', { event: 'pre_tool_use', at: PRE_AT, detail: 'read_file' });

    expect(turn('command-code', PRE_AT + 1)).toMatchObject({ openedAt: PRE_AT, closedAt: null });
  });

  it('still opens a turn after a close that was not the agent\'s own stop', () => {
    post('claude', { event: 'user_prompt_submit', at: PROMPT_AT, promptOpensTurns: true });
    closeAgentTurn(WT, 'claude', 'claude', 'scraper_evidence', STOP_AT);
    expect(turn('claude', STOP_AT + 1)).toMatchObject({ closedBy: 'scraper_evidence' });

    post('claude', {
      event: 'pre_tool_use',
      at: PRE_AT,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });

    expect(turn('claude', PRE_AT + 1)).toMatchObject({ openedAt: PRE_AT, closedAt: null });
  });

  it('still opens a turn when nothing has ended one (server started mid-turn)', () => {
    post('claude', {
      event: 'pre_tool_use',
      at: PRE_AT,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });

    expect(turn('claude', PRE_AT + 1)).toMatchObject({ openedAt: PRE_AT, closedAt: null });
  });
});

describe('[#3437] turns that must not change', () => {
  it('the ordinary turn: prompt, tool events, stop', () => {
    post('claude', { event: 'user_prompt_submit', at: PROMPT_AT, promptOpensTurns: true });
    const opened = turn('claude', PROMPT_AT + 1);
    post('claude', {
      event: 'pre_tool_use',
      at: PROMPT_AT + 1_000,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });
    post('claude', {
      event: 'post_tool_use',
      at: PROMPT_AT + 2_000,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });
    expect(turn('claude', PROMPT_AT + 2_001)?.turnId).toBe(opened?.turnId);

    post('claude', { event: 'stop', at: STOP_AT, promptOpensTurns: true });
    expect(turn('claude', STOP_AT + 1)).toMatchObject({
      turnId: opened?.turnId,
      openedAt: PROMPT_AT,
      closedAt: STOP_AT,
      closedBy: 'stop',
    });
  });

  it('the next prompt after a stop opens a new turn, and its pre_tool_use continues it', () => {
    post('claude', { event: 'user_prompt_submit', at: PROMPT_AT, promptOpensTurns: true });
    post('claude', { event: 'stop', at: STOP_AT, promptOpensTurns: true });
    const first = turn('claude', STOP_AT + 1);

    post('claude', { event: 'user_prompt_submit', at: PRE_AT, promptOpensTurns: true });
    const second = turn('claude', PRE_AT + 1);
    expect(second?.turnId).not.toBe(first?.turnId);
    expect(second).toMatchObject({ openedAt: PRE_AT, closedAt: null });

    post('claude', {
      event: 'pre_tool_use',
      at: PRE_AT + 1_000,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });
    expect(turn('claude', PRE_AT + 1_001)).toMatchObject({
      turnId: second?.turnId,
      openedAt: PRE_AT,
      closedAt: null,
    });
  });

  it('a post_tool_use after a stop still opens a turn (a Stop hook that blocks continues the agent)', () => {
    post('claude', { event: 'user_prompt_submit', at: PROMPT_AT, promptOpensTurns: true });
    post('claude', { event: 'stop', at: STOP_AT, promptOpensTurns: true });

    post('claude', {
      event: 'post_tool_use',
      at: PRE_AT,
      detail: 'AskUserQuestion',
      promptOpensTurns: true,
    });

    expect(turn('claude', PRE_AT + 1)).toMatchObject({ openedAt: PRE_AT, closedAt: null });
  });

  it('the self-resume wake (#2614): antigravity\'s post_tool_use after its stop opens a turn', () => {
    post('antigravity', { event: 'post_tool_use', at: PROMPT_AT, detail: 'run_command' });
    post('antigravity', { event: 'stop', at: STOP_AT, detail: SELF_RESUME_PENDING_DETAIL });
    const stopped = turn('antigravity', STOP_AT + 1);

    post('antigravity', { event: 'post_tool_use', at: PRE_AT, detail: 'schedule' });

    const woke = turn('antigravity', PRE_AT + 1);
    expect(woke?.turnId).not.toBe(stopped?.turnId);
    expect(woke).toMatchObject({ openedAt: PRE_AT, closedAt: null });
  });
});

describe('[#3437] the intake reads the declaration off the source', () => {
  function deliver(tool: CLIToolType, event: AgentEventRecord['event'], at: number, detail: string | null): void {
    const ctx = {
      worktree: { id: WT } as Worktree,
      tool,
      source: getAgentEventSource(tool),
      instanceParam: tool,
      event,
      sessionId: SESSION,
      receivedAt: at,
      detail,
      normalized: { model: null },
    } as unknown as ResolvedAgentEvent;
    applyAgentEventToState(ctx, {}, false, { info: () => {}, warn: () => {} } as never);
  }

  it('claude: the measured sequence does not open a turn', () => {
    deliver('claude', 'user_prompt_submit', PROMPT_AT, null);
    deliver('claude', 'stop', STOP_AT, null);
    deliver('claude', 'pre_tool_use', PRE_AT, 'AskUserQuestion');

    expect(turn('claude', PRE_AT + 1)).toMatchObject({
      openedAt: PROMPT_AT,
      closedAt: STOP_AT,
      closedBy: 'stop',
    });
  });

  it('command-code: declares no user_prompt_submit, so its pre_tool_use opens a turn', () => {
    expect(getAgentEventSource('command-code').capabilities.supportedEvents).not.toContain(
      'user_prompt_submit',
    );
    deliver('command-code', 'pre_tool_use', PROMPT_AT, 'shell_command');
    deliver('command-code', 'stop', STOP_AT, null);
    deliver('command-code', 'pre_tool_use', PRE_AT, 'read_file');

    expect(turn('command-code', PRE_AT + 1)).toMatchObject({ openedAt: PRE_AT, closedAt: null });
  });
});
