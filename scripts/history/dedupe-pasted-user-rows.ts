/**
 * One-off cleanup for Issue #3102: `user` rows that duplicate a sent message
 * because they hold it wrapped in Claude Code's `<pasted_content id="X">` marks.
 *
 * Usage:
 *   tsx scripts/history/dedupe-pasted-user-rows.ts --db <path>            # dry run (default)
 *   tsx scripts/history/dedupe-pasted-user-rows.ts --db <path> --apply    # change the DB
 *
 * A wrapped row is keyed `claude-prompt:<uuid>`. Once its marks are taken off, it
 * is compared with the other `user` rows of the same worktree and instance within
 * two minutes (the window `recordUserTurn` uses):
 *
 *  - a `/send` row (no `request_id`): the key moves onto it and the wrapped row is
 *    deleted. The key has to move first — without it the next transcript read
 *    would write the wrapped row again;
 *  - a relay row (`relay:<ledgerId>`): left exactly as it is, since the loop guard
 *    reads the ledger id back out of it, and only the wrapped row is deleted;
 *  - neither: left alone and only counted.
 */

import Database from 'better-sqlite3';
import { claudePastedContentPrompt } from '../../src/lib/hooks/sources/claude/transcript';
import { normalizeUserTurnContent, USER_TURN_ADOPTION_WINDOW_MS } from '../../src/lib/history/user-turn-recorder';

const KEY_PREFIX = 'claude-prompt:';
const RELAY_PREFIX = 'relay:';

/** The `chat_messages` columns the plan reads. */
export interface DedupeRow {
  readonly id: string;
  readonly worktree_id: string;
  readonly cli_tool_id: string | null;
  readonly instance_id: string | null;
  readonly content: string;
  readonly timestamp: number;
  readonly request_id: string | null;
  readonly message_type: string | null;
}

export type DedupeAction =
  | { readonly kind: 'move-key'; readonly wrappedId: string; readonly targetId: string; readonly requestId: string }
  | { readonly kind: 'delete-wrapped'; readonly wrappedId: string; readonly relayId: string }
  | { readonly kind: 'leave'; readonly wrappedId: string };

export interface DedupePlan {
  readonly actions: readonly DedupeAction[];
  readonly moveKey: number;
  readonly deleteWrapped: number;
  readonly left: number;
}

/** The body with the paste marks taken off, or null when the row has none. */
export function unwrapPastedContent(content: string): string | null {
  const unwrapped = claudePastedContentPrompt(content);
  return unwrapped === content ? null : unwrapped;
}

function instanceOf(row: DedupeRow): string {
  return row.instance_id ?? row.cli_tool_id ?? 'claude';
}

function isRelayRow(row: DedupeRow): boolean {
  return row.message_type === 'relay' && (row.request_id ?? '').startsWith(RELAY_PREFIX) && row.request_id!.length > RELAY_PREFIX.length;
}

/** Whether `row` is a row that carries a paste wrapper and a transcript key. */
function isWrappedRow(row: DedupeRow): boolean {
  return (row.request_id ?? '').startsWith(KEY_PREFIX) && unwrapPastedContent(row.content) !== null;
}

/**
 * The row that already holds a wrapped row's text, `/send` rows before relay rows.
 *
 * @param taken - `/send` rows already given to another wrapped row
 */
export function findCounterpart(
  wrapped: DedupeRow,
  rows: readonly DedupeRow[],
  taken: ReadonlySet<string> = new Set()
): DedupeRow | null {
  const body = unwrapPastedContent(wrapped.content);
  if (body === null) return null;
  const normalized = normalizeUserTurnContent(body);
  if (normalized.length === 0) return null;

  const candidates = rows
    .filter(
      (row) =>
        row.id !== wrapped.id &&
        row.worktree_id === wrapped.worktree_id &&
        instanceOf(row) === instanceOf(wrapped) &&
        Math.abs(row.timestamp - wrapped.timestamp) <= USER_TURN_ADOPTION_WINDOW_MS &&
        normalizeUserTurnContent(row.content) === normalized &&
        ((row.request_id === null && !taken.has(row.id)) || isRelayRow(row))
    )
    .sort((a, b) => Math.abs(a.timestamp - wrapped.timestamp) - Math.abs(b.timestamp - wrapped.timestamp));

  return candidates.find((row) => row.request_id === null) ?? candidates[0] ?? null;
}

