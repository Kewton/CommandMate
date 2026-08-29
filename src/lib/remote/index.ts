/**
 * Public surface of the remote Provider layer (Issue #1937, R1/R2/R3).
 *
 * Note what is not re-exported: there is no selection helper. The orchestrator
 * that owns `src/cli/commands/remote.ts` (R9) applies the selection rule
 * itself — see the header of `./provider-registry`.
 *
 * Both `CLOUDFLARE_NOT_IMPLEMENTED_REASON` (removed in R2) and
 * `TAILSCALE_NOT_IMPLEMENTED_REASON` (removed here in R3) are gone for the same
 * reason: both Providers are implemented, so a constant saying otherwise would
 * be a lie a caller could still read and act on.
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
export {
  BACKEND_STATE_RUNNING,
  buildServeArgs,
  buildServeOffArgs,
  buildServeUrl,
  createTailscaleProvider,
  DETECT_TIMEOUT_MS as TAILSCALE_DETECT_TIMEOUT_MS,
  LOOPBACK_HOST as TAILSCALE_LOOPBACK_HOST,
  normalizeDnsName,
  parseServeConfig,
  parseServeHandlerKey,
  readServeReadiness,
  SERVE_HTTPS_PORT,
  SERVE_PATH,
  SERVE_TIMEOUT_MS,
  serveHandlerKey,
  serveHandlerKeys,
  snapshotServeConfig,
  TAILSCALE_BIN,
  TAILSCALE_VERSION_ARG,
  tailscaleProvider,
  type ParsedServeHandlerKey,
  type ServeConfig,
  type ServeReadiness,
  type ServeTcpEntry,
  type ServeWebEntry,
  type TailscaleProviderDeps,
  type TailscaleStatus,
} from './tailscale';
