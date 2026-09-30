/**
 * OpenCode V2 in the slash palette (Issue #2944)
 *
 * A fake v2 server — a real loopback HTTP server answering `GET /api/command`
 * and `GET /api/skill` with the bodies captured from opencode2 2.0.18
 * (`tests/fixtures/opencode-v2-slash-2944`), behind Basic auth — stands in for
 * the instance's own `opencode2 serve`. The password file and the port
 * assignment are the real modules pointed at a sandbox through
 * `CM_OPENCODE_V2_DIR`; only the port lookup is mocked, so the test can hand
 * the server's ephemeral port to the cache.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

/** No real CLI processes: the route probes CLI versions for catalog staleness. */
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: (
      _command: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      cb(new Error('ENOENT'), '', '');
    },
  };
});

const getAssignedOpencodeV2Port = vi.fn<() => number | null>(() => null);
const readPersistedOpencodeV2Ports = vi.fn<
  () => Record<string, { port: number; worktreePath: string; updatedAt: number }>
>(() => ({}));

vi.mock('@/lib/hooks/sources/opencode-v2/ports', () => ({
  getAssignedOpencodeV2Port: (...args: unknown[]) =>
    (getAssignedOpencodeV2Port as unknown as (...a: unknown[]) => number | null)(...args),
  readPersistedOpencodeV2Ports: () => readPersistedOpencodeV2Ports(),
}));

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'opencode-v2-slash-2944');
const readFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const COMMAND_BODY = readFixture('command-2.0.18.json');
const COLD_COMMAND_BODY = readFixture('command-cold-2.0.18.json');
const SKILL_BODY = readFixture('skill-2.0.18.json');

const PASSWORD = 'fixture-password-2944';
const DEFAULT_KEY = 'wt:opencode-v2';

interface FakeServer {
  port: number;
  requests: Array<{ url: string; authorization: string | undefined }>;
  commandBody: unknown;
  close(): Promise<void>;
}

/** A loopback server shaped like `opencode2 serve`: Basic auth, `{location, data}` bodies. */
async function startFakeV2Server(): Promise<FakeServer> {
  const state: FakeServer = {
    port: 0,
    requests: [],
    commandBody: COMMAND_BODY,
    close: async () => {},
  };
  const expected = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"_tag":"UnauthorizedError"}');
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body =
      pathname === '/api/command' ? state.commandBody : pathname === '/api/skill' ? SKILL_BODY : null;
    if (body === null) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

let sandbox: string;
let workspace: string;
let fake: FakeServer | null = null;

function writePassword(key: string, value: string = PASSWORD): void {
  const dir = path.join(sandbox, 'opencode-v2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.pw`), `${value}\n`, { mode: 0o600 });
}

beforeEach(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-oc2-slash-'));
  workspace = path.join(sandbox, 'work');
  fs.mkdirSync(workspace);
  vi.stubEnv('CM_OPENCODE_V2_DIR', path.join(sandbox, 'opencode-v2'));
  const { resetOpencodeV2LiveCommandCache } = await import(
    '@/app/api/worktrees/[id]/slash-commands/opencode-v2-live'
  );
  resetOpencodeV2LiveCommandCache();
  getAssignedOpencodeV2Port.mockReturnValue(null);
  readPersistedOpencodeV2Ports.mockReturnValue({});
});

afterEach(async () => {
  await fake?.close();
  fake = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  removeTempDir(sandbox);
});

describe('parseOpencodeV2Documents (Issue #2944)', () => {
  it('reads the 2.0.18 bodies: commands first, Skills by id, content dropped', async () => {
    const { parseOpencodeV2Documents, readOpencodeV2DataArray } = await import(
      '@/lib/hooks/sources/opencode-v2/commands'
    );
    const rows = parseOpencodeV2Documents(
      readOpencodeV2DataArray(COMMAND_BODY) ?? [],
      readOpencodeV2DataArray(SKILL_BODY) ?? []
    );
    expect(rows.filter((r) => r.source === 'command').map((r) => r.name)).toEqual([
      'init',
      'review',
      'probe-cmd2',
      'probe-cmd',
    ]);
    const skills = rows.filter((r) => r.source === 'skill');
    // The builtin is `name: "OpenCode"`; the id is what `/<name>` matches.
    expect(skills.map((r) => r.name)).toContain('opencode');
    expect(skills.map((r) => r.name)).toContain('probe-agentsskills');
    expect(skills.find((r) => r.name === 'probe-cmd')).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('Reply exactly');
  });

  it('is total: anything but {data: [...]} is not a document', async () => {
    const { readOpencodeV2DataArray, parseOpencodeV2Documents } = await import(
      '@/lib/hooks/sources/opencode-v2/commands'
    );
    expect(readOpencodeV2DataArray([{ name: 'x' }])).toBeNull();
    expect(readOpencodeV2DataArray({ data: 'x' })).toBeNull();
    expect(readOpencodeV2DataArray(null)).toBeNull();
    expect(parseOpencodeV2Documents([null, 1, { name: '../x' }], [{ id: 'a b' }])).toEqual([]);
  });
});

