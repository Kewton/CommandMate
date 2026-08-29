/**
 * Public surface of the remote Provider layer (Issue #1937, R1/R2).
 *
 * Note what is not re-exported: there is no selection helper. The orchestrator
 * that will own `src/cli/commands/remote.ts` (R9) applies the selection rule
 * itself — see the header of `./provider-registry`.
 *
 * `CLOUDFLARE_NOT_IMPLEMENTED_REASON` is gone as of R2: the Cloudflare Provider
 * is implemented, so a constant saying it is not would be a lie a caller could
 * still read. `TAILSCALE_NOT_IMPLEMENTED_REASON` stays until R3 lands, because
 * for Tailscale it is still the true answer.
 */
export {
  isPreexistingSnapshot,
  planStop,
  type PreexistingSnapshot,
  type ProviderDetection,
  type RemoteHandle,
  type RemoteProvider,
  type RemoteProviderId,
  type StopOutcome,
  type StopPlan,
} from './types';
export {
  createRemoteProviders,
  detectRemoteProviders,
  REMOTE_PROVIDER_ORDER,
  type ProviderCandidate,
} from './provider-registry';
export {
  buildQuickTunnelArgs,
  CLOUDFLARED_BIN,
  CLOUDFLARED_PIDFILE_NAME,
  CLOUDFLARED_VERSION_ARG,
  cloudflareProvider,
  createCloudflareProvider,
  DEFAULT_QUICK_TUNNEL_TIMING,
  DETECT_TIMEOUT_MS,
  fetchQuickTunnelHostname,
  findFreeLoopbackPort,
  isQuickTunnelHostname,
  LOOPBACK_HOST,
  parseBannerUrl,
  parseQuickTunnelHostname,
  QUICK_TUNNEL_SUFFIX,
  resolveCloudflareStateDir,
  type CloudflareProviderDeps,
  type QuickTunnelProcess,
  type QuickTunnelTiming,
} from './cloudflare';
export { tailscaleProvider, TAILSCALE_NOT_IMPLEMENTED_REASON } from './tailscale';
