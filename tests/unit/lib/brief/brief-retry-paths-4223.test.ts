/**
 * Every way the brief builds a request again (review P1, 2026-11-09; the same kind of
 * miss as #4221's purge: a generation not checked). A rebuild must never carry a request
 * read before the worktree / instance was deleted and made again to the one made later.
 *
 * The table is checked against `src/lib/brief/**` itself: every function that calls
 * `buildBrief(` is a row, and whether it calls it inside a loop (a rebuild) is the row's
 * `retries`. A new caller, or a new loop around an existing one, fails here until it has
 * a row that runs the re-creation through it. The reasons a build gives up
 * (`BRIEF_CHANGE_REASONS`) are each the route's decision to rebuild or not.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ onInfo: null as null | ((event: string) => void) }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const quiet = () => undefined;
    return { info: (event: string) => hooks.onInfo?.(event), warn: quiet, error: quiet, debug: quiet, withContext: () => ({}) };
  },
}));

import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { addAgentInstance, removeAgentInstance } from '@/lib/db/agent-instances-db';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { getInstanceIncarnation } from '@/lib/mem/incarnation';
import { BRIEF_CHANGE_REASONS, BriefMembershipChangedError } from '@/lib/brief/build';
import { createMemBriefProvider } from '@/lib/brief/provider';
import { BRIEF_ROUTE_RETRIES } from '@/lib/brief/service';
import type { BriefSourceReader } from '@/lib/brief/sources';
import type { BriefRequest } from '@/lib/session/brief-provider';
import { BriefWorld, resetBriefMemory } from './brief-4223-harness';

const BRIEF_DIR = path.join(process.cwd(), 'src', 'lib', 'brief');

/** `file:function` → whether it builds again in a loop. Found from the source below. */
function buildCallers(sources: Record<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [file, source] of Object.entries(sources)) {
    const starts = [...source.matchAll(/^\s*(?:export )?(?:async )?function (\w+)/gm)];
    starts.forEach((match, index) => {
      const body = source.slice(match.index, starts[index + 1]?.index ?? source.length);
      const call = body.search(/\bbuildBrief\(/);
      if (match[1] === 'buildBrief' || call < 0) return;
      out[`${file}:${match[1]}`] = /\b(for|while)\s*\(/.test(body.slice(0, call));
    });
  }
  return out;
}

const briefSources = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(BRIEF_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [`src/lib/brief/${name}`, readFileSync(path.join(BRIEF_DIR, name), 'utf8')])
  );

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
    target: { worktreeId: 'wt-1', cliToolId: 'claude', instanceId: 'claude', instanceIncarnation: getInstanceIncarnation(world.db, 'wt-1', 'claude')?.incarnation ?? null },
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

const ROWS: Record<string, RetryRow> = {
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
  it('the table names every caller of buildBrief in src/lib/brief/** and whether it rebuilds', () => {
    const found = buildCallers(briefSources());
    expect(found).toEqual(Object.fromEntries(Object.entries(ROWS).map(([key, row]) => [key, row.retries])));
  });

  it('(control) the scan catches a new caller and a new loop around one', () => {
    const sources = briefSources();
    const extra = {
      ...sources,
      'src/lib/brief/extra.ts': `export async function again(db: never) {\n  while (true) {\n    await buildBrief(db, db, db);\n  }\n}\nexport async function once(db: never) {\n  return buildBrief(db, db, db);\n}\n`,
    };
    expect(buildCallers(extra)).toMatchObject({ 'src/lib/brief/extra.ts:again': true, 'src/lib/brief/extra.ts:once': false });
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
