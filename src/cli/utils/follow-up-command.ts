/**
 * The next command a CLI message tells the operator to run, aimed at the
 * target the command actually addressed (Issue #3982).
 *
 * Each hint used to append ` --instance ${options.instance}` itself: the string
 * the user typed (an alias reached `capture` unresolved), and nothing at all for
 * `--agent` (so the hint read the worktree default's pane). One of them was
 * fixed in #3975 and the others were not. These builders take the RESOLVED
 * target — {@link CommandTarget}, what `resolveCommandTarget` returns — so the
 * raw option cannot be passed where the hint's target belongs.
 */

import type { CommandTarget } from '../commands/command-target';

/**
 * The `capture` flags that read a dialog: the pane itself (the stored reply is
 * not what is on screen), and enough of it to hold the dialog and its numbers.
 */
export const DIALOG_CAPTURE_FLAGS = '--pane --tail 40';

/**
 * ` --instance <id>` for a resolved instance, else ` --agent <tool>` when one
 * was named, else nothing — a command that named no target keeps naming none.
 */
export function targetFlags(target: CommandTarget): string {
  if (target.instanceId) return ` --instance ${target.instanceId}`;
  if (target.agent) return ` --agent ${target.agent}`;
  return '';
}

/**
 * `commandmate <verb> <worktree-id>[ <args>]<target flags>[ <trailing>]`.
 *
 * @param args - What follows the worktree id, e.g. `<number>` or `"<text>"`
 * @param trailing - Flags that follow the target, e.g. `--pane --tail 40`
 */
export function followUpCommand(
  verb: string,
  worktreeId: string,
  target: CommandTarget,
  args?: string,
  trailing?: string,
): string {
  return `commandmate ${verb} ${worktreeId}${args ? ` ${args}` : ''}${targetFlags(target)}${trailing ? ` ${trailing}` : ''}`;
}

/** The `capture` that shows the target's dialog as it is on screen. */
export function dialogCaptureCommand(worktreeId: string, target: CommandTarget): string {
  return followUpCommand('capture', worktreeId, target, undefined, DIALOG_CAPTURE_FLAGS);
}

/**
 * `commandmate capture <id>[ target] --pane`: the pane a message went to, to
 * look at before a resend (Issue #3992). Without a target (a caller that has
 * none to give) it names none.
 */
export function paneCaptureCommand(worktreeId: string, target: CommandTarget | undefined): string {
  return target
    ? followUpCommand('capture', worktreeId, target, undefined, '--pane')
    : `commandmate capture ${worktreeId} --pane`;
}
