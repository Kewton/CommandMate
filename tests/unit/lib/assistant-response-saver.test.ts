/**
 * Tests for assistant-response-saver module
 * Issue #53: Assistant response save logic improvement
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getMessages, updateSessionState, getSessionState } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';

// The module we're testing - will be created
import {
  savePendingAssistantResponse,
  advanceCapturedLineForTranscriptTurn,
  cleanCliResponse,
  detectBufferReset,
} from '@/lib/assistant-response-saver';

// Issue #2437: advanceCapturedLineForTranscriptTurn is called from the Stop
// path, which has no `db` handle to pass — it resolves the singleton itself.
// Point that singleton at this file's in-memory database.
let dbForSingleton: Database.Database | null = null;
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => {
    if (!dbForSingleton) throw new Error('no test database bound');
    return dbForSingleton;
  },
}));

// Mock cli-session module
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));

// Mock ws-server module
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: vi.fn(),
}));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { broadcastMessage } from '@/lib/ws-server';

const mockCaptureSessionOutput = vi.mocked(captureSessionOutput);
const mockBroadcastMessage = vi.mocked(broadcastMessage);

describe('assistant-response-saver', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema
    runMigrations(testDb);
    dbForSingleton = testDb;

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
    dbForSingleton = null;
    testDb.close();
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

    /**
     * Issue #2437: the four tools that had no branch at all. `codex` had one
     * and it was `return output.trim()` under the comment "Codex doesn't need
     * special cleaning"; the other three fell through to the same line by
     * default. What that saved into History was the tool's idle composer.
     *
     * The frames here are one row each, so the assertion is about the BRANCH
     * existing. The measured pane frames those branches were written against
     * are in `./response-cleaner-scrollback-2437.test.ts`.
     */
    describe('scrollback tools (Issue #2437)', () => {
      it('drops codex chrome instead of returning the frame verbatim', () => {
        // The composer as codex draws it — bold `›`, dim placeholder (#2310) —
        // with the status bar underneath. This is the two-row shape the 10
        // bogus History rows on `commandagent-develop` were copies of.
        const idleComposer =
          '\x1b[1m\u203a\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n' +
          '\n' +
          '  \x1b[38;2;246;226;183mgpt-6-astra default\x1b[0m \u00b7 /repo';

        expect(cleanCliResponse(idleComposer, 'codex')).toBe('');
      });

      it('drops the command-code composer placeholder', () => {
        expect(cleanCliResponse('❯ Ask your question...', 'command-code')).toBe('');
      });

      it('drops the antigravity bare input prompt', () => {
        expect(cleanCliResponse('>', 'antigravity')).toBe('');
      });

      it('drops the vibe-local status bar', () => {
        expect(cleanCliResponse('✦ Ready    ESC: stop', 'vibe-local')).toBe('');
      });

      it('keeps ordinary prose for all four', () => {
        for (const cliToolId of ['codex', 'command-code', 'antigravity', 'vibe-local'] as const) {
          expect(cleanCliResponse('Here is the answer.', cliToolId)).toBe('Here is the answer.');
        }
      });
    });
  });

  describe('savePendingAssistantResponse', () => {
    it('should save assistant response when new output exists after lastCapturedLine', async () => {
      // Setup: lastCapturedLine = 10, current output = 20 lines
      updateSessionState(testDb, 'test-worktree', 'codex', 10);

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
        'codex',
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
      updateSessionState(testDb, 'test-worktree', 'codex', 100);

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
        'codex',
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
      // Setup: lastCapturedLine = 0, but output is only shell noise
      updateSessionState(testDb, 'test-worktree', 'gemini', 0);

      // Shell prompt / error lines that cleanGeminiResponse filters away entirely
      const noiseOutput = `
zsh: command not found: foo
zsh: no such file or directory
      `.trim();

      mockCaptureSessionOutput.mockResolvedValue(noiseOutput);

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'gemini',
        userTimestamp
      );

      // Assert: no message saved (cleaned content is empty)
      expect(result).toBeNull();
    });

    it('should set assistant timestamp 1ms before user message timestamp', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'codex', 0);

      const mockOutput = 'Some valid assistant response content\nMore content';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date('2026-01-15T12:00:00.000Z');
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'codex',
        userTimestamp
      );

      // Assert: assistant timestamp is 1ms before user timestamp
      expect(result).not.toBeNull();
      expect(result?.timestamp.getTime()).toBe(userTimestamp.getTime() - 1);
      expect(result?.timestamp.getTime()).toBeLessThan(userTimestamp.getTime());
    });

    it('should update session state lastCapturedLine after saving', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'codex', 5);

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
        'codex',
        userTimestamp
      );

      // Assert: session state updated
      const sessionState = getSessionState(testDb, 'test-worktree', 'codex');
      expect(sessionState?.lastCapturedLine).toBe(20);
    });

    it('should broadcast message via WebSocket after saving', async () => {
      // Setup
      updateSessionState(testDb, 'test-worktree', 'codex', 0);

      const mockOutput = 'Valid assistant response\nWith multiple lines';
      mockCaptureSessionOutput.mockResolvedValue(mockOutput);

      const userTimestamp = new Date();
      await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'codex',
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
      updateSessionState(testDb, 'test-worktree', 'codex', 0);

      mockCaptureSessionOutput.mockRejectedValue(new Error('Session not found'));

      const userTimestamp = new Date();
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'codex',
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
        'codex',
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
        updateSessionState(testDb, 'test-worktree', 'codex', 1993);

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
          'codex',
          userTimestamp
        );

        // Assert: should detect buffer reset and save response
        expect(result).not.toBeNull();
        expect(result?.role).toBe('assistant');

        // Verify session state was updated to current line count
        const sessionState = getSessionState(testDb, 'test-worktree', 'codex');
        expect(sessionState?.lastCapturedLine).toBe(608);
      });

      it('should save response when session restarts (500 -> 30 lines)', async () => {
        // Setup: lastCapturedLine = 500, session was restarted
        updateSessionState(testDb, 'test-worktree', 'codex', 500);

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
          'codex',
          userTimestamp
        );

        // Assert: should detect session restart and save response
        expect(result).not.toBeNull();
        expect(result?.role).toBe('assistant');
        expect(result?.content).toContain('Response after session restart');
      });

      it('should skip when currentLineCount equals lastCapturedLine (no change)', async () => {
        // Setup: Normal duplicate prevention case
        updateSessionState(testDb, 'test-worktree', 'codex', 100);

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
          'codex',
          userTimestamp
        );

        // Assert: should skip (no change)
        expect(result).toBeNull();
      });

      it('should NOT detect buffer reset when within tolerance (50 -> 30 lines)', async () => {
        // Setup: lastCapturedLine = 50, current = 30
        // Difference is 20, but lastCapturedLine is not > 50 for session restart
        // and (30 + 25) >= 50 for buffer shrink check
        updateSessionState(testDb, 'test-worktree', 'codex', 50);

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
          'codex',
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
        updateSessionState(testDb, 'test-worktree', 'codex', 55);

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
          'codex',
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
          'codex',
          userTimestamp
        );

        // Assert: should save normally (not a buffer reset, just initial state)
        expect(result).not.toBeNull();
        expect(result?.role).toBe('assistant');
      });

      it('should handle empty buffer (currentLineCount = 0)', async () => {
        // Setup: lastCapturedLine = 100, but buffer is now empty
        updateSessionState(testDb, 'test-worktree', 'codex', 100);

        // Empty output
        const mockOutput = '';

        mockCaptureSessionOutput.mockResolvedValue(mockOutput);

        const userTimestamp = new Date();
        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'codex',
          userTimestamp
        );

        // Assert: should skip (empty buffer)
        expect(result).toBeNull();
      });

      it('should save response on branch switch scenario (1000 -> 200 lines)', async () => {
        // Setup: Simulates switching branches where buffer is different
        updateSessionState(testDb, 'test-worktree', 'codex', 1000);

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
          'codex',
          userTimestamp
        );

        // Assert: should detect buffer reset and save response
        expect(result).not.toBeNull();
        expect(result?.content).toContain('Response in new branch context');
      });
    });

    /**
     * Issue #1292: alternate-screen tools are skipped entirely.
     *
     * This function reads the pane as a growing scrollback and treats
     * lastCapturedLine as a read cursor. Alternate-screen tools (claude since v2,
     * opencode, copilot) keep no scrollback: capture-pane always returns exactly
     * pane_height lines, so the cursor saturates after the first save and the
     * previous turns stay painted on screen.
     *
     * Measured against a real Claude session (pane_height=1000): the only message
     * this path ever produced was the startup banner, saved on the first send —
     * leaking model/plan, login expiry, MCP auth state and the local cwd into
     * History. The response poller records these tools' replies instead (#1268).
     */
    describe('alternate-screen CLI tools (Issue #1292)', () => {
      // Verbatim from a real Claude v2 session start (redacted paths aside).
      const CLAUDE_STARTUP_BANNER = [
        '▝▜█████▛▘  Opus 4.8 (1M context) with xhigh effort · Claude Max',
        '  ▘▘ ▝▝    ~/cm-verify/CommandMate',
        ' ⚠ 3 MCP servers need authentication · run /mcp',
        ' ⚠ Your login expires in 5 days · run /login to renew',
        '                                              ◉ xhigh · /effort',
      ].join('\n');

      it('should not save the Claude startup banner as an assistant message', async () => {
        mockCaptureSessionOutput.mockResolvedValue(CLAUDE_STARTUP_BANNER);

        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'claude',
          new Date()
        );

        expect(result).toBeNull();

        const assistantMessages = getMessages(testDb, 'test-worktree')
          .filter(m => m.role === 'assistant');
        expect(assistantMessages).toHaveLength(0);
        expect(mockBroadcastMessage).not.toHaveBeenCalled();
      });

      it('should keep private banner details out of history entirely', async () => {
        mockCaptureSessionOutput.mockResolvedValue(CLAUDE_STARTUP_BANNER);

        await savePendingAssistantResponse(testDb, 'test-worktree', 'claude', new Date());

        const history = getMessages(testDb, 'test-worktree').map(m => m.content).join('\n');
        for (const secret of [
          'Your login expires',
          'MCP servers need authentication',
          'Claude Max',
          '~/cm-verify/CommandMate',
          '/effort',
        ]) {
          expect(history).not.toContain(secret);
        }
      });

      it.each<CLIToolType>(['claude', 'opencode', 'copilot'])(
        'should skip %s before even capturing the pane',
        async (tool) => {
          const result = await savePendingAssistantResponse(
            testDb,
            'test-worktree',
            tool,
            new Date()
          );

          expect(result).toBeNull();
          // Proves the guard short-circuits ahead of any pane read, so no
          // screen content can reach the cleaners at all.
          expect(mockCaptureSessionOutput).not.toHaveBeenCalled();
        }
      );

      it('should still save for scrollback tools (guard is not a blanket disable)', async () => {
        mockCaptureSessionOutput.mockResolvedValue('Codex response content');

        const result = await savePendingAssistantResponse(
          testDb,
          'test-worktree',
          'codex',
          new Date()
        );

        expect(result).not.toBeNull();
        expect(mockCaptureSessionOutput).toHaveBeenCalled();
      });
    });
  });

  /**
   * Issue #2437, form 2: the pre-send flush re-saving a turn History already
   * holds as the agent's own Markdown.
   *
   * `savePendingAssistantResponse` saves EVERYTHING past `lastCapturedLine`.
   * The Stop path that writes the transcript row never moved that cursor
   * (`updateSessionState` call count in `hooks/sources/*` was zero), so a
   * `/send` landing between the transcript write and the next 2-second poll
   * tick saved the whole finished turn a second time — as the pane's scrape of
   * the very same words. No cleaner can see that: what is duplicated is the
   * real body, not chrome.
   */
  describe('advanceCapturedLineForTranscriptTurn (Issue #2437)', () => {
    /** A pane holding one finished turn, `count` rows tall. */
    function pane(count: number): string {
      const rows: string[] = [];
      for (let i = 0; i < count; i++) rows.push(`Turn body row ${i}`);
      return rows.join('\n');
    }

    it('parks the cursor at the pane height so the flush has nothing left to save', async () => {
      updateSessionState(testDb, 'test-worktree', 'codex', 10);
      mockCaptureSessionOutput.mockResolvedValue(pane(40));

      const advanced = await advanceCapturedLineForTranscriptTurn({
        worktreeId: 'test-worktree',
        cliToolId: 'codex',
      });

      expect(advanced).toBe(40);
      expect(getSessionState(testDb, 'test-worktree', 'codex')?.lastCapturedLine).toBe(40);

      // The `/send` that arrives before the next poll tick.
      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'codex',
        new Date()
      );

      expect(result).toBeNull();
      expect(getMessages(testDb, 'test-worktree').filter(m => m.role === 'assistant')).toHaveLength(0);
    });

    it('without it, that same `/send` saves the finished turn a second time', async () => {
      // The control for the test above: same pane, same cursor, transcript row
      // written — only the advance is missing. This is production before #2437,
      // and it is what keeps the assertion above from being vacuous.
      updateSessionState(testDb, 'test-worktree', 'codex', 10);
      mockCaptureSessionOutput.mockResolvedValue(pane(40));

      const result = await savePendingAssistantResponse(
        testDb,
        'test-worktree',
        'codex',
        new Date()
      );

      expect(result?.content).toContain('Turn body row 39');
    });

    it('trims the pane padding tmux adds below the transcript', async () => {
      // The cursor has to mean the same thing both writers mean by it, or the
      // poller's `lineCount <= lastCapturedLine` dedup can never fire again.
      updateSessionState(testDb, 'test-worktree', 'codex', 0);
      mockCaptureSessionOutput.mockResolvedValue(`${pane(12)}\n\n\n   \n`);

      await advanceCapturedLineForTranscriptTurn({
        worktreeId: 'test-worktree',
        cliToolId: 'codex',
      });

      expect(getSessionState(testDb, 'test-worktree', 'codex')?.lastCapturedLine).toBe(12);
    });

    it('never moves the cursor backwards', async () => {
      // A capture shorter than the stored value is a buffer reset, and
      // detectBufferReset owns that reading. Rewinding from here would hand the
      // flush a range it has already saved.
      updateSessionState(testDb, 'test-worktree', 'codex', 900);
      mockCaptureSessionOutput.mockResolvedValue(pane(40));

      const advanced = await advanceCapturedLineForTranscriptTurn({
        worktreeId: 'test-worktree',
        cliToolId: 'codex',
      });

      expect(advanced).toBeNull();
      expect(getSessionState(testDb, 'test-worktree', 'codex')?.lastCapturedLine).toBe(900);
    });

    it('keys the cursor on the instance, not on the tool', async () => {
      // Issue #868: session_states is (worktree_id, instance_id). A second codex
      // in the same worktree must not have its cursor moved by the first one.
      updateSessionState(testDb, 'test-worktree', 'codex', 5, 'codex-2');
      mockCaptureSessionOutput.mockResolvedValue(pane(30));

      await advanceCapturedLineForTranscriptTurn({
        worktreeId: 'test-worktree',
        cliToolId: 'codex',
        instanceId: 'codex-2',
      });

      expect(getSessionState(testDb, 'test-worktree', 'codex-2')?.lastCapturedLine).toBe(30);
      expect(getSessionState(testDb, 'test-worktree', 'codex')).toBeNull();
    });

    it('does nothing for alternate-screen tools', async () => {
      // Their line count is a screen-row constant, not a cursor (Issue #1268),
      // and savePendingAssistantResponse refuses to run for them at all — there
      // is no cursor here to advance and writing one would be a lie.
      updateSessionState(testDb, 'test-worktree', 'claude', 7);
      mockCaptureSessionOutput.mockResolvedValue(pane(1000));

      const advanced = await advanceCapturedLineForTranscriptTurn({
        worktreeId: 'test-worktree',
        cliToolId: 'claude',
      });

      expect(advanced).toBeNull();
      expect(mockCaptureSessionOutput).not.toHaveBeenCalled();
      expect(getSessionState(testDb, 'test-worktree', 'claude')?.lastCapturedLine).toBe(7);
    });

    it('returns null instead of throwing when the pane cannot be captured', async () => {
      // The transcript row is already written by the time this runs. A throw
      // here would cost that row; a null costs one duplicated reply.
      updateSessionState(testDb, 'test-worktree', 'codex', 3);
      mockCaptureSessionOutput.mockRejectedValue(new Error('session not found'));

      await expect(
        advanceCapturedLineForTranscriptTurn({ worktreeId: 'test-worktree', cliToolId: 'codex' })
      ).resolves.toBeNull();
      expect(getSessionState(testDb, 'test-worktree', 'codex')?.lastCapturedLine).toBe(3);
    });
  });

});
