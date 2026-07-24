import type { SlashCommand } from '@/types/slash-commands';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Return the command string shown to users and inserted into the input.
 *
 * Codex skills (.codex/skills/{name}/SKILL.md and the built-in
 * ~/.codex/skills/.system/* skills) are invoked with the `$NAME` syntax that
 * Codex CLI recognizes. Every other command (Claude/Copilot/Gemini commands and
 * skills) uses the `/NAME` form (Issue #790).
 *
 * `.agents/skills` entries also carry the `codex-skill` source but are surfaced
 * to antigravity sessions as well (Issue #1504). The Antigravity CLI (agy)
 * triggers skills with `/NAME`, not codex's `$NAME`, so when the active session
 * is antigravity a codex-skill resolves to the slash form. Codex sessions keep
 * `$NAME` (non-regression); callers that omit `cliToolId` also keep `$NAME`.
 */
export function getSlashCommandTrigger(
  command: SlashCommand,
  cliToolId?: CLIToolType
): string {
  if (command.source === 'codex-skill') {
    if (cliToolId === 'antigravity') {
      return `/${command.name}`;
    }
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
