/**
 * Gateway re-export for legacy session adoption (Issue #2866).
 *
 * `adoptLegacySessions` lives in `src/lib/session/`, which may not import
 * `src/lib/tmux/**` directly (Issue #1922, `.eslintrc.json`
 * `no-restricted-imports`). The CLITool layer is a sanctioned gateway, so the
 * one session listing and the adoption table it needs are reached through here
 * — the same arrangement as `session-ownership.ts` (Issue #2865).
 */

export { listSessions, type TmuxSession } from '../tmux/tmux';
export {
  clearLegacyAliasesForTests,
  dropLegacyAliasByLegacyName,
  lookupLegacyAlias,
  registerLegacyAlias,
} from '../tmux/legacy-session-alias';
