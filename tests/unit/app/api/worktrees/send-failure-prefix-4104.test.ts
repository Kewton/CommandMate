/**
 * Issue #4104: a failed send's error says `Failed to send message to` once.
 *
 * Eight tools wrap their own failure in that sentence and the route used to add
 * it again with `cliTool.name` — measured on opencode (`Failed to send message
 * to OpenCode: Failed to send message to OpenCode: …`). Four of them are named
 * differently on the two sides (`Codex CLI` / `Codex`), so comparing names would
 * miss them: each row below is the tool's real `name` and its real wrap.
 *
 * Controls:
 * - positive (each fails before #4104): every wrapped failure has the sentence
 *   once, with the tool's own wording and the `[send state: …]` kept.
 * - negative (unchanged): an unwrapped failure still gets `<tool name>:`, also
 *   when it merely mentions the sentence further along.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import type { ICLITool } from '@/lib/cli-tools/types';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import { CodexTool } from '@/lib/cli-tools/codex';
import { CommandCodeTool } from '@/lib/cli-tools/command-code';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import { GeminiTool } from '@/lib/cli-tools/gemini';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { OpenCodeV2Tool } from '@/lib/cli-tools/opencode-v2';
import { VibeLocalTool } from '@/lib/cli-tools/vibe-local';
import { answerSendFailure, type SendFailureInput } from '@/app/api/worktrees/[id]/send/send-failure';

const SENTENCE = 'Failed to send message to';

/** How often the sentence occurs in `text`. */
function occurrences(text: string): number {
  return text.split(SENTENCE).length - 1;
}

function inputFor(tool: Pick<ICLITool, 'name'>, overrides: Partial<SendFailureInput> = {}): SendFailureInput {
  return {
    cliTool: tool as ICLITool,
    worktreeId: 'wt-4104',
    instanceId: undefined,
    model: undefined,
    // Another instance than any send recorded: only `ownAttempt` can add a state.
    sendAttemptInstance: { worktreeId: 'wt-4104', cliToolId: 'codex', instanceId: 'codex-4104' },
    ownAttempt: null,
    sendStartedAt: Date.now(),
    trimmedContent: 'hello',
    ...overrides,
  } as SendFailureInput;
}

async function errorOf(error: string, input: SendFailureInput): Promise<string> {
  const response = await answerSendFailure({ stage: 'send', error }, input);
  expect(response.status).toBe(500);
  return ((await response.json()) as { error: string }).error;
}

describe('the route does not repeat a tool\'s own wrap (Issue #4104)', () => {
  // `wrap` is what the tool's sendMessage throws (`src/lib/cli-tools/<tool>.ts`).
  it.each([
    ['OpenCode (the same name)', new OpenCodeTool(), 'OpenCode'],
    ['OpenCode V2 (the same name)', new OpenCodeV2Tool(), 'OpenCode V2'],
    ['Vibe Local (the same name)', new VibeLocalTool(), 'Vibe Local'],
    ['Copilot (the same name)', new CopilotTool(), 'Copilot'],
    ['Codex (the route says `Codex CLI`)', new CodexTool(), 'Codex'],
    ['Gemini (the route says `Gemini CLI`)', new GeminiTool(), 'Gemini'],
    ['Antigravity (the route says `Antigravity CLI`)', new AntigravityTool(), 'Antigravity'],
    ['Command Code (the route says `Command Code CLI`)', new CommandCodeTool(), 'Command Code'],
  ])('positive: %s', async (_title, tool, wrap) => {
    const wrapped = `${SENTENCE} ${wrap}: boom`;
    expect(await errorOf(wrapped, inputFor(tool))).toBe(wrapped);
  });

  it('the rows above do cover both shapes: four names differ between route and tool', () => {
    expect(new CodexTool().name).toBe('Codex CLI');
    expect(new GeminiTool().name).toBe('Gemini CLI');
    expect(new AntigravityTool().name).toBe('Antigravity CLI');
    expect(new CommandCodeTool().name).toBe('Command Code CLI');
  });

  it('positive: the measured opencode refusal keeps its text and its send state, sentence once', async () => {
    const refusal =
      `${SENTENCE} OpenCode: OpenCode prompt not ready: a dialog or overlay (opencode_modal_overlay) ` +
      'stayed up for 2000ms before sending; nothing was typed (Issue #4084)';
    const error = await errorOf(
      refusal,
      inputFor(new OpenCodeTool(), { ownAttempt: { state: 'not-sent', reason: 'prompt-not-ready' } }),
    );
    expect(occurrences(error)).toBe(1);
    expect(error.startsWith(`${refusal} [send state: not-sent (prompt-not-ready)`)).toBe(true);
  });

  it('negative: an unwrapped failure still names the tool, with its send state', async () => {
    const error = await errorOf(
      'boom',
      inputFor(new CodexTool(), { ownAttempt: { state: 'not-sent', reason: 'send-failed' } }),
    );
    expect(error.startsWith(`${SENTENCE} Codex CLI: boom [send state: not-sent`)).toBe(true);
    expect(await errorOf('boom', inputFor(new CodexTool()))).toBe(`${SENTENCE} Codex CLI: boom`);
  });

  it('negative: claude does not wrap, so it keeps the route\'s sentence', async () => {
    expect(await errorOf('boom', inputFor({ name: 'Claude Code' }))).toBe(`${SENTENCE} Claude Code: boom`);
  });

  it('negative: the sentence further along is not a wrap', async () => {
    const quoted = `tmux said: ${SENTENCE} nowhere`;
    expect(await errorOf(quoted, inputFor(new CodexTool()))).toBe(`${SENTENCE} Codex CLI: ${quoted}`);
  });
});
