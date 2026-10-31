/**
 * Issue #4031 (item 4, review P3-1): every tool that wraps the shared sender's
 * error (`Failed to send message to <tool>: …`) keeps it as `cause`, so a
 * failed `load-buffer` is still recorded `not-sent` / `paste-not-started`
 * after the wrap.
 *
 * Table-driven over the eight tools whose `sendMessage` wraps (claude's
 * `sendMessageToSession` does not wrap). The shared sender is stubbed to throw
 * the error `pasteBody` throws; the steps before it (session, readiness) are
 * stubbed on the instance. Dropping `{ cause: error }` from any one wrap fails
 * that tool's positive row.
 *
 * - positive: load-buffer failed → the wrap's cause is the sender's error,
 *   classified not-sent / paste-not-started
 * - negative: paste-buffer failed → indeterminate / send-error
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { senderMock } = vi.hoisted(() => ({ senderMock: vi.fn() }));
vi.mock('@/lib/cli-tools/submit-verified-sender', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cli-tools/submit-verified-sender')>()),
  sendMessageWithSubmitVerification: senderMock,
}));
vi.mock('@/lib/tmux/tmux-capture-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux/tmux-capture-cache')>()),
  invalidateCache: vi.fn(),
}));

import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { OpenCodeV2Tool } from '@/lib/cli-tools/opencode-v2';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { CodexTool } from '@/lib/cli-tools/codex';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { PASTE_NOT_STARTED_CODE } from '@/lib/session/send-attempt-types';

interface SendingTool {
  sendMessage(worktreeId: string, message: string, instanceId?: string): Promise<void>;
}

/** The steps before the shared sender, made to pass. */
function stubPreSend(tool: object): void {
  const t = tool as Record<string, unknown>;
  t.requireSession = vi.fn(async () => undefined);
  t.waitForPrompt = vi.fn(async () => ({ ready: true, output: '' }));
  t.waitForComposer = vi.fn(async () => undefined);
  t.trySendViaServer = vi.fn(async () => false);
}

const TOOLS: ReadonlyArray<readonly [string, () => SendingTool, string]> = [
  ['antigravity', () => new AntigravityTool(), 'Antigravity'],
  ['vibe-local', () => new VibeLocalTool(), 'Vibe Local'],
  ['opencode', () => new OpenCodeTool(), 'OpenCode'],
  ['gemini', () => new GeminiTool(), 'Gemini'],
  ['opencode-v2', () => new OpenCodeV2Tool(), 'OpenCode V2'],
  ['copilot', () => new CopilotTool(), 'Copilot'],
  ['codex', () => new CodexTool(), 'Codex'],
  ['command-code', () => new CommandCodeTool(), 'Command Code'],
];

/** The error `pasteBody` throws when `load-buffer` failed. */
function loadBufferFailure(): Error {
  return Object.assign(
    new Error('Failed to load message into tmux buffer: Command failed: tmux load-buffer -b cm-send-1-1 -'),
    { delivery: 'not-started' as const, code: PASTE_NOT_STARTED_CODE },
  );
}

/** The error `pasteBody` throws when `paste-buffer` failed. */
function pasteBufferFailure(): Error {
  return new Error('Failed to paste message into tmux session: Command failed: tmux paste-buffer -p -r -d');
}

async function failedSend(make: () => SendingTool, error: Error): Promise<Error> {
  senderMock.mockRejectedValueOnce(error);
  const tool = make();
  stubPreSend(tool);
  const thrown = await tool.sendMessage('wt-4031', 'x'.repeat(600)).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(senderMock).toHaveBeenCalled();
  if (thrown === null) throw new Error('sendMessage did not throw');
  return thrown;
}

afterEach(() => {
  senderMock.mockReset();
});

describe('[#4031] each tool keeps the sender error as cause', () => {
  it.each(TOOLS)('positive: %s — load-buffer failed is not-sent / paste-not-started', async (_id, make, label) => {
    const original = loadBufferFailure();
    const thrown = await failedSend(make, original);
    expect(thrown.message).toContain(`Failed to send message to ${label}: `);
    expect(thrown.cause).toBe(original);
    expect(classifySendFailure(thrown)).toEqual({ state: 'not-sent', reason: 'paste-not-started' });
  });

  it.each(TOOLS)('negative: %s — paste-buffer failed stays indeterminate / send-error', async (_id, make) => {
    const thrown = await failedSend(make, pasteBufferFailure());
    expect(classifySendFailure(thrown)).toEqual({ state: 'indeterminate', reason: 'send-error' });
  });
});
