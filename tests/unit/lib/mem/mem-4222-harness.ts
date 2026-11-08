/**
 * Shared set-up of the Issue #4222 tests: a migrated file DB under `os.tmpdir()`, one
 * registered root, worktrees, and a fake `exec` for `gh` / `git` (nothing real is
 * called unless a test passes the real one). Not a test file.
 */
import type Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import path from 'path';
import { openMigratedFileDb } from '@tests/helpers/migrated-file-db';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';
import { createRepository } from '@/lib/db/db-repository';
import { setAgentInstances } from '@/lib/db/agent-instances-db';
import { getMemSettings, saveMemSettings } from '@/lib/db/mem-db';
import { memAddItem, type MemServiceDeps } from '@/lib/mem/service';
import type { ExecOptions, ExecResult, MemExec } from '@/lib/mem/query-plan';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import type { MemKind, MemWriteResponse } from '@/types/mem';

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);

export interface ExecCall {
  file: 'gh' | 'git';
  args: string[];
  cwd?: string;
}

export type ExecHandler = (call: ExecCall, options: ExecOptions) => Promise<Partial<ExecResult>> | Partial<ExecResult>;

export const ok = (stdout: string): Partial<ExecResult> => ({ code: 0, stdout });
export const fail = (code: number, stderr = ''): Partial<ExecResult> => ({ code, stderr });
export const json = (value: unknown): Partial<ExecResult> => ok(JSON.stringify(value));

export class FakeExec {
  readonly calls: ExecCall[] = [];
  started = 0;
  finished = 0;
  constructor(public handler: ExecHandler = () => fail(1, 'no handler')) {}
  readonly exec: MemExec = async (file, args, options) => {
    const call = { file, args: [...args], cwd: options.cwd };
    this.calls.push(call);
    this.started += 1;
    try {
      const partial = await this.handler(call, options);
      return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, missing: false, overflow: false, ...partial };
    } finally {
      this.finished += 1;
    }
  };
  count(predicate: (call: ExecCall) => boolean = () => true): number {
    return this.calls.filter(predicate).length;
  }
}

export class MemWorld {
  dir!: string;
  db!: Database.Database;
  root!: string;
  repo!: string;
  head: WorktreeHeadObservation = { branch: 'feature/x', detached: false, head: SHA, commonDir: '/common/.git', known: true };
  fake = new FakeExec();
  clock: (() => number) | null = null;
  gate: { wait: Promise<void>; armed: boolean } | null = null;

  open(prefix: string): void {
    this.dir = makeTempDir(prefix);
    this.db = openMigratedFileDb(path.join(this.dir, 'cm.db'), { foreignKeys: true });
    this.root = path.join(this.dir, 'root-a');
    mkdirSync(this.root, { recursive: true });
    this.repo = createRepository(this.db, { name: 'repo-a', path: this.root, cloneSource: 'local' }).id;
    this.fake = new FakeExec();
    this.clock = null;
    this.gate = null;
    this.head = { branch: 'feature/x', detached: false, head: SHA, commonDir: '/common/.git', known: true };
  }

  close(): void {
    this.db.close();
    removeTempDir(this.dir);
  }

  worktree(id: string, roster: Array<{ id: string; cliTool: 'claude' | 'codex' }> | null = [{ id: 'claude', cliTool: 'claude' }]): string {
    const wtPath = path.join(this.dir, id);
    mkdirSync(wtPath, { recursive: true });
    this.db
      .prepare(`INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES (?, ?, ?, ?, 'repo')`)
      .run(id, id, wtPath, this.root);
    if (roster) setAgentInstances(this.db, id, roster.map((entry, order) => ({ ...entry, alias: '', order })));
    return wtPath;
  }

  setMode(mode: 'off' | 'derived' | 'on'): void {
    const current = getMemSettings(this.db, this.repo);
    saveMemSettings(this.db, this.repo, { version: current.version, features: current.features, rules: [{ match: 'glob', pattern: '**', mode }] });
  }

  /** Hold the next `observe` (the target's await) until released. */
  arm(): () => void {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    this.gate = { wait, armed: true };
    return release;
  }

  deps(extra: Partial<MemServiceDeps> = {}): MemServiceDeps {
    return {
      resolveCommonDir: async () => '/common/.git',
      pathExists: () => true,
      observe: async () => {
        const seen = { ...this.head };
        if (this.gate?.armed) {
          this.gate.armed = false;
          await this.gate.wait;
        }
        return seen;
      },
      git: { originUrl: async () => 'git@github.com:Kewton/CommandMate.git', refTip: async () => SHA },
      ...(this.clock ? { now: this.clock } : {}),
      evaluation: { exec: this.fake.exec, ...(this.clock ? { now: this.clock } : {}) },
      ...extra,
    };
  }

  async add(kind: Exclude<MemKind, 'now'>, closeWhen: string | undefined, options: { worktreeId?: string; instanceId?: string; text?: string } = {}) {
    const outcome = await memAddItem(
      this.db,
      options.worktreeId ?? 'wt-1',
      { instanceId: options.instanceId ?? 'claude', kind, text: options.text ?? `${kind} item`, ...(closeWhen ? { closeWhen } : {}) },
      this.deps()
    );
    if (outcome.status >= 300) throw new Error(`add failed: ${JSON.stringify(outcome.body)}`);
    return (outcome.body as MemWriteResponse).item;
  }

  count(sql: string, ...params: unknown[]): number {
    return (this.db.prepare(sql).get(...params) as { n: number }).n;
  }

  itemState(id: string): string | undefined {
    return (this.db.prepare('SELECT state FROM mem_items WHERE id = ?').get(id) as { state: string } | undefined)?.state;
  }
}

/** `gh api --hostname h repos/o/r/issues/n` → the path, or null. */
export const ghPath = (call: ExecCall): string | null => (call.file === 'gh' ? call.args[3] ?? null : null);
