/**
 * handoff Command - the agent's side of the hand-off before a session ends (Issue #4227,
 * design `docs/design/mem-ui-4227.md` §4.2・§4.3).
 *
 *   commandmate handoff propose --request <id> add --kind <kind> (--text "<text>" | --stdin) [--close-when <cond>] [--evidence <ref>]
 *   commandmate handoff propose --request <id> update <itemId> --base-version <n> [--text ... | --stdin] [--close-when ...] [--evidence ...]
 *   commandmate handoff propose --request <id> close <itemId> --base-version <n> [--reason "<text>"]
 *   commandmate handoff done --request <id>
 *
 * G9 (the UAT of G-PR1+G-PR2): `--request` of `propose` is taken both before its operation (the
 * request text's form, `propose --request <id> add …`) and after it (`propose add --request <id> …`).
 * Every command line of the request text (`lib/handoff/template.ts`) and of the CLI guide is parsed
 * by this program in `tests/unit/cli/commands/handoff-template-parse-4227.test.ts`.
 *
 * A proposal is never confirmed here: a person approves it on the screen, which writes
 * it against the item's version. **There is no way here to approve, cancel or end**
 * (design §7.3): those are the screen's, with its mark. The exit codes are mem's.
 *
 * Errors print the server's code, field and rule, never what was refused.
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { ExitCode, MemExitCode, type HandoffCommonOptions } from '../types';
import { ApiClient, ApiError } from '../utils/api-client';
import { TOKEN_WARNING } from '../utils/command-helpers';
import { resolveSessionIdentity } from './whoami';
import { MEM_EXIT_BY_CODE, MEM_KINDS, type MemErrorCode } from '../../types/mem';

const HANDOFF_HELP = `
Used when CommandMate's screen asks this agent, before its session ends, to propose its
mem updates. A proposal is not an update: a person approves it on the screen, which
writes it against the item's version. Approving, cancelling and ending are the screen's.

Target: inside a CommandMate session, your own instance (whoami). In an ordinary shell,
name it: --worktree <id> --instance <id>.

--close-when of "propose add": required for kind waiting / next / external (without it: exit 2,
nothing stored); optional for decision / note. The values a kind takes are in "mem --help".

Exit codes:
  0   done
  1   the server is not running
  2   invalid input (nothing stored)
  50  disabled: mode is not on for the branch; nothing stored
  51  version_conflict
  52  not found (the request, the item, the worktree)
  55  not_requested (the request is another instance's), request_closed (not waiting for
      proposals any more: done, past the agent's time, cancelled, ended or forced),
      session_changed (the session was restarted after the request), state_forbids
  99  anything else
`;

/** The hand-off's own codes, mapped onto mem's exit codes (design §4.3: 52 / 55). */
const HANDOFF_EXIT_BY_CODE: Readonly<Record<string, number>> = {
  not_found: MemExitCode.TARGET_NOT_FOUND,
  not_requested: MemExitCode.NOT_OWNER,
  request_closed: MemExitCode.NOT_OWNER,
  session_changed: MemExitCode.NOT_OWNER,
  state_forbids: MemExitCode.NOT_OWNER,
  version_conflict: MemExitCode.CONFLICT,
};

class HandoffCliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly body: Record<string, unknown>
  ) {
    super(String(body.message ?? body.code));
  }
}

function usage(code: MemErrorCode, message: string, field?: string): HandoffCliError {
  return new HandoffCliError(MEM_EXIT_BY_CODE[code], { ok: false, code, message, ...(field ? { field } : {}) });
}

export function handoffExitCode(code: string | undefined): number | null {
  if (!code) return null;
  if (code in HANDOFF_EXIT_BY_CODE) return HANDOFF_EXIT_BY_CODE[code];
  if (code in MEM_EXIT_BY_CODE) return MEM_EXIT_BY_CODE[code as MemErrorCode];
  return null;
}