describe('fetchOpencodeV2LiveCommands (Issue #2944)', () => {
  it('reads both routes with the instance password and the worktree location', async () => {
    fake = await startFakeV2Server();
    const { fetchOpencodeV2LiveCommands } = await import('@/lib/hooks/sources/opencode-v2/commands');

    const result = await fetchOpencodeV2LiveCommands({
      port: fake.port,
      password: PASSWORD,
      directory: workspace,
    });

    expect(result.ok && result.complete).toBe(true);
    expect(fake.requests.map((r) => new URL(r.url, 'http://x').pathname).sort()).toEqual([
      '/api/command',
      '/api/skill',
    ]);
    for (const request of fake.requests) {
      expect(new URL(request.url, 'http://x').searchParams.get('location[directory]')).toBe(workspace);
      // The password travels in the header only.
      expect(request.url).not.toContain(PASSWORD);
    }
  });

  it('answers ok:false on a wrong password rather than throwing', async () => {
    fake = await startFakeV2Server();
    const { fetchOpencodeV2LiveCommands } = await import('@/lib/hooks/sources/opencode-v2/commands');
    const result = await fetchOpencodeV2LiveCommands({ port: fake.port, password: 'wrong' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.warning).not.toContain('wrong');
  });

  it('flags a cold server (empty command list) as incomplete', async () => {
    fake = await startFakeV2Server();
    fake.commandBody = COLD_COMMAND_BODY;
    const { fetchOpencodeV2LiveCommands } = await import('@/lib/hooks/sources/opencode-v2/commands');
    const result = await fetchOpencodeV2LiveCommands({ port: fake.port, password: PASSWORD });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.complete).toBe(false);
      expect(result.commands.every((c) => c.source === 'skill')).toBe(true);
    }
  });

  it('refuses a port that is not one', async () => {
    const { fetchOpencodeV2LiveCommands } = await import('@/lib/hooks/sources/opencode-v2/commands');
    expect((await fetchOpencodeV2LiveCommands({ port: 0, password: PASSWORD })).ok).toBe(false);
  });
});

describe('opencodeV2LiveCandidates / refresh (Issue #2944)', () => {
  it('takes the in-memory default instance first, then the file filtered by worktree', async () => {
    const { opencodeV2LiveCandidates } = await import(
      '@/app/api/worktrees/[id]/slash-commands/opencode-v2-live'
    );
    getAssignedOpencodeV2Port.mockReturnValue(4300);
    readPersistedOpencodeV2Ports.mockReturnValue({
      [DEFAULT_KEY]: { port: 4300, worktreePath: workspace, updatedAt: 1 },
      'wt:opencode-v2:opencode-v2-2': { port: 4301, worktreePath: workspace, updatedAt: 1 },
      'other:opencode-v2': { port: 4399, worktreePath: '/somewhere/else', updatedAt: 1 },
    });
    expect(opencodeV2LiveCandidates('wt', workspace)).toEqual([
      { port: 4300, key: DEFAULT_KEY },
      { port: 4301, key: 'wt:opencode-v2:opencode-v2-2' },
    ]);
  });

  it('skips a candidate with no password file and never throws', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-v2-live');
    fake = await startFakeV2Server();
    getAssignedOpencodeV2Port.mockReturnValue(fake.port);
    await expect(mod.refreshOpencodeV2LiveCommands('wt', workspace, 1_000)).resolves.toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it('picks up an instance launched after a palette open, without waiting out the TTL', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-v2-live');
    await mod.refreshOpencodeV2LiveCommands('wt', workspace, 1_000);
    expect(mod.getOpencodeV2LiveCommands('wt')).toEqual([]);

    fake = await startFakeV2Server();
    writePassword(DEFAULT_KEY);
    getAssignedOpencodeV2Port.mockReturnValue(fake.port);
    mod.scheduleOpencodeV2LiveRefresh('wt', workspace, 1_001);
    await vi.waitFor(() =>
      expect(mod.getOpencodeV2LiveCommands('wt').some((c) => c.name === 'probe-cmd')).toBe(true)
    );
  });

  it('re-probes on the next open after a cold read, and not after a warm one', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-v2-live');
    fake = await startFakeV2Server();
    fake.commandBody = COLD_COMMAND_BODY;
    writePassword(DEFAULT_KEY);
    getAssignedOpencodeV2Port.mockReturnValue(fake.port);

    await mod.refreshOpencodeV2LiveCommands('wt', workspace, 1_000);
    expect(mod.getOpencodeV2LiveCommands('wt').some((c) => c.name === 'probe-cmd')).toBe(false);

    fake.commandBody = COMMAND_BODY;
    mod.scheduleOpencodeV2LiveRefresh('wt', workspace, 1_001);
    await vi.waitFor(() =>
      expect(mod.getOpencodeV2LiveCommands('wt').some((c) => c.name === 'probe-cmd')).toBe(true)
    );

    const before = fake.requests.length;
    mod.scheduleOpencodeV2LiveRefresh('wt', workspace, 1_002);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.requests.length).toBe(before);
  });
});

