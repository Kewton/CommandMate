/**
 * Security Messages
 * Issue #179: Reverse proxy authentication recommendation
 * Issue #331: Updated to include --auth option
 * Shared warning constants for CLI commands (DRY principle)
 *
 * [SF-002] GitHub URLs imported from github-links.ts (DRY)
 */

import { GITHUB_SECURITY_GUIDE_URL } from '../../config/github-links';

/**
 * Warning message displayed when CM_BIND=0.0.0.0 and --auth is not enabled
 * Used by: init.ts, start.ts, daemon.ts
 * Issue #331: Added --auth as a recommended option
 */
export const REVERSE_PROXY_WARNING = `
\x1b[1m\x1b[31mWARNING: Server is exposed to external networks without authentication\x1b[0m

Exposing the server without reverse proxy authentication
or built-in token auth is a serious security risk.

\x1b[1mRisks:\x1b[0m
  File read/write/delete and command execution
  become accessible to third parties.

\x1b[1mRecommended authentication methods:\x1b[0m
  - commandmate start --auth (built-in token auth)
  - commandmate start --allowed-ips 192.168.1.0/24 (IP restriction)
  - Nginx + Basic Auth
  - Cloudflare Access
  - Tailscale

Details: ${GITHUB_SECURITY_GUIDE_URL}
`;
