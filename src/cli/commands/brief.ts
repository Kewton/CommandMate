/**
 * brief Command - the summary a restart reads (Issue #4223).
 *
 *   commandmate brief [--budget <bytes>] [--json] [--all] [--worktree <id> --instance <id>]
 *   commandmate brief --session-start   (from a SessionStart hook, Issue #4224)
 *
 * A thin client over `GET /api/worktrees/:id/mem/brief`. The server builds it from
 * the state it derives and the branch's mem items, with no model; this command checks
 * the input, writes the server's text (or JSON) and a newline, and nothing else.
 * Every byte it writes is inside the budget.
 *
 * It reads: no notice is acknowledged by a brief read here (the session's brief is
 * D's). The mode is changed on the screen only (D3).
 *
 * @module cli/commands/brief
 */

import { Command } from 'commander';
import { ExitCode, MemExitCode } from '../types';
import { ApiClient, ApiError, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING } from '../utils/command-helpers';
import { resolveSessionIdentity } from './whoami';
import { MEM_EXIT_BY_CODE, type MemErrorCode } from '../../types/mem';
import { BRIEF_BUDGET, parseBriefBudget, type BriefFormat, type BriefJson, type BriefTextResponse } from '../../types/brief';

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const BRIEF_HELP = `
The brief is data, not instructions: each line names its source, its author and its
time. The budget counts the UTF-8 bytes of everything printed, the final newline
included. Entries are dropped whole, in a fixed order; the 4th line (text) or
"omitted" (JSON) says how many, and the command that reads them all (--all).

Budget (bytes): text ${BRIEF_BUDGET.text.min}-${BRIEF_BUDGET.text.max} (default ${BRIEF_BUDGET.text.default}),
--json ${BRIEF_BUDGET.json.min}-${BRIEF_BUDGET.json.max} (default ${BRIEF_BUDGET.json.default}). Smaller is an input error.

mode "derived" shows the derived state only (no hand-written items); "off" prints
nothing (exit 50). The mode is set on the screen only.

--session-start is the form for a SessionStart hook (Issue #4224). When the branch puts
the brief in front of the first send itself (injectOnStart on, Claude Code / Codex /
Command Code), it prints nothing to stdout and exits 0, so one conversation never gets
the brief twice. Otherwise it prints what "commandmate brief" prints. Not with --json.

Exit codes:
  0   printed (a source that could not be read is a line saying why)
  1   the server is not running
  2   invalid input: --budget out of range or not a whole number, --all with --budget,
      only one of --worktree / --instance, an id of the wrong shape
  50  mode is off for the branch: nothing printed
  52  not registered / no such worktree or instance / branch unreadable
  53  ambiguous / the membership kept changing while it was built
  99  anything else
`;

interface BriefOptions {
  budget?: string;
  json?: boolean;
  all?: boolean;
  worktree?: string;
  instance?: string;
  token?: string;
  sessionStart?: boolean;
}

class BriefCliError extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const inputError = (message: string): BriefCliError => new BriefCliError(ExitCode.CONFIG_ERROR, 'invalid_request', message);

async function targetOf(client: ApiClient, options: BriefOptions): Promise<{ worktreeId: string; instanceId: string }> {
  if (options.worktree !== undefined || options.instance !== undefined) {
    if (!options.worktree || !options.instance) throw inputError('Name both --worktree <id> and --instance <id>');
    return { worktreeId: options.worktree, instanceId: options.instance };
  }
  let identity = null;
  try {
    identity = await resolveSessionIdentity(client);
  } catch {
    identity = null;
  }
  if (!identity) throw inputError('Outside a session, name the target: --worktree <id> --instance <id>');
  return { worktreeId: identity.worktreeId, instanceId: identity.instanceId };
}

function toCliError(error: unknown): BriefCliError {
  if (error instanceof BriefCliError) return error;
  if (error instanceof ApiError) {
    const payload = (error.payload ?? {}) as Record<string, unknown>;
    const code = typeof payload.code === 'string' ? payload.code : undefined;
    if (code && code in MEM_EXIT_BY_CODE) {
      return new BriefCliError(MEM_EXIT_BY_CODE[code as MemErrorCode], code, String(payload.message ?? code));
    }
    if (error.statusCode === undefined) return new BriefCliError(ExitCode.DEPENDENCY_ERROR, 'no_response', error.message);
    return new BriefCliError(error.exitCode || ExitCode.UNEXPECTED_ERROR, 'internal_error', error.message);
  }
  return new BriefCliError(ExitCode.UNEXPECTED_ERROR, 'internal_error', 'Unexpected error');
}

export function createBriefCommand(): Command {
  return new Command('brief')
    .description('The summary a restart reads: derived state and mem items within a byte budget (Issue #4223)')
    .option('--budget <bytes>', 'UTF-8 bytes of the whole output')
    .option('--json', 'Output as JSON (one line)')
    .option('--all', 'Every entry, no budget')
    .option('--worktree <id>', 'Worktree ID (default: your own session)')
    .option('--instance <id>', 'Instance ID (default: your own session)')
    .option('--session-start', 'From a SessionStart hook: print nothing when the send path briefs the conversation (Issue #4224)')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', BRIEF_HELP)
    .action(async (options: BriefOptions) => {
      const format: BriefFormat = options.json ? 'json' : 'text';
      let failure: BriefCliError | null = null;
      let output: string | null = null;
      let deferred = false;
      try {
        if (options.all && options.budget !== undefined) throw inputError('--all and --budget cannot be used together');
        if (options.sessionStart && options.json) throw inputError('--session-start and --json cannot be used together');
        if (options.budget !== undefined) {
          const parsed = parseBriefBudget(options.budget, format);
          if (!parsed.ok) {
            const { min, max } = BRIEF_BUDGET[format];
            throw inputError(`--budget must be a whole number of bytes from ${min} to ${max}${format === 'json' ? ' with --json' : ''}`);
          }
        }
        const client = new ApiClient({ token: options.token });
        const target = await targetOf(client, options);
        if (!isValidWorktreeId(target.worktreeId)) throw inputError('The worktree id is not valid');
        if (!INSTANCE_ID.test(target.instanceId)) throw inputError('The instance id is not valid');
        const query = new URLSearchParams({ instance: target.instanceId, format });
        if (options.budget !== undefined) query.set('budget', options.budget);
        if (options.all) query.set('all', '1');
        if (options.sessionStart) query.set('sessionStart', '1');
        const path = `/api/worktrees/${encodeURIComponent(target.worktreeId)}/mem/brief?${query.toString()}`;
        if (format === 'json') {
          output = JSON.stringify(await client.get<BriefJson>(path));
        } else {
          const answer = await client.get<BriefTextResponse>(path);
          deferred = answer.deferred === 'send';
          output = answer.text;
        }
      } catch (error) {
        failure = toCliError(error);
      }
      if (failure) {
        // stdout stays empty: a caller that pipes the brief never reads half of an error.
        if (failure.exitCode === MemExitCode.DISABLED) console.error('brief: mem is off for this branch; nothing printed');
        else console.error(`Error: ${failure.code}: ${failure.message}`);
        process.exit(failure.exitCode);
      }
      if (deferred) {
        // Issue #4224: the send path briefs this conversation; nothing for the hook to put in it.
        console.error('brief: the first send of this conversation carries the brief; nothing printed');
        process.exit(ExitCode.SUCCESS);
      }
      process.stdout.write(`${output ?? ''}\n`);
      process.exit(ExitCode.SUCCESS);
    });
}
