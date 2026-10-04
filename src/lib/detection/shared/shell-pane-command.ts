/** `#{pane_current_command}` values of an interactive shell, with tmux's `-` login prefix removed. */
const SHELL_PANE_COMMANDS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);

/**
 * Whether a pane's foreground command is a shell rather than an agent
 * (Issue #3089). Claude Code shows up as `claude`, `node` or its version
 * string (`2.1.287`), never as one of these, so a shell here after the agent
 * was seen running means the agent has exited.
 *
 * @param command - `#{pane_current_command}` of the pane
 */
export function isShellPaneCommand(command: string): boolean {
  return SHELL_PANE_COMMANDS.has(command.trim().replace(/^-/, ''));
}
