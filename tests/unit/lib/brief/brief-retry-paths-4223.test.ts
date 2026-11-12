/**
 * Every way the brief builds a request again (review P1, 2026-11-09; the same kind of
 * miss as #4221's purge: a generation not checked). A rebuild must never carry a request
 * read before the worktree / instance was deleted and made again to the one made later.
 *
 * The table is checked against `src/` itself (`brief-call-chain.ts`): every function in
 * the chain of callers of `buildBrief` — arrow functions, methods, aliases and the API
 * around `briefForRoute` included — is a row, and whether it calls the chain inside a
 * loop (a rebuild) is the row's `retries`. A new caller, or a new loop around an existing
 * one, fails here until it has a row that runs the re-creation through it. The reasons a build gives up
 * (`BRIEF_CHANGE_REASONS`) are each the route's decision to rebuild or not.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ onInfo: null as null | ((event: string) => void), db: null as unknown }));
vi.mock('@/lib/db/db-instance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/db-instance')>()),
  getDbInstance: () => hooks.db,
}));
vi.mock('@/lib/brief/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/brief/service')>();
  return { ...actual, briefForRoute: vi.fn(actual.briefForRoute) };
});
// Issue #4227 G-PR3: the start preview's route answers what handoffStartPreview answered, once.
vi.mock('@/lib/handoff/preview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/handoff/preview')>();
  return { ...actual, handoffStartPreview: vi.fn(actual.handoffStartPreview) };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: (event: string) => hooks.onInfo?.(event), warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { NextRequest } from 'next/server';
import { addAgentInstance, removeAgentInstance } from '@/lib/db/agent-instances-db';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { getInstanceIncarnation, getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';
import { readInstanceLifetime } from '@/lib/db/session-brief-db';
import { BRIEF_CHANGE_REASONS, BriefMembershipChangedError } from '@/lib/brief/build';
import { createMemBriefProvider } from '@/lib/brief/provider';
import { BRIEF_ROUTE_RETRIES, briefForRoute } from '@/lib/brief/service';
import { GET } from '@/app/api/worktrees/[id]/mem/brief/route';
import { GET as START_PREVIEW_GET } from '@/app/api/worktrees/[id]/mem/start-preview/route';
import { handoffStartPreview, type StartPreviewResponse } from '@/lib/handoff/preview';
import { openBoundary } from '@/lib/db/session-brief-db';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { briefCallChain, chainSources } from './brief-call-chain';
import type { BriefSourceReader } from '@/lib/brief/sources';
import type { BriefRequest } from '@/lib/session/brief-provider';
import { BriefWorld, resetBriefMemory } from './brief-4223-harness';

const world = new BriefWorld();
const recreate = () => {
  deleteWorktreesByIds(world.db, ['wt-1']);
  world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
};
const closedCount = () => world.count("SELECT COUNT(*) n FROM mem_items WHERE state = 'closed'");
const writtenB = () => world.count('SELECT COUNT(*) n FROM mem_close_records') + world.count('SELECT COUNT(*) n FROM mem_notices');
const ISSUE = (state: 'open' | 'closed') => ({ code: 0, stdout: JSON.stringify({ state, state_reason: state === 'closed' ? 'completed' : null }) });

function request(): BriefRequest {
  return {
    // Issue #4224: the lifetimes a send's entrance fixes (D2 design §2.4), as of now.
    target: {
      worktreeId: 'wt-1',
      worktreeIncarnation: getOrCreateWorktreeIncarnation(world.db, 'wt-1'),
      cliToolId: 'claude',
      instanceId: 'claude',
      instanceIncarnation: getInstanceIncarnation(world.db, 'wt-1', 'claude')?.incarnation ?? null,
      instanceOnRoster: readInstanceLifetime(world.db, 'wt-1', 'claude').onRoster,
    },
    membership: { repositoryId: world.repo, readRepositoryIds: [world.repo], branch: 'feature/x', detached: false, mode: 'on' },
    boundary: { id: 'b-1', kind: 'launch', late: false, openedAt: Date.now() },
    budget: { maxBytes: 4096, maxLines: 240 },
    now: Date.now(),
  };
}

interface RetryRow {
  retries: boolean;
  /** The worktree re-made during the first build only: nothing closed, the request refused. */
  recreatedOnce: () => Promise<void>;
  /** Re-made between a first build that gave up for another reason and the rebuild. */
  recreatedBetween?: () => Promise<void>;
  /** Left alone: the condition closes (the negative control). */
  untouched: () => Promise<void>;
}

