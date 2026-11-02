/**
 * Issue #4048 — the receipt's lookups after #4035: the known limit kept as it
 * is (item 3), the body fingerprint tied to one attempt and cleared by the
 * agent's report (item 4), and the explicit target (item 5).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPromptSubmitReceipts,
  findSubmittedBody,
  getPromptSubmitTarget,
  matchesSubmittedBody,
  notePromptSubmitHook,
  notePromptSubmitSession,
  noteSubmittedBody,
  readPromptSubmitReceipt,
  reportsPrompts,
} from '@/lib/session/prompt-submit-receipt';
import {
  clearSendAttempts,
  getLastSendAttempt,
  markLastSendDiscarded,
  recordSendAttempt,
  sendMessageDigest,
} from '@/lib/session/send-attempt-state';

const WT = 'wt-4048';
const TARGET = { worktreeId: WT, cliToolId: 'claude' as const };
const SESSION = 'mcbd-claude-wt-4048';
const INSTANCE = { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' };

beforeEach(() => {
  clearPromptSubmitReceipts();
  clearSendAttempts();
});

describe('[#4048 3] known limit: no hook by the first read-back means the screen decides (characterization)', () => {
  it('answers not-required before SessionStart, and only a later read sees the wait', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    // The first read-back after an Enter at 2_000: no hook from the process yet.
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('not-required');
    // A SessionStart that is only late arrives after that read; the send has
    // already returned on the screen's verdict. Asked again, it would wait.
    notePromptSubmitHook(TARGET, 'session_start', 2_100);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('awaited');
  });

  it('answers not-required for a session this server did not start (adopted after a restart)', () => {
    notePromptSubmitHook(TARGET, 'session_start', 1_500);
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000)).toBe('not-required');
  });
});

describe('[#4048 4] the remembered body', () => {
  it('carries the attempt\'s own digest (the one lastSend records)', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    noteSubmittedBody(SESSION, 'hello  world');
    expect(findSubmittedBody(SESSION, 'hello world')).toEqual({ messageDigest: sendMessageDigest('hello  world') });
  });

  it('is forgotten when the agent reports a prompt; other hooks keep it', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    noteSubmittedBody(SESSION, 'hello');
    notePromptSubmitHook(TARGET, 'session_start', 1_500);
    expect(matchesSubmittedBody(SESSION, 'hello')).toBe(true);
    notePromptSubmitHook(TARGET, 'user_prompt_submit', 2_000);
    expect(matchesSubmittedBody(SESSION, 'hello')).toBe(false);
  });

  it('positive: a body sharing the 64-character beginning matches the fingerprint but demotes only its own attempt', () => {
    const preface = '契約: '.padEnd(70, 'あ');
    const x = `${preface} X の本文`;
    const y = `${preface} Y の本文`;
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    noteSubmittedBody(SESSION, x);
    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: y }, 1_500);

    const found = findSubmittedBody(SESSION, preface);
    expect(found).not.toBeNull();
    markLastSendDiscarded(INSTANCE, 2_000, found?.messageDigest);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ at: 1_500, state: 'sent', reason: 'submitted' });

    recordSendAttempt(INSTANCE, { state: 'sent', reason: 'submitted', content: x }, 3_000);
    markLastSendDiscarded(INSTANCE, 4_000, found?.messageDigest);
    expect(getLastSendAttempt(INSTANCE)).toMatchObject({ at: 4_000, state: 'indeterminate', reason: 'found-in-composer' });
  });

  it('only claude\'s prompt hook is trusted (and so only claude\'s record is rewritten)', () => {
    expect(reportsPrompts('claude')).toBe(true);
    for (const tool of ['codex', 'copilot', 'gemini', 'opencode', 'vibe-local', 'antigravity'] as const) {
      expect(reportsPrompts(tool)).toBe(false);
    }
  });
});

describe('[#4048 5] an explicit target names the same entry as the session name, or none', () => {
  const OTHER = { worktreeId: WT, cliToolId: 'claude' as const, instanceId: 'claude-2' };

  it('negative: the primary omitted and named are the same entry', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    notePromptSubmitHook(TARGET, 'session_start', 1_500);
    for (const expected of [undefined, { worktreeId: WT }, { worktreeId: WT, instanceId: 'claude' }]) {
      expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, expected)).toBe('awaited');
    }
    expect(getPromptSubmitTarget(SESSION, { worktreeId: WT, cliToolId: 'claude' })).toMatchObject(TARGET);
  });

  it('positive: another instance\'s entry under the name is not the target\'s', () => {
    notePromptSubmitSession(SESSION, OTHER, 1_000);
    notePromptSubmitHook(OTHER, 'user_prompt_submit', 2_500);
    noteSubmittedBody(SESSION, 'hello');

    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: WT })).toBe('not-required');
    expect(getPromptSubmitTarget(SESSION, { worktreeId: WT, cliToolId: 'claude' })).toBeNull();
    expect(findSubmittedBody(SESSION, 'hello', { worktreeId: WT, cliToolId: 'claude' })).toBeNull();
    expect(findSubmittedBody(SESSION, 'hello', { ...OTHER })).not.toBeNull();
  });

  it('positive: the instance moved to another name — the old name no longer resolves for it', () => {
    notePromptSubmitSession(SESSION, TARGET, 1_000);
    notePromptSubmitSession('mcbd-claude-renamed', TARGET, 2_000);
    notePromptSubmitHook(TARGET, 'session_start', 2_500);

    expect(readPromptSubmitReceipt(SESSION, 'claude', 3_000, { worktreeId: WT })).toBe('not-required');
    expect(readPromptSubmitReceipt('mcbd-claude-renamed', 'claude', 3_000, { worktreeId: WT })).toBe('awaited');
  });

  it('negative: looking with a target registers nothing and resets nothing', () => {
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: WT })).toBe('not-required');
    noteSubmittedBody(SESSION, 'hello', { worktreeId: WT, cliToolId: 'claude' });
    expect(getPromptSubmitTarget(SESSION)).toBeNull();

    notePromptSubmitSession(SESSION, TARGET, 1_000);
    notePromptSubmitHook(TARGET, 'user_prompt_submit', 1_500);
    readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: WT });
    noteSubmittedBody(SESSION, 'hello', { worktreeId: WT, cliToolId: 'claude' });
    // Still the same generation: its first prompt stays reported.
    expect(readPromptSubmitReceipt(SESSION, 'claude', 2_000, { worktreeId: WT })).toBe('not-required');
    expect(readPromptSubmitReceipt(SESSION, 'claude', 1_200)).toBe('received');
  });
});
