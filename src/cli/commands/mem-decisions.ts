/**
 * `commandmate mem decisions` — read a branch's decisions and one decision's reference diff
 * (Issue #4355, design `docs/design/mem-decisions-ux-4355.md` §3.4).
 *
 *   commandmate mem decisions [--worktree <id> [--branch <name>] | --repository <id> --branch <name>] [--pending] [--json]
 *   commandmate mem decisions <itemId> [--worktree <id> | --repository <id>] [--effect spec|record_only] [--json]
 *
 * Reads only, with GET: nothing here writes the decisions or makes what a person approves.
 * Approving stays on the screen (#4225 D9; the person's decision of 2026-11-13 kept the CLI
 * to reading). The diff printed here is a reference: it is never a preview, so it cannot be
 * approved, and it says so first.
 *
 * Kept apart from `mem.ts` (which has the writes of the items) so that the guard
 * `tests/unit/guards/mem-promote-screen-only-4225.test.ts`, which reads a file as a whole,
 * keeps saying "the CLI has no write of the decisions" (design §3.4.1).
 *
 * The free fields (the text, the quote, the destination, the body) were typed by an agent
 * or a person: the text output shows the terminal's controls as `\xHH` (`\n` kept only in
 * the body), and `--json` carries them as JSON strings only.
 */

import { Command } from 'commander';
import type { MemCommonOptions } from '../types';
import type { ApiClient } from '../utils/api-client';
import type { MemErrorCode, MemModeResponse } from '../../types/mem';
import { decisionCountsOf, type DecisionCountsMode } from '../../lib/promote/decision-counts';
import type { PromoteOperationView } from '../../lib/promote/model';
import type {
  MemDecisionDiffJsonV1,
  MemDecisionJsonV1,
  MemDecisionOperationJsonV1,
  MemDecisionsJsonV1,
  PromoteListWire,
  PromoteReferenceDiffView,
} from '../types/mem-decisions';

/** What `mem.ts` lends this command: its runner, its refusals and its target options. */
export interface MemDecisionsHost {
  run: (options: MemCommonOptions, action: (client: ApiClient) => Promise<void | number>) => Promise<void>;
  usage: (code: MemErrorCode, message: string, field?: string) => Error;
  /** The worktree of the caller's own session, if any. */
  sessionWorktreeId: (client: ApiClient) => Promise<string | undefined>;
  withTargetOptions: (command: Command, write: boolean) => Command;
}

export interface MemDecisionsOptions extends MemCommonOptions {
  pending?: boolean;
  effect?: string;
}

// ---------------------------------------------------------------------------
// The shapes (pure: the tests feed them the routes' real answers)
// ---------------------------------------------------------------------------