function toCliError(error: unknown): HandoffCliError {
  if (error instanceof HandoffCliError) return error;
  if (error instanceof ApiError) {
    const payload = (error.payload ?? {}) as Record<string, unknown>;
    const exit = handoffExitCode(typeof payload.code === 'string' ? payload.code : undefined);
    if (exit !== null) return new HandoffCliError(exit, payload);
    if (error.statusCode === undefined) {
      return new HandoffCliError(ExitCode.DEPENDENCY_ERROR, { ok: false, code: 'no_response', message: error.message });
    }
    return new HandoffCliError(error.exitCode || ExitCode.UNEXPECTED_ERROR, { ok: false, code: 'internal_error', message: error.message });
  }
  return new HandoffCliError(ExitCode.UNEXPECTED_ERROR, { ok: false, code: 'internal_error', message: 'Unexpected error' });
}

async function target(client: ApiClient, options: HandoffCommonOptions): Promise<{ worktreeId: string; instanceId: string }> {
  let identity: Awaited<ReturnType<typeof resolveSessionIdentity>> | null = null;
  try {
    identity = await resolveSessionIdentity(client);
  } catch {
    identity = null;
  }
  const worktreeId = options.worktree ?? identity?.worktreeId;
  const instanceId =
    options.instance ?? (identity && (!options.worktree || options.worktree === identity.worktreeId) ? identity.instanceId : undefined);
  if (!worktreeId || !instanceId) {
    throw usage('target_required', 'Outside a session, name the target: --worktree <id> --instance <id>', 'target');
  }
  return { worktreeId, instanceId };
}

function requestId(options: HandoffCommonOptions): string {
  if (!options.request) throw usage('invalid_request', 'Name the request: --request <id>', 'request');
  return options.request;
}

/**
 * G9: the request a `propose` operation names — its own `--request`, else the one given to
 * `propose` before the operation (the request text's form). Commander hands an option the parent
 * knows to the parent wherever it stands, so both places are read.
 */
export function handoffRequestOf(command: Command): string | undefined {
  const own = command.opts<HandoffCommonOptions>().request;
  if (own) return own;
  const parent = command.parent?.name() === 'propose' ? command.parent.opts<{ request?: string }>().request : undefined;
  return parent || undefined;
}

const path = (worktreeId: string, request: string, rest: string) =>
  `/api/worktrees/${encodeURIComponent(worktreeId)}/mem/handoff/requests/${encodeURIComponent(request)}/${rest}`;