/** Issue #4227 G-PR3: the start preview shows (attended, injectOnStart, a pending boundary of claude). */
function previewShows(): void {
  const current = getMemSettings(world.db, world.repo);
  saveMemSettings(world.db, world.repo, { version: current.version, features: { ...current.features, popup: true, injectOnStart: true }, rules: [{ match: 'glob', pattern: '**', mode: 'on' }] });
  openBoundary(world.db, { worktreeId: 'wt-1', instanceId: 'claude', cliToolId: 'claude', lifetime: readInstanceLifetime(world.db, 'wt-1', 'claude'), kind: 'launch', evidence: 'launch', openedAt: Date.now() });
}
const startPreview = () => handoffStartPreview(world.db, 'wt-1', 'claude', { mem: world.deps(), brief: world.briefDeps() });

const ROWS: Record<string, RetryRow> = {
  'src/app/api/worktrees/[id]/mem/start-preview/route.ts:GET': {
    retries: false,
    recreatedOnce: async () => {
      // The route answers what handoffStartPreview answered, once: it adds no rebuild of its own.
      hooks.db = world.db;
      vi.mocked(handoffStartPreview).mockClear();
      vi.mocked(handoffStartPreview).mockResolvedValueOnce({ status: 404, body: { ok: false, code: 'not_found' } });
      const response = await START_PREVIEW_GET(new NextRequest('http://localhost/api/worktrees/wt-1/mem/start-preview?instance=claude'), { params: Promise.resolve({ id: 'wt-1' }) });
      expect(response.status).toBe(404);
      expect(vi.mocked(handoffStartPreview)).toHaveBeenCalledTimes(1);
      expect(closedCount()).toBe(0);
    },
    untouched: async () => {
      hooks.db = world.db;
      vi.mocked(handoffStartPreview).mockClear();
      vi.mocked(handoffStartPreview).mockResolvedValueOnce({ status: 200, body: { ok: true, show: false } });
      const response = await START_PREVIEW_GET(new NextRequest('http://localhost/api/worktrees/wt-1/mem/start-preview?instance=claude'), { params: Promise.resolve({ id: 'wt-1' }) });
      expect(response.status).toBe(200);
      expect(vi.mocked(handoffStartPreview)).toHaveBeenCalledTimes(1);
    },
  },
  'src/lib/handoff/preview.ts:handoffStartPreview': {
    retries: false,
    recreatedOnce: async () => {
      await world.add('next', 'issue:#1');
      previewShows();
      let calls = 0;
      world.fake.handler = () => {
        calls += 1;
        if (calls === 1) recreate();
        return ISSUE('closed');
      };
      vi.mocked(briefForRoute).mockClear();
      const outcome = await startPreview();
      // One build of C (it does not rebuild for an ended lifetime); the preview says it could not read.
      expect(vi.mocked(briefForRoute)).toHaveBeenCalledTimes(1);
      expect(calls).toBe(1);
      expect((outcome.body as StartPreviewResponse & { preview?: unknown }).preview ?? null).toBeNull();
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    untouched: async () => {
      await world.add('next', 'issue:#1');
      previewShows();
      world.fake.handler = () => ISSUE('closed');
      const outcome = await startPreview();
      expect((outcome.body as StartPreviewResponse).show).toBe(true);
      expect(closedCount()).toBe(1);
    },
  },
  'src/app/api/worktrees/[id]/mem/brief/route.ts:GET': {
    retries: false,
    recreatedOnce: async () => {
      // The route answers what briefForRoute answered, once: it adds no rebuild of its own.
      hooks.db = world.db;
      vi.mocked(briefForRoute).mockClear();
      vi.mocked(briefForRoute).mockResolvedValueOnce({ status: 404, body: { ok: false, code: 'not_found', reason: 'lifetime_changed' } });
      const response = await GET(new NextRequest('http://localhost/api/worktrees/wt-1/mem/brief?instance=claude'), { params: Promise.resolve({ id: 'wt-1' }) });
      expect(response.status).toBe(404);
      expect(vi.mocked(briefForRoute)).toHaveBeenCalledTimes(1);
      expect(closedCount()).toBe(0);
    },
    untouched: async () => {
      hooks.db = world.db;
      vi.mocked(briefForRoute).mockClear();
      vi.mocked(briefForRoute).mockResolvedValueOnce({ status: 200, body: { ok: true, format: 'text', mode: 'on', text: 'x', omitted: 0 } });
      const response = await GET(new NextRequest('http://localhost/api/worktrees/wt-1/mem/brief?instance=claude'), { params: Promise.resolve({ id: 'wt-1' }) });
      expect(response.status).toBe(200);
      expect(vi.mocked(briefForRoute)).toHaveBeenCalledTimes(1);
    },
  },
  'src/lib/brief/service.ts:briefForRoute': {
    retries: true,
    recreatedOnce: async () => {
      await world.add('next', 'issue:#1');
      let calls = 0;
      world.fake.handler = () => {
        calls += 1;
        if (calls === 1) recreate();
        return ISSUE('closed');
      };
      const run = await world.brief();
      expect(run.exit).toBe(52);
      expect(run.body).toMatchObject({ code: 'not_found', reason: 'lifetime_changed' });
      expect(calls).toBe(1);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    recreatedBetween: async () => {
      // 1st build: the issue is open; then the mode changes (a reason the route rebuilds
      // for) and the worktree is made again. Before the rebuild the mode is back to on and
      // the issue is closed: only the pinned lifetime stops the rebuild from closing it.
      await world.add('next', 'issue:#1');
      let open = true;
      world.fake.handler = () => ISSUE(open ? 'open' : 'closed');
      let changed = false;
      const state: BriefSourceReader = () => {
        if (!changed) {
          changed = true;
          world.setMode('derived');
          recreate();
        }
        return { status: 'ok', items: [] };
      };
      hooks.onInfo = (event) => {
        if (event !== 'brief-membership-changed') return;
        world.setMode('on');
        open = false;
      };
      const run = await world.brief({}, { readers: { state } });
      expect(run.exit).toBe(52);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
    },
    untouched: async () => {
      await world.add('next', 'issue:#1');
      world.fake.handler = () => ISSUE('closed');
      expect((await world.brief()).exit).toBe(0);
      expect(closedCount()).toBe(1);
    },
  },
  'src/lib/brief/provider.ts:build': {
    retries: false,
    recreatedOnce: async () => {
      await world.add('next', 'issue:#1');
      let calls = 0;
      world.fake.handler = () => {
        calls += 1;
        if (calls === 1) recreate();
        return ISSUE('closed');
      };
      const provider = createMemBriefProvider(() => world.db, world.briefDeps());
      await expect(provider.provider.build(request())).rejects.toBeInstanceOf(BriefMembershipChangedError);
      expect(calls).toBe(1);
      expect(closedCount()).toBe(0);
      expect(writtenB()).toBe(0);
      expect(provider.memoCount()).toBe(0);
    },
    untouched: async () => {
      await world.add('next', 'issue:#1');
      world.fake.handler = () => ISSUE('closed');
      const provider = createMemBriefProvider(() => world.db, world.briefDeps());
      expect((await provider.provider.build(request())).body).toContain('mode=on');
      expect(closedCount()).toBe(1);
    },
  },
};

beforeEach(() => {
  resetBriefMemory();
  hooks.onInfo = null;
  world.open('brief-retry-4223-');
  world.worktree('wt-1', [{ id: 'claude', cliTool: 'claude' }]);
  world.setMode('on');
});
afterEach(() => {
  hooks.onInfo = null;
  world.close();
  resetBriefMemory();
});

describe('every rebuild of a brief keeps the request’s lifetime', () => {
  const table = () => Object.fromEntries(Object.entries(ROWS).map(([key, row]) => [key, { retries: row.retries }]));

  it('the table names every caller in the chain of buildBrief in src/ and whether it rebuilds', () => {
    expect(briefCallChain(chainSources())).toEqual(table());
  });

  it.each([
    [
      'an arrow function only file',
      { 'src/lib/brief/extra.ts': `import { buildBrief } from './build';\nexport const again = async (db: never) => {\n  for (let i = 0; i < 2; i += 1) await buildBrief(db, db, db);\n};\n` },
      'src/lib/brief/extra.ts:again',
      true,
    ],
    [
      'an import alias',
      { 'src/lib/brief/extra.ts': `import { buildBrief as make } from './build';\nexport async function viaAlias(db: never) {\n  return make(db, db, db);\n}\n` },
      'src/lib/brief/extra.ts:viaAlias',
      false,
    ],
    [
      'a local alias in a loop',
      { 'src/lib/brief/extra.ts': `import { buildBrief } from './build';\nconst make = buildBrief;\nexport async function loop(db: never) {\n  while (db) await make(db, db, db);\n}\n` },
      'src/lib/brief/extra.ts:loop',
      true,
    ],
    [
      'a class method',
      { 'src/lib/brief/extra.ts': `import { buildBrief } from './build';\nexport class Again {\n  async run(db: never) {\n    do { await buildBrief(db, db, db); } while (db);\n  }\n}\n` },
      'src/lib/brief/extra.ts:Again.run',
      true,
    ],
    [
      'an API that retries briefForRoute (outside)',
      {
        'src/app/api/worktrees/[id]/mem/brief2/route.ts': `import { briefForRoute } from '@/lib/brief/service';\nexport const POST = async (db: never) => {\n  for (const _ of [1, 2]) await briefForRoute(db, db, db);\n};\n`,
      },
      'src/app/api/worktrees/[id]/mem/brief2/route.ts:POST',
      true,
    ],
    [
      'a namespace import retried',
      { 'src/lib/brief/extra.ts': `import * as svc from './service';\nexport async function viaNs(db: never) {\n  for (;;) await svc.briefForRoute(db, db, db);\n}\n` },
      'src/lib/brief/extra.ts:viaNs',
      true,
    ],
    [
      'a retry through a callback',
      { 'src/lib/brief/extra.ts': `import { briefForRoute } from './service';\nexport function twice(db: never) {\n  return [1, 2].map(async () => { for (;;) await briefForRoute(db, db, db); });\n}\n` },
      'src/lib/brief/extra.ts:twice',
      true,
    ],
  ])('(control) %s is found and the table comparison fails on it', (_name, extra, key, retries) => {
    const found = briefCallChain(chainSources(undefined, extra));
    expect(found[key]).toEqual({ retries });
    expect(found).not.toEqual(table());
  });

  it.each([
    ['export { buildBrief as make } from', `export { buildBrief as make } from './build';\n`],
    ['export const make = buildBrief', `import { buildBrief } from './build';\nexport const make = buildBrief;\n`],
  ])('(control) a re-exported alias (%s) used only by name in another file goes from the selection to the table and fails it', (_name, bridge) => {
    const extra = {
      'src/lib/brief/bridge.ts': bridge,
      'src/app/api/worktrees/[id]/mem/brief3/route.ts': `import { make } from '@/lib/brief/bridge';\nexport async function POST(db: never) {\n  while (db) await make(db, db, db);\n}\n`,
    };
    const selected = chainSources(undefined, extra);
    expect(Object.keys(selected)).toContain('src/app/api/worktrees/[id]/mem/brief3/route.ts');
    const found = briefCallChain(selected);
    expect(found['src/app/api/worktrees/[id]/mem/brief3/route.ts:POST']).toEqual({ retries: true });
    expect(found).not.toEqual(table());
  });

  it('(control) a file that only names buildBrief in a comment or a string is not a caller', () => {
    const found = briefCallChain(chainSources(undefined, { 'src/lib/brief/extra.ts': `// buildBrief(db) is called by the route\nexport const NOTE = 'buildBrief(';\n` }));
    expect(found).toEqual(table());
  });

  it('every reason a build gives up is the route’s decision; an ended lifetime is never rebuilt', () => {
    expect(Object.keys(BRIEF_ROUTE_RETRIES).sort()).toEqual([...BRIEF_CHANGE_REASONS].sort());
    expect(BRIEF_ROUTE_RETRIES.worktree_lifetime).toBe(false);
    expect(BRIEF_ROUTE_RETRIES.instance_lifetime).toBe(false);
  });

  for (const [key, row] of Object.entries(ROWS)) {
    it(`${key}: the worktree re-made during the first build only → not built again (closes nothing)`, async () => row.recreatedOnce());
    if (row.recreatedBetween) {
      const between = row.recreatedBetween;
      it(`${key}: a mode change, then the worktree re-made before the rebuild → the pinned lifetime refuses it`, async () => between());
    }
    it(`${key}: left alone → the condition closes (negative control)`, async () => row.untouched());
  }

  it('the route: the instance removed and added again during the first build → instance_not_found, nothing closed', async () => {
    await world.add('next', 'issue:#1');
    let calls = 0;
    world.fake.handler = () => {
      calls += 1;
      if (calls === 1) {
        removeAgentInstance(world.db, 'wt-1', 'claude');
        addAgentInstance(world.db, 'wt-1', { id: 'claude', cliTool: 'claude', alias: '', order: 1 });
      }
      return ISSUE('closed');
    };
    const run = await world.brief();
    expect(run.exit).toBe(52);
    expect(run.body).toMatchObject({ code: 'instance_not_found', reason: 'lifetime_changed' });
    expect(calls).toBe(1);
  });
});
