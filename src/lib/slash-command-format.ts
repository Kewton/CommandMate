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

/** Translator for the `worktree` namespace, narrowed to what description lookup needs. */
export type CommandDescriptionTranslator = (key: string) => string;

/**
 * Return the description shown to users for a command (Issue #1306).
 *
 * Built-in commands are plain data defined outside React, so they carry a
 * `descriptionKey` instead of translated text. User-authored commands keep the
 * literal `description` from their frontmatter, which is not translatable.
 *
 * Callers that match user input against descriptions must go through this too,
 * otherwise built-in commands become unsearchable by their description text.
 */
export function resolveCommandDescription(
  command: SlashCommand,
  t: CommandDescriptionTranslator
): string {
  if (command.descriptionKey) {
    return t(command.descriptionKey);
  }

  return command.description ?? '';
}