/** Decide what to do with every wrapped row. Pure: reads nothing but `rows`. */
export function planDedupe(rows: readonly DedupeRow[]): DedupePlan {
  const taken = new Set<string>();
  const actions: DedupeAction[] = [];
  const wrappedRows = rows.filter(isWrappedRow).sort((a, b) => a.timestamp - b.timestamp);

  for (const wrapped of wrappedRows) {
    const counterpart = findCounterpart(wrapped, rows, taken);
    if (counterpart === null) {
      actions.push({ kind: 'leave', wrappedId: wrapped.id });
    } else if (counterpart.request_id === null) {
      taken.add(counterpart.id);
      actions.push({
        kind: 'move-key',
        wrappedId: wrapped.id,
        targetId: counterpart.id,
        requestId: wrapped.request_id as string,
      });
    } else {
      actions.push({ kind: 'delete-wrapped', wrappedId: wrapped.id, relayId: counterpart.id });
    }
  }

  const count = (kind: DedupeAction['kind']) => actions.filter((action) => action.kind === kind).length;
  return {
    actions,
    moveKey: count('move-key'),
    deleteWrapped: count('delete-wrapped'),
    left: count('leave'),
  };
}

/** Read the user rows the plan can look at. */
export function loadUserRows(db: Database.Database): DedupeRow[] {
  return db
    .prepare(
      `SELECT id, worktree_id, cli_tool_id, instance_id, content, timestamp, request_id, message_type
       FROM chat_messages WHERE role = 'user' AND archived = 0`
    )
    .all() as DedupeRow[];
}

/** Carry out a plan in one transaction. Throws (and changes nothing) if a row moved under it. */
export function applyDedupePlan(db: Database.Database, plan: DedupePlan): void {
  const remove = db.prepare('DELETE FROM chat_messages WHERE id = ?');
  const claim = db.prepare('UPDATE chat_messages SET request_id = ? WHERE id = ? AND request_id IS NULL');
  db.transaction(() => {
    for (const action of plan.actions) {
      if (action.kind === 'leave') continue;
      // Delete first: the key may be unique-indexed, and it must be free to move.
      if (remove.run(action.wrappedId).changes !== 1) {
        throw new Error(`row ${action.wrappedId} disappeared before it could be deleted`);
      }
      if (action.kind === 'move-key' && claim.run(action.requestId, action.targetId).changes !== 1) {
        throw new Error(`row ${action.targetId} was keyed by someone else`);
      }
    }
  })();
}

export interface DedupeArgs {
  readonly dbPath: string;
  readonly apply: boolean;
}

export function parseArgs(argv: readonly string[]): DedupeArgs {
  let dbPath = 'data/db.sqlite';
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--db') {
      const value = argv[i + 1];
      if (!value) throw new Error('--db needs a path');
      dbPath = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dbPath, apply };
}

/** Open the DB, plan, and apply only with `--apply`. */
export function run(argv: readonly string[], log: (line: string) => void = console.log): DedupePlan {
  const args = parseArgs(argv);
  const db = new Database(args.dbPath, { fileMustExist: true });
  try {
    const plan = planDedupe(loadUserRows(db));
    log(`${args.apply ? 'apply' : 'dry-run'}: ${args.dbPath}`);
    log(`  move key to /send row and delete wrapped row: ${plan.moveKey}`);
    log(`  delete wrapped row (relay row kept):          ${plan.deleteWrapped}`);
    log(`  left (no counterpart):                        ${plan.left}`);
    if (args.apply) applyDedupePlan(db, plan);
    else log('  (dry run: nothing changed; pass --apply to change the DB)');
    return plan;
  } finally {
    db.close();
  }
}

if (process.argv[1] && /dedupe-pasted-user-rows\.[tj]s$/.test(process.argv[1])) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
