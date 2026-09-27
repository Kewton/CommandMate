/**
 * Legacy tmux session adoption table (Issue #2866).
 *
 * Once the server has a session-name namespace, a session is named
 * `mcbd-{ns}-{cli}-{worktreeId}[-{suffix}]`. Sessions the same server started
 * before that (`mcbd-{cli}-{worktreeId}[-{suffix}]`) are NOT renamed — a rename
 * would lose them for an older CommandMate running beside this one, or after a
 * downgrade. Instead `adoptLegacySessions` records "the new-format name X is
 * served by the legacy session Y", and `resolveSessionName` returns Y for X
 * while the entry lives.
 *
 * An entry is dropped when its legacy session is killed or found gone
 * (`tmux.ts` `killSession` / `hasSession`), so the next start uses the
 * new-format name.
 *
 * Pure (no `@/` alias, no child_process): `cli-tools/session-name.ts` reads it,
 * and that module is part of the CLI bundle (`tsconfig.cli.json` has no paths).
 *
 * Kept on `globalThis` rather than in module scope: under `next start` this
 * module is evaluated once in the custom server's graph and again in each Next
 * route bundle (see `tui-accumulator.ts`, Issue #2223), and the table is filled
 * by the server at startup but read by the routes.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cmLegacySessionAliases: Map<string, string> | undefined;
}

function aliases(): Map<string, string> {
  return (globalThis.__cmLegacySessionAliases ??= new Map<string, string>());
}

/**
 * Serve the new-format session name `newName` with the existing legacy session
 * `legacyName`.
 */
export function registerLegacyAlias(newName: string, legacyName: string): void {
  aliases().set(newName, legacyName);
}

/** The legacy session name adopted for `newName`, if any. */
export function lookupLegacyAlias(newName: string): string | undefined {
  return aliases().get(newName);
}

/**
 * Forget every adoption served by the legacy session `legacyName`. A no-op for
 * a name that is not an adopted legacy session.
 *
 * @returns true when an entry was removed
 */
export function dropLegacyAliasByLegacyName(legacyName: string): boolean {
  const table = aliases();
  let dropped = false;
  for (const [newName, legacy] of table) {
    if (legacy === legacyName) {
      table.delete(newName);
      dropped = true;
    }
  }
  return dropped;
}

/** Test-only: forget every adoption. */
export function clearLegacyAliasesForTests(): void {
  aliases().clear();
}
