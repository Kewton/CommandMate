/**
 * The fingerprint of a prompt's state and the hash of its scope (Issue #4226, design
 * §4.1). No time goes in: a prompt that turned `stale` keeps one fingerprint until the
 * item is updated. No text goes in either: ids, versions, states and counts only.
 *
 * @module lib/mem-suggest/fingerprint
 */

import { createHash } from 'crypto';

const sha256 = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** `sha256(JSON.stringify([code, material]))`. */
export function suggestionFingerprint(code: string, material: unknown): string {
  return sha256([code, material]);
}

/**
 * The scope of a record (the 4th part of its key): the storage root and the branch
 * (null when detached). Hashed so no branch name is kept in the table (D12).
 */
export function suggestionScopeHash(storageRepositoryId: string, branch: string | null): string {
  return sha256([storageRepositoryId, branch]);
}
