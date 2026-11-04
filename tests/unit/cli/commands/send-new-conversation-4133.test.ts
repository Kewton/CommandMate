/**
 * `send --new-conversation` and the help's account of a 4xx (Issue #4133).
 *
 * The API takes `newConversation` from anyone and ignores it where it does not apply,
 * so the CLI is what refuses: everything here that stops, stops with exit 2 and with
 * nothing created, saved, armed or sent.
 *
 * Positive controls: all of the first describe fails on the code before this Issue.
 * Negative control: a send without the flag makes no new request and has no new field.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** A worktree whose default is `defaultTool`, and whose `opencode` is running or not. */
function mockServer({ defaultTool = 'opencode', running = false as unknown, startingSince = undefined as unknown, outputStatus = 200 } = {}): Call[] {
  const calls: Call[] = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);
    if (!url.includes('/api/capabilities')) {
      calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    }
    let status = 200;
    let data: unknown = {};
    if (url.includes('/api/capabilities')) {
      data = { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] };
    } else if (url.includes('/resolve-target')) {
      const instance = parsed.searchParams.get('instanceId') ?? parsed.searchParams.get('instance');
      const tool = parsed.searchParams.get('cliTool') ?? parsed.searchParams.get('cliToolId');
      const cliToolId = instance?.startsWith('opencode-v2') ? 'opencode-v2' : instance?.startsWith('opencode') ? 'opencode' : tool ?? defaultTool;
      data = { cliToolId, instanceId: instance ?? cliToolId, resolvedBy: 'server', conflict: null };
    } else if (url.includes('/current-output')) {
      status = outputStatus;
      data = status === 200 ? { isRunning: running, ...(startingSince === undefined ? {} : { startingSince }) } : { error: 'failed' };
    } else if (url.includes('/tasks')) {
      status = 201;
      data = { task: { id: 'task-1' }, message: 'contract goal' };
    } else if (url.endsWith('/send')) {
      status = 201;
      data = { id: 'm1', role: 'user', content: 'hi' };
    }
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }) as unknown as typeof fetch;
  return calls;
}

class ExitSignal extends Error {}

