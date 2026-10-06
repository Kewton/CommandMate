/**
 * attach Command - open a worktree's tmux session in this terminal (Issue #2317, Phase A/D)
 *
 *   commandmate attach <worktree-id> [--instance <id>] [--read-only] [--live]
 *
 * ## Why this exists when `tmux attach` already does
 *
 * Three reasons, and each one is a thing an operator got wrong before it:
 *
 * 1. **The session name.** It is `mcbd-<ns>-<tool>-<worktree>[-<suffix>]` (or
 *    the legacy `mcbd-<tool>-<worktree>[-<suffix>]` for a session the server
 *    adopted), the suffix depends on the agent-instance roster, and the `<ns>`
 *    lives in the server's DB (Issue #2866). `commandmate ls` did not print it,
 *    so the name had to be assembled by hand from facts spread across two
 *    commands — and since #2866 it cannot be assembled client-side at all.
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
import {
  ApiClient,
  ApiError,
  FOREIGN_SESSION_ERROR_CODE,
  foreignSessionMessage,
  isValidWorktreeId,
  isValidInstanceId,
} from '../utils/api-client';
import type { ApiErrorPayload } from '../utils/api-client';
import { TOKEN_WARNING, handleCommandError } from '../utils/command-helpers';
import { isCliToolId, DEFAULT_CLI_TOOL_ID } from '../config/cli-tool-ids';
import { AGENT_OPTION_DESCRIPTION, INSTANCE_OPTION_DESCRIPTION } from '../config/agent-target-options';
import { resolveSessionTarget, describeSessionTargetConflict } from '../utils/session-target';
import { fetchAgentInstances } from '../utils/agent-instances';
import { resolveLegacySessionName } from '../../lib/cli-tools/session-name';
import { validateSessionName } from '../../lib/cli-tools/validation';
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

/** The name `attach` will connect to, and whether the server published it. */
export interface AttachSessionTarget {
  sessionName: string;
  /**
   * True when the name came from the server's roster (Issue #2867); false when
   * it is the legacy name assembled here because the roster could not supply
   * one. Only a published name is the one the server's own routes address, so
   * only a published name can be vouched for by them (Issue #3334).
   */
  published: boolean;
}

/**
 * The tmux session name the server uses for this (tool, instance) (Issue #2867).
 *
 * The server publishes it per roster entry (`sessionName` on
 * `GET /api/worktrees/[id]`), and that is the only place that knows both the
 * server's namespace and whether a legacy session was adopted under the old
 * name. A server older than #2867 sends no `sessionName` — and it also names
 * its sessions the legacy way, so assembling the legacy name is right there.
 * An unreadable roster, or a published name that fails `validateSessionName`
 * (it is echoed into a copy-pasteable shell line), degrades the same way rather
 * than failing the attach: `has-session` still refuses a name that opens nothing.
 */
async function resolveAttachSessionName(
  client: ApiClient,
  worktreeId: string,
  cliToolId: string,
  instanceId: string | undefined
): Promise<AttachSessionTarget> {
  const targetId = instanceId ?? cliToolId;
  try {
    const instances = await fetchAgentInstances(client, worktreeId);
    const published = instances.find((inst) => inst.id === targetId)?.sessionName;
    if (published) {
      validateSessionName(published);
      return { sessionName: published, published: true };
    }
  } catch {
    // Fall through to the legacy name.
  }
  return {
    sessionName: resolveLegacySessionName(cliToolId as CLIToolType, worktreeId, instanceId),
    published: false,
  };
}

/**
 * What the server could say about the session `attach` is about to open.
 *
 * - `owned`: the server's ownership check passed, for this very name.
 * - `foreign`: the server answered 409 `session_owned_by_other_server` for
 *   this very name.
 * - `unconfirmed`: anything else — the owner is not known. The server answered
 *   about a DIFFERENT name than the one `attach` connects to (`other-name`), or
 *   gave no ownership answer at all (`no-answer`, i.e. any non-2xx such as the 404
 *   for a namespaced session that does not exist, a server older than #2865,
 *   no server).
 */
export type AttachOwnership =
  | { verdict: 'owned' }
  | { verdict: 'foreign'; payload: ApiErrorPayload }
  | { verdict: 'unconfirmed'; why: 'other-name' | 'no-answer'; checkedName: string | null };

/**
 * Ask the server whether the session `attach` is about to open is its own
 * (Issue #3334).
 *
 * ## Why ask the server, and why through `capture`
 *
 * `has-session` answers by name, and a name is all two servers on one tmux
 * socket have in common (Issue #2865): a worktree directory called the same on
 * both resolves to the same `mcbd-…` name. Only the server that holds the
 * worktree row knows the directory its own session was started in, and every
 * session route already compares that with tmux's `#{session_path}` and
 * answers 409 `session_owned_by_other_server` when they differ. `capture` with
 * `lines: 1` is the cheapest of them, reads nothing it would not show anyway,
 * and sends tmux no key.
 *
 * ## The name has to be the same one
 *
 * The route checks the name IT resolves — the namespaced one, or the legacy
 * one it adopted — which is exactly the name the roster publishes. When the
 * roster could not be read, `attach` falls back to the legacy name, and a 200
 * from `capture` is then about a different session: the namespaced name and
 * the legacy name can both exist, one this server's and one another's. So a
 * 200 counts as `owned` only for a published name, and a 409 counts as
 * `foreign` only when the name it reports is the one being opened.
 *
 * Every other outcome is `unconfirmed`, including no answer at all. A 404
 * from `capture` is the common case of that: the roster could not be read, the
 * name fell back to the legacy form, and the server's namespaced session does
 * not exist — so the legacy session `has-session` found belongs to nobody this
 * server can vouch for. Only a confirmed owner gets a writable attach.
 */
