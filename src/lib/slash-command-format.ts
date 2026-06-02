import type { SlashCommand } from '@/types/slash-commands';

/**
 * Return the command string shown to users and inserted into the input.
 *
 * Codex skills (.codex/skills/{name}/SKILL.md and the built-in
 * ~/.codex/skills/.system/* skills) are invoked with the `$NAME` syntax that
 * Codex CLI recognizes. Every other command (Claude/Copilot/Gemini commands and
 * skills) uses the `/NAME` form (Issue #790).
 */
export function getSlashCommandTrigger(command: SlashCommand): string {
  if (command.source === 'codex-skill') {
    return `$${command.name}`;
  }

  return `/${command.name}`;
}
