/**
 * Security Messages
 * Issue #179: Reverse proxy authentication recommendation
 * Shared warning constants for CLI commands (DRY principle)
 */

/**
 * Warning message displayed when CM_BIND=0.0.0.0
 * Used by: init.ts, start.ts, daemon.ts
 */
export const REVERSE_PROXY_WARNING = `
\x1b[1m\x1b[31mWARNING: Server is exposed to external networks without authentication\x1b[0m

Exposing the server without reverse proxy authentication
is a serious security risk.

\x1b[1mRisks:\x1b[0m
  File read/write/delete and command execution
  become accessible to third parties.

\x1b[1mRecommended authentication methods:\x1b[0m
  - Nginx + Basic Auth
  - Cloudflare Access
  - Tailscale

Details: https://github.com/Kewton/CommandMate/blob/main/docs/security-guide.md
`;
