/**
 * The fingerprints of `docs/design/agent-roles-adapters.md` §5. All SHA-256, and
 * three different things: the body fingerprint hashes the body's bytes, the
 * artifact fingerprint hashes every byte of a generated file, and the injection
 * fingerprint belongs to #4115's transform. They are never compared to each other.
 *
 * @module lib/agent-roles/fingerprint
 */
import { createHash } from 'crypto';

/** Lower-case hex SHA-256 of exactly these bytes. */
export function computeFingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The body fingerprint: the UTF-8 bytes of the body and nothing else. */
export function computeBodyFingerprint(body: string): string {
  return computeFingerprint(Buffer.from(body, 'utf8'));
}
