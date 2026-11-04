/**
 * Issue #4149: `send --register` without a role writes the roster after the message
 * has gone out. A conflict there is not "nothing sent": exit 31 says that, and a script
 * reading it would send the message a second time.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSendCommand } from '../../../../src/cli/commands/send';

const WT = 'wt1';
type Row = { id: string; cliTool: string; alias: string; order: number };

interface Server {
  /** The bodies the send endpoint took. */
  sends: unknown[];
  patches: unknown[];
  autoYes: string[];
  roster: Row[];
  /** Other writers landing right before a save. */
  interruptions: number;
  sendStatus: number;
  /** Set to answer every roster save with this instead. */
  saveRefusal: { status: number; body: Record<string, unknown> } | null;
}

function fakeServer(overrides: Partial<Server> = {}): Server {
  const state: Server = {
    sends: [],
    patches: [],
    autoYes: [],
    roster: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    interruptions: 99,
    sendStatus: 201,
    saveRefusal: null,
    ...overrides,
  };
  let revision = 1;
  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      redirected: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/capabilities')) {
      return respond(200, { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] });
    }
    if (url.includes('/resolve-target')) {
      const instanceId = new URL(url).searchParams.get('instance') ?? 'codex-2';
      return respond(200, { cliToolId: instanceId.split('-')[0], instanceId, resolvedBy: 'explicit', conflict: null });
    }
    if (url.includes('/auto-yes') && method === 'POST') {
      state.autoYes.push(String(init?.body));
      return respond(200, {});
    }
    if (url.endsWith('/send') && method === 'POST') {
      state.sends.push(JSON.parse(String(init?.body)));
      return state.sendStatus === 201 ? respond(201, { id: 1 }) : respond(state.sendStatus, { error: 'refused' });
    }
    if (url.endsWith(`/api/worktrees/${WT}`) && method === 'PATCH') {
      state.patches.push(JSON.parse(String(init?.body)));
      if (state.saveRefusal) return respond(state.saveRefusal.status, state.saveRefusal.body);
      const body = JSON.parse(String(init?.body)) as { agentInstances: Row[]; expectedRosterRevision?: string };
      if (state.interruptions > 0) {
        state.interruptions -= 1;
        revision += 1;
      }
      if (body.expectedRosterRevision !== `rev-${revision}`) {
        return respond(409, { error: 'The roster changed since it was read', code: 'ROSTER_CHANGED' });
      }
      revision += 1;
      state.roster = body.agentInstances;
      return respond(200, { success: true });
    }
    if (url.endsWith(`/api/worktrees/${WT}`)) {
      return respond(200, { id: WT, agentInstances: state.roster, rosterRevision: `rev-${revision}` });
    }
    return respond(200, {});
  }) as unknown as typeof fetch;
  return state;
}

describe('[#4149] send --register, when the roster refuses after the message went out', () => {
  const realFetch = global.fetch;
  let errors: string[];
  let stdout: string[];

  beforeEach(() => {
    errors = [];
    stdout = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errors.push(String(line)));
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void stdout.push(String(line)));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const sendAs = (agent: string, instance: string, ...args: string[]): Promise<unknown> =>
    createSendCommand()
      .parseAsync(['node', 'send', WT, 'hello', '--agent', agent, '--instance', instance, '--register', ...args])
      .then(() => null)
      .catch((error: unknown) => error);
  const send = (...args: string[]): Promise<unknown> => sendAs('codex', 'codex-2', ...args);

  it('the roster keeps moving: sent once, exit 0, and a warning with the command that registers only', async () => {
    const server = fakeServer();

    const outcome = await send();

    expect(outcome).toBeNull();
    expect(process.exit).not.toHaveBeenCalled();
    expect(server.sends).toHaveLength(1);
    expect(server.patches).toHaveLength(3);
    const text = errors.join('\n');
    expect(text).toContain('Message sent.');
    expect(text).toMatch(/^Warning: .*codex-2/m);
    expect(text).toMatch(/do not send it again/i);
    expect(text).toContain(`commandmate instances ${WT} add --agent codex --id codex-2`);
    // The sentence for a command with nothing done yet says the opposite of this.
    expect(text).not.toContain('Run the command again');
    expect(text).not.toContain('Instance registered in roster');
    expect(server.roster.map((row) => row.id)).toEqual(['claude']);
  });

  it('stdout stays what a registered send leaves there', async () => {
    fakeServer({ interruptions: 0 });
    await send();
    const registered = [...stdout];
    stdout.length = 0;

    fakeServer();
    await send();

    expect(stdout).toEqual(registered);
  });

  it('what comes after the register still happens: --auto-yes with --model is armed', async () => {
    const server = fakeServer();

    const outcome = await sendAs('claude', 'claude-2', '--auto-yes', '--model', 'opus');

    expect(outcome).toBeNull();
    expect(server.sends).toHaveLength(1);
    expect(server.autoYes).toHaveLength(1);
  });

  it('the command it names registers only: nothing more goes to the send endpoint', async () => {
    const server = fakeServer();
    await send();
    server.interruptions = 0;

    const { createInstancesCommand } = await import('../../../../src/cli/commands/instances');
    await createInstancesCommand().parseAsync(['node', 'instances', WT, 'add', '--agent', 'codex', '--id', 'codex-2']);

    expect(server.sends).toHaveLength(1);
    expect(server.roster.map((row) => row.id)).toEqual(['claude', 'codex-2']);
  });

  it('control: within the retries it registers, with no warning', async () => {
    const server = fakeServer({ interruptions: 2 });

    expect(await send()).toBeNull();

    expect(server.sends).toHaveLength(1);
    expect(server.roster.map((row) => row.id)).toEqual(['claude', 'codex-2']);
    expect(errors.join('\n')).toContain('Instance registered in roster: codex-2');
    expect(errors.join('\n')).not.toContain('Warning');
  });

  it('control: a send that fails is what it was, and nothing is written to the roster', async () => {
    const server = fakeServer({ sendStatus: 500 });

    const outcome = (await send()) as Error;

    expect(outcome.message).toBe('exit:99');
    expect(server.patches).toHaveLength(0);
    expect(errors.join('\n')).not.toContain('Message sent.');
  });

  it('the help keeps the two orders apart', () => {
    // --register --role writes first: a conflict there is exit 31 with nothing sent, which
    // tests/integration/cli-roles-4116.test.ts drives end to end.
    let help = '';
    const command = createSendCommand();
    command.configureOutput({ writeOut: (text) => void (help += text) });
    command.outputHelp();
    expect(help).toMatch(/A changed roster is exit 31, nothing sent\./);
    expect(help).toMatch(/sent, then registered/);
    expect(help).toMatch(/warning and exit 0/);
  });

  it('control: another refusal of the save is not a conflict, and keeps its exit code', async () => {
    const server = fakeServer({ saveRefusal: { status: 500, body: { error: 'boom' } } });

    const outcome = (await send()) as Error;

    expect(outcome.message).toBe('exit:99');
    expect(server.sends).toHaveLength(1);
    expect(errors.join('\n')).not.toContain('do not send it again');
  });
});
