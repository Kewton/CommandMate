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

/**
 * Approval prompt shown before a public Cloudflare Quick Tunnel is created
 * (Issue #1937, R9 — design §6.4).
 *
 * Lives here, beside {@link REVERSE_PROXY_WARNING}, because it is the same kind
 * of statement: "this next step puts the machine somewhere it was not". Keeping
 * the two together is also what stops the wording from drifting into the
 * orchestrator, where a future refactor could quietly reword or skip it.
 *
 * The Provider never prints this. Selection and approval are the orchestrator's
 * responsibility (§6.2): a prompt inside a Provider would have to re-derive
 * interactive-vs-not per Provider, and its answer would be invisible to the
 * caller that has to honour `--yes`.
 */
export const QUICK_TUNNEL_APPROVAL_WARNING = `
\x1b[1m\x1b[33mWARNING: A Cloudflare Quick Tunnel exposes this machine on the public internet\x1b[0m

cloudflared creates a temporary https://<random>.trycloudflare.com address.
Anyone who learns that address can reach it, and the traffic passes through
Cloudflare. CommandMate answers with token authentication enabled, so a visitor
without the pairing code is refused - but the listener itself is public.

\x1b[1mWhat is exposed:\x1b[0m
  - The CommandMate server on 127.0.0.1 only, and nothing else on this machine
  - Until the tunnel is closed (see --expires and "commandmate remote stop")

\x1b[1mA narrower option:\x1b[0m
  Tailscale Serve publishes to your own tailnet instead of the public internet:
    commandmate remote --provider tailscale

Details: ${GITHUB_SECURITY_GUIDE_URL}
`;

/** The yes/no question asked after {@link QUICK_TUNNEL_APPROVAL_WARNING}. */
export const QUICK_TUNNEL_APPROVAL_QUESTION =
  'Create a public Cloudflare Quick Tunnel now?';

/**
 * Refusal shown when approval cannot be asked for (no TTY) and `--yes` is absent.
 *
 * Defaulting to "yes" here would make a scripted invocation publish the machine
 * without anyone having said so, which is why this path is a CONFIG_ERROR
 * rather than a prompt-less approval.
 */
export const QUICK_TUNNEL_APPROVAL_REQUIRED =
  'Creating a public Quick Tunnel requires explicit approval. Re-run with --yes to approve it, or use --provider tailscale.';
