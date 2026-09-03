/**
 * Issue #2250 — what `extractResponse` saves for a Command Code turn.
 *
 * Four things have to hold at once, and three of them are regressions this
 * repository has already paid for on another tool:
 *
 *  1. a finished turn is saved, **including a short one that quotes a version
 *     string** (#2247 — the claude branch that swallowed such a reply is
 *     deliberately not reproduced for this tool);
 *  2. the launch screen is NOT saved as the agent's first reply (#1897's shape:
 *     no user echo on the pane means no turn has happened);
 *  3. a permission dialog is reported as a prompt, not as a finished turn —
 *     Command Code draws its highlighted option as `❯ 1. Yes` and keeps a rule
 *     above it, so the `hasPrompt && hasSeparator && !isThinking` rule alone
 *     answers "complete" for a dialog that is still waiting;
 *  4. the composer block never reaches the saved body (#1289 / #1268).
 *
 * The frames are `tests/fixtures/command-code-live-2250` — see its README for
 * provenance and for the measurements the assertions below rest on.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Built inside vi.hoisted() rather than from tests/helpers/logger-mock:
// `@/lib/logger` is pulled in transitively by `cli-patterns` while the hoisted
// vi.mock factory runs, so a plain `const` above the factory would still be in
// the temporal dead zone (same reason as the #2247 suite next door).
const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

// ---------------------------------------------------------------------------
// Module boundary mocks — the seams the #2247 suite cuts, trimmed to what
// `extractResponse` touches. Nothing here is under test.
// ---------------------------------------------------------------------------

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn(),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', name: 'wt-1' })),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {}),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

import { extractResponse } from '@/lib/polling/response-checker';
import { stripAnsi, findCommandCodeChromeStart } from '@/lib/detection/cli-patterns';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/command-code-live-2250');

const frame = (name: string): string =>
  fs.readFileSync(path.join(FIXTURE_DIR, `${name}.txt`), 'utf-8');

/** `extractResponse` as the poller calls it: whole pane, no prior cursor. */
const extract = (name: string) => extractResponse(frame(name), 0, 'command-code', 1000);

/** The body the poller would hand to `chat_messages.content`, ANSI stripped. */
const savedBody = (name: string): string | null => {
  const result = extract(name);
  if (!result?.isComplete) return null;
  return stripAnsi(result.response).trim();
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Issue #2250: a finished turn is saved', () => {
  it('saves a short reply that quotes a version string (#2247 does not recur here)', () => {
    // The exact shape that lost a turn on claude on 2026-09-02: a reply well
    // under 2000 characters whose text contains `v<major>.<minor>`. Command Code
    // prints `# Command Code v1.40.1` on every launch, so a banner rule written
    // around a bare version number would swallow this turn on the FIRST reply
    // rather than eventually.
    const body = savedBody('turn-version');

    expect(body).toBe('⠶ released v1.40.1');
    expect(body!.length).toBeLessThan(2000);
    expect(body).toMatch(/v\d+\.\d+/);
  });

  it('saves a turn whose reply follows a tool block, keeping the block', () => {
    const body = savedBody('turn-tool-write');

    expect(body).toContain('WRITE  [probe.txt]');
    expect(body).toContain('└  Created probe.txt (1 line)');
    // The file preview uses `│`, the glyph #2247 had to stop treating as banner
    // art. There is no `^\s*│` skip rule for this tool, on purpose.
    expect(body).toContain('1 │ hello');
    expect(body).toContain('⠶ Done.');
  });

  it('drops the banner, the reasoning summary and the turn summary from the body', () => {
    const body = savedBody('turn-version')!;

    expect(body).not.toContain('# Command Code v1.40.1');
    expect(body).not.toContain('# models:');
    expect(body).not.toContain('✻ Thought for');
    expect(body).not.toContain('✻ Worked for');
    // ...all of which really are on the frame, so the assertions above are not
    // vacuous.
    const pane = stripAnsi(frame('turn-version'));
    expect(pane).toContain('# Command Code v1.40.1');
    expect(pane).toContain('✻ Thought for 1 second');
    expect(pane).toContain('✻ Worked for 2s');
  });

  it('stops the body at the composer block', () => {
    const body = savedBody('turn-tool-write')!;

    expect(body).not.toContain('Ask your question');
    expect(body).not.toContain('? for shortcuts');
    expect(body).not.toMatch(/^─{10,}$/m);
    // The boundary the exclusion rests on.
    expect(findCommandCodeChromeStart(frame('turn-tool-write').split('\n'))).toBeGreaterThan(0);
  });

  it('extracts only the NEWEST turn from a pane that holds two', () => {
    // `turn-tool-write.txt` still carries turn 1's echo and its `⠶ released
    // v1.40.1` reply. Anchoring on the newest echo is what keeps the older reply
    // out of the new message.
    const pane = stripAnsi(frame('turn-tool-write'));
    expect(pane).toContain('⠶ released v1.40.1');
    expect(savedBody('turn-tool-write')).not.toContain('released v1.40.1');
  });
});

