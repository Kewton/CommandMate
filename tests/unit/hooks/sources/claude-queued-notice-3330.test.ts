/**
 * Which `UserPromptSubmit` payloads join the running turn (Issue #3330).
 *
 * The payloads are synthetic: the shape is Claude's `UserPromptSubmit`, the
 * notice text is the tag every queued background-task notice begins with.
 */

import { describe, expect, it } from 'vitest';
import {
  CLAUDE_TASK_NOTIFICATION_PREFIX,
  isClaudeQueuedNoticePrompt,
} from '@/lib/hooks/sources/claude/queued-notice';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';

const payload = (prompt: unknown) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-3330',
  prompt,
});

const NOTICE = `${CLAUDE_TASK_NOTIFICATION_PREFIX}\n<status>completed</status>\n</task-notification>`;

describe('isClaudeQueuedNoticePrompt', () => {
  it('is true for a background-task notice', () => {
    expect(isClaudeQueuedNoticePrompt(payload(NOTICE))).toBe(true);
    expect(isClaudeQueuedNoticePrompt(payload(`\n${NOTICE}`))).toBe(true);
  });

  it('is false for a prompt the operator wrote', () => {
    expect(isClaudeQueuedNoticePrompt(payload('Implement the change'))).toBe(false);
    // Mentioning the tag is not being a notice.
    expect(isClaudeQueuedNoticePrompt(payload(`see ${NOTICE}`))).toBe(false);
  });

  it('is false when there is no prompt to read', () => {
    expect(isClaudeQueuedNoticePrompt({ hook_event_name: 'UserPromptSubmit' })).toBe(false);
    expect(isClaudeQueuedNoticePrompt(payload(null))).toBe(false);
    expect(isClaudeQueuedNoticePrompt(payload(42))).toBe(false);
    expect(isClaudeQueuedNoticePrompt(payload(''))).toBe(false);
  });
});

describe('promptJoinsOpenTurn on the registered sources', () => {
  it('is wired on claude', () => {
    const source = getAgentEventSource('claude');
    expect(source.promptJoinsOpenTurn?.(payload(NOTICE))).toBe(true);
    expect(source.promptJoinsOpenTurn?.(payload('Implement the change'))).toBe(false);
  });

  it('answers false (or nothing) on every other tool', () => {
    for (const tool of CLI_TOOL_IDS.filter((id) => id !== 'claude')) {
      expect(getAgentEventSource(tool).promptJoinsOpenTurn?.(payload(NOTICE)) ?? false, tool).toBe(false);
    }
  });
});
