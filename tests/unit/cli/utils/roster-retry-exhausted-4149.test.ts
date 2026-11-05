/**
 * Issue #4149 F1: when the roster keeps moving past the retries, the CLI says so.
 *
 * Six `instances add` at once ended one of them in `Unexpected HTTP status: 409`
 * (exit 99). The refusal is answered here by a fake server whose roster another
 * writer changes between each read and each save.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoleExitCode } from '../../../../src/cli/types';
import { ApiClient, ApiError } from '../../../../src/cli/utils/api-client';
import { handleApiError } from '../../../../src/cli/utils/api-client-errors';
import { saveAgentInstances, saveRosterChange } from '../../../../src/cli/utils/agent-instances';
import { RoleCliError } from '../../../../src/cli/utils/role-failure';
import { createInstancesCommand } from '../../../../src/cli/commands/instances';
import type { AgentInstance } from '../../../../src/cli/types/api-responses';

const WT = 'wt1';
const row = (id: string): AgentInstance => ({ id, cliTool: 'codex', alias: id, order: 0 } as AgentInstance);

/** A roster with a revision. `interruptions` other writers land right before a save. */
function fakeServer(interruptions: number) {
  const state = { revision: 1, roster: [row('claude')], left: interruptions, patches: [] as Array<Record<string, unknown>> };
  const respond = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      redirected: false,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  global.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== 'PATCH') {
      return respond(200, { id: WT, agentInstances: state.roster, rosterRevision: `rev-${state.revision}` });
    }
    const body = JSON.parse(String(init.body)) as { agentInstances: AgentInstance[]; expectedRosterRevision?: string };
    state.patches.push(body);
    if (state.left > 0) {
      state.left -= 1;
      state.revision += 1;
      state.roster = [...state.roster, row(`other-${state.revision}`)];
    }
    if (body.expectedRosterRevision !== `rev-${state.revision}`) {
      return respond(409, { error: 'The roster changed since it was read', code: 'ROSTER_CHANGED' });
    }
    state.revision += 1;
    state.roster = body.agentInstances;
    return respond(200, { success: true });
  }) as unknown as typeof fetch;
  return state;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('[#4149] saveRosterChange when the retries run out', () => {
  const add = (base: AgentInstance[]): AgentInstance[] => [...base, row('mine')];

  it('says the roster kept moving and nothing was saved, as roster_changed / exit 31', async () => {
    const server = fakeServer(99);
    const client = new ApiClient();

    const error = await saveRosterChange(client, WT, { instances: [row('claude')], revision: 'rev-1' }, add).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RoleCliError);
    const failure = error as RoleCliError;
    expect(failure.code).toBe('roster_changed');
    expect(failure.exitCode).toBe(RoleExitCode.CONFLICT);
    expect(failure.statusCode).toBe(409);
    expect(failure.message).not.toContain('Unexpected HTTP status');
    expect(failure.message).toMatch(/kept changing/);
    expect(failure.message).toMatch(/nothing was saved/i);
    expect(failure.message).toMatch(/3 attempts/);
    // Every attempt was built on a fresh read; none of them replaced the other writers' rows.
    expect(server.patches).toHaveLength(3);
    expect(server.roster.some((inst) => inst.id === 'mine')).toBe(false);
    expect(server.roster.some((inst) => inst.id === 'other-2')).toBe(true);
  });

  it('control: two interruptions are within the retries, and the save keeps their rows', async () => {
    const server = fakeServer(2);
    const client = new ApiClient();

    const saved = await saveRosterChange(client, WT, { instances: [row('claude')], revision: 'rev-1' }, add);

    expect(saved?.map((inst) => inst.id)).toEqual(['claude', 'other-2', 'other-3', 'mine']);
    expect(server.patches).toHaveLength(3);
    expect(server.roster.map((inst) => inst.id)).toEqual(['claude', 'other-2', 'other-3', 'mine']);
  });

  it('control: another refusal is not retried, and stays what it was', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls += 1;
      return {
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        redirected: false,
        text: async () => JSON.stringify({ code: 'SOMETHING_ELSE', error: 'x' }),
        json: async () => ({ code: 'SOMETHING_ELSE', error: 'x' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const error = await saveRosterChange(new ApiClient(), WT, { instances: [row('claude')], revision: 'r' }, add).catch((e: unknown) => e);

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(RoleCliError);
    expect((error as ApiError).message).toBe('Unexpected HTTP status: 409');
    expect((error as ApiError).exitCode).toBe(99);
  });

  it('a single refusal of a direct save reads the same way, without claiming retries', async () => {
    const server = fakeServer(1);
    const error = await saveAgentInstances(new ApiClient(), WT, [row('mine')], 'rev-1').catch((e: unknown) => e);

    expect(server.patches).toHaveLength(1);
    expect((error as ApiError).exitCode).toBe(RoleExitCode.CONFLICT);
    expect((error as ApiError).message).toMatch(/nothing was saved/i);
    expect((error as ApiError).message).not.toMatch(/attempts/);
  });
});

describe('[#4149] handleApiError and the roster 409', () => {
  it('names the refusal with the exit code the help gives', () => {
    const result = handleApiError(null, 409, { code: 'ROSTER_CHANGED', error: 'x' });
    expect(result.exitCode).toBe(RoleExitCode.CONFLICT);
    expect(result.message).toMatch(/roster changed/i);
  });

  it('control: every other 409 keeps its wording and exit code', () => {
    expect(handleApiError(null, 409, { code: 'PROMPT_WAITING', error: 'x' })).toEqual({
      message: 'Unexpected HTTP status: 409',
      exitCode: 99,
    });
  });
});

describe('[#4149] instances, end to end against the interrupted roster', () => {
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

  const run = (...args: string[]): Promise<unknown> =>
    createInstancesCommand().parseAsync(['node', 'instances', WT, ...args]).catch((e: unknown) => e);

  it('add: exit 31 and a sentence that says why', async () => {
    fakeServer(99);
    const outcome = (await run('add', '--agent', 'codex')) as Error;

    expect(outcome.message).toBe('exit:31');
    expect(errors.join('\n')).toMatch(/roster kept changing/);
    expect(errors.join('\n')).not.toContain('Unexpected HTTP status');
    expect(errors.join('\n')).not.toContain('Instance added');
  });

  it('add --json: the same failure is on stdout as roster_changed', async () => {
    fakeServer(99);
    const outcome = (await run('add', '--agent', 'codex', '--json')) as Error;

    expect(outcome.message).toBe('exit:31');
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({ success: false, error: 'roster_changed' });
  });

  it.each([
    ['remove', ['remove', 'claude-2']],
    ['alias', ['alias', 'claude-2', 'new name']],
  ])('%s: the same exit and sentence, through the same save', async (_name, args) => {
    const server = fakeServer(99);
    server.roster = [row('claude'), row('claude-2')];
    const outcome = (await run(...args)) as Error;

    expect(outcome.message).toBe('exit:31');
    expect(errors.join('\n')).toMatch(/roster kept changing/);
  });

  it('control: an add that fits within the retries succeeds', async () => {
    fakeServer(1);
    const outcome = await run('add', '--agent', 'codex');

    expect(outcome).not.toBeInstanceOf(Error);
    expect(errors.join('\n')).toContain('Instance added');
  });

  it('the help says what the plain forms do', () => {
    let help = '';
    const command = createInstancesCommand();
    command.configureOutput({ writeOut: (text) => void (help += text) });
    command.outputHelp();
    expect(help).toMatch(/kept changing/);
    expect(help).toMatch(/remove --kill/);
  });
});
