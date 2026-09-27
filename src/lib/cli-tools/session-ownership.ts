/**
 * Gateway re-export of the tmux session-ownership check (Issue #2865).
 *
 * Routes, pollers and the WebSocket server may not import `src/lib/tmux/**`
 * directly (Issue #1922, `.eslintrc.json` `no-restricted-imports`); the
 * CLITool layer is one of the sanctioned gateways, so the ownership check is
 * reached through here. The implementation lives in
 * `src/lib/tmux/session-ownership.ts`.
 */

export {
  FOREIGN_SESSION_ERROR_CODE,
  ForeignSessionError,
  assertSessionNotForeign,
  checkSessionOwnership,
  createCachedOwnershipMatcher,
  foreignSessionErrorBody,
  isSessionPathOwnedBy,
  ownedSessionNameSet,
  type SessionOwnership,
  type SessionOwnershipVerdict,
} from '../tmux/session-ownership';

