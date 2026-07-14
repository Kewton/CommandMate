/**
 * VAPID configuration for Web Push (Issue #1125).
 *
 * Keys are supplied via environment variables and read lazily so tests can vary
 * them and so an unconfigured deployment simply disables push (never crashes).
 * The private key and subject are secrets — never log the returned config.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const DEFAULT_SUBJECT = 'mailto:commandmate@localhost';

/**
 * Returns the VAPID config, or null when push is not configured (both public
 * and private keys must be present). Read from env on every call.
 */
export function getVapidConfig(): VapidConfig | null {
  const publicKey = process.env.CM_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.CM_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) {
    return null;
  }
  const subject = process.env.CM_VAPID_SUBJECT?.trim() || DEFAULT_SUBJECT;
  return { publicKey, privateKey, subject };
}

/** True when both VAPID keys are configured. */
export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

/** The public (application server) key clients need to subscribe, or null. */
export function getVapidPublicKey(): string | null {
  return getVapidConfig()?.publicKey ?? null;
}
