/**
 * Shared help text for the two flags that name *where* a message goes:
 * `--instance` (the instance) and `--agent` (the CLI tool behind it).
 *
 * Issue #1638: the flags were not interchangeable and the docs did not say so.
 * `--instance` is accepted by `send` / `wait` / `respond` / `capture` /
 * `auto-yes`; `--agent` is accepted by every one of those except `wait`, which
 * rejects it with `unknown option` (exit 1). A worktree cut for Codex therefore
 * ran Claude in silence when a workflow copied from the quick start omitted the
 * target flag on the one command that could not take it.
 *
 * ## Why `--agent` is kept rather than removed
 *
 * Removing it would break every shipped script, the embedded `commandmate docs`
 * guide and the published user guide, in exchange for making the flag set look
 * symmetric. It also cannot be removed outright: `send --register` needs an
 * explicit CLI tool whenever the instance id is not itself a tool id
 * (`--instance codex-3 --register` has no other way to say "this is codex"),
 * and an ad-hoc instance the roster has never seen carries no tool either.
 *
 * So `--agent` stays as-is — same parsing, same precedence (Issue #1629: the
 * roster wins, a contradiction is an error) — and only its *position* changes:
 * it is the supplement for ad-hoc, roster-less instances, not the way to pick
 * an agent. The recommended form is `--instance <id>` on its own, which works
 * on all five commands: a rostered instance carries its CLI tool, and an
 * instance id that is itself a tool id (`--instance codex`) resolves to that
 * tool's primary instance without a roster row.
 *
 * Adding `wait --agent` was rejected in #1629: without an instance, `--agent
 * codex` does not say *which* codex session to wait on.
 */

import { CLI_TOOL_IDS } from './cli-tool-ids';

/**
 * `--agent` description for send / respond / capture / auto-yes.
 * `instances add --agent` is deliberately NOT this text: there the flag
 * declares the tool of a new roster entry and is required, not a supplement.
 */
export const AGENT_OPTION_DESCRIPTION =
  `Ad-hoc CLI tool for an instance the roster does not know (${CLI_TOOL_IDS.join(', ')}). `
  + 'Prefer --instance on its own: a rostered instance already carries its CLI tool, '
  + 'and --instance is the only target flag every command accepts (wait has no --agent).';

/** `--instance` description, shared by send / respond / capture / auto-yes. */
export const INSTANCE_OPTION_DESCRIPTION =
  'Agent instance ID: <agent> or <agent>-<n> (e.g. claude-2). '
  + 'Recommended way to name the target; accepted by send/wait/respond/capture/auto-yes. '
  + "Defaults to the agent's primary instance.";

/**
 * `--instance` description for `wait`, which has no `--agent` to fall back on.
 * Spelling that out here is the point of the Issue: a workflow that names the
 * agent on `send` and nothing on `wait` waits on the wrong session in silence.
 */
export const WAIT_INSTANCE_OPTION_DESCRIPTION =
  `${INSTANCE_OPTION_DESCRIPTION} wait takes no --agent, so name the instance here `
  + '(e.g. --instance codex for the codex primary instance).';