describe('GET /api/worktrees/[id]/slash-commands?cliTool=opencode-v2 (Issue #2944)', () => {
  async function callRoute(cliTool: string) {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: 'wt',
      path: workspace,
    } as unknown as ReturnType<typeof getWorktreeById>);
    const { GET } = await import('@/app/api/worktrees/[id]/slash-commands/route');
    const request = new NextRequest(
      `http://localhost:3000/api/worktrees/wt/slash-commands?cliTool=${cliTool}`
    );
    const response = await GET(request, { params: Promise.resolve({ id: 'wt' }) });
    const body = (await response.json()) as {
      groups: Array<{
        commands: Array<{ name: string; description?: string; source?: string; cliTools?: string[] }>;
      }>;
    };
    return body.groups.flatMap((group) => group.commands);
  }

  it('offers the project commands and Skills from a running v2 server', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-v2-live');
    fake = await startFakeV2Server();
    writePassword(DEFAULT_KEY);
    getAssignedOpencodeV2Port.mockReturnValue(fake.port);
    await mod.refreshOpencodeV2LiveCommands('wt', workspace, Date.now());

    const commands = await callRoute('opencode-v2');
    const names = commands.map((c) => c.name);
    for (const name of ['probe-cmd', 'probe-cmd2', 'probe-agentsskills', 'probe-opencodeskill', 'opencode', 'report']) {
      expect(names, `/${name} must reach the opencode-v2 palette`).toContain(name);
    }
    expect(commands.find((c) => c.name === 'probe-cmd')?.description).toBe('Probe markdown command');
    expect(commands.find((c) => c.name === 'probe-agentsskills')?.source).toBe('skill');
    // The catalog row wins for a name both know, so its translated text survives.
    const init = commands.filter((c) => c.name === 'init');
    expect(init).toHaveLength(1);
    expect(init[0].description).toBeUndefined();
    // Built-ins from the attested palette are there too.
    for (const name of ['status', 'models', 'worktrees', 'exit']) expect(names).toContain(name);
    expect(commands.every((c) => c.cliTools?.includes('opencode-v2'))).toBe(true);
  });

  it('answers the built-in list only when no v2 server is running', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const commands = await callRoute('opencode-v2');
    const names = commands.map((c) => c.name);
    expect(names).toContain('status');
    expect(names).toContain('worktrees');
    for (const name of ['probe-cmd', 'probe-agentsskills', 'report']) expect(names).not.toContain(name);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('offers a Skill planted in a v2 project root with no server running', async () => {
    for (const root of ['.opencode/skill', '.agents/skills']) {
      const name = `planted-${root.replace(/[^a-z]/g, '')}`;
      const dir = path.join(workspace, root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Planted\n---\nBody\n`);
    }
    const commands = await callRoute('opencode-v2');
    for (const name of ['planted-opencodeskill', 'planted-agentsskills']) {
      const row = commands.find((c) => c.name === name);
      expect(row, `/${name}`).toBeDefined();
      expect(row?.source).toBe('skill');
    }
    // v1 does not read the singular root, and is not handed v2's rows.
    const v1 = await callRoute('opencode');
    expect(v1.some((c) => c.name === 'planted-opencodeskill')).toBe(false);
  });

  it('lists a Skill the disk scan and the server both know once', async () => {
    const dir = path.join(workspace, '.agents/skills', 'probe-agentsskills');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: probe-agentsskills\ndescription: On disk\n---\nBody\n');
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-v2-live');
    fake = await startFakeV2Server();
    writePassword(DEFAULT_KEY);
    getAssignedOpencodeV2Port.mockReturnValue(fake.port);
    await mod.refreshOpencodeV2LiveCommands('wt', workspace, Date.now());

    const rows = (await callRoute('opencode-v2')).filter((c) => c.name === 'probe-agentsskills');
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('On disk');
  });

  it('leaves the opencode (v1) palette untouched with a v2 snapshot loaded', async () => {
    const before = (await callRoute('opencode')).map((c) => `${c.name}:${c.source}`).sort();

    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-v2-live');
    fake = await startFakeV2Server();
    writePassword(DEFAULT_KEY);
    getAssignedOpencodeV2Port.mockReturnValue(fake.port);
    await mod.refreshOpencodeV2LiveCommands('wt', workspace, Date.now());

    const after = (await callRoute('opencode')).map((c) => `${c.name}:${c.source}`).sort();
    expect(after).toEqual(before);
  });
});