describe('Issue #2250: the launch screen is not a reply', () => {
  it('refuses the boot frame even though it is a complete, idle pane', () => {
    // Composer drawn between its two rules, footer painted, nothing running —
    // every completion condition is satisfied. What is missing is a turn.
    const result = extract('boot-idle');

    expect(result?.isComplete).toBe(false);
  });

  it('says so in the log rather than dropping the frame in silence', () => {
    // #2247's other half: the claude branch swallowed turns without logging, so
    // a lost turn was indistinguishable from an idle session.
    extract('boot-idle');

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Command Code launch screen suppressed, response not saved',
      expect.objectContaining({ responseLength: expect.any(Number) }),
    );
  });

  it('bases the refusal on the missing echo, not on banner wording', () => {
    // The rule is one positive condition. Proof that it is the ECHO and not the
    // banner text: give the same launch screen an echo and a reply, and the
    // frame is saved — with the banner still on it, unchanged.
    const lines = frame('boot-idle').split('\n');
    const chrome = findCommandCodeChromeStart(lines);
    const withTurn = [
      ...lines.slice(0, chrome),
      '❯ say hi',
      '',
      '⠶ hi',
      '',
      ...lines.slice(chrome),
    ].join('\n');

    const result = extractResponse(withTurn, 0, 'command-code', 1000);

    expect(result?.isComplete).toBe(true);
    expect(stripAnsi(result!.response).trim()).toBe('⠶ hi');
    expect(stripAnsi(withTurn)).toContain('# Command Code v1.40.1');
  });
});

describe('Issue #2250: a permission dialog is a prompt, not a finished turn', () => {
  it.each(['dialog-create-file', 'dialog-shell-command'] as const)(
    '%s is reported with its prompt detection attached',
    (name) => {
      const result = extract(name);

      expect(result?.promptDetection?.isPrompt).toBe(true);
      expect(result?.promptDetection?.promptData?.type).toBe('multiple_choice');
    },
  );

  it('would otherwise be read as complete, which is why the early check exists', () => {
    // The three conditions of the completion rule, measured on the dialog frame:
    // the highlighted option supplies `hasPrompt`, the rule above the dialog
    // supplies `hasSeparator`, and nothing is generating.
    const tail = stripAnsi(frame('dialog-create-file')).split('\n');
    const lastContent = tail.reduce((acc, line, i) => (line.trim() ? i : acc), 0);
    const window = tail.slice(Math.max(0, lastContent + 1 - 20), lastContent + 1).join('\n');

    expect(/^❯(\s*$|\s+\S)/m.test(window)).toBe(true);
    expect(/^─{10,}$/m.test(window)).toBe(true);
  });
});

describe('Issue #2250: a turn in flight is not saved', () => {
  it('reports the thinking frame as incomplete even though the composer is drawn', () => {
    const result = extract('turn-thinking');

    expect(result?.isComplete).toBe(false);
    expect(stripAnsi(frame('turn-thinking'))).toContain('❯ Ask your question...');
  });
});
