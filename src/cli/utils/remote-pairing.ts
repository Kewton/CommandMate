/**
 * Re-issue the pairing code of a live `commandmate remote` session (Issue #3127).
 *
 * `remote up` shows the pairing link once, as a QR code, and keeps only the
 * code's HASH on disk (`pairing-code.ts`). When that QR is lost — an agent's
 * chat pane folds the output and cuts the QR off — the link cannot be shown
 * again, because the plaintext code no longer exists anywhere. Before this
 * module the only way back was `remote stop` + `remote`, which tears the
 * Provider down and publishes a NEW URL.
 *
 * What this does instead: mint a fresh code and swap its hash into the
 * existing handoff file, keeping the session token and the expiry. Nothing
 * else changes — the server, the Provider and the public URL are untouched,
 * and no new way in is created. The previous code stops working, because its
 * hash is gone.
 *
 * ## Why the file is renamed away first
 *
 * The consumed flag is the ABSENCE of the handoff file: the server unlinks it
 * on a successful pairing. A plain read-modify-write races with that — a
 * pairing landing between our read and our write would see the file deleted,
 * then recreated by us, and the already-paired session token would become
 * pairable a second time. Renaming the file to a private name first is an
 * atomic claim: if the rename fails with ENOENT the code was spent and we stop;
 * if it succeeds the server can no longer consume it (it sees "absent", which
 * answers 410 for the old code — the code we are about to replace anyway).
 *
 * ## Fail-closed
 *
 * Anything unreadable, malformed or already expired yields no code. A failure
 * after the claim deletes the claimed file rather than guessing, so the worst
 * case is "pairing is gone, run `remote stop` and `remote` again", never "a
 * spent token is pairable again".
 */

import { renameSync, unlinkSync } from 'fs';

import { hashToken } from '../../lib/security/auth';
import {
  generatePairingCode,
  isPairingExpired,
  readPairingHandoff,
  writePairingHandoff,
} from '../../lib/security/pairing-code';

/** Why no new code was issued. */
export type PairingReissueFailure =
  /** The handoff file is absent: the code was used (or never written). */
  | 'consumed'
  /** The code's window has closed. */
  | 'expired'
  /** The file exists but could not be claimed or parsed. */
  | 'unreadable'
  /** Claimed, but the new code could not be written. The pairing is gone. */
  | 'write-failed';

export type PairingReissueResult =
  | {
      ok: true;
      /** Plaintext pairing code. Never persisted; the caller shows it and drops it. */
      code: string;
      /** Epoch ms, unchanged from the original code. */
      expiresAt: number;
    }
  | { ok: false; reason: PairingReissueFailure };

/**
 * @param filePath - Handoff file
 * @returns The private name the file is claimed under while it is rewritten
 */
export function getReissueClaimPath(filePath: string): string {
  return `${filePath}.reissue-${process.pid}`;
}

/**
 * Best-effort unlink. A missing file is the state we wanted.
 *
 * @param filePath - File to remove
 */
function removeQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone.
  }
}

/**
 * Put a claimed file back where the server reads it. When that fails the
 * claimed copy is deleted: an orphan holding the plaintext token is worse than
 * a pairing that has to be started again.
 *
 * @param claimPath - Where the file was claimed to
 * @param filePath - Where the server expects it
 */
function restoreClaim(claimPath: string, filePath: string): void {
  try {
    renameSync(claimPath, filePath);
  } catch {
    removeQuietly(claimPath);
  }
}

/**
 * Replace the pairing code of an unused handoff file with a fresh one.
 *
 * @param filePath - Absolute path of the handoff file (`state.pairing.filePath`)
 * @param now - Epoch ms, injectable for tests
 * @returns The new code and its (unchanged) expiry, or why there is none
 */
export function reissuePairingCode(filePath: string, now: number = Date.now()): PairingReissueResult {
  const claimPath = getReissueClaimPath(filePath);

  try {
    renameSync(filePath, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { ok: false, reason: code === 'ENOENT' ? 'consumed' : 'unreadable' };
  }

  const handoff = readPairingHandoff(claimPath);
  if (handoff === null) {
    restoreClaim(claimPath, filePath);
    return { ok: false, reason: 'unreadable' };
  }

  if (isPairingExpired(handoff, now)) {
    restoreClaim(claimPath, filePath);
    return { ok: false, reason: 'expired' };
  }

  const code = generatePairingCode();
  try {
    writePairingHandoff(claimPath, {
      pairingHash: hashToken(code),
      expiresAt: handoff.expiresAt,
      sessionToken: handoff.sessionToken,
    });
    renameSync(claimPath, filePath);
  } catch {
    removeQuietly(claimPath);
    return { ok: false, reason: 'write-failed' };
  }

  return { ok: true, code, expiresAt: handoff.expiresAt };
}
