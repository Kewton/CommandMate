/**
 * Issue #4466 PR0: what the table observes — the snapshot of the tables a send operation
 * writes and of what it does outside the database, and their difference (design §6.1
 * 「観測は、対象の表の中身の snapshot の差分」, review A P2-1).
 *
 * The rows are compared by content, not counted: a refused operation that rewrites a row
 * in place (a role setting turned and turned back, a relay `requested` → `cancelled`) is a
 * change too. The readers of the outside are passed in, because the fakes that record
 * them (tmux, the tool, the WebSocket) are the test file's mocks.
 */

import type Database from 'better-sqlite3';

/** The tables of §6.1: tasks, the roster and its roles, relays, the transcript, mem and its incarnations. */
export const OBSERVED_TABLES = [
  'tasks',
  'task_events',
  'agent_instances',
  'agent_instance_roles',
  'session_relays',
  'chat_messages',
  'mem_items',
  'mem_worktree_incarnations',
  'mem_instance_incarnations',
] as const;
export type ObservedTable = (typeof OBSERVED_TABLES)[number];

/** Outside the database (§6.1): grants, pollers, env baselines, keys, launches, broadcasts. */
export interface OutsideObservation {
  /** `cliToolId/instanceId` of every enabled grant (`peekAutoYesState`). */
  grants: string[];
  /** Pollers started (Auto-Yes and response pollers). */
  pollers: string[];
  /** Files in the env-snapshot directory. */
  envSnapshots: string[];
  /** What was typed into the fake tmux, `tool:message`. */
  typed: string[];
  /** Fake tool launches, `tool:instanceId`. */
  launched: string[];
  /** WebSocket broadcasts the fake recorded. */
  broadcasts: string[];
}

export interface OperationSnapshot {
  tables: Record<ObservedTable, string[]>;
  outside: OutsideObservation;
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** Every row of the observed tables, as JSON, sorted (order of insertion is not the subject). */
export function snapshotTables(db: Database.Database): Record<ObservedTable, string[]> {
  const tables = {} as Record<ObservedTable, string[]>;
  for (const table of OBSERVED_TABLES) {
    if (!tableExists(db, table)) {
      // A renamed table must not read as "nothing changed": the self-check of the test pins all of them.
      tables[table] = ['<missing table>'];
      continue;
    }
    const rows = db.prepare(`SELECT * FROM "${table}"`).all() as unknown[];
    tables[table] = rows.map((row) => JSON.stringify(row)).sort();
  }
  return tables;
}

export function takeSnapshot(db: Database.Database, outside: () => OutsideObservation): OperationSnapshot {
  const seen = outside();
  return {
    tables: snapshotTables(db),
    outside: {
      grants: [...seen.grants].sort(),
      pollers: [...seen.pollers],
      envSnapshots: [...seen.envSnapshots].sort(),
      typed: [...seen.typed],
      launched: [...seen.launched],
      broadcasts: [...seen.broadcasts],
    },
  };
}

/** One part that differs: `+n` rows / items added, `-n` removed (a rewrite is both). */
export interface Change {
  part: ObservedTable | keyof OutsideObservation;
  added: string[];
  removed: string[];
}

function multisetDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const left = new Map<string, number>();
  for (const item of before) left.set(item, (left.get(item) ?? 0) + 1);
  const added: string[] = [];
  for (const item of after) {
    const n = left.get(item) ?? 0;
    if (n > 0) left.set(item, n - 1);
    else added.push(item);
  }
  const removed = [...left.entries()].flatMap(([item, n]) => Array.from({ length: n }, () => item));
  return { added, removed };
}

/** What changed between two snapshots; empty when nothing did (a refusal's I1). */
export function diffSnapshots(before: OperationSnapshot, after: OperationSnapshot): Change[] {
  const changes: Change[] = [];
  for (const table of OBSERVED_TABLES) {
    const { added, removed } = multisetDiff(before.tables[table], after.tables[table]);
    if (added.length > 0 || removed.length > 0) changes.push({ part: table, added, removed });
  }
  for (const part of Object.keys(before.outside) as Array<keyof OutsideObservation>) {
    const { added, removed } = multisetDiff(before.outside[part], after.outside[part]);
    if (added.length > 0 || removed.length > 0) changes.push({ part, added, removed });
  }
  return changes;
}

/**
 * The changes left once the test's own are taken out: an interrupt (h-S2, a K1 change
 * between two requests) rewrites the roster or the default on purpose, and that rewrite is
 * the row's input, not something the operation left.
 */
export function withoutOwnChanges(changes: readonly Change[], own: readonly Change[]): Change[] {
  return changes
    .map((change) => {
      const mine = own.filter(({ part }) => part === change.part);
      const minus = (items: string[], taken: string[]): string[] => multisetDiff(taken, items).added;
      return {
        part: change.part,
        added: minus(change.added, mine.flatMap(({ added }) => added)),
        removed: minus(change.removed, mine.flatMap(({ removed }) => removed)),
      };
    })
    .filter(({ added, removed }) => added.length > 0 || removed.length > 0);
}

/** `part +a -r` per change, for a readable assertion message. */
export function summarizeChanges(changes: readonly Change[]): string[] {
  return changes.map(({ part, added, removed }) => `${part} +${added.length} -${removed.length}`);
}