export async function checkAttachOwnership(
  client: ApiClient,
  worktreeId: string,
  cliToolId: string,
  instanceId: string | undefined,
  target: AttachSessionTarget
): Promise<AttachOwnership> {
  try {
    await client.post(`/api/worktrees/${worktreeId}/capture`, {
      cliToolId,
      lines: 1,
      ...(instanceId !== undefined && instanceId !== cliToolId ? { instanceId } : {}),
    });
    return target.published
      ? { verdict: 'owned' }
      : { verdict: 'unconfirmed', why: 'other-name', checkedName: null };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409 && error.apiCode === FOREIGN_SESSION_ERROR_CODE) {
      const payload = error.payload ?? { code: FOREIGN_SESSION_ERROR_CODE };
      const checkedName = typeof payload.sessionName === 'string' ? payload.sessionName : null;
      if (checkedName === target.sessionName || (checkedName === null && target.published)) {
        return { verdict: 'foreign', payload };
      }
      return { verdict: 'unconfirmed', why: 'other-name', checkedName };
    }
    return { verdict: 'unconfirmed', why: 'no-answer', checkedName: null };
  }
}

/**
 * What to do with an attach the server did not vouch for (Issue #3334): a
 * session another server owns (`foreign`), or one whose owner could not be
 * confirmed because the server checked a different name (`unconfirmed`).
 *
 * Attaching is the one path where the operator named the session themselves,
 * and looking at it can be what they came for — so the attach is not refused,
 * it is made read-only: tmux then delivers no key but the detach one. The two
 * forms that cannot be made read-only are refused before tmux is touched:
 *
 * - `--live` re-lays the session out (`set-option` / `resize-window`), which
 *   changes the other server's pane whether or not a key is typed;
 * - inside tmux, `switch-client` has no read-only form (its `-r` TOGGLES the
 *   client's mode, so it can just as well turn read-only off), and the manual
 *   `attach -r` from outside tmux is printed instead.
 *
 * @returns the lines for stderr and whether to go on (read-only)
 */
export function planGuardedAttach(
  ownership: Extract<AttachOwnership, { verdict: 'foreign' | 'unconfirmed' }>,
  sessionName: string,
  options: { live?: boolean; insideTmux: boolean }
): { proceedReadOnly: boolean; lines: string[] } {
  const reason = ownership.verdict === 'foreign'
    ? foreignSessionMessage(ownership.payload)
    : `Could not confirm that tmux session "${sessionName}" is this CommandMate server's: `
      + (ownership.why === 'no-answer'
        ? 'the server gave no ownership answer for it (an older server, a session it does not have, or no server).'
        : ownership.checkedName
          ? `the server checked "${ownership.checkedName}", not that name.`
          : 'the server did not publish the session name it uses, so its check was about a different name.');
  if (options.live) {
    return {
      proceedReadOnly: false,
      lines: [`Error: ${reason}`, '--live would re-lay that session out, so it was not attached.'],
    };
  }
  if (options.insideTmux) {
    return {
      proceedReadOnly: false,
      lines: [
        `Error: ${reason}`,
        'Inside tmux this client can only switch to it with keys enabled, so it was not switched. '
          + 'To look at it read-only, from a terminal outside tmux run:',
        `  tmux attach -r -t '${exactSessionTarget(sessionName)}'`,
      ],
    };
  }
  if (ownership.verdict === 'unconfirmed') {
    return {
      proceedReadOnly: true,
      lines: [`Warning: ${reason}`, 'Attaching READ-ONLY, so no key you type reaches it.'],
    };
  }
  const where = typeof ownership.payload.sessionPath === 'string' && ownership.payload.sessionPath !== ''
    ? ` (it was started in ${ownership.payload.sessionPath})`
    : '';
  return {
    proceedReadOnly: true,
    lines: [
      `Warning: tmux session "${sessionName}" belongs to another CommandMate server${where}.`,
      'Attaching READ-ONLY, so no key you type reaches it. To work in it, use the server that started it.',
    ],
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

        const target = await resolveAttachSessionName(client, worktreeId, cliToolId, instanceId);
        const { sessionName } = target;

        if (!runTmux(['has-session', '-t', exactSessionTarget(sessionName)])) {
          console.error(
            `Error: no tmux session named ${sessionName}.\n`
            + `  commandmate ls                      which worktrees have a running session\n`
            + `  commandmate instances ${worktreeId}   which agents this worktree runs`
          );
          process.exit(ExitCode.UNEXPECTED_ERROR);
        }

        // Issue #3334: the name exists, but it may be another server's session,
        // and the server's check has to be about this very name.
        let readOnly = Boolean(options.readOnly);
        // Only a confirmed owner attaches writable; everything else is read-only
        // or refused (`planGuardedAttach`).
        const ownership = await checkAttachOwnership(client, worktreeId, cliToolId, instanceId, target);
        if (ownership.verdict !== 'owned') {
          const plan = planGuardedAttach(ownership, sessionName, {
            live: options.live,
            insideTmux: Boolean(process.env.TMUX),
          });
          for (const line of plan.lines) console.error(line);
          if (!plan.proceedReadOnly) process.exit(ExitCode.UNEXPECTED_ERROR);
          readOnly = true;
        }

        for (const line of buildAttachHints(cliToolId, worktreeId, sessionName, {
          readOnly,
          live: options.live,
        })) {
          console.error(line);
        }

        const status = options.live
          ? attachLive(sessionName, readOnly)
          : attachOrSwitch(sessionName, readOnly);
        process.exit(status);
      } catch (error) {
        handleCommandError(error);
      }
    });
  return cmd;
}
