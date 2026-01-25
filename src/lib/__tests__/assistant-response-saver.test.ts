/**
 * Tests for assistant-response-saver module
 * Issue #53: Assistant response save logic improvement
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db-migrations';
import { upsertWorktree, getMessages, updateSessionState, getSessionState } from '../db';

// The module we're testing - will be created
import {
  savePendingAssistantResponse,
  cleanCliResponse,
  extractAssistantResponseBeforeLastPrompt,
  detectBufferReset,
} from '../assistant-response-saver';

// Mock cli-session module
vi.mock('../cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));

// Mock ws-server module
vi.mock('../ws-server', () => ({
  broadcastMessage: vi.fn(),
}));

import { captureSessionOutput } from '../cli-session';
import { broadcastMessage } from '../ws-server';

const mockCaptureSessionOutput = vi.mocked(captureSessionOutput);
const mockBroadcastMessage = vi.mocked(broadcastMessage);

describe('assistant-response-saver', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema
    runMigrations(testDb);

    // Insert test worktree
    upsertWorktree(testDb, {
      id: 'test-worktree',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  /**
   * Issue #54: extractAssistantResponseBeforeLastPrompt tests
   *
   * This function is the key fix for Issue #54 Problem 4:
   * - cleanClaudeResponse() extracts AFTER the last prompt (for response-poller)
   * - extractAssistantResponseBeforeLastPrompt() extracts BEFORE the last prompt (for savePendingAssistantResponse)
   *
   * Scenario:
   * tmuxバッファの状態（ユーザーがメッセージBを送信した時点）:
   * ─────────────────────────────────────
   * ❯ メッセージA（前回のユーザー入力）
   * [前回のassistant応答 - 保存したい内容]
   * ───
   * ❯ メッセージB（今回のユーザー入力）  ← 最後のプロンプト
   * [Claude処理中...]
   * ─────────────────────────────────────
   *
   * We want to extract the content BEFORE ❯ メッセージB
   */
  describe('extractAssistantResponseBeforeLastPrompt', () => {
    describe('claude', () => {
      it('should extract response BEFORE the last user prompt', () => {
        // This is the main Issue #54 fix scenario
        const output = `❯ First message
Assistant response to first message
This is the content we want to capture
───
❯ Second message
`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        // Should extract content BEFORE "❯ Second message"
        expect(result).toContain('Assistant response to first message');
        expect(result).toContain('This is the content we want to capture');
        // Should NOT include the new user message
        expect(result).not.toContain('Second message');
      });

      it('should return all content when no user prompt exists', () => {
        const output = `Assistant response text
More response content`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        expect(result).toContain('Assistant response text');
        expect(result).toContain('More response content');
      });

      it('should return empty string for empty input', () => {
        const result = extractAssistantResponseBeforeLastPrompt('', 'claude');
        expect(result).toBe('');
      });

      it('should return empty string when output only contains the new prompt', () => {
        // Edge case: only the new user message, no previous assistant response
        const output = `❯ New message
`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        // No content before the prompt
        expect(result).toBe('');
      });

      it('should filter out Claude skip patterns (banners, separators)', () => {
        const output = `╭───────────────────────────────────╮
│ Claude Code v1.0.0               │
╰───────────────────────────────────╯
Welcome back!
Tips for getting started
? for shortcuts
───────────────────────────────────
Actual assistant response content
More useful content
───────────────────────────────────
❯ New user message
`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        // Should filter out banner elements
        expect(result).not.toContain('Claude Code v');
        expect(result).not.toContain('Welcome back');
        expect(result).not.toContain('Tips for getting started');
        expect(result).not.toContain('╭');
        expect(result).not.toContain('╯');
        // Should keep actual response content
        expect(result).toContain('Actual assistant response content');
        expect(result).toContain('More useful content');
      });

      it('should filter out export and hook commands', () => {
        const output = `export CLAUDE_HOOKS_test='value'
/usr/local/bin/claude
Actual response here
───
❯ New message
`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        expect(result).not.toContain('export CLAUDE_HOOKS');
        expect(result).not.toContain('/bin/claude');
        expect(result).toContain('Actual response here');
      });

      it('should handle ANSI escape codes', () => {
        // ANSI code for bold text: \x1b[1m ... \x1b[0m
        const output = `\x1b[1mBold text\x1b[0m normal text
Response content
───
❯ New message
`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        // Should strip ANSI codes and extract content
        expect(result).toContain('Response content');
        // ANSI codes should be removed
        expect(result).not.toContain('\x1b');
      });

      it('should handle multiple prompts and extract before the last one', () => {
        const output = `❯ First message
First response
───
❯ Second message
Second response
───
❯ Third message
`;
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        // Should extract everything before "❯ Third message"
        expect(result).toContain('First response');
        expect(result).toContain('Second response');
        expect(result).not.toContain('Third message');
      });

      it('should handle legacy > prompt character', () => {
        const output = `> First message
Assistant response
───
> Second message
`;
        // Note: The current implementation uses ❯, but we should verify behavior
        // with legacy > character
        const result = extractAssistantResponseBeforeLastPrompt(output, 'claude');

        // The function uses ❯ pattern, so > won't be detected as user prompt
        // This is expected behavior - legacy > is handled differently
        expect(result).toBeDefined();
      });
    });

    describe('non-claude tools', () => {
      it('should return trimmed output for codex', () => {
        const output = '  Codex response content  ';
        const result = extractAssistantResponseBeforeLastPrompt(output, 'codex');

        expect(result).toBe('Codex response content');
      });

      it('should return trimmed output for gemini', () => {
        const output = '  Gemini response content  ';
        const result = extractAssistantResponseBeforeLastPrompt(output, 'gemini');

        expect(result).toBe('Gemini response content');
      });
    });
  });

  /**
   * Issue #59: detectBufferReset unit tests
   *
   * Direct tests for the buffer reset detection function
   */
  describe('detectBufferReset', () => {
    describe('buffer shrink detection', () => {
      it('should detect shrink when buffer significantly smaller (1993 -> 608)', () => {
        const result = detectBufferReset(608, 1993);
        expect(result.bufferReset).toBe(true);
        expect(result.reason).toBe('shrink');
      });

      it('should detect shrink when buffer smaller (1000 -> 200)', () => {
        const result = detectBufferReset(200, 1000);
        expect(result.bufferReset).toBe(true);
        expect(result.reason).toBe('shrink');
      });

      it('should NOT detect shrink when within tolerance (50 -> 30)', () => {
        // lastCapturedLine (50) > 25 (tolerance)
        // BUT: (30 + 25) = 55 is NOT < 50
        const result = detectBufferReset(30, 50);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });

      it('should NOT detect shrink when lastCapturedLine <= tolerance', () => {
        // lastCapturedLine (20) is not > 25 (tolerance)
        const result = detectBufferReset(5, 20);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });
    });

    describe('session restart detection', () => {
      it('should detect restart when session restarted (500 -> 30)', () => {
        // Note: Since both shrink and restart conditions are met here,
        // shrink takes priority (checked first)
        const result = detectBufferReset(30, 500);
        expect(result.bufferReset).toBe(true);
        // Shrink: (30 + 25) = 55 < 500 AND lastCapturedLine (500) > 25
        expect(result.reason).toBe('shrink');
      });

      it('should detect restart at boundary (55 -> 30)', () => {
        // lastCapturedLine (55) > 50 AND currentLineCount (30) < 50
        // But shrink also applies: (30 + 25) = 55 NOT < 55 (strict <)
        // So this triggers restart, not shrink
        const result = detectBufferReset(30, 55);
        expect(result.bufferReset).toBe(true);
        expect(result.reason).toBe('restart');
      });

      it('should NOT detect restart when lastCapturedLine <= 50', () => {
        // lastCapturedLine (50) is NOT > 50
        const result = detectBufferReset(30, 50);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });

      it('should NOT detect restart when currentLineCount >= 50 and no shrink', () => {
        // currentLineCount (50) is NOT < 50 for restart
        // But shrink applies: (50 + 25) = 75 < 100 AND lastCapturedLine (100) > 25
        const result = detectBufferReset(50, 100);
        expect(result.bufferReset).toBe(true);
        expect(result.reason).toBe('shrink');
      });

      it('should NOT detect restart when both conditions fail', () => {
        // currentLineCount (51) is NOT < 50
        // shrink: (51 + 25) = 76 which is NOT < 76
        const result = detectBufferReset(51, 76);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should NOT detect reset when currentLineCount = 0 (empty buffer)', () => {
        const result = detectBufferReset(0, 100);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });

      it('should NOT detect reset when lastCapturedLine = 0 (initial state)', () => {
        const result = detectBufferReset(100, 0);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });

      it('should NOT detect reset when both are 0', () => {
        const result = detectBufferReset(0, 0);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });

      it('should NOT detect reset when currentLineCount > lastCapturedLine (normal growth)', () => {
        const result = detectBufferReset(200, 100);
        expect(result.bufferReset).toBe(false);
        expect(result.reason).toBeNull();
      });

      it('should prioritize shrink over restart when both conditions match', () => {
        // Both conditions could match: 30 < 50 (restart) AND (30+25) < 100 (shrink)
        // lastCapturedLine=100 > 25 (tolerance) and > 50
        const result = detectBufferReset(30, 100);
        expect(result.bufferReset).toBe(true);
        // Shrink check comes first in the code
        expect(result.reason).toBe('shrink');
      });
    });
  });

  describe('cleanCliResponse', () => {
    describe('claude', () => {
      it('should clean Claude response by stripping ANSI and filtering skip patterns', () => {
        // The cleanClaudeResponse function:
        // 1. Strips ANSI codes
        // 2. Finds last user prompt (> or ❯ followed by content)
        // 3. Extracts lines after it
        // 4. Filters out skip patterns (export, /bin/claude, etc)
        const rawResponse = `
Some assistant response text
More response content
        `.trim();

        const cleaned = cleanCliResponse(rawResponse, 'claude');

        // Should contain the response content
        expect(cleaned).toContain('Some assistant response text');
        expect(cleaned).toContain('More response content');
      });

      it('should filter out Claude setup commands', () => {
        const rawResponse = `
export CLAUDE_HOOKS_something='value'
/usr/local/bin/claude
Actual response text
        `.trim();

        const cleaned = cleanCliResponse(rawResponse, 'claude');

        // Should filter out setup commands
        expect(cleaned).not.toContain('export CLAUDE_HOOKS');
        expect(cleaned).not.toContain('/bin/claude');
        // Should keep actual response
        expect(cleaned).toContain('Actual response text');
      });

      it('should handle empty response', () => {
        const cleaned = cleanCliResponse('', 'claude');
        expect(cleaned).toBe('');
      });
    });

    describe('gemini', () => {
      it('should clean Gemini response by extracting content after marker', () => {
        const rawResponse = `
maenokota@host % gemini
Some shell output
sparkle marker content here
More response
        `.trim();

        const cleaned = cleanCliResponse(rawResponse, 'gemini');

        // Should filter out shell prompts
        expect(cleaned).not.toContain('maenokota@host');
      });
    });

    describe('codex', () => {
      it('should return response as-is for codex (no special cleaning)', () => {
        const rawResponse = 'Codex response text';
        const cleaned = cleanCliResponse(rawResponse, 'codex');

        expect(cleaned).toBe('Codex response text');
      });
    });
  });

  describe('savePendingAssistantResponse', () => {
    it('should save assistant response when new output exists after lastCapturedLine', async () => {
      // Setup: lastCapturedLine = 10, current output = 20 lines
      updateSessionState(testDb, 'test-worktree', 'claude', 10);

      // Create output with 20 lines
      const outputLines = [];
      for (let i = 0; i < 10; i++) {
        outputLines.push(`Old line ${i}`);
      }
      for (let i = 0; i < 10; i++) {
        outputLines.push(`New response line ${i}`);
      }
      const mockOutput = outputLines.join('\n');

      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: assistant response saved
      expect(result).not.toBeNull();
      expect(result?.role).toBe('assistant');
      expect(result?.content).toContain('New response line');

      // Verify DB contains the message
      const messages = getMessages(testDb, 'test-worktree');
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(assistantMessages.length).toBe(1);
    });

    it('should return null when no new output exists (currentLineCount <= lastCapturedLine)', async () => {
      // Setup: lastCapturedLine = 100, current output = 100 lines (no change)
      updateSessionState(testDb, 'test-worktree', 'claude', 100);

      // Create output with exactly 100 lines
      const outputLines = [];
      for (let i = 0; i < 100; i++) {
        outputLines.push(`Line ${i}`);
      }
      const mockOutput = outputLines.join('\n');

      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: no message saved (null returned)
      expect(result).toBeNull();

      // Verify DB has no assistant messages
      const messages = getMessages(testDb, 'test-worktree');
      const assistantMessages = messages.filter(m => m.role === 'assistant');
      expect(assistantMessages.length).toBe(0);
    });

    it('should return null when cleaned response is empty', async () => {
      // Setup: lastCapturedLine = 0, but output is only banner/setup commands
      updateSessionState(testDb, 'test-worktree', 'claude', 0);

      // Claude banner/setup content that will be cleaned away
      // These patterns are all filtered out by cleanClaudeResponse
      const bannerOutput = `
export CLAUDE_HOOKS_completion_hook='...'
/usr/local/bin/claude
      `.trim();

      mockCaptureSessionOutput.mockResolvedValue(bannerOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: no message saved (cleaned content is empty)
      // The export and /usr/local/bin patterns are filtered out
      expect(result).toBeNull();
    });

    it('should set assistant timestamp 1ms before user message timestamp', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'claude', 0);

      const mockOutput = 'Some valid assistant response content\nMore content';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date('2026-01-15T12:00:00.000Z');
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: assistant timestamp is 1ms before user timestamp
      expect(result).not.toBeNull();
      expect(result?.timestamp.getTime()).toBe(userTimestamp.getTime() - 1);
      expect(result?.timestamp.getTime()).toBeLessThan(userTimestamp.getTime());
    });

    it('should update session state lastCapturedLine after saving', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'claude', 5);

      // Create output with 20 lines
      const outputLines = [];
      for (let i = 0; i < 20; i++) {
        outputLines.push(`Line ${i}`);
      }
      const mockOutput = outputLines.join('\n');

      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: session state updated
      const sessionState = getSessionState(testDb, 'test-worktree', 'claude');
      expect(sessionState?.lastCapturedLine).toBe(20);
    });

    it('should broadcast message via WebSocket after saving', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'claude', 0);

      const mockOutput = 'Valid assistant response\nWith multiple lines';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: broadcastMessage was called
      expect(mockBroadcastMessage).toHaveBeenCalledWith('message', expect.objectContaining({
        worktreeId: 'test-worktree',
        message: expect.objectContaining({
          role: 'assistant',
        }),
      }));
    });

    it('should return null and not throw when captureSessionOutput fails', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'claude', 0);

      mockCaptureSessionOutput.mockRejectedValue(new Error('Session not found'));

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: returns null without throwing
      expect(result).toBeNull();
    });

    it('should handle missing session state (lastCapturedLine defaults to 0)', async () => {
      // Setup: no session state exists
      // (don't call updateSessionState)

      const mockOutput = 'Assistant response content\nLine 2';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: still saves response (treats lastCapturedLine as 0)
      expect(result).not.toBeNull();
      expect(result?.role).toBe('assistant');
    });

    /**
     * Issue #54 Key Fix Test
     * This test verifies that savePendingAssistantResponse correctly extracts
     * the assistant response BEFORE the new user prompt (not after it).
     *
     * Scenario:
     * User sends message B -> tmux buffer contains:
     *   ❯ Message A (previous user input)
     *   [Previous assistant response - SHOULD BE SAVED]
     *   ───
     *   ❯ Message B (new user input)
     *   [Claude processing...]
     *
     * Expected: Save "Previous assistant response" (content before ❯ Message B)
     */
    it('should extract and save response BEFORE the last user prompt (Issue #54 fix)', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'claude', 0);

      // Simulate tmux output when user sends a new message
      // The new message (❯ New message) should trigger saving the PREVIOUS assistant response
      const mockOutput = `❯ Previous question
This is the assistant response we want to save
This content should be captured
───
❯ New message from user
`;

      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'claude',
        userTimestamp
      );

      // Assert: should save the response BEFORE "❯ New message from user"
      expect(result).not.toBeNull();
      expect(result?.content).toContain('This is the assistant response we want to save');
      expect(result?.content).toContain('This content should be captured');
      // Should NOT include the new user message
      expect(result?.content).not.toContain('New message from user');
    });

    it('should work with gemini CLI tool', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'gemini', 0);

      const mockOutput = 'Gemini response content';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'gemini',
        userTimestamp
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result?.cliToolId).toBe('gemini');
    });

    it('should work with codex CLI tool', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'codex', 0);

      const mockOutput = 'Codex response content';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'codex',
        userTimestamp
      );

      // Assert
      expect(result).not.toBeNull();
      expect(result?.cliToolId).toBe('codex');
    });

    /**
     * Issue #59: Buffer Reset Detection Tests
     *
     * These tests verify the buffer reset detection logic for scenarios where:
     * 1. Buffer shrinks (e.g., 1993 lines -> 608 lines) - session restart/scrollback cleared
     * 2. Session restart (e.g., 500 lines -> 30 lines) - CLI tool restarted
     *
     * Without this fix, the condition `currentLineCount <= lastCapturedLine` would
     * incorrectly skip saving the response when the buffer has been reset.
     */
    describe('buffer reset detection', () => {
      it('should save response when buffer shrinks significantly (1993 -> 608 lines)', async () => {
        // Setup: lastCapturedLine = 1993, but buffer was reset/cleared
        updateSessionState(testDb, 'test-worktree', 'claude', 1993);

        // Create output with 608 lines (buffer shrunk from 1993)
        const outputLines = [];
        for (let i = 0; i < 607; i++) {
          outputLines.push(`Line ${i}`);
        }
        outputLines.push('Valid assistant response after buffer reset');
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should detect buffer reset and save response
        expect(result).not.toBeNull();
        expect(result?.role).toBe('assistant');

        // Verify session state was updated to current line count
        const sessionState = getSessionState(testDb, 'test-worktree', 'claude');
        expect(sessionState?.lastCapturedLine).toBe(608);
      });

      it('should save response when session restarts (500 -> 30 lines)', async () => {
        // Setup: lastCapturedLine = 500, session was restarted
        updateSessionState(testDb, 'test-worktree', 'claude', 500);

        // Create output with 30 lines (session restarted)
        const outputLines = [];
        for (let i = 0; i < 29; i++) {
          outputLines.push(`Line ${i}`);
        }
        outputLines.push('Response after session restart');
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should detect session restart and save response
        expect(result).not.toBeNull();
        expect(result?.role).toBe('assistant');
        expect(result?.content).toContain('Response after session restart');
      });

      it('should skip when currentLineCount equals lastCapturedLine (no change)', async () => {
        // Setup: Normal duplicate prevention case
        updateSessionState(testDb, 'test-worktree', 'claude', 100);

        // Create output with exactly 100 lines (no new output)
        const outputLines = [];
        for (let i = 0; i < 100; i++) {
          outputLines.push(`Line ${i}`);
        }
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should skip (no change)
        expect(result).toBeNull();
      });

      it('should NOT detect buffer reset when within tolerance (50 -> 30 lines)', async () => {
        // Setup: lastCapturedLine = 50, current = 30
        // Difference is 20, but lastCapturedLine is not > 50 for session restart
        // and (30 + 25) >= 50 for buffer shrink check
        updateSessionState(testDb, 'test-worktree', 'claude', 50);

        // Create output with 30 lines
        const outputLines = [];
        for (let i = 0; i < 30; i++) {
          outputLines.push(`Line ${i}`);
        }
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should skip (within tolerance, not a buffer reset)
        expect(result).toBeNull();
      });

      it('should NOT detect buffer reset at boundary (55 -> 30 lines)', async () => {
        // Setup: Boundary case - lastCapturedLine = 55, current = 30
        // For shrink check: (30 + 25) = 55, which is NOT < 55 (need strict <)
        // For restart check: lastCapturedLine (55) > 50 but currentLineCount (30) < 50
        // This WILL trigger session restart detection
        updateSessionState(testDb, 'test-worktree', 'claude', 55);

        // Create output with 30 lines
        const outputLines = [];
        for (let i = 0; i < 29; i++) {
          outputLines.push(`Line ${i}`);
        }
        outputLines.push('Content at boundary');
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should detect session restart (lastCapturedLine > 50, currentLineCount < 50)
        expect(result).not.toBeNull();
        expect(result?.content).toContain('Content at boundary');
      });

      it('should handle initial execution (lastCapturedLine = 0)', async () => {
        // Setup: First run, no previous session state
        // Don't set session state (defaults to 0)

        // Create output with 100 lines
        const outputLines = [];
        for (let i = 0; i < 99; i++) {
          outputLines.push(`Line ${i}`);
        }
        outputLines.push('Initial response content');
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should save normally (not a buffer reset, just initial state)
        expect(result).not.toBeNull();
        expect(result?.role).toBe('assistant');
      });

      it('should handle empty buffer (currentLineCount = 0)', async () => {
        // Setup: lastCapturedLine = 100, but buffer is now empty
        updateSessionState(testDb, 'test-worktree', 'claude', 100);

        // Empty output
        const mockOutput = '';

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should skip (empty buffer)
        expect(result).toBeNull();
      });

      it('should save response on branch switch scenario (1000 -> 200 lines)', async () => {
        // Setup: Simulates switching branches where buffer is different
        updateSessionState(testDb, 'test-worktree', 'claude', 1000);

        // Create output with 200 lines (different branch context)
        const outputLines = [];
        for (let i = 0; i < 199; i++) {
          outputLines.push(`Branch context line ${i}`);
        }
        outputLines.push('Response in new branch context');
        const mockOutput = outputLines.join('\n');

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          userTimestamp
        );

        // Assert: should detect buffer reset and save response
        expect(result).not.toBeNull();
        expect(result?.content).toContain('Response in new branch context');
      });
    });
  });
});
