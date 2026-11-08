/**
 * mem Command - the typed items that carry a piece of work across sessions (Issue #4221).
 *
 *   commandmate mem now "<text>" [--close-when <cond>] [--evidence <ref>]
 *   commandmate mem add --kind <kind> (--text "<text>" | --stdin) [--close-when <cond>] ...
 *   commandmate mem update <id> --if-version <n> [--text ... | --stdin] [--close-when ...] [--evidence ...]
 *   commandmate mem close <id> [--reason "<text>"]
 *   commandmate mem list [--all] [--branch <name>] [--json]
 *   commandmate mem check [--branch <name>] [--json]          (Issue #4222)
 *   commandmate mem mode [--json]
 *   commandmate mem purge --branch <name> [--closed-only] --confirm
 *
 * A thin client over `/api/worktrees/:id/mem/*` and `/api/repositories/:id/mem*`. The
 * rules are the server's. **There is no way to change the mode here** (D3): `mode`
 * only reads it, and the settings are written from the screen.
 *
 * Errors print the server's code, field and rule, never what was refused (§7).
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { ExitCode, MemExitCode, type MemCommonOptions } from '../types';
import { ApiClient, ApiError } from '../utils/api-client';
import { TOKEN_WARNING } from '../utils/command-helpers';
import { resolveSessionIdentity, type SessionIdentity } from './whoami';
import {
  MEM_EXIT_BY_CODE,
  MEM_KINDS,
  type MemCheckResponse,
  type MemConditionView,
  type MemErrorCode,
  type MemItemView,
  type MemListResponse,
  type MemModeResponse,
  type MemPurgeResponse,
  type MemWriteResponse,
} from '../../types/mem';

const MEM_HELP = `
Items are kept per registered repository and branch. Writing needs mode "on" for the
branch; the mode is changed on the screen (Repositories → mem), never from here.

Target: inside a CommandMate session, your own instance (whoami). In an ordinary shell,
name it: --worktree <id> --instance <id> for writes; --worktree <id>, or
--repository <id> --branch <name>, for list / mode / purge.

--close-when (required for waiting / next / external):
  manual | replaced (now only) | issue:[host/owner/repo]#N | pr:[host/owner/repo]#N[?state=merged|closed]
  branch:<name>?merged=<ref>[&scope=local|remote] | branch:<name>?deleted
  relay:<id> | worktree:<id> | session:task:<id> | session:verify:<run id> |
  session:schedule:<execution log id> | at:<ISO 8601 with offset>
  Omitted: now → replaced, note → manual, decision → until promoted.

Conditions are evaluated when read (list, check, the brief), never in the background.
Each one is met, not-met or unknown with a fixed reason; unknown (offline, 404, no
permission, a timeout, the query budget, ...) never closes anything. A decision met
before it is promoted stays open as "unreflected".

Exit codes:
  0   done (a --key retry answering the first item: replayed)
  1   the server is not running
  2   invalid input (nothing stored): invalid_close_when, control_char, secret_like,
      too_long, absolute_path, outside_repository, symlink, sensitive_path,
      invalid_evidence, invalid_key, target_required, ...
  50  disabled: mode is off or derived for the branch; nothing stored
  51  version_conflict: --if-version is not current; the stored item is returned
  52  not_registered / item_not_found / instance_not_found / branch_unresolved
  53  ambiguous: roots whose settings differ, git not answering, registration changing
  54  duplicate_key: the --key was used for another request
  55  not_owner / state_forbids (and purge from inside a session)
  56  limit_exceeded: too many open items of the kind on the branch
  99  anything else

What is not prevented: a process with your OS rights can write the database or
call the API directly. The author check stops mistakes, not intent.
`;

interface Target {
  worktreeId: string;
  instanceId?: string;
}

class MemCliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly body: Record<string, unknown>
  ) {
    super(String(body.message ?? body.code));
  }
}

function usage(code: MemErrorCode, message: string, field?: string): MemCliError {
  return new MemCliError(MEM_EXIT_BY_CODE[code], { ok: false, code, message, ...(field ? { field } : {}) });
}

async function identityOf(client: ApiClient): Promise<SessionIdentity | null> {
  try {
    return await resolveSessionIdentity(client);
  } catch {
    return null;
  }
}

async function writeTarget(client: ApiClient, options: MemCommonOptions): Promise<Target> {
  const identity = await identityOf(client);
  const worktreeId = options.worktree ?? identity?.worktreeId;
  const instanceId =
    options.instance ?? (identity && (!options.worktree || options.worktree === identity.worktreeId) ? identity.instanceId : undefined);
  if (!worktreeId || !instanceId) {
    throw usage('target_required', 'Outside a session, name the target: --worktree <id> --instance <id>', 'target');
  }
  return { worktreeId, instanceId };
}

type ReadTarget = { via: 'worktree'; worktreeId: string } | { via: 'repository'; repositoryId: string; branch: string };

async function readTarget(client: ApiClient, options: MemCommonOptions): Promise<ReadTarget> {
  if (options.repository) {
    if (!options.branch) throw usage('target_required', '--repository needs --branch', 'branch');
    return { via: 'repository', repositoryId: options.repository, branch: options.branch };
  }
  const worktreeId = options.worktree ?? (await identityOf(client))?.worktreeId;
  if (!worktreeId) {
    throw usage('target_required', 'Outside a session, name the target: --worktree <id>, or --repository <id> --branch <name>', 'target');
  }
  return { via: 'worktree', worktreeId };
}

const wt = (id: string) => `/api/worktrees/${encodeURIComponent(id)}/mem`;
const repo = (id: string) => `/api/repositories/${encodeURIComponent(id)}/mem`;

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function toCliError(error: unknown): MemCliError {
  if (error instanceof MemCliError) return error;
  if (error instanceof ApiError) {
    const payload = (error.payload ?? {}) as Record<string, unknown>;
    const code = typeof payload.code === 'string' ? (payload.code as MemErrorCode) : undefined;
    if (code && code in MEM_EXIT_BY_CODE) return new MemCliError(MEM_EXIT_BY_CODE[code], payload);
    if (error.statusCode === undefined) {
      return new MemCliError(ExitCode.DEPENDENCY_ERROR, { ok: false, code: 'no_response', message: error.message });
    }
    return new MemCliError(error.exitCode || ExitCode.UNEXPECTED_ERROR, { ok: false, code: 'internal_error', message: error.message });
  }
  return new MemCliError(ExitCode.UNEXPECTED_ERROR, { ok: false, code: 'internal_error', message: 'Unexpected error' });
}

function report(error: MemCliError, json: boolean | undefined): never {
  const body: Record<string, unknown> = { ...error.body, exitCode: error.exitCode };
  if (json) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    const detail = [body.field ? `field=${String(body.field)}` : null, body.rule ? `rule=${String(body.rule)}` : null, body.reason ? `reason=${String(body.reason)}` : null]
      .filter(Boolean)
      .join(' ');
    console.error(`Error: ${String(body.code)}: ${String(body.message ?? '')}${detail ? ` (${detail})` : ''}`);
    if (body.code === 'version_conflict' && typeof body.currentVersion === 'number') {
      console.error(`Current version: ${body.currentVersion}`);
    }
  }
  process.exit(error.exitCode);
}

function itemLine(item: MemItemView, condition?: MemConditionView): string {
  const text = item.withheld ? `(withheld: ${item.withheld.rule})` : (item.text ?? '');
  const flags = [item.stale ? 'stale' : null, item.frozen ? 'frozen' : null].filter(Boolean).join(',');
  return `[${item.kind}] ${item.id} v${item.version} ${item.state}${flags ? ` (${flags})` : ''}${conditionText(condition)}: ${text}`;
}

/** ` {met:issue-closed}` — the result and its fixed reason (Issue #4222). */
function conditionText(condition: MemConditionView | undefined): string {
  if (!condition) return '';
  const extra = [condition.closed ? 'closed' : null, condition.unreflected ? 'unreflected' : null].filter(Boolean).join(',');
  return ` {${condition.result}:${condition.reason}${extra ? `,${extra}` : ''}}`;
}

