/**
 * Tests for summary-prompt-builder.ts
 * Issue #607: Prompt construction and sanitization
 */

import { describe, it, expect } from 'vitest';
import { sanitizeMessage, buildSummaryPrompt, MAX_TOTAL_MESSAGE_LENGTH } from '@/lib/summary-prompt-builder';
import { MAX_MESSAGE_LENGTH } from '@/lib/session/claude-executor';
import type { ChatMessage } from '@/types/models';

function createMockMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    worktreeId: 'wt-1',
    role: 'user',
    content: 'Hello world',
    timestamp: new Date('2026-04-02T12:00:00'),
    messageType: 'normal',
    archived: false,
    ...overrides,
  };
}

describe('sanitizeMessage', () => {
  it('should preserve normal text', () => {
    expect(sanitizeMessage('Hello world')).toBe('Hello world');
  });

  it('should preserve tabs, newlines, and carriage returns', () => {
    const input = 'line1\n\tindented\r\nline3';
    expect(sanitizeMessage(input)).toBe(input);
  });

  it('should remove control characters', () => {
    const input = 'hello\x00\x01\x02\x03\x04\x05\x06\x07\x08world';
    expect(sanitizeMessage(input)).toBe('helloworld');
  });

  it('should remove vertical tab and form feed', () => {
    const input = 'hello\x0b\x0cworld';
    expect(sanitizeMessage(input)).toBe('helloworld');
  });

  it('should remove DEL character', () => {
    const input = 'hello\x7fworld';
    expect(sanitizeMessage(input)).toBe('helloworld');
  });

  it('should escape <user_data> tags', () => {
    const input = 'text <user_data> more text </user_data> end';
    const result = sanitizeMessage(input);
    expect(result).not.toContain('<user_data>');
    expect(result).not.toContain('</user_data>');
    expect(result).toContain('&lt;user_data&gt;');
    expect(result).toContain('&lt;/user_data&gt;');
  });

  it('should escape user_data tags case-insensitively', () => {
    const input = '<USER_DATA>test</USER_DATA>';
    const result = sanitizeMessage(input);
    expect(result).not.toContain('<USER_DATA>');
    expect(result).toContain('&lt;USER_DATA&gt;');
  });

  it('should truncate to MAX_MESSAGE_LENGTH', () => {
    const input = 'x'.repeat(MAX_MESSAGE_LENGTH + 100);
    const result = sanitizeMessage(input);
    expect(result.length).toBe(MAX_MESSAGE_LENGTH);
  });

  it('should apply processing in correct order: control chars -> escape -> truncate', () => {
    // Ensure control chars are removed before escape which is before truncate
    const input = '\x00<user_data>' + 'x'.repeat(MAX_MESSAGE_LENGTH);
    const result = sanitizeMessage(input);
    expect(result.length).toBe(MAX_MESSAGE_LENGTH);
    expect(result).not.toContain('\x00');
  });
});

describe('buildSummaryPrompt', () => {
  it('should include system prompt', () => {
    const messages = [createMockMessage()];
    const worktrees = new Map([['wt-1', 'feature/test']]);

    const result = buildSummaryPrompt(messages, worktrees);

    expect(result).toContain('technical report generator');
    expect(result).toContain('<user_data>');
    expect(result).toContain('</user_data>');
  });

  it('should group messages by worktree', () => {
    const messages = [
      createMockMessage({ id: 'msg-1', worktreeId: 'wt-1', content: 'msg from wt-1' }),
      createMockMessage({ id: 'msg-2', worktreeId: 'wt-2', content: 'msg from wt-2' }),
    ];
    const worktrees = new Map([['wt-1', 'feature/a'], ['wt-2', 'feature/b']]);

    const result = buildSummaryPrompt(messages, worktrees);

    expect(result).toContain('## Worktree: feature/a');
    expect(result).toContain('## Worktree: feature/b');
    expect(result).toContain('[user] msg from wt-1');
    expect(result).toContain('[user] msg from wt-2');
  });

  it('should use worktreeId as fallback when branch name not found', () => {
    const messages = [createMockMessage({ worktreeId: 'unknown-wt' })];
    const worktrees = new Map<string, string>();

    const result = buildSummaryPrompt(messages, worktrees);

    expect(result).toContain('## Worktree: unknown-wt');
  });

  it('should include role prefix in message lines', () => {
    const messages = [
      createMockMessage({ role: 'user', content: 'user question' }),
      createMockMessage({ id: 'msg-2', role: 'assistant', content: 'assistant answer' }),
    ];
    const worktrees = new Map([['wt-1', 'main']]);

    const result = buildSummaryPrompt(messages, worktrees);

    expect(result).toContain('[user] user question');
    expect(result).toContain('[assistant] assistant answer');
  });

  it('should add truncation note when message length exceeds limit', () => {
    // Create messages that exceed MAX_TOTAL_MESSAGE_LENGTH
    const longContent = 'x'.repeat(MAX_TOTAL_MESSAGE_LENGTH + 100);
    const messages = [createMockMessage({ content: longContent })];
    const worktrees = new Map([['wt-1', 'main']]);

    const result = buildSummaryPrompt(messages, worktrees);

    expect(result).toContain('omitted due to length limits');
  });

  it('should handle empty messages array', () => {
    const result = buildSummaryPrompt([], new Map());

    expect(result).toContain('technical report generator');
    expect(result).toContain('<user_data>');
  });

  it('should sanitize branch names', () => {
    const messages = [createMockMessage()];
    const worktrees = new Map([['wt-1', '<user_data>malicious']]);

    const result = buildSummaryPrompt(messages, worktrees);

    expect(result).not.toContain('## Worktree: <user_data>malicious');
  });
});
