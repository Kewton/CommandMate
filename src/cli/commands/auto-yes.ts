/**
 * auto-yes Command - Control auto-yes for a worktree
 * Issue #518: [DR1-08] Factory pattern
 */

import { Command } from 'commander';
import { ExitCode } from '../types';
import type { AutoYesOptions } from '../types';
import type { AutoYesContractPolicy, AutoYesSetResult } from '../types/api-responses';
import { ApiClient, isValidWorktreeId, isValidInstanceId, MAX_STOP_PATTERN_LENGTH } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { parseDurationToMs, AUTO_YES_DURATION_FLAG_RANGE, DEFAULT_DURATION_FLAG } from '../config/duration-constants';
import { isCliToolId, CLI_TOOL_IDS } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveInstanceCliTool } from './instances';
import {
  AUTO_YES_ANSWER_MODES,
  DEFAULT_AUTO_YES_ANSWER_MODE,
  isAutoYesAnswerMode,
} from '../../types/auto-yes-answer-mode';

/** Issue #3863: `--answer-mode`'s help, shared with `send --auto-yes-answer-mode`. */
export const ANSWER_MODE_OPTION_DESCRIPTION =
  `How Auto-Yes answers a question the agent asks (${AUTO_YES_ANSWER_MODES.join(', ')}). ` +
  'recommended: the option marked (Recommended) / （推奨）, else the default; careful: questions are left to you. ' +
  'Permissions are answered alike (allow this call once). Omitted: a grant that is on keeps its mode, a new one is recommended';

/**
 * Issue #3863: the stderr line naming the answer mode Auto-Yes is on with, or
 * null when there is nothing to say. Read off the response — an omitted mode
 * is resolved by the server (a grant that is on keeps its mode), so the CLI
 * cannot know it otherwise.
 *
 * Said when the mode was asked for, or when it is not the default
 * (`recommended`) — a re-enable that kept `careful`, say. An enable that asked
 * for nothing and got the default prints what it printed before the modes
 * (the output scripts already read); `capture --json`, `instances --json` and
 * the response's `answerMode` carry the mode in every case.
 *
 * @param answerMode - `answerMode` of the auto-yes POST (absent from older servers)
 * @param requested - Whether the command named a mode
 */
export function describeAnswerMode(answerMode: string | undefined, requested: boolean): string | null {
  if (answerMode === undefined) return null;
  if (answerMode === DEFAULT_AUTO_YES_ANSWER_MODE && !requested) return null;
  if (answerMode === 'recommended') {
    return 'Answer mode: recommended (questions are answered with the recommended option, else the default).';
  }
  if (answerMode === 'careful') {
    return 'Answer mode: careful (questions are left to you; permissions are still answered).';
  }
  // A mode this build does not know (a newer server): name it, judge nothing.
  return `Answer mode: ${answerMode}.`;
}

/**
 * Issue #3863: validate an answer-mode option value, exiting 2 on a bad one.
 *
 * @param flag - The option's spelling, for the message
 */
export function validateAnswerModeOption(value: string | undefined, flag: string): void {
  if (value !== undefined && !isAutoYesAnswerMode(value)) {
    console.error(`Error: Invalid ${flag}. Must be one of: ${AUTO_YES_ANSWER_MODES.join(', ')}`);
    process.exit(ExitCode.CONFIG_ERROR);
  }
}

/**
 * Report what arming Auto-Yes actually did: which agent (Issue #1909) and what
 * it answered on the way in (Issue #1898-2).
 *
 * Both halves are read off the response rather than worked out here. For the
 * agent that is a rule, not a convenience: a bare `auto-yes <id> --enable`
 * deliberately sends no `cliToolId`, the server applies the precedence chain
 * (roster > explicit > primary anchor > worktree default) that `send` / `wait` /
 * `capture` also get, and resolving it a second time in the CLI is how the two
 * answers diverged in the first place (design §4 D5 決定 1 / DR2-008). The
 * server names what it chose; this only prints it.
 *
 * @param worktreeId - Worktree the command targeted
 * @param result - Body of the auto-yes POST, or undefined from an old daemon
 * @param answerModeRequested - Issue #3863: whether `--answer-mode` was given
 */
