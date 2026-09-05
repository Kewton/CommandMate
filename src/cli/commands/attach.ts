/**
 * attach Command - open a worktree's tmux session in this terminal (Issue #2317, Phase A/D)
 *
 *   commandmate attach <worktree-id> [--instance <id>] [--read-only] [--live]
 *
 * ## Why this exists when `tmux attach` already does
 *
 * Three reasons, and each one is a thing an operator got wrong before it:
 *
 * 1. **The session name.** It is `mcbd-<tool>-<worktree>[-<suffix>]`, and the
 *    suffix depends on the agent-instance roster. `commandmate ls` did not print
 *    it, so the name had to be assembled by hand from three facts spread across
 *    two commands.
 * 2. **The `=` trap.** The exact-match target form is `'=<name>:'` (Issue #1156),
 *    and in zsh an unquoted `=name` is an equals expansion — `tmux attach -t
 *    =mcbd-…:` fails with `not found` before tmux ever runs. Measured; it is in
 *    the Issue. This command quotes it so nobody has to know.
 * 3. **What you will see.** For an alternate-screen agent a bare attach shows
 *    the composer and nothing else — the transcript is at the top of a 1000-row
 *    canvas and tmux follows the cursor at row 997. That is not a fault to
 *    debug, it is the geometry, and the hint printed before attaching says so
 *    and names the three ways to read anyway.
 *
 * ## `--live` is claude-only, and that is a measurement
 *
 * See `LIVE_ATTACH_TOOLS` in `lib/tmux/session-surface.ts`. Every other tool
 * either reads its reply off the pane, or has detection rules measured only at
 * 200x1000, or cannot survive a width change at all.
 */

import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { ExitCode } from '../types';
import type { AttachOptions } from '../types';
import { ApiClient, isValidWorktreeId, isValidInstanceId } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId, DEFAULT_CLI_TOOL_ID } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveSessionTarget, describeSessionTargetConflict } from '../utils/session-target';
import { resolveSessionName } from '../../lib/cli-tools/session-name';
import type { CLIToolType } from '../../lib/cli-tools/types';
import {
  buildAttachArgs,
  buildDelegateGeometryCommands,
  buildRestoreGeometryCommands,
  buildSwitchClientArgs,
  exactSessionTarget,
  isLiveAttachSupported,
  usesAltScreen,
} from '../../lib/session/tmux-session-surface';

