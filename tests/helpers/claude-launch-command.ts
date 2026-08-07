/**
 * Locating the `sendKeys` call that launched the Claude CLI.
 *
 * Before Issue #1722 the launch command was the bare CLI path, so tests found
 * it — and asserted on it — with string equality. It is now
 * `'<path>' --settings '<file>'`, and `CM_AGENT_HOOKS_INJECT=0` puts the bare
 * form back, so both spellings are legitimate launches of the same binary.
 *
 * Shared between the unit and integration suites on purpose. The tests that
 * broke when the launch line changed are about *which path was resolved*
 * (CLAUDE_PATH validation) and *when the launch happened* relative to
 * environment sanitisation — never about the flags. Giving them one definition
 * of "this is the launch call" keeps the next change to the launch line from
 * breaking the same assertions in two places, and keeps that definition
 * narrow: it still refuses a launch from any other path.
 *
 * @module tests/helpers/claude-launch-command
 */

/** `sendKeys(sessionName, command, sendEnter?)` as vitest records it. */
export type SendKeysCall = readonly unknown[];

/**
 * Whether `command` launches the CLI binary at `claudePath`.
 *
 * Matches the bare path and the quoted-with-flags form, and nothing else — in
 * particular not a different path that happens to contain this one as a
 * substring, and not a path merely mentioned inside a flag value.
 */
export function isClaudeLaunchCommand(command: unknown, claudePath: string): boolean {
  if (typeof command !== 'string') return false;
  return command === claudePath || command.startsWith(`'${claudePath}' `);
}

/**
 * @returns Index of the call that launched `claudePath`, or -1 when no call did
 */
export function findClaudeLaunchIndex(
  calls: readonly SendKeysCall[],
  claudePath: string
): number {
  return calls.findIndex((call) => isClaudeLaunchCommand(call[1], claudePath));
}

/** Every command string passed to `sendKeys`, for a readable failure message. */
export function sendKeysCommands(calls: readonly SendKeysCall[]): unknown[] {
  return calls.map((call) => call[1]);
}