/** Show the terminal's controls (C0, DEL, C1, and the invisible / bidi code points) as escapes. */
export function escapeTerminal(value: string, keepNewlines = false): string {
  // eslint-disable-next-line no-control-regex -- the controls are what is escaped
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, (ch) => {
    if (keepNewlines && ch === '\n') return ch;
    const code = ch.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** The first `max` characters (code points), escaped, with `…` when cut. */
function head(value: string, max: number): string {
  const chars = Array.from(value);
  return `${escapeTerminal(chars.slice(0, max).join(''))}${chars.length > max ? '…' : ''}`;
}

/** An operation a person still has to look at: in progress, unknown, or its item's move pending (I9). */
export function operationNeedsReconcile(operation: Pick<PromoteOperationView, 'state' | 'transitionPending'>): boolean {
  return operation.transitionPending || operation.state === 'unknown' || operation.state === 'in_flight' || operation.state === 'approved';
}

/**
 * One operation as `--json` prints it. `itemWithheld`: its item matches a current rule (I5),
 * so where it was written (the destination, and the comment's URL that names it) is withheld
 * too — the reconcile's state (I8) is kept as it is.
 */
function operationJson(operation: PromoteOperationView, itemWithheld: boolean): MemDecisionOperationJsonV1 {
  return {
    id: operation.id,
    state: operation.state,
    transitionPending: operation.transitionPending,
    transitionReason: operation.transitionReason,
    concurrentEdit: operation.concurrentEdit,
    unknownReason: operation.unknownReason,
    decidedBy: operation.decidedBy,
    effect: operation.effect,
    destination: itemWithheld ? null : operation.destination,
    destinationWithheld: itemWithheld,
    resultRef: itemWithheld ? null : operation.resultRef,
    approvedAt: operation.approvedAt,
    settledAt: operation.settledAt,
  };
}

function decisionJson(entry: PromoteListWire['decisions'][number]): MemDecisionJsonV1 {
  const { item } = entry;
  const withheld = item.withheld ?? null;
  return {
    id: item.id,
    state: item.state,
    version: item.version,
    humanApprovals: entry.operations.length,
    // I5: a withheld item carries none of what anyone typed.
    text: withheld ? null : (item.text ?? null),
    promoteTo: withheld ? null : (item.promoteTo ?? null),
    quote: withheld ? null : (item.quote ?? null),
    quoteAt: withheld ? null : (item.quoteAt ?? null),
    createdBy: item.createdBy,
    author: { instanceId: item.owner.instanceId, worktreeId: item.owner.worktreeId },
    withheld,
    stale: item.stale,
    operations: entry.operations.map((operation) => operationJson(operation, withheld !== null)),
  };
}

/**
 * `--json` (schema 1, I7). `counts` is taken before `--pending`; `--pending` keeps the open
 * decisions and, whatever their state, those with an operation to reconcile (I9).
 */
export function toDecisionsJson(repositoryId: string, list: PromoteListWire, pending: boolean): MemDecisionsJsonV1 {
  const counts = list.counts ?? decisionCountsOf(list.mode as DecisionCountsMode, list.decisions.map((entry) => entry.item));
  const shown = pending
    ? list.decisions.filter((entry) => entry.item.state === 'open' || entry.operations.some(operationNeedsReconcile))
    : list.decisions;
  return {
    schema: 1,
    repositoryId,
    branch: list.branch,
    mode: list.mode,
    counts: { open: counts.open, recorded: counts.recorded, approvable: counts.approvable },
    pending,
    decisions: shown.map(decisionJson),
    unresolved: list.unresolved.map((entry) => ({
      itemId: entry.operation.itemId,
      itemVersion: entry.itemVersion,
      itemState: entry.item ? entry.item.state : null,
      // A closed item's operation too (I5): its item, when still there, says whether it is withheld.
      operation: operationJson(entry.operation, Boolean(entry.item?.withheld)),
    })),
  };
}

function operationLine(operation: MemDecisionOperationJsonV1): string {
  const flags = [
    operation.transitionPending ? ` pending-transition(${operation.transitionReason ?? '-'})` : '',
    operation.concurrentEdit ? ' concurrent-edit' : '',
    operation.state === 'unknown' || operation.unknownReason ? ` unknown(${operation.unknownReason ?? '-'})` : '',
  ].join('');
  const withheld = operation.destinationWithheld ? ' destination-withheld' : '';
  return `op ${operation.id} ${operation.state}${flags} decided-by=${operation.decidedBy ?? '-'} effect=${operation.effect}${withheld}`;
}

/** The text output (design §3.4.1): one head line per decision, an indented line per operation. */
export function decisionsLines(json: MemDecisionsJsonV1): string[] {
  const lines = [`mode: ${json.mode}  branch: ${escapeTerminal(json.branch)}  repository: ${escapeTerminal(json.repositoryId)}`];
  for (const decision of json.decisions) {
    const to = decision.promoteTo !== null ? escapeTerminal(decision.promoteTo) : '-';
    const quote = decision.quote !== null ? `"${head(decision.quote, 40)}"` : '-';
    const withheld = decision.withheld ? ` withheld(field=${decision.withheld.field} rule=${decision.withheld.rule})` : '';
    lines.push(
      `${decision.id} ${decision.state} v${decision.version} by=${decision.createdBy}(${escapeTerminal(decision.author.instanceId)}) to=${to} quote=${quote} approvals=${decision.humanApprovals}${withheld}`
    );
    if (decision.text !== null) lines.push(`  text: ${head(decision.text, 80)}`);
    for (const operation of decision.operations) lines.push(`  ${operationLine(operation)}`);
  }
  for (const entry of json.unresolved) {
    lines.push(`unresolved ${operationLine(entry.operation)} item=${entry.itemId} v${entry.itemVersion ?? '-'} (${entry.itemState ?? 'purged'})`);
  }
  const n = (value: number | null) => (value === null ? 'unknown' : String(value));
  lines.push(`counts (before --pending): open=${n(json.counts.open)} recorded=${n(json.counts.recorded)} approvable=${json.counts.approvable ? 'yes' : 'no'}`);
  return lines;
}

/** `<itemId> --json` (schema 1): the server's reference diff as it is, `ok` dropped. */
export function toDiffJson(view: PromoteReferenceDiffView): MemDecisionDiffJsonV1 {
  const { ok, ...rest } = view;
  void ok;
  return { schema: 1, ...rest };
}

function destinationText(destination: PromoteReferenceDiffView['destination']): string {
  if (destination === null) return '- (no destination)';
  if (!destination.resolved) return `unresolved (${destination.reason}${destination.detail ? `: ${destination.detail}` : ''})`;
  if (destination.kind === 'issue_comment') {
    const target = destination.target ? `${escapeTerminal(`${destination.target.host}/${destination.target.owner}/${destination.target.repo}`)}` : '(origin)';
    return `${destination.ref} ${target}#${destination.number}`;
  }
  return `path:${escapeTerminal(destination.path)} in worktree ${escapeTerminal(destination.worktreeId)}${destination.exists ? '' : ' (new file)'}`;
}

/** The text output of a reference diff: the notice first, then what it is drawn from, then the body. */
export function diffLines(view: PromoteReferenceDiffView): string[] {
  const lines = [
    view.notice,
    `item: ${view.item.id} v${view.item.version} ${view.item.state}  branch: ${view.item.branch === null ? '(detached)' : escapeTerminal(view.item.branch)}  mode: ${view.mode}  effect: ${view.effect}`,
    `quote: ${view.quoteOrigin === 'agent' ? "the agent's (unconfirmed)" : 'none'}`,
    `destination: ${destinationText(view.destination)}`,
    `--- body (sha256 ${view.bodySha256.slice(0, 12)}, drawn ${view.drawnAt}) ---`,
    escapeTerminal(view.body, true),
    '--- end ---',
  ];
  if (view.invisibleReplaced) lines.push('Note: invisible characters in the body are shown as [U+XXXX].');
  return lines;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const repo = (id: string) => `/api/repositories/${encodeURIComponent(id)}/mem/decisions`;

interface DecisionsTarget {
  repositoryId: string;
  branch: string | null;
  worktreeId: string | null;
}

async function decisionsTarget(host: MemDecisionsHost, client: ApiClient, options: MemDecisionsOptions, itemId: string | undefined): Promise<DecisionsTarget> {
  if (options.repository) {
    // The list is a branch's; a diff names its item and needs no branch.
    if (!itemId && !options.branch) throw host.usage('target_required', '--repository needs --branch', 'branch');
    return { repositoryId: options.repository, branch: options.branch ?? null, worktreeId: options.worktree ?? null };
  }
  const worktreeId = options.worktree ?? (await host.sessionWorktreeId(client));
  if (!worktreeId) {
    throw host.usage('target_required', 'Outside a session, name the target: --worktree <id>, or --repository <id> --branch <name>', 'target');
  }
  const query = options.branch ? `?branch=${encodeURIComponent(options.branch)}` : '';
  const mode = await client.get<MemModeResponse>(`/api/worktrees/${encodeURIComponent(worktreeId)}/mem/mode${query}`);
  const repositoryId = mode.repositoryIds[0];
  if (!repositoryId) throw host.usage('not_registered', 'The worktree belongs to no registered repository', 'worktree');
  if (!itemId && mode.branch === null) throw host.usage('branch_unresolved', 'The worktree is detached: name the branch with --branch', 'branch');
  return { repositoryId, branch: mode.branch, worktreeId };
}

/** Register `decisions` on `mem` (called by `mem.ts`). */
export function addMemDecisionsCommand(mem: Command, host: MemDecisionsHost): void {
  host
    .withTargetOptions(
      mem
        .command('decisions [itemId]')
        .description("Read the branch's decisions (state, destination, quote, approvals), or one decision's reference diff. Approving is on the screen")
        .option('--branch <name>', 'The branch (with --repository; or another branch than the worktree’s)')
        .option('--pending', 'Only the open decisions, and any with an operation to reconcile (counts stay those before the filter)')
        .option('--effect <effect>', 'With <itemId>: spec | record_only (default spec)'),
      false
    )
    .action(async (itemId: string | undefined, options: MemDecisionsOptions) => {
      await host.run(options, async (client) => {
        if (itemId !== undefined && options.pending) throw host.usage('invalid_request', '--pending lists decisions; it takes no <itemId>', 'pending');
        if (itemId === undefined && options.effect !== undefined) throw host.usage('invalid_request', '--effect needs <itemId>', 'effect');
        const target = await decisionsTarget(host, client, options, itemId);
        if (itemId !== undefined) {
          const query = new URLSearchParams();
          if (target.worktreeId) query.set('worktreeId', target.worktreeId);
          if (options.effect !== undefined) query.set('effect', options.effect);
          const queryText = query.toString();
          const view = await client.get<PromoteReferenceDiffView>(`${repo(target.repositoryId)}/${encodeURIComponent(itemId)}/diff${queryText ? `?${queryText}` : ''}`);
          if (options.json) console.log(JSON.stringify(toDiffJson(view), null, 2));
          else for (const line of diffLines(view)) console.log(line);
          return;
        }
        const list = await client.get<PromoteListWire>(`${repo(target.repositoryId)}?branch=${encodeURIComponent(target.branch as string)}`);
        const json = toDecisionsJson(target.repositoryId, list, Boolean(options.pending));
        if (options.json) console.log(JSON.stringify(json, null, 2));
        else for (const line of decisionsLines(json)) console.log(line);
      });
    });
}
