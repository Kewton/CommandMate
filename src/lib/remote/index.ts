/**
 * Public surface of the remote Provider layer (Issue #1937, R1).
 *
 * Note what is not re-exported: there is no selection helper. The orchestrator
 * that will own `src/cli/commands/remote.ts` (R9) applies the selection rule
 * itself — see the header of `./provider-registry`.
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
export { cloudflareProvider, CLOUDFLARE_NOT_IMPLEMENTED_REASON } from './cloudflare';
export { tailscaleProvider, TAILSCALE_NOT_IMPLEMENTED_REASON } from './tailscale';
