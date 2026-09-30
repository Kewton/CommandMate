/**
 * A numbered list in a Claude / Codex reply, on live panes (Issue #2997).
 *
 * #2991 reported that the synthetic #2457 frames (`reply-numbered-list-repaint`,
 * `…-generating-repaint`) and the #2070 `codex-exited-01491` scrollback read as
 * `waiting` for claude / codex, and asked for a live check before opting them
 * into `requireVouchedPrompt`. The live panes in
 * `tests/fixtures/claude-idle-numbered-list-2457/live-2997/` (claude-cli
 * 2.1.284, codex-cli 0.157.1) are that check: an agent asked to reply with
 * `❯ 1. Yes / 2. No` (or codex's own `› 1. Yes, continue`) is `ready` once the
 * turn ends and `running` while it streams, never `waiting`, and the send guard
 * is open — so the flag stays off (see the README there).
 *
 * Pinned both ways:
 *   - negative: the live reply frames carry no prompt and the send is accepted;
 *   - positive: the live dialogs captured in the same sessions stay `waiting`,
 *     and codex's refuse the send from the scraper alone (#1708);
 *   - control: the same reply frame with its composer cut off — the shape the
 *     synthetic repaint frames have — IS read as a prompt, which is what makes
 *     the negative above say something about the composer rather than the list.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const isRunning = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({ getTool: () => ({ getSessionName: () => 'mcbd-test-session', isRunning: (...a: unknown[]) => isRunning(...a) }) }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({ captureSessionOutput: vi.fn() }));

import { captureSessionOutput } from '@/lib/session/cli-session';
import { isPromptWaiting } from '@/lib/session/prompt-waiting-guard';
import { clearAgentStopEvents } from '@/lib/session/agent-event-state';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import type { CLIToolType } from '@/lib/cli-tools/types';

const LIVE = join(__dirname, '../../../fixtures/claude-idle-numbered-list-2457/live-2997');
const WORKTREE_ID = 'wt-2997';

function live(file: string): string {
  return readFileSync(join(LIVE, file), 'utf8');
}

/** Reply frames whose turn has ended: the list is in the body, the composer is below it. */
const IDLE_REPLIES: ReadonlyArray<readonly [CLIToolType, string]> = [
  ['claude', 'claude-reply-numbered-list-21284.txt'],
  ['codex', 'codex-reply-numbered-list-01571.txt'],
  ['codex', 'codex-reply-dialog-glyph-01571.txt'],
];

/** The live dialogs of the same sessions, and the reason each is published with. */
const DIALOGS: ReadonlyArray<readonly [CLIToolType, string, string]> = [
  ['claude', 'claude-trust-dialog-21284.txt', 'claude_selection_list'],
  ['codex', 'codex-trust-dialog-01571.txt', 'prompt_detected'],
  ['codex', 'codex-update-dialog-01571.txt', 'prompt_detected'],
];

/**
 * The frame cut just above its composer: claude's opening rule (the composer
 * sits between two `─` rules, so the second-to-last one) or codex's last `› ` row.
 */
function withoutComposer(tool: 'claude' | 'codex', frame: string): string {
  const lines = frame.split('\n');
  const rows = lines.flatMap((line, i) => ((tool === 'claude' ? /^─{10,}$/ : /^› /).test(line) ? [i] : []));
  const cut = tool === 'claude' ? rows[rows.length - 2] : rows[rows.length - 1];
  return lines.slice(0, cut).join('\n') + '\n';
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
});

describe('[#2997] live replies that quote a numbered list', () => {
  it.each(IDLE_REPLIES)('%s %s is ready, with no prompt', (tool, file) => {
    const result = detectSessionStatus(live(file), tool);
    expect(result.status).toBe('ready');
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
  });

  it('claude mid-stream, with the list already on screen, is running', () => {
    const frame = live('claude-reply-numbered-list-generating-21284.txt');
    expect(frame).toContain('❯ 1. Yes');
    const result = detectSessionStatus(frame, 'claude');
    expect(result.status).toBe('running');
    expect(result.hasActivePrompt).toBe(false);
  });

  it.each(IDLE_REPLIES)('%s %s accepts the send', async (tool, file) => {
    vi.mocked(captureSessionOutput).mockResolvedValue(live(file));
    const verdict = await isPromptWaiting(WORKTREE_ID, tool, tool);
    expect(verdict.waiting).toBe(false);
  });
});

describe('[#2997] live dialogs of the same sessions', () => {
  it.each(DIALOGS)('%s %s stays waiting / %s', (tool, file, reason) => {
    const result = detectSessionStatus(live(file), tool);
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(reason);
  });

  it.each(DIALOGS.filter(([tool]) => tool === 'codex'))('%s %s refuses the send', async (tool, file) => {
    vi.mocked(captureSessionOutput).mockResolvedValue(live(file));
    const verdict = await isPromptWaiting(WORKTREE_ID, tool, tool);
    expect(verdict.waiting).toBe(true);
    expect(verdict.blockedBy).toBe('scraper');
  });
});

describe('[#2997] control: the composer is what keeps the list from reading as a prompt', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-2997-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(IDLE_REPLIES.filter(([, file]) => !file.includes('dialog-glyph')))(
    '%s %s without its composer reads as a prompt',
    (tool, file) => {
      const path = join(dir, file);
      writeFileSync(path, withoutComposer(tool as 'claude' | 'codex', live(file)));
      const result = detectSessionStatus(readFileSync(path, 'utf8'), tool);
      expect(result.status).toBe('waiting');
      expect(result.hasActivePrompt).toBe(true);
      expect(result.promptDetection.promptData?.type).toBe('multiple_choice');
    },
  );
});
