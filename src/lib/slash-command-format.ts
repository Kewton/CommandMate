import type { SlashCommand } from '@/types/slash-commands';

/**
 * Return the command string shown to users and inserted into the input.
 */
export function getSlashCommandTrigger(command: SlashCommand): string {
  if (command.invocation === 'codex-prompt') {
    return `/prompts:${command.name}`;
  }

  return `/${command.name}`;
}
