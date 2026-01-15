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
import { savePendingAssistantResponse, cleanCliResponse } from '../assistant-response-saver';

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
  });
});
