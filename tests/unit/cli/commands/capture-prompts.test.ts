/**
 * capture --prompts Tests (Issue #1685)
 *
 * The prompt audit listing reads resolved prompts from chat history via
 * GET /messages?messageType=prompt, so a prompt Auto-Yes already cleared from
 * the screen (never surfaced by wait exit 10, promptData already null in
 * capture --json) remains retrievable after the fact.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const samplePromptMessages = [
  {
    id: 'msg-1',
    worktreeId: 'wt1',
    role: 'assistant',
    content: 'Allow tool use?',
    timestamp: '2026-08-04T10:00:00.000Z',
    messageType: 'prompt',
    promptData: {
      type: 'yes_no',
      question: 'Allow tool use?',
      options: ['yes', 'no'],
      status: 'answered',
      answer: 'yes',
      answeredAt: '2026-08-04T10:00:02.000Z',
      answeredBy: 'auto',
    },
    cliToolId: 'claude',
    instanceId: 'claude',
    archived: false,
  },
  {
    id: 'msg-2',
    worktreeId: 'wt1',
    role: 'assistant',
    content: 'Pick a plan',
    timestamp: '2026-08-04T11:00:00.000Z',
    messageType: 'prompt',
    promptData: {
      type: 'multiple_choice',
      question: 'Pick a plan',
      options: [
        { number: 1, label: 'Plan A', isDefault: true },
        { number: 2, label: 'Plan B' },
      ],
      status: 'pending',
    },
    cliToolId: 'claude',
    instanceId: 'claude-2',
    archived: false,
  },
];

async function runCapture(args: string[]): Promise<void> {
  const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
  const cmd = createCaptureCommand();
  await cmd.parseAsync(['node', 'capture', ...args]);
}

describe('capture --prompts request shape', () => {
  it('requests messages with messageType=prompt and the default limit', async () => {
    mockFetchResponse(samplePromptMessages);
    await runCapture(['wt1', '--prompts']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/messages?'),
      expect.any(Object)
    );
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('messageType=prompt');
    expect(url).toContain('limit=20');
  });

  it('passes --limit, --agent and --instance through as query params', async () => {
    mockFetchResponse([]);
    await runCapture(['wt1', '--prompts', '--limit', '5', '--agent', 'codex', '--instance', 'codex-2']);

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('limit=5');
    expect(url).toContain('cliTool=codex');
    expect(url).toContain('instance=codex-2');
  });
});

describe('capture --prompts output', () => {
  it('emits the audit fields as JSON with --json', async () => {
    mockFetchResponse(samplePromptMessages);
    await runCapture(['wt1', '--prompts', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(output.worktreeId).toBe('wt1');
    expect(output.count).toBe(2);
    expect(output.prompts[0]).toMatchObject({
      id: 'msg-1',
      type: 'yes_no',
      question: 'Allow tool use?',
      status: 'answered',
      answer: 'yes',
      answeredBy: 'auto',
      instanceId: 'claude',
    });
    expect(output.prompts[1]).toMatchObject({
      type: 'multiple_choice',
      status: 'pending',
      answer: null,
      answeredBy: null,
    });
    expect(output.prompts[1].options).toHaveLength(2);
  });

  it('renders a readable text listing by default', async () => {
    mockFetchResponse(samplePromptMessages);
    await runCapture(['wt1', '--prompts']);

    const text = mockConsoleLog.mock.calls[0][0] as string;
    expect(text).toContain('[answered:auto]');
    expect(text).toContain('Q: Allow tool use?');
    expect(text).toContain('A: yes');
    expect(text).toContain('[pending]');
    expect(text).toContain('1) Plan A (default)');
  });

  it('says so when there is no prompt history', async () => {
    mockFetchResponse([]);
    await runCapture(['wt1', '--prompts']);
    expect(mockConsoleLog).toHaveBeenCalledWith('No prompt history.');
  });

  it('skips rows without promptData instead of rendering empty entries', async () => {
    mockFetchResponse([
      { ...samplePromptMessages[0], promptData: undefined },
      samplePromptMessages[1],
    ]);
    await runCapture(['wt1', '--prompts', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0] as string);
    expect(output.count).toBe(1);
    expect(output.prompts[0].id).toBe('msg-2');
  });
});

describe('capture --prompts flag validation', () => {
  it('rejects --prompts combined with --pane', async () => {
    mockFetchResponse([]);
    await runCapture(['wt1', '--prompts', '--pane']);
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: --prompts cannot be combined with --pane.');
  });

  it('rejects --limit without --prompts', async () => {
    mockFetchResponse([]);
    await runCapture(['wt1', '--limit', '5']);
    expect(mockExit).toHaveBeenCalledWith(2);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: --limit requires --prompts.');
  });

  it('rejects a non-integer --limit', async () => {
    mockFetchResponse([]);
    await runCapture(['wt1', '--prompts', '--limit', 'abc']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects a --limit above the server maximum', async () => {
    mockFetchResponse([]);
    await runCapture(['wt1', '--prompts', '--limit', '999999']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });
});
