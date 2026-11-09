/**
 * What the #4224 (D2) send tests add to the #4274 world (`session-brief-4274-harness.ts`):
 * C's real provider bound to the world's database, the request's entrance (the two pins the
 * send route takes), a send with a pin taken when the test says, the worktree deleted and
 * made again under the same id and path, and a fingerprint of every `mem_*` table.
 *
 * Nothing here touches the repository's files, tmux or a server. Not a test file.
 */
import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { deleteWorktreesByIds } from '@/lib/db/worktree-db';
import { createMemBriefProvider, type MemBriefProviderState } from '@/lib/brief/provider';
import type { BriefSourceId } from '@/types/brief';
import type { BriefSourceReader } from '@/lib/brief/sources';
import { setBriefProviderForTest, type BriefProvider } from '@/lib/session/brief-provider';
import { pinBriefRequest, pinBriefWorktree, type BriefReport, type BriefRequestPin } from '@/lib/session/session-brief';
import { sendUserMessage, type SendUserMessageResult } from '@/lib/session/send-user-message';
import { memAddItem, memCheck, type MemServiceDeps } from '@/lib/mem/service';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { WT, type World } from './session-brief-4274-harness';

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** #4222's dependencies on this world: the same git answers the send's `withMemTarget` gets. */
export function memDeps(world: World): MemServiceDeps {
  return {
    resolveCommonDir: async () => '/common/.git',
    pathExists: () => true,
    observe: async () => ({ branch: world.branch, detached: false, head: SHA, commonDir: '/common/.git', known: true }),
    git: { originUrl: async () => 'git@github.com:Kewton/CommandMate.git', refTip: async () => SHA },
    evaluation: { exec: async () => ({ code: 1, stdout: '', stderr: 'no exec in this world', timedOut: false }) } as unknown as MemServiceDeps['evaluation'],
  };
}

/** The sources that read outside the database are quiet here (S6 run logs, S9 transcripts). */
const QUIET: Partial<Record<BriefSourceId, BriefSourceReader>> = {
  run: () => ({ status: 'ok', items: [] }),
  transcript: () => ({ status: 'ok', items: [] }),
};

export interface RealPort {
  port: BriefProvider;
  state: MemBriefProviderState;
}

/**
 * C's provider on this world, composed as `MEM_BRIEF_PORT` is (`{ ...provider, settle }`),
 * and handed to the send service. `wrapBuild` runs before each build (a re-creation there).
 */
export function realPort(world: World, options: { beforeBuild?: (call: number) => void } = {}): RealPort {
  const deps = memDeps(world);
  const state = createMemBriefProvider(() => world.db, { target: deps, evaluation: deps.evaluation, readers: QUIET, notices: {} });
  let calls = 0;
  const port: BriefProvider = {
    ...state.provider,
    build: (request) => {
      calls += 1;
      options.beforeBuild?.(calls);
      return state.provider.build(request);
    },
    settle: state.settle,
  };
  setBriefProviderForTest(port);
  return { port, state };
}

/** Delete the worktree (its children go with it) and register it again: same id, same path. */
export function recreateWorktree(world: World): void {
  deleteWorktreesByIds(world.db, [WT]);
  world.db.prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`).run(WT, WT, world.wtPath, world.root);
}

/** The request's entrance, as the send route takes it (step 1 then step 2). */
export function entrance(world: World, instanceId: string): BriefRequestPin {
  return pinBriefRequest(world.db, pinBriefWorktree(world.db, WT), instanceId);
}

export interface PinnedSent {
  result: SendUserMessageResult;
  report: BriefReport | null;
}

/** A send with the pin the test took (its entrance may be long before). */
export async function sendPinned(
  world: World,
  tool: string,
  content: string,
  pin: BriefRequestPin,
  brief: 'auto' | 'force' = 'auto'
): Promise<PinnedSent> {
  let report: BriefReport | null = null;
  const result = await sendUserMessage(world.db, {
    worktreeId: WT,
    content,
    cliToolId: tool as CLIToolType,
    brief,
    briefPin: pin,
    onBrief: (r) => {
      report = r;
    },
  });
  return { result, report };
}

/** Every `mem_*` table's rows, in a stable order, hashed — what "wrote nothing to mem" compares. */
export function memFingerprint(db: Database.Database): { counts: Record<string, number>; hash: string } {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mem_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (row) => row.name
  );
  const hash = createHash('sha256');
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    counts[table] = rows.length;
    hash.update(table);
    for (const row of rows.map((r) => JSON.stringify(r)).sort()) hash.update(row);
  }
  return { counts, hash: hash.digest('hex') };
}

/** One `on` item of `claude` that closes when read, and the "it ended" notice it leaves for claude. */
export async function noticeForClaude(world: World, text = 'wait for it'): Promise<string> {
  const deps = memDeps(world);
  const added = await memAddItem(world.db, WT, { instanceId: 'claude', kind: 'waiting', text, closeWhen: 'at:2020-01-01T00:00+00:00' }, deps);
  if (added.status >= 300) throw new Error(`add failed: ${JSON.stringify(added.body)}`);
  await memCheck(world.db, { via: 'worktree', worktreeId: WT }, { instanceId: 'codex' }, deps);
  const row = world.db.prepare("SELECT id FROM mem_notices WHERE state = 'pending' ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
  if (!row) throw new Error('no notice was made');
  return row.id;
}

export const noticeState = (world: World, id: string): string =>
  (world.db.prepare('SELECT state FROM mem_notices WHERE id = ?').get(id) as { state: string }).state;
