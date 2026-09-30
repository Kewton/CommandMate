/**
 * A numbered list in an OpenCode V2 reply is not a prompt (Issue #2991).
 *
 * The UAT frame (`tests/fixtures/opencode-v2-body-numbered-list-2991/`) is a
 * reply whose body is `Pick one:` / `❯ 1. Yes` / `  2. No`. The generic parser
 * reads it as `multiple_choice`, and before this Issue the status chain
 * published that as `waiting` / `prompt_detected` with `hasActivePrompt: true`
 * — so `isPromptWaiting` refused every send, while nothing on screen could be
 * answered. #2984 had already taught Auto-Yes (and #2457 History) that v2's own
 * dialog rules do not vouch for this frame; the status chain now asks the same
 * question through `evaluateDialogPresence`.
 *
 * Pinned both ways:
 *   - negative: the reply frames read `ready`, no prompt, and the send guard is open;
 *   - positive: v2's approval / question / palette still read `waiting` with the
 *     same reasons, a v2 approval the agent reported still refuses the send, and
 *     a real Claude dialog still refuses it from the scraper alone;
 *   - `legacy` tools keep reading the same list as a prompt, and the other
 *     `enforce` tools are not opted in (`requireVouchedPrompt`).
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
import { clearAgentStopEvents, reportPermissionRequestPending } from '@/lib/session/agent-event-state';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { getToolStatusDetector } from '@/lib/detection/tools/registry';
import { normalizeFrame } from '@/lib/detection/tools/frame';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { buildClaude1000RowPermissionFrame } from '../../fixtures/claude-1000-row-prompt';

const FIXTURES = join(__dirname, '../../fixtures');
const WORKTREE_ID = 'wt-2991';

function fixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

/** The reply frames: a `❯ 1. Yes / 2. No` list in the body, no dialog. */
const REPLY_FRAMES = [
  'opencode-v2-body-numbered-list-2991/uat-tc04-pane.txt',
  'opencode-v2-dialogs-2984/quoted-dialog-reply.txt',
] as const;

/** v2's own dialogs and the reason each has always been published with. */
const DIALOG_FRAMES: ReadonlyArray<readonly [string, string]> = [
  ['opencode-v2-dialogs-2984/permission.txt', 'opencode_permission_prompt'],
  ['opencode-v2-dialogs-2984/permission-after-digit.txt', 'opencode_permission_prompt'],
  ['opencode-v2-dialogs-2984/question.txt', 'opencode_selection_list'],
  ['opencode-v2-dialogs-2984/question-under-quoted-dialog.txt', 'opencode_selection_list'],
  ['opencode-v2-dialogs-2984/commands.txt', 'opencode_modal_overlay'],
];

beforeEach(() => {
  vi.clearAllMocks();
  clearAgentStopEvents();
  isRunning.mockResolvedValue(true);
});

describe('[#2991] status: a reply that quotes a numbered list', () => {
  it.each(REPLY_FRAMES)('%s was read as a prompt before (chain without the presence check)', (path) => {
    // The control: the same chain with no `isPromptVouched` is exactly the
    // pre-#2991 reading, and it IS the reported symptom.
    const before = getToolStatusDetector('opencode-v2').detect(normalizeFrame(fixture(path)));
    expect(before.status).toBe('waiting');
    expect(before.reason).toBe('prompt_detected');
    expect(before.hasActivePrompt).toBe(true);
  });

  it.each(REPLY_FRAMES)('%s is ready, with no prompt', (path) => {
    const result = detectSessionStatus(fixture(path), 'opencode-v2');
    expect(result.status).toBe('ready');
    expect(result.reason).not.toBe('prompt_detected');
    expect(result.hasActivePrompt).toBe(false);
    expect(result.promptDetection.isPrompt).toBe(false);
    expect(result.promptDetection.promptData).toBeUndefined();
  });
});

describe('[#2991] status: v2 dialogs are unchanged', () => {
  it.each(DIALOG_FRAMES)('%s stays waiting / %s', (path, reason) => {
    const result = detectSessionStatus(fixture(path), 'opencode-v2');
    expect(result.status).toBe('waiting');
    expect(result.reason).toBe(reason);
  });
});

describe('[#2991] status: legacy tools are not judged', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-2991-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each<CLIToolType>(['gemini', 'vibe-local', 'antigravity'])(
    '%s still reads the same list as a prompt',
    (tool) => {
      const path = join(dir, `${tool}.txt`);
      writeFileSync(path, ['Pick one:', '❯ 1. Yes', '  2. No', ''].join('\n'));
      const result = detectSessionStatus(readFileSync(path, 'utf8'), tool);
      expect(result.status).toBe('waiting');
      expect(result.reason).toBe('prompt_detected');
      expect(result.hasActivePrompt).toBe(true);
    },
  );
});

describe('[#2991] scope: only OpenCode V2 requires a vouched prompt', () => {
  it('opencode-v2 opts in', () => {
    expect(getToolStatusDetector('opencode-v2').requireVouchedPrompt).toBe(true);
  });

  // Their dialogs reach `waiting` through the generic parser itself, so the
  // same check would also judge their live dialogs; see the Issue's report.
  it.each<CLIToolType>(['claude', 'codex', 'copilot', 'opencode'])('%s does not', (tool) => {
    expect(getToolStatusDetector(tool).requireVouchedPrompt).toBeFalsy();
  });
});

describe('[#2991] send guard', () => {
  it.each(REPLY_FRAMES)('%s accepts the send', async (path) => {
    vi.mocked(captureSessionOutput).mockResolvedValue(fixture(path));
    const verdict = await isPromptWaiting(WORKTREE_ID, 'opencode-v2', 'opencode-v2');
    expect(verdict.waiting).toBe(false);
  });

  it('a v2 approval the agent reported still refuses the send', async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(fixture('opencode-v2-dialogs-2984/permission.txt'));
    reportPermissionRequestPending(WORKTREE_ID, 'opencode-v2', 'opencode-v2', 'edit', Date.now() - 1_000);

    const verdict = await isPromptWaiting(WORKTREE_ID, 'opencode-v2', 'opencode-v2');
    expect(verdict.waiting).toBe(true);
    expect(verdict.blockedBy).toBe('structured');
  });

  it("a real Claude dialog still refuses the send from the scraper alone", async () => {
    vi.mocked(captureSessionOutput).mockResolvedValue(buildClaude1000RowPermissionFrame());

    const verdict = await isPromptWaiting(WORKTREE_ID, 'claude', 'claude');
    expect(verdict.waiting).toBe(true);
    expect(verdict.blockedBy).toBe('scraper');
  });
});
