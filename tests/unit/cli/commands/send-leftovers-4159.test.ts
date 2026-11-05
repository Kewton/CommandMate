/**
 * Issue #4159: what `send` leaves behind once the message has, or has not, gone in.
 *
 *  - A withdrawal goes by the grant's name, so a server that gives none is not asked to
 *    stop whatever is there.
 *  - `--auto-yes` with nothing else reads nothing first, so it cannot tell its own grant
 *    from one already on. It leaves it on, and says so.
 *  - `--register` without a role writes after the message went out: whatever fails there,
 *    the send has succeeded, and sending it again would deliver it twice.
 *  - So does the enable that comes after the message, for the same reason.
 *
 * The real grants and the moments between the requests are driven against the real route in
 * tests/integration/cli-roles-4116.test.ts. This fakes what no current route can answer.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSendCommand } from '../../../../src/cli/commands/send';

const WT = 'wt1';
const EXPIRES = 1_900_000_000_000;

interface Server {
  /** Named by the arming and every read of a live grant. Undefined: a server older than #4132. */
  grantId: string | undefined;
  autoYesReads: string[];
  autoYesPosts: { url: string; body: Record<string, unknown> }[];
  /** What reached the server, in order: `send`, `roster-read`, `auto-yes`. */
  order: string[];
  sends: number;
  sendAnswer: { status: number; body: Record<string, unknown> };
  /** What a read of the grant says once armed. */
  liveAfterArming: boolean;
  patches: number;
  /** Set to answer the roster read with this instead. */
  rosterRead: { status: number; body: Record<string, unknown> } | 'network' | null;
  saveRefusal: { status: number; body: Record<string, unknown> } | null;
  roster: { id: string; cliTool: string; alias: string; order: number }[];
  /** Set to answer every enable with this instead. */
  armRefusal: { status: number; body: Record<string, unknown> } | 'network' | null;
  /** On before this send: a send that reads first leaves its terms to after the message. */
  onBefore: boolean;
  /** The statuses reported for the contract's task. */
  taskStatuses: unknown[];
}

function fakeServer(overrides: Partial<Server> = {}): Server {
  const state: Server = {
    grantId: 'grant-1',
    autoYesReads: [],
    autoYesPosts: [],
    order: [],
    sends: 0,
    sendAnswer: { status: 201, body: { id: 1 } },
    liveAfterArming: true,
    patches: 0,
    rosterRead: null,
    saveRefusal: null,
    roster: [{ id: 'claude', cliTool: 'claude', alias: 'Claude', order: 0 }],
    armRefusal: null,
    onBefore: false,
    taskStatuses: [],
    ...overrides,
  };
  let armed = state.onBefore;
  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      redirected: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  const grant = (): Record<string, unknown> => ({
    enabled: true,
    expiresAt: EXPIRES,
    cliToolId: 'codex',
    instanceId: 'codex',
    ...(state.grantId === undefined ? {} : { grantId: state.grantId }),
  });

  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/capabilities')) {
      return respond(200, { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] });
    }
    if (url.includes('/resolve-target')) {
      const instanceId = new URL(url).searchParams.get('instance') ?? 'codex';
      return respond(200, { cliToolId: instanceId.split('-')[0], instanceId, resolvedBy: 'explicit', conflict: null });
    }
    if (url.includes('/auto-yes') && method === 'GET') {
      state.autoYesReads.push(url);
      return respond(200, armed && state.liveAfterArming ? grant() : { enabled: false, expiresAt: null });
    }
    if (url.includes('/auto-yes') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      state.autoYesPosts.push({ url, body });
      state.order.push('auto-yes');
      const refusal = body.enabled === true ? state.armRefusal : null;
      if (refusal === 'network') throw new TypeError('fetch failed');
      if (refusal) return respond(refusal.status, refusal.body);
      armed = body.enabled === true;
      return respond(200, armed ? grant() : { enabled: false, expiresAt: null });
    }
    if (url.endsWith(`/api/worktrees/${WT}/tasks`) && method === 'POST') {
      return respond(201, { task: { id: 'task-1' }, message: 'from the contract' });
    }
    if (url.includes('/api/tasks/') && method === 'PATCH') {
      state.taskStatuses.push((JSON.parse(String(init?.body)) as { status: unknown }).status);
      return respond(200, {});
    }
    if (url.endsWith('/send') && method === 'POST') {
      state.sends += 1;
      state.order.push('send');
      return respond(state.sendAnswer.status, state.sendAnswer.body);
    }
    if (url.endsWith(`/api/worktrees/${WT}`) && method === 'PATCH') {
      state.patches += 1;
      if (state.saveRefusal) return respond(state.saveRefusal.status, state.saveRefusal.body);
      state.roster = (JSON.parse(String(init?.body)) as { agentInstances: Server['roster'] }).agentInstances;
      return respond(200, { success: true });
    }
    if (url.endsWith(`/api/worktrees/${WT}`)) {
      state.order.push('roster-read');
      if (state.rosterRead === 'network') throw new TypeError('fetch failed');
      if (state.rosterRead) return respond(state.rosterRead.status, state.rosterRead.body);
      return respond(200, { id: WT, agentInstances: state.roster, rosterRevision: 'rev-1' });
    }
    return respond(200, {});
  }) as unknown as typeof fetch;
  return state;
}