async function run(options: MemCommonOptions, action: (client: ApiClient) => Promise<void>): Promise<void> {
  let failure: MemCliError | null = null;
  try {
    const client = new ApiClient({ token: options.token });
    await action(client);
  } catch (error) {
    failure = toCliError(error);
  }
  if (failure) report(failure, options.json);
  process.exit(MemExitCode.SUCCESS);
}

function printWrite(result: MemWriteResponse, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${itemLine(result.item)}${result.replayed ? ' (replayed)' : ''}`);
  for (const warning of result.warnings) {
    console.error(`Warning: ${warning.code} ${warning.kind ?? ''} ${warning.count}/${warning.threshold}`);
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function withTargetOptions(command: Command, write: boolean): Command {
  command
    .option('--worktree <id>', 'Worktree ID (default: your own session)')
    .option('--json', 'Output as JSON')
    .option('--token <token>', TOKEN_WARNING);
  if (write) command.option('--instance <id>', 'Instance ID (default: your own session)');
  else command.option('--repository <id>', 'Repository ID, with --branch, when the worktree is gone');
  return command;
}

function parseIfVersion(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw usage('invalid_request', '--if-version must be a whole number', 'ifVersion');
  return Number(raw);
}

export function createMemCommand(): Command {
  const mem = new Command('mem').description('Typed items that carry work across sessions (Issue #4221)').addHelpText('after', MEM_HELP);

  withTargetOptions(
    mem
      .command('now <text>')
      .description("Replace your session's now (its #2427 note)")
      .option('--close-when <cond>', 'When it closes (default: replaced by the next now)')
      .option('--evidence <ref>', 'path:<rel>[:<line>] | commit:<sha> | issue:#N | pr:#N | url:https://… (repeatable)', collect),
    true
  ).action(async (text: string, options: MemCommonOptions & { closeWhen?: string; evidence?: string[] }) => {
    await run(options, async (client) => {
      const target = await writeTarget(client, options);
      const result = await client.post<MemWriteResponse>(`${wt(target.worktreeId)}/now`, {
        instanceId: target.instanceId,
        text,
        ...(options.closeWhen !== undefined ? { closeWhen: options.closeWhen } : {}),
        ...(options.evidence ? { evidence: options.evidence } : {}),
      });
      printWrite(result, options.json);
    });
  });

  withTargetOptions(
    mem
      .command('add')
      .description('Add one item')
      .requiredOption('--kind <kind>', MEM_KINDS.filter((kind) => kind !== 'now').join(' | '))
      .option('--text <text>', 'The text')
      .option('--stdin', 'Read the text from stdin')
      .option('--close-when <cond>', 'When it closes (required for waiting / next / external)')
      .option('--promote-to <dest>', 'Where a decision is to be recorded: path:<rel> | issue:#N | pr:#N')
      .option('--quote <words>', "An agent's quotation of what was said (with --quote-at)")
      .option('--quote-at <ts>', 'When it was said: ISO 8601 with an offset')
      .option('--evidence <ref>', 'Evidence (repeatable)', collect)
      .option('--key <key>', 'Idempotency key: a retry with the same key and content answers the first item'),
    true
  ).action(
    async (
      options: MemCommonOptions & {
        kind: string;
        text?: string;
        stdin?: boolean;
        closeWhen?: string;
        promoteTo?: string;
        quote?: string;
        quoteAt?: string;
        evidence?: string[];
        key?: string;
      }
    ) => {
      await run(options, async (client) => {
        if ((options.text === undefined) === !options.stdin) {
          throw usage('invalid_request', 'Give exactly one of --text or --stdin', 'text');
        }
        const text = options.stdin ? readStdin() : options.text;
        const target = await writeTarget(client, options);
        const result = await client.post<MemWriteResponse>(`${wt(target.worktreeId)}/items`, {
          instanceId: target.instanceId,
          kind: options.kind,
          text,
          ...(options.closeWhen !== undefined ? { closeWhen: options.closeWhen } : {}),
          ...(options.promoteTo !== undefined ? { promoteTo: options.promoteTo } : {}),
          ...(options.quote !== undefined ? { quote: options.quote } : {}),
          ...(options.quoteAt !== undefined ? { quoteAt: options.quoteAt } : {}),
          ...(options.evidence ? { evidence: options.evidence } : {}),
          ...(options.key !== undefined ? { key: options.key } : {}),
        });
        printWrite(result, options.json);
      });
    }
  );

  withTargetOptions(
    mem
      .command('update <id>')
      .description('Change an item you wrote, against the version you read')
      .requiredOption('--if-version <n>', 'The version you read')
      .option('--text <text>', 'The new text')
      .option('--stdin', 'Read the new text from stdin')
      .option('--close-when <cond>', 'The new condition')
      .option('--evidence <ref>', 'The new evidence (repeatable; replaces the list)', collect),
    true
  ).action(
    async (
      id: string,
      options: MemCommonOptions & { ifVersion?: string; text?: string; stdin?: boolean; closeWhen?: string; evidence?: string[] }
    ) => {
      await run(options, async (client) => {
        if (options.text !== undefined && options.stdin) throw usage('invalid_request', 'Give one of --text or --stdin', 'text');
        const ifVersion = parseIfVersion(options.ifVersion);
        const text = options.stdin ? readStdin() : options.text;
        const target = await writeTarget(client, options);
        const result = await client.patch<MemWriteResponse>(`${wt(target.worktreeId)}/items/${encodeURIComponent(id)}`, {
          instanceId: target.instanceId,
          ifVersion,
          ...(text !== undefined ? { text } : {}),
          ...(options.closeWhen !== undefined ? { closeWhen: options.closeWhen } : {}),
          ...(options.evidence ? { evidence: options.evidence } : {}),
        });
        printWrite(result, options.json);
      });
    }
  );

  withTargetOptions(
    mem.command('close <id>').description('Close an item you wrote').option('--reason <text>', 'Why'),
    true
  ).action(async (id: string, options: MemCommonOptions & { reason?: string }) => {
    await run(options, async (client) => {
      const target = await writeTarget(client, options);
      const result = await client.post<MemWriteResponse>(`${wt(target.worktreeId)}/items/${encodeURIComponent(id)}/close`, {
        instanceId: target.instanceId,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      });
      printWrite(result, options.json);
    });
  });

  withTargetOptions(
    mem
      .command('list')
      .description('The open items of the branch, and every session’s now on it')
      .option('--all', 'Include closed items')
      .option('--branch <name>', 'Another branch than the worktree’s'),
    false
  ).action(async (options: MemCommonOptions & { all?: boolean }) => {
    await run(options, async (client) => {
      const target = await readTarget(client, options);
      const query = new URLSearchParams();
      if (options.all) query.set('all', '1');
      if (target.via === 'repository' || options.branch) query.set('branch', target.via === 'repository' ? target.branch : options.branch!);
      const path = target.via === 'repository' ? repo(target.repositoryId) : wt(target.worktreeId);
      const queryText = query.toString();
      const result = await client.get<MemListResponse>(`${path}${queryText ? `?${queryText}` : ''}`);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`mode: ${result.mode}  branch: ${result.branch ?? '(detached)'}`);
      const conditions = result.conditions ?? {};
      for (const slot of result.now) console.log(`now ${slot.instanceId}: ${itemLine(slot.item, conditions[slot.item.id])}`);
      for (const item of result.items) console.log(itemLine(item, conditions[item.id]));
      for (const warning of result.warnings) {
        console.error(`Warning: ${warning.code} ${warning.kind ?? ''} ${warning.count}/${warning.threshold}`);
      }
    });
  });

  withTargetOptions(
    mem
      .command('check')
      .description('Evaluate the close conditions of the branch now, and close what is met (mode on only)')
      .option('--branch <name>', 'Another branch than the worktree’s'),
    false
  ).action(async (options: MemCommonOptions) => {
    await run(options, async (client) => {
      const target = await readTarget(client, options);
      if (target.via !== 'worktree') throw usage('target_required', 'check runs through a worktree: --worktree <id>', 'worktree');
      const identity = await identityOf(client);
      const instanceId = identity && identity.worktreeId === target.worktreeId ? identity.instanceId : undefined;
      const result = await client.post<MemCheckResponse>(`${wt(target.worktreeId)}/check`, {
        ...(options.branch ? { branch: options.branch } : {}),
        ...(instanceId ? { instanceId } : {}),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`mode: ${result.mode}  branch: ${result.branch ?? '(detached)'}  evaluated: ${result.results.length}`);
      for (const entry of result.results) {
        console.log(`[${entry.kind}] ${entry.itemId} ${entry.type ?? '?'}${conditionText(entry.condition)}`);
      }
    });
  });

  withTargetOptions(
    mem.command('mode').description('The mode of the branch and the rule that decided it (read-only)').option('--branch <name>', 'Another branch than the worktree’s'),
    false
  ).action(async (options: MemCommonOptions) => {
    await run(options, async (client) => {
      const target = await readTarget(client, options);
      const path =
        target.via === 'repository'
          ? `${repo(target.repositoryId)}/mode?branch=${encodeURIComponent(target.branch)}`
          : `${wt(target.worktreeId)}/mode${options.branch ? `?branch=${encodeURIComponent(options.branch)}` : ''}`;
      const result = await client.get<MemModeResponse>(path);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const source =
        result.source.level === 'rule'
          ? `rule #${result.source.rulePosition}${result.source.pattern ? ` "${result.source.pattern}"` : ' (detached)'}`
          : result.source.level;
      console.log(`mode: ${result.mode}  branch: ${result.branch ?? '(detached)'}  decided by: ${source}`);
    });
  });

  withTargetOptions(
    mem
      .command('purge')
      .description('Delete items of a branch. Without --confirm nothing is deleted and the counts are shown')
      .requiredOption('--branch <name>', 'The branch')
      .option('--closed-only', 'Closed items only')
      .option('--kind <kind>', 'One kind only')
      .option('--before <ts>', 'Last updated before (ISO 8601 with an offset)')
      .option('--include-decisions', 'Also recorded / promoted decisions')
      .option('--confirm', 'Delete'),
    false
  ).action(
    async (
      options: MemCommonOptions & { closedOnly?: boolean; kind?: string; before?: string; includeDecisions?: boolean; confirm?: boolean }
    ) => {
      await run(options, async (client) => {
        // A check, not a guarantee: clearing the environment gets past it (§11.3).
        if (await identityOf(client)) {
          throw usage('state_forbids', 'purge is for a person: run it outside an agent session');
        }
        const target = await readTarget(client, options);
        const path = target.via === 'repository' ? repo(target.repositoryId) : wt(target.worktreeId);
        const result = await client.post<MemPurgeResponse>(`${path}/purge`, {
          branch: options.branch,
          ...(options.closedOnly ? { closedOnly: true } : {}),
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.before ? { before: options.before } : {}),
          ...(options.includeDecisions ? { includeDecisions: true } : {}),
          ...(options.confirm ? { confirm: true } : {}),
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const counts = Object.entries(result.counts)
          .map(([kind, n]) => `${kind}=${n}`)
          .join(' ');
        console.log(`${result.dryRun ? 'Would delete (add --confirm)' : 'Deleted'}: ${counts || 'nothing'}`);
      });
    }
  );

  return mem;
}
