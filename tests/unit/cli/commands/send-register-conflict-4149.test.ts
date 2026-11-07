/**
 * Issue #4149: `send --register` without a role writes the roster after the message
 * has gone out. A conflict there is not "nothing sent": exit 31 says that, and a script
 * reading it would send the message a second time.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSendCommand } from '../../../../src/cli/commands/send';

const WT = 'wt1';
/** Copilot defers the enable behind --model (Issue #576), so it comes after the register. */
const DEFERRED_ARGS = ['--auto-yes', '--model', 'gpt-5-mini'];
/** Sent, three saves that all conflict, then armed. */
const SENT_CONFLICT_ARMED = ['send', 'save', 'save', 'save', 'auto-yes'];
type Row = { id: string; cliTool: string; alias: string; order: number };

interface Server {
  /** The bodies the send endpoint took. */
  sends: unknown[];
  patches: unknown[];
  autoYes: string[];
  /** What reached the server, in order: `send`, `save` (a roster save), `auto-yes`. */
  order: string[];
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
    order: [],
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
      state.order.push('auto-yes');
      return respond(200, {});
    }
    if (url.endsWith('/send') && method === 'POST') {
      state.sends.push(JSON.parse(String(init?.body)));
      state.order.push('send');
      return state.sendStatus === 201 ? respond(201, { id: 1 }) : respond(state.sendStatus, { error: 'refused' });
    }
    if (url.endsWith(`/api/worktrees/${WT}`) && method === 'PATCH') {
      state.patches.push(JSON.parse(String(init?.body)));
      state.order.push('save');
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

  it('what comes after the register still happens: copilot with --model arms Auto-Yes after the conflict', async () => {
    const server = fakeServer();

    const outcome = await sendAs('copilot', 'copilot-2', ...DEFERRED_ARGS);

    expect(outcome).toBeNull();
    expect(process.exit).not.toHaveBeenCalled();
    expect(server.order).toEqual(SENT_CONFLICT_ARMED);
    expect(errors.join('\n')).toMatch(/^Warning: .*copilot-2/m);
  });

  it('control: Claude arms before the send, which is why it cannot show what comes after the register', async () => {
    const server = fakeServer();

    expect(await sendAs('claude', 'claude-2', '--auto-yes', '--model', 'opus')).toBeNull();

    expect(server.order).toEqual(['auto-yes', 'send', 'save', 'save', 'save']);
  });

  describe('positive control: the same run against send.ts with a step taken out', () => {
    const SEND_DIR = path.resolve(process.cwd(), 'src/cli/commands');
    const SEND_SOURCE = fs.readFileSync(path.join(SEND_DIR, 'send.ts'), 'utf-8');
    const dirs: string[] = [];

    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    /** The command from a copy of send.ts under the temp directory; the real file is only read. */
    async function commandWithout(step: RegExp): Promise<typeof createSendCommand> {
      expect(SEND_SOURCE).toMatch(step);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-mutant-4163-'));
      dirs.push(dir);
      fs.symlinkSync(path.resolve(process.cwd(), 'node_modules'), path.join(dir, 'node_modules'));
      const copy = SEND_SOURCE
        .replace(step, '')
        .replace(/from '(\.\.?\/[^']+)'/g, (_all, relative: string) => `from '${path.resolve(SEND_DIR, relative)}'`);
      const file = path.join(dir, 'send-mutant.ts');
      fs.writeFileSync(file, copy);
      const mutant = (await import(/* @vite-ignore */ file)) as { createSendCommand: typeof createSendCommand };
      return mutant.createSendCommand;
    }

    const orderWith = async (create: typeof createSendCommand): Promise<string[]> => {
      const server = fakeServer();
      await create().parseAsync(['node', 'send', WT, 'hello', '--agent', 'copilot', '--instance', 'copilot-2', '--register', ...DEFERRED_ARGS]);
      return server.order;
    };

    it('with the enable after the send removed, nothing is armed', async () => {
      const create = await commandWithout(/if \(applyAutoYesAfterSend\) \{[\s\S]*?\n {8}\}\n/);
      expect(await orderWith(create)).toEqual(['send', 'save', 'save', 'save']);
    });

    it('with the register removed, there is no conflict to get past', async () => {
      const create = await commandWithout(/if \(options\.register && instanceId && roleAssignment === undefined\) \{[\s\S]*?\n {8}\}\n/);
      expect(await orderWith(create)).toEqual(['send', 'auto-yes']);
    });

    it('negative: the copy with nothing taken out runs as the real command does', async () => {
      const create = await commandWithout(/\/\/ Issue #1000: register the ad-hoc instance into the roster after the\n/);
      expect(await orderWith(create)).toEqual(SENT_CONFLICT_ARMED);
    });
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

  it('[#4159] another refusal of the save is not a conflict, and is a warning all the same: exit 0', async () => {
    const server = fakeServer({ saveRefusal: { status: 500, body: { error: 'boom' } } });

    const outcome = await send();

    expect(outcome).toBeNull();
    expect(process.exit).not.toHaveBeenCalled();
    expect(server.sends).toHaveLength(1);
    expect(errors.join('\n')).toMatch(/^Warning: .*codex-2/m);
    expect(errors.join('\n')).toMatch(/do not send it again/i);
  });
});