async function run(options: HandoffCommonOptions, action: (client: ApiClient) => Promise<unknown>): Promise<void> {
  let failure = null as HandoffCliError | null;
  let result: unknown = null;
  try {
    result = await action(new ApiClient({ token: options.token }));
  } catch (error) {
    failure = toCliError(error);
  }
  if (failure) {
    const body: Record<string, unknown> = { ...failure.body, exitCode: failure.exitCode };
    if (options.json) console.log(JSON.stringify(body, null, 2));
    else {
      const detail = [body.field ? `field=${String(body.field)}` : null, body.rule ? `rule=${String(body.rule)}` : null, body.reason ? `reason=${String(body.reason)}` : null]
        .filter(Boolean)
        .join(' ');
      console.error(`Error: ${String(body.code)}: ${String(body.message ?? '')}${detail ? ` (${detail})` : ''}`);
    }
    process.exit(failure.exitCode);
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  process.exit(MemExitCode.SUCCESS);
}

const REQUEST_HELP = 'The hand-off request id (from the request text)';

/**
 * The options every subcommand takes. `propose`'s operations take `--request` as an ordinary
 * option (it may stand before the operation instead; checked when run: 2, nothing sent).
 */
function withCommon(command: Command, request: 'required' | 'here-or-before' = 'required'): Command {
  return (request === 'required' ? command.requiredOption('--request <id>', REQUEST_HELP) : command.option('--request <id>', REQUEST_HELP))
    .option('--worktree <id>', 'Worktree ID (default: your own session)')
    .option('--instance <id>', 'Instance ID (default: your own session)')
    .option('--json', 'Output as JSON')
    .option('--token <token>', TOKEN_WARNING);
}

function parseBaseVersion(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) throw usage('invalid_request', '--base-version must be a whole number', 'baseVersion');
  return Number(raw);
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

interface ProposeOptions extends HandoffCommonOptions {
  kind?: string;
  text?: string;
  stdin?: boolean;
  closeWhen?: string;
  evidence?: string[];
  promoteTo?: string;
  baseVersion?: string;
  reason?: string;
}

function textOf(options: ProposeOptions): string | undefined {
  if (options.stdin) return readFileSync(0, 'utf-8');
  return options.text;
}

async function propose(op: 'add' | 'update' | 'close', itemId: string | undefined, options: ProposeOptions): Promise<void> {
  await run(options, async (client) => {
    const request = requestId(options);
    const { worktreeId, instanceId } = await target(client, options);
    const body: Record<string, unknown> = { instanceId, op };
    if (op === 'add') {
      if (!options.kind) throw usage('invalid_request', '--kind is required', 'kind');
      body.kind = options.kind;
      body.text = textOf(options);
      if (options.promoteTo !== undefined) body.promoteTo = options.promoteTo;
    } else {
      body.itemId = itemId;
      body.baseVersion = parseBaseVersion(options.baseVersion);
      if (op === 'update') {
        const text = textOf(options);
        if (text !== undefined) body.text = text;
      } else if (options.reason !== undefined) {
        body.reason = options.reason;
      }
    }
    if (op !== 'close') {
      if (options.closeWhen !== undefined) body.closeWhen = options.closeWhen;
      if (options.evidence !== undefined) body.evidence = options.evidence;
    }
    const answer = await client.post<{ proposal?: { id: string; state: string } }>(path(worktreeId, request, 'proposals'), body);
    if (!options.json) console.log(`proposed ${answer.proposal?.id ?? ''} (${op}${itemId ? ` ${itemId}` : ''}): a person decides on the screen`);
    return answer;
  });
}

export function createHandoffCommand(): Command {
  const handoff = new Command('handoff').description('Propose mem updates before your session ends (the screen asks; a person confirms)');
  handoff.addHelpText('after', HANDOFF_HELP);

  const proposeCommand = new Command('propose')
    .description('Propose one mem update for the hand-off (never confirms it)')
    // G9: the request text's form, `propose --request <id> add …` (after the operation works too).
    .option('--request <id>', REQUEST_HELP);
  withCommon(
    proposeCommand
      .command('add')
      .description('Propose a new item')
      .option('--kind <kind>', `Kind: ${MEM_KINDS.filter((kind) => kind !== 'now').join(', ')}`)
      .option('--text <text>', 'Text')
      .option('--stdin', 'Read the text from stdin')
      .option('--close-when <cond>', 'When it closes (required for waiting / next / external)')
      .option('--evidence <ref>', 'Evidence path (repeatable)', collect)
      .option('--promote-to <dest>', 'Where a decision is reflected'),
    'here-or-before'
  ).action((options: ProposeOptions, command: Command) => propose('add', undefined, { ...options, request: handoffRequestOf(command) }));
  withCommon(
    proposeCommand
      .command('update <itemId>')
      .description('Propose a change to an item, from the version you read')
      .option('--base-version <n>', 'The version you read (mem list)')
      .option('--text <text>', 'New text')
      .option('--stdin', 'Read the text from stdin')
      .option('--close-when <cond>', 'New close condition')
      .option('--evidence <ref>', 'Evidence path (repeatable; replaces the list)', collect),
    'here-or-before'
  ).action((itemId: string, options: ProposeOptions, command: Command) => propose('update', itemId, { ...options, request: handoffRequestOf(command) }));
  withCommon(
    proposeCommand
      .command('close <itemId>')
      .description('Propose closing an item (an open decision is withdrawn)')
      .option('--base-version <n>', 'The version you read (mem list)')
      .option('--reason <text>', 'Why'),
    'here-or-before'
  ).action((itemId: string, options: ProposeOptions, command: Command) => propose('close', itemId, { ...options, request: handoffRequestOf(command) }));
  handoff.addCommand(proposeCommand);

  withCommon(handoff.command('done').description('Your proposals are all in: the screen shows them to a person')).action(
    (options: HandoffCommonOptions) =>
      run(options, async (client) => {
        const request = requestId(options);
        const { worktreeId, instanceId } = await target(client, options);
        const answer = await client.post(path(worktreeId, request, 'done'), { instanceId });
        if (!options.json) console.log('done: the proposals are with a person on the screen');
        return answer;
      })
  );

  return handoff;
}
