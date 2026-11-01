/**
 * prompt Command - Read the screen an agent is stopped on, once (Issue #3755)
 *
 * `commandmate prompt <worktree-id> [--instance <id>] [--json]` prints one
 * observation (`GET /api/worktrees/:id/current-output?observe=1`, field
 * `promptObservation`): which kind of
 * screen is open (`lib/prompt-observation/kinds`), what it asks, an
 * observation token bound to it, and Auto-Yes as it bears on it. A supervising
 * agent reads this instead of guessing from `capture --pane` (#3746 P4-4).
 *
 * Exit codes:
 * - 0: the screen was read — including when nothing on it asks (`composer` /
 *      `none`) and when no reader names it (`unknown`)
 * - 21: the instance has no running session, so there was no screen to read
 *       (the NOT_STARTED value `wait` uses for the same fact)
 * - 1 / 2 / 99: infrastructure errors, as every other command
 */

import { Command } from 'commander';
import { ExitCode, VerifyExitCode } from '../types';
import type { PromptOptions } from '../types';
import type { CurrentOutputObservedResponse } from '../types/api-responses';
import type { PromptObservation } from '../../lib/prompt-observation/types';
import { PROMPT_OBSERVATION_KINDS } from '../../lib/prompt-observation/kinds';
import { ApiClient, isValidWorktreeId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import {
  isInstanceSelector,
  INSTANCE_ALIAS_HELP_SUFFIX,
  INSTANCE_SELECTOR_ERROR,
  resolveInstanceTarget,
} from './instances';

/** `--instance` description: like the other commands, but this one takes no `--agent`. */
const PROMPT_INSTANCE_OPTION_DESCRIPTION =
  'Agent instance ID: <agent> or <agent>-<n> (e.g. antigravity-2). '
  + "prompt takes no --agent, so name the instance here. Defaults to the worktree's primary instance.";

/**
 * The `current-output` request that carries an observation: `?observe=1`, and
 * the instance first so a reader of the URL sees the target where every other
 * poll puts it.
 */
export function observedCurrentOutputPath(worktreeId: string, instanceId?: string): string {
  return instanceId
    ? `/api/worktrees/${worktreeId}/current-output?instance=${encodeURIComponent(instanceId)}&observe=1`
    : `/api/worktrees/${worktreeId}/current-output?observe=1`;
}

/**
 * Whether a value is an observation this CLI can read.
 *
 * Checked rather than cast: a daemon older than the field sends none, and that
 * is "no observation", never a payload of another shape passed on as one. A
 * newer `schemaVersion` passes: `--json` and `wait` hand it on verbatim.
 */
export function isPromptObservation(value: unknown): value is PromptObservation {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.schemaVersion === 'number' &&
    (body.status === 'observed' || body.status === 'unavailable') &&
    typeof body.target === 'object' &&
    body.target !== null &&
    typeof body.autoYes === 'object' &&
    body.autoYes !== null
  );
}

/**
 * The last send in the words a human reads (Issue #3759), or null when the
 * server holds no record or is older than the field.
 */
export function formatLastSend(lastSend: PromptObservation['lastSend'], now: number = Date.now()): string | null {
  if (!lastSend) return null;
  const ago = `${Math.max(0, Math.round((now - lastSend.at) / 1000))}s ago`;
  const advice =
    lastSend.state === 'not-sent'
      ? ' — the message was not typed; it is not resent automatically'
      : lastSend.state === 'indeterminate'
        ? ' — part of it may have been typed; do not resend before checking `capture --pane`'
        : '';
  return `  last send: ${lastSend.state} (${lastSend.reason}, ${ago})${advice}`;
}

/** The `kind:` line and what the screen asks: question, target, options, answer route and token. */
function formatScreenLines(
  observation: PromptObservation,
  screen: NonNullable<PromptObservation['screen']>,
  now: number,
): string[] {
  const lines: string[] = [];
  const kindNote =
    screen.kind === 'none'
      ? ' (nothing on screen asks for a decision)'
      : screen.kind === 'composer'
        ? ' (at the input box; nothing asks for a decision)'
        : screen.kind === 'unknown'
          ? ' (something waits on a human, and no measured reading names it — inspect `capture --pane`)'
          : '';
  lines.push(`  kind: ${screen.kind}${kindNote}`);
  if (observation.session.starting) lines.push('  (the instance is still launching)');
  if (screen.question !== null) lines.push(`  question: ${screen.question}`);
  if (screen.approvalTarget !== null) lines.push(`  approval target: ${screen.approvalTarget}`);
  if (screen.options.length > 0) {
    lines.push('  options:');
    for (const option of screen.options) {
      const marker = option.position === screen.selectedPosition ? '>' : ' ';
      lines.push(`  ${marker} ${option.position}. ${option.label}`);
    }
  }
  if (screen.answerVia !== 'none') {
    const note = screen.answerVia === 'strict' ? ' (commandmate respond --expect-screen)' : '';
    lines.push(`  answer via: ${screen.answerVia}${note}`);
  }
  if (screen.token !== null) {
    const expiresIn =
      screen.tokenExpiresAt === null ? '' : ` (expires in ${Math.max(0, Math.round((screen.tokenExpiresAt - now) / 1000))}s)`;
    lines.push(`  token: ${screen.token}${expiresIn}`);
  } else if (screen.tokenWithheld === 'unknown-screen' || screen.tokenWithheld === 'no-session-generation') {
    // An older server sends no `tokenWithheld`; `no-decision` needs no line.
    lines.push(`  token: none (${screen.tokenWithheld})`);
  }
  return lines;
}

