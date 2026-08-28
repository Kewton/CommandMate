/**
 * The opencode live registry behind the palette route (Issue #2036)
 *
 * Two things are asserted here that nothing else can assert:
 *
 *  1. the route never awaits the loopback probe. That rule (#1913 §4 D2) is the
 *     reason `catalogStaleness` is a cache read, and the same reason applies
 *     with more force to a request aimed at a process CommandMate did not start.
 *  2. the enrichment is opencode-only and additive, so claude / codex palettes
 *     come back byte-identical.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import * as fs from 'fs';
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

const getAssignedOpencodePort = vi.fn<() => number | null>(() => null);
const readPersistedOpencodePorts = vi.fn<
  () => Record<string, { port: number; worktreePath: string; updatedAt: number }>
>(() => ({}));

vi.mock('@/lib/hooks/sources/opencode/ports', () => ({
  getAssignedOpencodePort: (...args: unknown[]) =>
    (getAssignedOpencodePort as unknown as (...a: unknown[]) => number | null)(...args),
  readPersistedOpencodePorts: () => readPersistedOpencodePorts(),
}));

/** The 1.18.22 body, cut to what the palette reads. */
const LIVE_BODY = [
  { name: 'init', description: 'guided AGENTS.md setup', source: 'command', hints: ['$ARGUMENTS'] },
  {
    name: 'test',
    description: 'Issue 2036 probe custom command',
    source: 'command',
    agent: 'build',
    hints: ['$ARGUMENTS'],
  },
  {
    name: 'probe-agents-root',
    description: 'CommandMate probe skill planted at .agents/skills',
    source: 'skill',
    hints: [],
  },
];

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  } as unknown as Response;
}

let workspace: string;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-oc-live-'));
  const { resetOpencodeLiveCommandCache } = await import(
    '@/app/api/worktrees/[id]/slash-commands/opencode-live'
  );
  resetOpencodeLiveCommandCache();
  getAssignedOpencodePort.mockReturnValue(null);
  readPersistedOpencodePorts.mockReturnValue({});
  vi.restoreAllMocks();
});

afterEach(() => {
  removeTempDir(workspace);
  vi.clearAllMocks();
});

describe('opencodeLivePortCandidates (Issue #2036)', () => {
  it('takes the in-memory assignment first, then the file, filtered by worktree', async () => {
    const { opencodeLivePortCandidates } = await import(
      '@/app/api/worktrees/[id]/slash-commands/opencode-live'
    );
    getAssignedOpencodePort.mockReturnValue(4200);
    readPersistedOpencodePorts.mockReturnValue({
      'wt|opencode': { port: 4200, worktreePath: workspace, updatedAt: 1 },
      'wt|opencode-2': { port: 4201, worktreePath: workspace, updatedAt: 1 },
      // Another worktree's pane. Reading it would file that project's commands
      // under this palette.
      'other|opencode': { port: 4299, worktreePath: '/somewhere/else', updatedAt: 1 },
    });

    expect(opencodeLivePortCandidates('wt', workspace)).toEqual([4200, 4201]);
  });

  it('answers empty when no opencode has ever run here', async () => {
    const { opencodeLivePortCandidates } = await import(
      '@/app/api/worktrees/[id]/slash-commands/opencode-live'
    );
    expect(opencodeLivePortCandidates('wt', workspace)).toEqual([]);
  });
});

describe('refreshOpencodeLiveCommands (Issue #2036)', () => {
  it('caches what the first answering port returns', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));

    await mod.refreshOpencodeLiveCommands('wt', workspace, 1_000);

    expect(mod.getOpencodeLiveCommands('wt').map((c) => c.name)).toEqual([
      'init',
      'test',
      'probe-agents-root',
    ]);
  });

  it('keeps the previous rows when the pane is momentarily down', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));
    await mod.refreshOpencodeLiveCommands('wt', workspace, 1_000);
    expect(mod.getOpencodeLiveCommands('wt')).toHaveLength(3);

    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    await mod.refreshOpencodeLiveCommands('wt', workspace, 100_000);
    // Blanking the palette because a restart was in flight would be worse than
    // showing a snapshot one relaunch old.
    expect(mod.getOpencodeLiveCommands('wt')).toHaveLength(3);
  });

  it('stops at the first port that answers', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    readPersistedOpencodePorts.mockReturnValue({
      a: { port: 4200, worktreePath: workspace, updatedAt: 1 },
      b: { port: 4201, worktreePath: workspace, updatedAt: 1 },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));

    await mod.refreshOpencodeLiveCommands('wt', workspace, 1_000);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:4200/command');
  });

  it('never throws, whatever the assignments file says', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    readPersistedOpencodePorts.mockImplementation(() => {
      throw new Error('unreadable');
    });
    await expect(mod.refreshOpencodeLiveCommands('wt', workspace, 1_000)).resolves.toEqual([]);
  });
});