function reportEnabled(worktreeId: string, result: AutoYesSetResult | undefined, answerModeRequested = false): void {
  const agent = result?.cliToolId;
  const instanceId = result?.instanceId;
  // `instanceId === cliToolId` is how the primary instance is spelled (#868);
  // repeating it as "copilot (copilot)" would be noise.
  const label = agent && instanceId && instanceId !== agent
    ? `${agent}, instance ${instanceId}`
    : agent;
  console.error(
    label
      ? `Auto-yes enabled for ${worktreeId} (${label}).`
      : `Auto-yes enabled for ${worktreeId}.`
  );
  // Issue #3863: the mode the server put it on with.
  const modeLine = describeAnswerMode(result?.answerMode, answerModeRequested);
  if (modeLine !== null) console.error(modeLine);

  // Issue #1898-2: enabling Auto-Yes under a dialog that was already up used to
  // do nothing at all, silently. If it answered something on the way in, say so
  // — that is the difference between "armed for next time" and "the worker you
  // were unsticking is moving again". Printed after the agent line because the
  // approvals it re-judged are that agent's (#1909).
  const pending = result?.pendingDecisions;
  if (pending && pending.examined > 0) {
    console.error(
      `Re-judged ${pending.examined} pending approval(s): ` +
        `${pending.delivered} answered` +
        `${pending.skipped > 0 ? `, ${pending.skipped} skipped (limit)` : ''}.`,
    );
  }

  // Issue #3723: after the "enabled" line it qualifies.
  for (const line of describeContractPolicy(result?.contractPolicy)) {
    console.error(line);
  }
}

/**
 * The stderr line(s) describing what the contract on the armed instance lets
 * Auto-Yes answer (Issue #3723), or an empty list when there is nothing to say.
 *
 * `mode: 'off'` is a warning: the poller just armed will answer no prompt at
 * all, and before this the only trace of that was `capture --json`'s
 * `autoYes.lastSuppression`, written once a prompt had already sat unanswered.
 * `safe` / `allow-listed` still answer some prompts, so they get one line that
 * names which. No contract, or one that states no mode, prints nothing — the
 * output is what it was.
 *
 * Shared with `send --auto-yes`, so the two ways of arming say the same thing.
 * Neither changes the exit code: arming did succeed, and a script that checks
 * `$?` must not start failing on a contract the operator chose.
 *
 * @param policy - `contractPolicy` from the auto-yes POST (absent from older servers)
 */
export function describeContractPolicy(policy: AutoYesContractPolicy | null | undefined): string[] {
  if (!policy || policy.mode === null) return [];
  const task = policy.taskId ? `the contract of task ${policy.taskId}` : 'the contract on this instance';
  const deny = policy.denyPatternCount > 0
    ? ` ${policy.denyPatternCount} deny pattern(s) also escalate matching prompts to a human.`
    : '';
  if (policy.mode === 'off') {
    return [
      `Warning: ${task} sets autoYes.mode: off, so Auto-Yes is armed but will answer no prompt. ` +
        'Prompts on this instance wait for a human (commandmate respond).',
    ];
  }
  if (policy.mode === 'safe') {
    // Issue #3822: on a tool whose dialog gate is `enforce`, a `yes_no` the
    // tool's own dialog detector does not vouch for is left to a human too.
    return [
      `Note: ${task} sets autoYes.mode: safe; Auto-Yes answers yes_no prompts only ` +
        '(on claude, codex, copilot, opencode and opencode-v2, only those the tool itself shows as a confirmation, not a generic (y/n)).' +
        deny,
    ];
  }
  if (policy.mode === 'allow-listed') {
    const types = policy.allowPromptTypes.length > 0 ? policy.allowPromptTypes.join(', ') : 'none';
    return [`Note: ${task} sets autoYes.mode: allow-listed; Auto-Yes answers only: ${types}.${deny}`];
  }
  // A mode this build does not know (a newer server): name it, judge nothing.
  return [`Note: ${task} sets autoYes.mode: ${policy.mode}.${deny}`];
}