async function run(argv: string[]): Promise<number | undefined> {
  const { createSendCommand } = await import('../../../../src/cli/commands/send');
  let code: number | undefined;
  mockExit.mockImplementation(((value?: number) => {
    if (code === undefined) code = value ?? 0;
    throw new ExitSignal();
  }) as never);
  try {
    await createSendCommand().parseAsync(['node', 'send', ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    mockExit.mockImplementation((() => {}) as never);
  }
  return code;
}

const stderr = (): string => mockConsoleError.mock.calls.flat().join('\n');
const sendsOf = (calls: Call[]): Call[] => calls.filter((c) => c.url.endsWith('/send'));
/** Anything that changes something: reads are all this may have done. */
const writesOf = (calls: Call[]): Call[] => calls.filter((c) => c.method !== 'GET');

describe('send --new-conversation', () => {
  it('stopped OpenCode V1: the field goes, naming the tool and instance it checked', async () => {
    const calls = mockServer();
    expect(await run(['wt', 'hello', '--agent', 'opencode', '--new-conversation'])).toBeUndefined();
    expect(sendsOf(calls)[0].body).toMatchObject({ content: 'hello', cliToolId: 'opencode', instanceId: 'opencode', newConversation: true });
  });

  it('a second V1 instance is asked about by its own id', async () => {
    const calls = mockServer();
    expect(await run(['wt', 'hello', '--instance', 'opencode-2', '--new-conversation'])).toBeUndefined();
    const read = new URL(calls.find((c) => c.url.includes('/current-output'))!.url);
    expect(read.searchParams.get('cliTool')).toBe('opencode');
    expect(read.searchParams.get('instance')).toBe('opencode-2');
    expect(sendsOf(calls)[0].body).toMatchObject({ instanceId: 'opencode-2', newConversation: true });
  });

  it('no target named: the default it read is what it names from then on', async () => {
    const calls = mockServer({ defaultTool: 'opencode' });
    expect(await run(['wt', 'hello', '--new-conversation'])).toBeUndefined();
    expect(sendsOf(calls)[0].body).toMatchObject({ cliToolId: 'opencode', instanceId: 'opencode', newConversation: true });
  });

  it('with --contract, stopped: the task is created, and the field goes', async () => {
    const calls = mockServer();
    expect(await run(['wt', '--contract', '.commandmate/tasks/x.yaml', '--agent', 'opencode', '--new-conversation'])).toBeUndefined();
    expect(sendsOf(calls)[0].body).toMatchObject({ content: 'contract goal', newConversation: true });
  });

  it.each([
    ['another tool, named', ['--agent', 'codex']],
    ['OpenCode V2', ['--agent', 'opencode-v2']],
    ['a V2 instance', ['--instance', 'opencode-v2-2']],
  ])('%s: exit 2, nothing sent', async (_label, flags) => {
    const calls = mockServer();
    expect(await run(['wt', 'hello', ...flags, '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
    expect(stderr()).toContain('--new-conversation');
    expect(calls.some((c) => c.url.includes('/current-output'))).toBe(false);
  });

  it('a default that is another tool: exit 2, nothing sent', async () => {
    const calls = mockServer({ defaultTool: 'claude' });
    expect(await run(['wt', 'hello', '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
  });

  it('running at the check: exit 2, nothing sent, and how to stop it', async () => {
    const calls = mockServer({ running: true });
    expect(await run(['wt', 'hello', '--agent', 'opencode', '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
    expect(stderr()).toContain('commandmate instances wt kill opencode');
  });

  it('running, with --contract and --auto-yes: no task and no grant', async () => {
    const calls = mockServer({ running: true });
    expect(await run(['wt', '--contract', '.commandmate/tasks/x.yaml', '--agent', 'opencode', '--auto-yes', '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
  });

  // current-output answers isRunning:false with a number here while the launch is under way.
  it('still starting, isRunning false: exit 2, nothing sent, and says it is starting', async () => {
    const calls = mockServer({ running: false, startingSince: 1_700_000_000_000 });
    expect(await run(['wt', 'hello', '--agent', 'opencode', '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
    expect(stderr()).toContain('opencode is still starting');
    expect(stderr()).toContain('commandmate instances wt kill opencode');
  });

  it('still starting, with --contract and --auto-yes: no task and no grant', async () => {
    const calls = mockServer({ running: false, startingSince: 1_700_000_000_000 });
    expect(await run(['wt', '--contract', '.commandmate/tasks/x.yaml', '--agent', 'opencode', '--auto-yes', '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
  });

  it('startingSince null, isRunning false: stopped, so the field goes (negative control)', async () => {
    const calls = mockServer({ running: false, startingSince: null });
    expect(await run(['wt', 'hello', '--agent', 'opencode', '--new-conversation'])).toBeUndefined();
    expect(sendsOf(calls)[0].body).toMatchObject({ newConversation: true });
  });

  it('an answer that does not say: exit 2, not "not running"', async () => {
    const calls = mockServer({ running: 'unknown' });
    expect(await run(['wt', 'hello', '--agent', 'opencode', '--new-conversation'])).toBe(ExitCode.CONFIG_ERROR);
    expect(writesOf(calls)).toEqual([]);
  });

  it('a check that fails sends nothing, with the failure it was', async () => {
    const calls = mockServer({ outputStatus: 500 });
    expect(await run(['wt', 'hello', '--agent', 'opencode', '--new-conversation'])).toBeDefined();
    expect(writesOf(calls)).toEqual([]);
  });

  it('without the flag: no check, no field (negative control)', async () => {
    const calls = mockServer({ running: true });
    expect(await run(['wt', 'hello', '--agent', 'opencode'])).toBeUndefined();
    expect(calls.some((c) => c.url.includes('/current-output'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/resolve-target'))).toBe(false);
    expect(sendsOf(calls)[0].body).not.toHaveProperty('newConversation');
  });
});

describe('what send --help says', () => {
  let help: string;

  beforeEach(async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    let text = '';
    cmd.configureOutput({ writeOut: (chunk) => { text += chunk; } });
    cmd.outputHelp();
    help = text.replace(/\s+/g, ' ');
  });

  it('limits "a 4xx saved nothing" to the save requests, not /send (#4133)', () => {
    expect(help).not.toContain('A 4xx saved nothing.');
    expect(help).toContain('A 4xx to that request saved nothing.');
    expect(help).toContain('its own 400 or 409 can come after the save');
  });

  it('names --new-conversation and what stops it', () => {
    expect(help).toContain('--new-conversation');
    expect(help).toContain('OpenCode V1');
  });
});
