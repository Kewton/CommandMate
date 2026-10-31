/**
 * Issue #4035 — what the sender asks before trusting a B/F verdict on a
 * session's first prompt, and how the hooks and the session start feed it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPromptSubmitReceipts,
  getPromptSubmitTarget,
  matchesSubmittedBody,
  notePromptSubmitHook,
  notePromptSubmitSession,
  noteSubmittedBody,
  readPromptSubmitReceipt,
} from '@/lib/session/prompt-submit-receipt';
import { recordAgentEvent } from '@/lib/session/agent-event-state';
import { beginAgentSession } from '@/lib/session/agent-session-lifecycle';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import {
  classifySendFailure,
  clearSendAttempts,
  getLastSendAttempt,
  markLastSendDiscarded,
  recordSendAttempt,
} from '@/lib/session/send-attempt-state';

const WT = 'wt-4035';
const TARGET = { worktreeId: WT, cliToolId: 'claude' as const };
const SESSION = 'mcbd-claude-wt-4035';

beforeEach(() => {
  clearPromptSubmitReceipts();
  clearSendAttempts();
});

describe('[#4035] readPromptSubmitReceipt', () => {
  it('awaits the first prompt of a session whose hooks are live', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    notePromptSubmitHook(TARGET, 'session_start', 1_500);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('awaited');
    notePromptSubmitHook(TARGET, 'user_prompt_submit', 2_300);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('received');
    // The next send is not the first: the screen decides again.
    expect(readPromptSubmitReceipt(SESSION, 'claude', 9_000)).toBe('not-required');
  });

  it('does not require a report before any hook has arrived from the new process', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('not-required');
  });

  it('forgets the previous process when the session starts again', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    notePromptSubmitHook(TARGET, 'user_prompt_submit', 1_500);
    noteSubmittedBody(SESSION, 'hello');
    notePromptSubmitSession(SESSION, TARGET, 5_000);
    notePromptSubmitHook(TARGET, 'session_start', 5_500);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 6_000)).toBe('awaited');
    expect(matchesSubmittedBody(SESSION, 'hello')).toBe(false);
  });

  it('ignores hooks of an instance it was not told about', () => {
    notePromptSubmitHook(TARGET, 'session_start', 1_500);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('not-required');
  });
});

describe('[#4035] matchesSubmittedBody', () => {
  it('matches the whole body or a long enough beginning, whitespace aside, and nothing else', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    const body = 'a'.repeat(40) + ' ' + 'b'.repeat(80);
    noteSubmittedBody(SESSION, body);
    expect(matchesSubmittedBody(SESSION, body)).toBe(true);
    expect(matchesSubmittedBody(SESSION, `${'a'.repeat(40)}\n${'b'.repeat(30)}`)).toBe(true);
    expect(matchesSubmittedBody(SESSION, 'a'.repeat(20))).toBe(false);
    expect(matchesSubmittedBody(SESSION, 'something else entirely, typed by a person')).toBe(false);
    expect(matchesSubmittedBody(SESSION, '')).toBe(false);
  });
});

describe('[#4035] wiring', () => {
  it('beginAgentSession registers the session and recordAgentEvent feeds it', () => {
    beginAgentSession({ worktreeId: WT, cliToolId: 'claude' });
    const sessionName = resolveSessionName('claude', WT);
    expect(getPromptSubmitTarget(sessionName)).toMatchObject({ worktreeId: WT, cliToolId: 'claude' });

    const enteredAt = Date.now() + 10;
    recordAgentEvent(WT, 'claude', undefined, { event: 'session_start', at: Date.now(), detail: 'startup', sessionId: 's1' });
    expect(readPromptSubmitReceipt(sessionName, 'claude', enteredAt)).toBe('awaited');
    recordAgentEvent(WT, 'claude', undefined, { event: 'user_prompt_submit', at: enteredAt + 5, detail: null, sessionId: 's1' });
    expect(readPromptSubmitReceipt(sessionName, 'claude', enteredAt)).toBe('received');
  });
});

describe('[#4035] send attempt records', () => {
  const INSTANCE = { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' };

  it('classifies the unreported first prompt as indeterminate', () => {
    const error = new Error(
      'Message submit could not be confirmed for session s: the composer did not show the body (rule F) ' +
        'but the agent did not report the prompt within 5000ms (Issue #4035).'
    );
    expect(classifySendFailure(error)).toEqual({ state: 'indeterminate', reason: 'prompt-unreported' });
  });

  it('turns only a sent record indeterminate', () => {
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: 'x' }, 1_000);
    markLastSendDiscarded(INSTANCE, 2_000);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ at: 2_000, state: 'indeterminate', reason: 'found-in-composer' });

    recordSendAttempt(INSTANCE, { state: 'not-sent', reason: 'prompt-not-ready', content: 'x' }, 3_000);
    markLastSendDiscarded(INSTANCE, 4_000);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ at: 3_000, state: 'not-sent' });
  });
});