/** The Auto-Yes lines: switch and poller, the poller's last record, and the contract re-evaluated now. */
function formatAutoYesLines(autoYes: PromptObservation['autoYes']): string[] {
  const lines: string[] = [];
  const enabled = autoYes.enabled === null ? 'unknown' : autoYes.enabled ? 'on' : 'off';
  const poller = autoYes.pollerActive === null ? 'unknown' : autoYes.pollerActive ? 'running' : 'stopped';
  lines.push(
    `  auto-yes: ${enabled}, poller ${poller}${autoYes.stopReason ? `, stopReason=${autoYes.stopReason}` : ''}`,
  );
  const record = autoYes.pollerRecord;
  lines.push(
    record === null
      ? '  poller record: none (a missing record does not mean Auto-Yes can answer)'
      : `  poller record: reason=${record.reason} promptType=${record.promptType} ` +
          `(${record.ageSeconds}s ago; relation to this screen: ${record.screenCorrelation})`,
  );
  const evaluation = autoYes.contractEvaluation;
  const evaluationDetail =
    evaluation.state === 'policy-withholds'
      ? `policy-withholds reason=${evaluation.reason}${evaluation.pattern !== undefined ? ` pattern=${JSON.stringify(evaluation.pattern)}` : ''}`
      : evaluation.state === 'base-withholds'
        ? `base-withholds reason=${evaluation.reason}`
        : evaluation.state === 'not-evaluated'
          ? `not-evaluated (${evaluation.because})`
          : evaluation.state;
  lines.push(
    `  contract re-evaluation: ${evaluationDetail}` +
      (evaluation.contract ? ` (task ${evaluation.contract.taskId ?? 'unknown'}, mode=${evaluation.contract.mode ?? 'none'})` : ' (no contract)'),
  );
  return lines;
}

/** The observation in the words a human reads. */
export function formatPromptObservation(observation: PromptObservation, now: number = Date.now()): string {
  const { target, screen, autoYes } = observation;
  const lines: string[] = [];
  lines.push(
    `Instance ${target.instanceId} (${target.cliToolId}) on ${target.worktreeId}, pane ${target.sessionName}`,
  );
  const lastSendLine = formatLastSend(observation.lastSend, now);
  if (observation.status === 'unavailable' || screen === null) {
    lines.push('  No running session: there is no screen to read.');
    if (lastSendLine !== null) lines.push(lastSendLine);
    return lines.join('\n');
  }

  lines.push(...formatScreenLines(observation, screen, now));

  lines.push(...formatAutoYesLines(autoYes));
  if (lastSendLine !== null) lines.push(lastSendLine);
  return lines.join('\n');
}

export function createPromptCommand(): Command {
  const cmd = new Command('prompt');
  cmd
    .description('Show the screen an agent is stopped on: its kind, question, options and an observation token')
    .argument('<worktree-id>', 'Worktree ID')
    .option('--instance <id>', `${PROMPT_INSTANCE_OPTION_DESCRIPTION} ${INSTANCE_ALIAS_HELP_SUFFIX}`)
    .option('--json', 'Print the observation payload as JSON (schemaVersion-tagged)')
    .option('--token <token>', TOKEN_WARNING)
    .addHelpText(
      'after',
      `
Kinds (screen.kind):
  ${PROMPT_OBSERVATION_KINDS.join(', ')}
  composer / none mean nothing on screen asks for a decision; unknown means
  something waits on a human and no measured reading names it.

Exit codes:
  0   the screen was read (also when nothing asks, and for unknown)
  21  the instance has no running session: nothing to read
  1/2/99  infrastructure errors

The token is short-lived, single use, and bound to the instance, the session
generation, the pane, this appearance of the screen, what it asks and the
highlighted option. None is issued for unknown, or when the server did not
start the running agent (tokenWithheld says which). Auto-Yes is reported as two separate items:
the poller's last record (with how it relates to this screen) and the
contract's policy re-evaluated now. A missing record does not mean Auto-Yes
can answer.

lastSend says how the last send to the instance ended: not-sent (no key of the
message was typed, e.g. prompt not ready), sent, or indeterminate (part of it
may have been typed). Nothing is resent automatically: resend a not-sent
message yourself, and do not resend an indeterminate one before checking
\`capture --pane\`. With overlapping sends it follows the input lock's grant
order, so it may be another request's outcome, not yours (Issue #4065).

To answer the screen only if it is still this one (Issue #3756):
  commandmate respond <worktree-id> --instance <id> --expect-screen <kind> \\
    --observation <token> [--expect-target <approvalTarget>] <label>`,
    )
    .action(async (worktreeId: string, options: PromptOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }
        if (options.instance && !isInstanceSelector(options.instance)) {
          console.error(INSTANCE_SELECTOR_ERROR);
          process.exit(ExitCode.CONFIG_ERROR);
          return;
        }

        const client = new ApiClient({ token: options.token });
        // An alias reaches the route only as the id it names (Issue #2376).
        const instanceId = options.instance
          ? (await resolveInstanceTarget(client, worktreeId, options.instance, undefined, 'read-only')).instanceId
          : undefined;

        const data = await client.get<CurrentOutputObservedResponse>(
          observedCurrentOutputPath(worktreeId, instanceId),
        );
        const body = data.promptObservation;
        if (!isPromptObservation(body)) {
          console.error(
            'Error: the server sent no prompt observation. It is older than this CLI '
              + '(restart it with `commandmate stop` / `commandmate start` after updating).',
          );
          process.exit(ExitCode.UNEXPECTED_ERROR);
          return;
        }

        console.log(options.json ? JSON.stringify(body, null, 2) : formatPromptObservation(body));
        process.exit(body.status === 'observed' ? ExitCode.SUCCESS : VerifyExitCode.NOT_STARTED);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
