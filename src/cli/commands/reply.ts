/**
 * reply Command - read an agent session's latest reply (Issue #3039)
 *
 *   commandmate reply <worktree-id> [--instance <id|alias>] [--agent <tool>]
 *                     [--since <iso8601>] [--json]
 *
 * ## Why this exists next to ask / capture
 *
 * `ask` reads the reply to the turn IT sent. A supervisor that nudged a worker
 * with a plain `send` ("stop and report") had no way to read the answer short
 * of opening the tool's transcript file itself — which works for Claude, whose
 * path is computable from the cwd, and not for Command Code, whose project slug
 * is not. `capture` is no substitute: the pane also holds the nudge's own echo,
 * and a pane line cannot be attributed to a turn.
 *
 * The server already has the reply: the transcript readers write each turn into
 * the chat ledger keyed `<tool>-turn:<id>`, and `ask` reads it from there. This
 * command is that read on its own, through the same shared rules
 * (`utils/reply-ledger`), so the two can never disagree about what a reply is.
 *
 * ## What it deliberately does not do
 *
 * - No pane fallback. A row off the screen is exactly what cannot be attributed
 *   to a turn; returning it would re-introduce the problem this command solves.
 *   Only transcript-reader rows count, for every tool.
 * - No wait. It is one read; "no reply yet" is an answer (exit 0, empty stdout,
 *   `reply: null`), not an error, so a caller can poll or give up on its terms.
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import { ApiClient, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
} from './instances';
import { resolveCommandTarget } from './command-target';
import { pickLatestReply, replyCandidates, requestRecentMessages } from '../utils/reply-ledger';

/** Options for the reply command. */
interface ReplyOptions {
  instance?: string;
  agent?: string;
  since?: string;
  json?: boolean;
  token?: string;
}

/** The `--json` payload. `reply` is null when there is no reply yet. */
export interface ReplyJsonPayload {
  worktreeId: string;
  instanceId: string | null;
  cliToolId: string | null;
  reply: string | null;
  requestId: string | null;
  at: string | null;
}

/**
 * A date-time that starts with a calendar date. Date.parse alone would also
 * take "1" or "Sep 30", which is a typo more often than an intent.
 */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Parse `--since <iso8601>` into epoch ms. No value means "any time".
 *
 * @param raw - Raw option value, if the user passed one
 */
function parseSince(raw: string | undefined): number {
  if (raw === undefined) return Number.NEGATIVE_INFINITY;
  const value = Date.parse(raw);
  if (!ISO_DATE_PREFIX.test(raw) || !Number.isFinite(value)) {
    console.error('Error: --since must be an ISO 8601 date-time (e.g. 2026-09-30T12:00:00Z).');
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return value;
}

export function createReplyCommand(): Command {
  const cmd = new Command('reply');
  cmd
    .description(
      'Print the latest reply an agent session wrote (from its transcript; '
      + 'exit 0 with empty stdout when there is none yet)'
    )
    .argument('<worktree-id>', 'Worktree ID')
    .option('--instance <id>', `${INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--since <iso8601>', 'Only a reply written at or after this time')
    .option('--json', 'Print { worktreeId, instanceId, cliToolId, reply, requestId, at }')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText('after', `
Only rows a transcript reader wrote (<tool>-turn:<id>) count as a reply, the
same rule \`ask\` uses; the pane is never read. Tools with a transcript reader:
claude, codex, antigravity, command-code, opencode.

No reply yet (or none after --since) is not an error: stdout is empty, stderr
says so in one line, and the exit code is 0. --json prints "reply": null.
`)
    .action(async (worktreeId: string, options: ReplyOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.agent && !isCliToolId(options.agent)) {
          console.error(`Error: Invalid agent. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.instance && !isInstanceSelector(options.instance)) {
          console.error(INSTANCE_SELECTOR_ERROR);
          process.exit(ExitCode.CONFIG_ERROR);
        }
        const since = parseSince(options.since);
        const client = new ApiClient({ token: options.token });

        // Resolved exactly as `ask` resolves it: `--agent` alone names that
        // tool's primary instance (Issue #2479).
        const selector = options.instance ?? options.agent;
        const { agent: cliToolId, instanceId } = await resolveCommandTarget(client, worktreeId, selector, options.agent);

        // Unlike `ask`, a failed read is not swallowed: there is no turn this
        // command completed that a fallback would be protecting.
        const messages = await requestRecentMessages(client, worktreeId, instanceId);
        const latest = pickLatestReply(replyCandidates(messages, since), true);

        if (options.json) {
          const payload: ReplyJsonPayload = {
            worktreeId,
            instanceId: instanceId ?? null,
            cliToolId: cliToolId ?? null,
            reply: latest?.content ?? null,
            requestId: latest?.requestId ?? null,
            at: latest?.at ?? null,
          };
          console.log(JSON.stringify(payload, null, 2));
        } else if (latest) {
          console.log(latest.content);
        }
        if (!latest) {
          console.error(
            options.since
              ? `No reply since ${options.since} (no transcript row yet).`
              : 'No reply yet (no transcript row yet).'
          );
        }
        process.exit(ExitCode.SUCCESS);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
