import type { SlashCommand } from '@/types/slash-commands';

/**
 * Return the command string shown to users and inserted into the input.
 *
 * Every command (including Codex prompts, invocation: 'codex-prompt') uses the
 * `/${name}` form. Codex prompts cannot be invoked via `/prompts:NAME` because
 * Codex CLI does not read worktree-local `.codex/prompts/*` files; their bodies
 * are expanded into a plain message at send time instead (Issue #790).
 */
export function getSlashCommandTrigger(command: SlashCommand): string {
  return `/${command.name}`;
}