const NOT_SENT = { status: 409, body: { error: 'refused', code: 'SOMETHING', sendOutcome: 'not_sent' } };
const UNKNOWN = { status: 500, body: { error: 'boom' } };

describe('[#4159]', () => {
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

  const run = (...args: string[]): Promise<unknown> =>
    createSendCommand()
      .parseAsync(['node', 'send', WT, 'hello', ...args])
      .then(() => null)
      .catch((error: unknown) => error);
  const disables = (server: Server) => server.autoYesPosts.filter(({ body }) => body.enabled === false);
  const STOP = `commandmate auto-yes ${WT} --disable --instance codex`;

  describe('item 1: a send that read the state first, refused with nothing typed', () => {
    /** A pin makes it a send that reads first, with no role to look up. */
    const armAndSend = (): Promise<unknown> => run('--instance', 'codex', '--auto-yes', '--expect-no-role');

    it('a server that names its grants: withdrawn, on that name', async () => {
      const server = fakeServer({ sendAnswer: NOT_SENT });

      expect(((await armAndSend()) as Error).message).toMatch(/^exit:/);

      expect(disables(server)).toHaveLength(1);
      expect(disables(server)[0].url).toContain('expectedGrantId=grant-1');
      expect(disables(server)[0].body).toEqual({ enabled: false, cliToolId: 'codex', instanceId: 'codex' });
      expect(errors.join('\n')).toContain('withdrawn');
    });

    it('a server that names none: no request with no condition, left on, with the command that stops it', async () => {
      const server = fakeServer({ sendAnswer: NOT_SENT, grantId: undefined });

      await armAndSend();

      expect(disables(server)).toEqual([]);
      const text = errors.join('\n');
      expect(text).not.toContain('withdrawn');
      expect(text).toContain('Warning: Auto-Yes stays on');
      expect(text).toContain(STOP);
    });

    it('a server that names none, with the grant already gone: nothing to say', async () => {
      const server = fakeServer({ sendAnswer: NOT_SENT, grantId: undefined, liveAfterArming: false });

      await armAndSend();

      expect(disables(server)).toEqual([]);
      expect(errors.join('\n')).not.toContain('stays on');
    });

    it('control: the outcome of the send not known, left on whatever the server is', async () => {
      const server = fakeServer({ sendAnswer: UNKNOWN });

      await armAndSend();

      expect(disables(server)).toEqual([]);
      expect(errors.join('\n')).toContain('the message may have gone in');
    });
  });

  describe('item 1: --auto-yes with nothing else reads nothing first (decided: not increased)', () => {
    it.each<[string, string[]]>([
      ['with a target', ['--instance', 'codex', '--auto-yes']],
      ['with no target, by the instance the server answered', ['--auto-yes']],
    ])('refused, %s: not read, not withdrawn, and it says what is left on', async (_label, args) => {
      const server = fakeServer({ sendAnswer: NOT_SENT });

      await run(...args);

      expect(server.autoYesReads).toEqual([]);
      expect(server.autoYesPosts.map(({ body }) => body.enabled)).toEqual([true]);
      expect(server.autoYesPosts[0].body).not.toHaveProperty('onlyIfOff');
      const text = errors.join('\n');
      expect(text).toContain('Warning: Auto-Yes stays on');
      expect(text).toContain(STOP);
    });

    it('control: sent, it says nothing of the kind', async () => {
      const server = fakeServer();

      expect(await run('--instance', 'codex', '--auto-yes')).toBeNull();

      expect(server.autoYesReads).toEqual([]);
      expect(errors.join('\n')).not.toContain('stays on');
    });

    it('control: no --auto-yes on a refused send, nothing about Auto-Yes', async () => {
      const server = fakeServer({ sendAnswer: NOT_SENT });

      await run('--instance', 'codex');

      expect(server.autoYesPosts).toEqual([]);
      expect(errors.join('\n')).not.toContain('Auto-Yes');
    });

    it('the help says why it stays on, and what reading first would cost', () => {
      let help = '';
      const command = createSendCommand();
      command.configureOutput({ writeOut: (text) => void (help += text) });
      command.outputHelp();
      expect(help).toMatch(/--auto-yes with no role, pin or\s+--reply-to reads nothing first/);
      expect(help).toMatch(/would add a request to every such send/);
    });
  });

  describe('item 3: --register without a role, once the message has gone out', () => {
    const send = (...args: string[]): Promise<unknown> =>
      run('--agent', 'codex', '--instance', 'codex-2', '--register', ...args);
    const ADD = `commandmate instances ${WT} add --agent codex --id codex-2`;

    it.each<[string, Partial<Server>]>([
      ['the roster read answers 500', { rosterRead: { status: 500, body: { error: 'boom' } } }],
      ['the roster read gets no answer', { rosterRead: 'network' }],
      ['the roster read is from a server with no roster', { rosterRead: { status: 200, body: { id: WT } } }],
      ['the worktree is gone by the read', { rosterRead: { status: 404, body: { error: 'gone' } } }],
      ['the save answers 500', { saveRefusal: { status: 500, body: { error: 'boom' } } }],
      ['the save answers another 409', { saveRefusal: { status: 409, body: { error: 'locked', code: 'OTHER' } } }],
      ['the save answers 400', { saveRefusal: { status: 400, body: { error: 'bad' } } }],
    ])('%s: sent once, exit 0, not to send again, and how to register', async (_label, overrides) => {
      const server = fakeServer(overrides);

      const outcome = await send();

      expect(outcome).toBeNull();
      expect(process.exit).not.toHaveBeenCalled();
      expect(server.sends).toBe(1);
      const text = errors.join('\n');
      expect(text).toContain('Message sent.');
      expect(text).toMatch(/^Warning: the message was sent/m);
      expect(text).toMatch(/do not send it again/i);
      expect(text).toContain(ADD);
      expect(text).not.toContain('Instance registered in roster');
    });

    it('a save with no usable answer is not reported as not saved: it may have been', async () => {
      fakeServer({ saveRefusal: { status: 500, body: { error: 'boom' } } });

      await send();

      const text = errors.join('\n');
      expect(text).not.toContain('was not added');
      expect(text).toContain(`commandmate instances ${WT}\``);
    });

    it('at the instance limit: the same two things', async () => {
      const roster = Array.from({ length: 10 }, (_, order) => ({ id: `claude-${order + 2}`, cliTool: 'claude', alias: `C${order}`, order }));
      const server = fakeServer({ roster });

      expect(await send()).toBeNull();

      expect(server.patches).toBe(0);
      const text = errors.join('\n');
      expect(text).toContain('limit');
      expect(text).toMatch(/do not send it again/i);
      expect(text).toContain(ADD);
    });

    it('what comes after the register still happens: copilot with --model arms Auto-Yes after the refused read', async () => {
      const server = fakeServer({ rosterRead: { status: 500, body: { error: 'boom' } } });

      const outcome = await run('--agent', 'copilot', '--instance', 'copilot-2', '--register', '--auto-yes', '--model', 'gpt-5-mini');

      expect(outcome).toBeNull();
      expect(server.autoYesPosts.map(({ body }) => body.enabled)).toEqual([true]);
      // The last of them. Claude arms before the send, and could not show this.
      expect(server.order.slice(-3)).toEqual(['send', 'roster-read', 'auto-yes']);
      expect(errors.join('\n')).toMatch(/do not send it again/i);
    });

    it('stdout stays what a registered send leaves there', async () => {
      fakeServer();
      await send();
      const registered = [...stdout];
      stdout.length = 0;

      fakeServer({ rosterRead: { status: 500, body: { error: 'boom' } } });
      await send();

      expect(stdout).toEqual(registered);
    });

    it('control: nothing fails: registered, with no warning', async () => {
      const server = fakeServer();

      expect(await send()).toBeNull();

      expect(server.roster.map(({ id }) => id)).toEqual(['claude', 'codex-2']);
      expect(errors.join('\n')).toContain('Instance registered in roster: codex-2');
      expect(errors.join('\n')).not.toContain('Warning');
    });

    it('control: a send that fails stays a failure, and nothing is written to the roster', async () => {
      const server = fakeServer({ sendAnswer: UNKNOWN });

      expect(((await send()) as Error).message).toBe('exit:99');

      expect(server.patches).toBe(0);
      expect(errors.join('\n')).not.toContain('do not send it again');
    });
  });

  describe('the enable that comes after the message', () => {
    const FOREIGN = { status: 409, body: { error: 'another server', code: 'SESSION_OWNED_ELSEWHERE' } };
    const afterSend = (...args: string[]): Promise<unknown> =>
      run('--instance', 'copilot', '--model', 'gpt-5-mini', '--auto-yes', ...args);
    const ENABLE = `commandmate auto-yes ${WT} --enable --duration 1h --instance copilot`;

    it.each<[string, Server['armRefusal']]>([
      ['a refusal', FOREIGN],
      ['a 500', { status: 500, body: { error: 'boom' } }],
      ['no answer', 'network'],
    ])('%s: sent once, exit 0, not to send again, and how to enable it', async (_label, armRefusal) => {
      const server = fakeServer({ armRefusal });

      expect(await afterSend()).toBeNull();

      expect(process.exit).not.toHaveBeenCalled();
      expect(server.sends).toBe(1);
      const text = errors.join('\n');
      expect(text).toContain('Message sent.');
      expect(text).toMatch(/^Warning: the message was sent, but Auto-Yes/m);
      expect(text).toMatch(/do not send it again/i);
      expect(text).toContain(ENABLE);
      expect(text).not.toContain('Auto-yes enabled.');
    });

    it('the command it names carries the terms of this send, and the tool an id does not say', async () => {
      fakeServer({ armRefusal: FOREIGN });

      await run(
        '--instance', 'copilot-2', '--model', 'gpt-5-mini', '--auto-yes',
        '--duration', '3h', '--stop-pattern', "it's done", '--auto-yes-answer-mode', 'careful',
      );

      expect(errors.join('\n')).toContain(
        `commandmate auto-yes ${WT} --enable --duration 3h --instance copilot-2 --agent copilot --stop-pattern 'it'\\''s done' --answer-mode careful`,
      );
    });

    it('with a contract: stdout is the task id alone, and the task stays running', async () => {
      const server = fakeServer({ armRefusal: FOREIGN });

      await createSendCommand().parseAsync([
        'node', 'send', WT, '--contract', '.commandmate/tasks/x.yaml',
        '--instance', 'copilot', '--model', 'gpt-5-mini', '--auto-yes',
      ]);

      expect(stdout).toEqual(['task-1']);
      expect(server.taskStatuses).toEqual(['running']);
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('send has no --json: there is no other form of this outcome to keep in step', () => {
      expect(createSendCommand().options.map((option) => option.long)).not.toContain('--json');
    });

    it('a grant already on, whose new terms come after the message: the same, and it does not say it is off', async () => {
      const server = fakeServer({ armRefusal: FOREIGN, onBefore: true });

      expect(await run('--instance', 'codex', '--auto-yes', '--expect-no-role')).toBeNull();

      expect(server.sends).toBe(1);
      const text = errors.join('\n');
      expect(text).toMatch(/do not send it again/i);
      expect(text).toContain(`commandmate auto-yes ${WT} --enable --duration 1h --instance codex`);
      expect(text).toMatch(/may not be on with this send's terms/);
    });

    it('control: it goes through, with no warning', async () => {
      const server = fakeServer();

      expect(await afterSend()).toBeNull();

      expect(server.autoYesPosts.map(({ body }) => body.enabled)).toEqual([true]);
      expect(errors.join('\n')).toContain('Auto-yes enabled.');
      expect(errors.join('\n')).not.toContain('Warning');
    });

    it.each<[string, string[]]>([
      ['no --model', ['--instance', 'codex', '--auto-yes']],
      ['--model on claude, which arms first', ['--instance', 'claude', '--model', 'opus', '--auto-yes']],
    ])('control: an enable before the send, %s, still fails the command with nothing sent', async (_label, args) => {
      const server = fakeServer({ armRefusal: FOREIGN });

      expect(((await run(...args)) as Error).message).toMatch(/^exit:[1-9]/);

      expect(server.sends).toBe(0);
      expect(errors.join('\n')).not.toContain('the message was sent');
    });

    it('control: a send that fails never gets as far as the enable', async () => {
      const server = fakeServer({ sendAnswer: UNKNOWN, armRefusal: FOREIGN });

      expect(((await afterSend()) as Error).message).toBe('exit:99');

      expect(server.autoYesPosts).toEqual([]);
      expect(errors.join('\n')).not.toContain('the message was sent');
    });
  });
});