/** Run one tmux command, inheriting nothing. Returns true on exit 0. */
function runTmux(args: string[]): boolean {
  const result = spawnSync('tmux', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  return result.status === 0;
}

/**
 * Resolve which (tool, instance) pair the worktree id addresses.
 *
 * Through the server's resolver, exactly as `send` / `capture` / `wait` do
 * (Issue #1925): the tool id is half the tmux session name, so a locally-guessed
 * one is a different session. A `--agent` the roster contradicts is a hard error
 * here rather than a warning — attaching is a thing you do WITH a session, and
 * doing it to the wrong one wastes the reader's time in a way a wrong `capture`
 * does not.
 */
async function resolveTarget(
  client: ApiClient,
  worktreeId: string,
  options: AttachOptions
): Promise<{ cliToolId: string; instanceId: string | undefined }> {
  const target = await resolveSessionTarget(client, worktreeId, {
    instanceId: options.instance,
    requestedCliTool: options.agent,
  });
  if (target.conflict) {
    console.error(`Error: ${describeSessionTargetConflict(target.conflict)}`);
    process.exit(ExitCode.CONFIG_ERROR);
  }
  return {
    cliToolId: target.cliToolId ?? options.agent ?? DEFAULT_CLI_TOOL_ID,
    instanceId: target.instanceId ?? options.instance,
  };
}

/**
 * The lines printed to stderr before the terminal is handed to tmux.
 *
 * stderr, not stdout: the session takes the screen over immediately afterwards,
 * and a caller piping this command's stdout is not asking for advice.
 *
 * Exported so the test asserts the text a user actually sees rather than a
 * paraphrase of it.
 *
 * @param cliToolId - Resolved CLI tool
 * @param worktreeId - Worktree id, so the hint's commands are copy-pasteable
 * @param sessionName - Resolved tmux session name
 * @param options - The flags as given
 */
export function buildAttachHints(
  cliToolId: string,
  worktreeId: string,
  sessionName: string,
  options: { readOnly?: boolean; live?: boolean }
): string[] {
  const hints = [`Attaching to ${sessionName} (${cliToolId}). Detach with Ctrl+b then d.`];

  if (usesAltScreen(cliToolId) && !options.live) {
    hints.push(
      `${cliToolId} draws its transcript at the top of a 200x1000 canvas and its composer at the`,
      'bottom, and tmux follows the cursor — so this attach shows the composer and blank rows,',
      'not the conversation. To read it:',
      `  prefix + g                                     popup, in this terminal`,
      `  commandmate capture ${worktreeId} --pane --tail 60   without attaching`,
      `  commandmate capture ${worktreeId} --pane --follow    live, without attaching`,
    );
    if (isLiveAttachSupported(cliToolId)) {
      hints.push(
        `  commandmate attach ${worktreeId} --live               re-lay-out to this terminal`,
      );
    }
  }

  if (options.readOnly) {
    hints.push(
      'Read-only attach: tmux delivers no keys but the detach one, so prefix + g does NOT open',
      'the popup here. Read with `commandmate capture <id> --pane --follow` in another terminal.',
    );
  }

  if (options.live) {
    hints.push(
      'Live attach: this session follows THIS terminal until you detach, then goes back to',
      '200x1000. The web terminal shows the smaller frame while you are attached.',
    );
  }

  hints.push(`Status without attaching:  tmux ls -F '#{session_name} #{@cm_status}'`);
  return hints;
}

/**
 * Hand the geometry over, attach, and hand it back (Phase D).
 *
 * The restore runs in a `finally`, so a tmux that exits non-zero — or a
 * `attach-session` interrupted by a signal — still gives the canvas back. The
 * server's poll (`reconcileDelegatedGeometry`) is the second net for the case
 * this process does not survive to run it.
 */
function attachLive(sessionName: string, readOnly: boolean): number {
  for (const args of buildDelegateGeometryCommands(sessionName)) {
    runTmux(args);
  }
  try {
    const result = spawnSync('tmux', buildAttachArgs(sessionName, readOnly), {
      stdio: 'inherit',
    });
    return result.status ?? ExitCode.UNEXPECTED_ERROR;
  } finally {
    for (const args of buildRestoreGeometryCommands(sessionName)) {
      runTmux(args);
    }
  }
}

/**
 * Attach, or switch this tmux client, to `sessionName`.
 *
 * `switch-client` rather than an error when `$TMUX` is set: attaching a session
 * inside another session is what tmux refuses, and switching is what the user
 * meant. When the switch fails — the ambient `$TMUX` is a DIFFERENT tmux server,
 * which is the case CommandMate's own agents run under — the manual command is
 * printed, quoted, rather than a bare "nested sessions" complaint.
 */
function attachOrSwitch(sessionName: string, readOnly: boolean): number {
  if (process.env.TMUX) {
    if (runTmux(buildSwitchClientArgs(sessionName))) return ExitCode.SUCCESS;
    console.error(
      'Error: already inside tmux, and this client could not switch to that session '
      + '(a different tmux server?). From a terminal outside tmux, run:\n'
      + `  tmux attach -t '${exactSessionTarget(sessionName)}'`
    );
    return ExitCode.UNEXPECTED_ERROR;
  }
  const result = spawnSync('tmux', buildAttachArgs(sessionName, readOnly), { stdio: 'inherit' });
  return result.status ?? ExitCode.UNEXPECTED_ERROR;
}

export function createAttachCommand(): Command {
  const cmd = new Command('attach');
  cmd
    .description("Attach this terminal to a worktree's agent tmux session")
    .argument('<worktree-id>', 'Worktree ID')
    .option('--instance <id>', INSTANCE_OPTION_DESCRIPTION)
    .option('--agent <agent>', AGENT_OPTION_DESCRIPTION)
    .option('-r, --read-only', 'Attach without sending any input to the session')
    .option(
      '--live',
      'Re-lay the session out to this terminal while attached, restoring 200x1000 on detach (claude only)'
    )
    .option('--token <token>', TOKEN_WARNING)
    .action(async (worktreeId: string, options: AttachOptions) => {
      try {
        if (!isValidWorktreeId(worktreeId)) {
          console.error('Error: Invalid worktree ID format.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.agent && !isCliToolId(options.agent)) {
          console.error('Error: Invalid agent.');
          process.exit(ExitCode.CONFIG_ERROR);
        }
        if (options.instance && !isValidInstanceId(options.instance)) {
          console.error('Error: Invalid --instance. Must be an alphanumeric/underscore/hyphen identifier (max 64 chars).');
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const client = new ApiClient({ token: options.token });
        const { cliToolId, instanceId } = await resolveTarget(client, worktreeId, options);

        if (options.live && !isLiveAttachSupported(cliToolId)) {
          console.error(
            `Error: --live is not supported for ${cliToolId}. It is claude-only until each other `
            + "agent's detection rules are re-measured at a terminal-sized pane (Issue #2317). "
            + `Attach without it, or read with: commandmate capture ${worktreeId} --pane --follow`
          );
          process.exit(ExitCode.CONFIG_ERROR);
        }

        const sessionName = resolveSessionName(cliToolId as CLIToolType, worktreeId, instanceId);

        if (!runTmux(['has-session', '-t', exactSessionTarget(sessionName)])) {
          console.error(
            `Error: no tmux session named ${sessionName}.\n`
            + `  commandmate ls                      which worktrees have a running session\n`
            + `  commandmate instances ${worktreeId}   which agents this worktree runs`
          );
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }

        for (const line of buildAttachHints(cliToolId, worktreeId, sessionName, {
          readOnly: options.readOnly,
          live: options.live,
        })) {
          console.error(line);
        }

        const status = options.live
          ? attachLive(sessionName, Boolean(options.readOnly))
          : attachOrSwitch(sessionName, Boolean(options.readOnly));
        process.exit(status);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
