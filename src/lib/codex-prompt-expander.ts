/**
 * Codex prompt content expander (Issue #790)
 *
 * Codex CLI only reads `$CODEX_HOME/prompts`, so worktree-local
 * `.codex/prompts/*.md` files are never recognized when sent as a
 * `/prompts:NAME` slash command ("Unrecognized command"). Instead we carry the
 * prompt body in the SlashCommand object and, at send time, substitute the
 * user-supplied arguments and send the expanded body as a plain message.
 */

import type { SlashCommandGroup } from '@/types/slash-commands';

/**
 * Substitute argument placeholders inside a Codex prompt body.
 *
 * Substitution rules:
 * - `$ARGUMENTS` is replaced with the full trimmed args string.
 * - `$1` .. `$9` are replaced with the corresponding positional argument
 *   (missing positions become an empty string). `$10` is intentionally NOT
 *   treated as `$1` followed by `0`.
 * - When the body contains no placeholder but args are present, the args are
 *   appended after a blank line (or returned alone if the body is empty).
 *
 * @param body - The prompt body (frontmatter already stripped)
 * @param args - The raw argument string typed after the command name
 * @returns The expanded message body
 */
export function substituteCodexPromptArgs(body: string, args: string): string {
  const trimmedArgs = args.trim();
  const positional = trimmedArgs ? trimmedArgs.split(/\s+/) : [];

  const hasArgumentsToken = /\$ARGUMENTS\b/.test(body);
  const hasPositionalToken = /\$[1-9](?!\d)/.test(body);
  // Any dollar-style placeholder (e.g. $ARGUMENTS, $1, or an unsupported $10)
  // suppresses the append fallback so we never tack the raw args onto a body
  // that already references an argument token.
  const hasAnyArgPlaceholder = /\$(?:ARGUMENTS\b|\d)/.test(body);

  let result = body;

  if (hasArgumentsToken) {
    result = result.replace(/\$ARGUMENTS\b/g, trimmedArgs);
  }

  if (hasPositionalToken) {
    result = result.replace(/\$([1-9])(?!\d)/g, (_match, digit: string) => {
      const index = Number(digit) - 1;
      return positional[index] ?? '';
    });
  }

  if (!hasAnyArgPlaceholder && trimmedArgs) {
    result = result.trim() ? `${result.trimEnd()}\n\n${trimmedArgs}` : trimmedArgs;
  }

  return result;
}

/**
 * Expand a slash-command-style message into a plain Codex prompt body.
 *
 * Parses `/NAME [args]` from the message, looks up a `codex-prompt` command with
 * a string `body` matching NAME, and returns the expanded body. Returns `null`
 * when the message is not a slash command, when the name does not match a
 * codex-prompt command, or when the matched command has no body (in which case
 * the caller should send the original message verbatim).
 *
 * @param message - The trimmed outgoing message
 * @param groups - The available slash command groups (already CLI-tool scoped)
 * @returns The expanded body, or `null` to send the message verbatim
 */
export function expandCodexPromptMessage(
  message: string,
  groups: SlashCommandGroup[]
): string | null {
  const match = /^\/(\S+)([\s\S]*)$/.exec(message);
  if (!match) {
    return null;
  }

  const name = match[1];
  const rest = match[2];

  const command = groups
    .flatMap((group) => group.commands)
    .find(
      (cmd) =>
        cmd.invocation === 'codex-prompt' &&
        cmd.name === name &&
        typeof cmd.body === 'string'
    );

  if (!command || typeof command.body !== 'string') {
    return null;
  }

  return substituteCodexPromptArgs(command.body, rest);
}