describe('scheduleOpencodeLiveRefresh (Issue #2036)', () => {
  it('does not re-probe inside the TTL', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));

    await mod.refreshOpencodeLiveCommands('wt', workspace, 1_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    mod.scheduleOpencodeLiveRefresh('wt', workspace, 1_000 + mod.OPENCODE_LIVE_TTL_MS - 1);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    mod.scheduleOpencodeLiveRefresh('wt', workspace, 1_000 + mod.OPENCODE_LIVE_TTL_MS);
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns before the probe settles', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);

    let release: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(LIVE_BODY));
        })
    );

    mod.scheduleOpencodeLiveRefresh('wt', workspace, 1_000);
    // The probe is still hanging; the caller already has control back and the
    // snapshot is empty rather than blocked. This is the whole contract.
    expect(mod.getOpencodeLiveCommands('wt')).toEqual([]);

    release?.();
  });
});

describe('GET /api/worktrees/[id]/slash-commands with a live opencode (Issue #2036)', () => {
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
    return (await response.json()) as {
      groups: Array<{ commands: Array<{ name: string; description?: string; source?: string }> }>;
    };
  }

  function flatten(body: Awaited<ReturnType<typeof callRoute>>) {
    return body.groups.flatMap((group) => group.commands);
  }

  it('shows a .opencode/commands entry with its description once the snapshot exists', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));
    await mod.refreshOpencodeLiveCommands('wt', workspace, Date.now());

    const commands = flatten(await callRoute('opencode'));
    const test = commands.find((c) => c.name === 'test');
    expect(test, '/test must reach the opencode palette').toBeDefined();
    expect(test?.description).toBe('Issue 2036 probe custom command · $ARGUMENTS');

    const skill = commands.find((c) => c.name === 'probe-agents-root');
    expect(skill?.source).toBe('skill');
  });

  it('keeps the catalog description for a name the live registry also carries', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));
    await mod.refreshOpencodeLiveCommands('wt', workspace, Date.now());

    const init = flatten(await callRoute('opencode')).filter((c) => c.name === 'init');
    expect(init).toHaveLength(1);
    // Literal English here would be an untranslated row for every ja user.
    expect(init[0].description).toBeUndefined();
  });

  it('answers from the catalog when nothing is listening, and never blocks', async () => {
    getAssignedOpencodePort.mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const commands = flatten(await callRoute('opencode'));

    expect(commands.some((c) => c.name === 'init')).toBe(true);
    expect(commands.some((c) => c.name === 'test')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves claude and codex untouched even with a live snapshot loaded', async () => {
    const mod = await import('@/app/api/worktrees/[id]/slash-commands/opencode-live');
    getAssignedOpencodePort.mockReturnValue(4200);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(LIVE_BODY));
    await mod.refreshOpencodeLiveCommands('wt', workspace, Date.now());

    for (const tool of ['claude', 'codex']) {
      const commands = flatten(await callRoute(tool));
      for (const name of ['test', 'probe-agents-root']) {
        expect(
          commands.some((c) => c.name === name),
          `${tool} must not be offered /${name}`
        ).toBe(false);
      }
    }
  });

  it('offers an installed Skill to opencode with no server running at all', async () => {
    // The acceptance criterion for #2037, on the offline path: `commandmate
    // skill install` writes the same payload into `.agents/skills` and
    // `.claude/skills` (#1460), opencode was measured to read both, and its own
    // palette never offers a Skill — so this row is the only way to reach one.
    for (const root of ['.agents/skills', '.claude/skills']) {
      const dir = path.join(workspace, root, 'cmate-installed-skill');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: cmate-installed-skill\ndescription: Installed by CommandMate\n---\nBody\n'
      );
    }
    getAssignedOpencodePort.mockReturnValue(null);

    const opencode = flatten(await callRoute('opencode'));
    const row = opencode.find((c) => c.name === 'cmate-installed-skill');
    expect(row, 'the installed Skill must reach the opencode palette').toBeDefined();
    expect(row?.description).toBe('Installed by CommandMate');
    expect(row?.source).toBe('skill');

    // codex still gets its own `.agents/skills` row (source codex-skill), and
    // claude its `.claude/skills` one — neither changed shape.
    expect(
      flatten(await callRoute('codex')).find((c) => c.name === 'cmate-installed-skill')?.source
    ).toBe('codex-skill');
    expect(
      flatten(await callRoute('claude')).find((c) => c.name === 'cmate-installed-skill')?.source
    ).toBe('skill');
  });

  it('starts the probe behind the response rather than awaiting it', async () => {
    getAssignedOpencodePort.mockReturnValue(4200);
    let started = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>(() => {
          // Never settles. If the route awaited it, the call below would hang.
          started = true;
        })
    );

    const commands = flatten(await callRoute('opencode'));

    expect(started, 'the refresh must have been started').toBe(true);
    expect(commands.length).toBeGreaterThan(0);
  });
});