export function createAutoYesCommand(): Command {
  const cmd = new Command('auto-yes');
  cmd
    .description('Control auto-yes for a worktree')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--enable', 'Enable auto-yes')
    .option('--disable', 'Disable auto-yes')
    .option('--duration <duration>', `Duration (${AUTO_YES_DURATION_FLAG_RANGE}, e.g. 1h, 3h, 8h; default ${DEFAULT_DURATION_FLAG})`)
    .option('--stop-pattern <pattern>', 'Stop pattern (regex, max 500 chars). Matched against terminal output; cannot block commands (build logs mentioning the pattern also trigger it). To suppress auto-responses per command, use the task contract\'s autoYes.denyPatterns')
    .option('--answer-mode <mode>', ANSWER_MODE_OPTION_DESCRIPTION)
    .option('--instance <id>', INSTANCE_OPTION_DESCRIPTION)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: AutoYesOptions) => {
      try {
        // [SEC4-04] Validate worktree ID
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Must specify --enable or --disable
        if (!options.enable && !options.disable) {
          console.error('Error: Specify --enable or --disable.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.enable && options.disable) {
          console.error('Error: Cannot specify both --enable and --disable.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #3863
        validateAnswerModeOption(options.answerMode, '--answer-mode');
        if (options.answerMode !== undefined && options.disable) {
          console.error('Error: --answer-mode applies to --enable only.');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        if (options.agent && !isCliToolId(options.agent)) {
          console.error(`Error: Invalid agent. Must be one of: ${CLI_TOOL_IDS.join(', ')}`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // Issue #896: Validate instance ID if provided
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        // [SEC4-06] Validate stop-pattern length
        if (options.stopPattern && options.stopPattern.length > MAX_STOP_PATTERN_LENGTH) {
          console.error(`Error: stop-pattern exceeds maximum length of ${MAX_STOP_PATTERN_LENGTH} characters.`);
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });

        const body: Record<string, unknown> = {
          enabled: !!options.enable,
        };

        if (options.enable) {
          // [DR2-02] Convert duration string to ms
          const durationMs = parseDurationToMs(options.duration ?? DEFAULT_DURATION_FLAG);

          if (durationMs === null) {
            console.error(`Error: Invalid duration. Must be ${AUTO_YES_DURATION_FLAG_RANGE} (e.g. 5h).`);
            process.exit(ExitCode.CONFIG_ERROR);
          }

          body.duration = durationMs;

          if (options.stopPattern) {
            body.stopPattern = options.stopPattern;
          }

          // Issue #3863: sent only when given, so the server keeps a live grant's mode.
          if (options.answerMode !== undefined) {
            body.answerMode = options.answerMode;
          }
        }

        // Issue #1629: the auto-yes poller keys on (worktree, cliTool, instance)
        // and watches the session cliTool names, so the instance must be paired
        // with the CLI tool its roster entry declares.
        const agent = options.instance
          ? await resolveInstanceCliTool(client, worktreeId, options.instance, options.agent)
          : options.agent;

        if (agent) {
          body.cliToolId = agent;
        }

        // Issue #896: per-instance auto-yes
        if (options.instance) {
          body.instanceId = options.instance;
        }

        const result = await client.post<AutoYesSetResult | undefined>(
          `/api/worktrees/${worktreeId}/auto-yes`,
          body,
        );

        if (options.enable) {
          reportEnabled(worktreeId, result, options.answerMode !== undefined);
        } else {
          console.error(`Auto-yes disabled for ${worktreeId}.`);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
