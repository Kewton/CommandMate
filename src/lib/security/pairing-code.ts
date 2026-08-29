/**
 * Pairing code lifecycle for `commandmate remote` (Issue #1937, R5)
 *
 * Design: docs/design/remote-qr-pairing-1937.md §7
 *
 * CONSTRAINTS:
 * - NODE RUNTIME ONLY. This module touches `fs` and `crypto`; the Edge Runtime
 *   (`src/middleware.ts`) must never import it. Pairing is an excluded path, so
 *   middleware never needs to.
 * - No Next.js imports, so `src/cli/**` can pull it in for `commandmate remote`
 *   under `tsconfig.cli.json` (which declares `"paths": {}` — relative imports
 *   only, never `@/...`).
 *
 * WHY A FILE AND NOT AN ENVIRONMENT VARIABLE (§7.2)
 * -------------------------------------------------
 * The cookie has to carry the *plaintext* long-lived token, so the server must
 * know it. The obvious route — put it in the server's startup env — is rejected:
 * `src/lib/tmux/**` passes no `env:` to the panes it spawns, so a pane inherits
 * the server's environment wholesale, and `sanitizeEnvForChildProcess()` is
 * called in only two places that an agent pane does not go through. An env var
 * would therefore be readable by the very Claude / Codex / OpenCode processes
 * CommandMate is driving.
 *
 * So the secret lands in one 0600 handoff file and only its *path* travels in
 * `CM_REMOTE_PAIRING_FILE` (a path is not a secret). Two further consequences:
 *
 *   - The consumed flag is THE ABSENCE OF THE FILE. A module-level variable
 *     cannot work here: `server.ts` and the Next route handler bundle are
 *     separate module instances, so state written by one is invisible to the
 *     other.
 *   - Deleting the file destroys the plaintext token at the moment of pairing,
 *     shrinking its window on disk to "remote start → first pairing".
 */

import { timingSafeEqual } from 'crypto';
import { mkdirSync, chmodSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { isValidTokenHash } from '../../config/auth-config';
import { ensureConfigDir, getConfigDir } from '../../cli/utils/install-context';
import { generateToken, hashToken } from './auth';

/** Env var carrying the handoff file PATH (never the secret itself). */
export const PAIRING_FILE_ENV_KEY = 'CM_REMOTE_PAIRING_FILE';

/** File name inside the config directory (`~/.commandmate` for global installs). */
export const PAIRING_FILE_NAME = 'remote-pairing.json';

/** Owner read/write only. Asserted by tests, not merely intended. */
export const PAIRING_FILE_MODE = 0o600;

/**
 * Crockford Base32 (https://www.crockford.com/base32.html).
 * `I`, `L`, `O` and `U` are absent so a transcribed code cannot be ambiguous.
 */
export const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bits of entropy carried by a pairing code. */
export const PAIRING_CODE_BITS = 128;

/** ceil(128 / 5) — the encoded length of PAIRING_CODE_BITS. */
export const PAIRING_CODE_LENGTH = 26;

/** Default time-to-live for one pairing code (§7.4). */
export const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Input length cap for `POST /api/remote/pair`, copied from `/api/auth/login`'s
 * 256-char cap so an oversized body cannot be used to burn CPU on hashing.
 */
export const MAX_PAIRING_CODE_LENGTH = 256;

/** On-disk shape of the handoff file. */
export interface PairingHandoff {
  /** SHA-256 hex of the canonical pairing code. The code itself is never stored. */
  pairingHash: string;
  /** Epoch ms after which the code is dead. */
  expiresAt: number;
  /** Plaintext long-lived token that becomes the auth cookie value. */
  sessionToken: string;
}

/** What `createPairingHandoff()` hands back to the caller (the `remote` command). */
export interface CreatedPairing {
  /**
   * Plaintext pairing code. NEVER persisted — the caller renders it as a QR
   * code and drops it. Re-displaying it means running `remote` again.
   */
  code: string;
  /** Plaintext long-lived token (also written to the handoff file). */
  sessionToken: string;
  expiresAt: number;
  filePath: string;
}

export interface CreatePairingHandoffOptions {
  /** Defaults to `<configDir>/remote-pairing.json`. */
  filePath?: string;
  /** Defaults to {@link DEFAULT_PAIRING_TTL_MS}. */
  ttlMs?: number;
  /** Defaults to a fresh `generateToken()`. */
  sessionToken?: string;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Encode bytes as Crockford Base32, MSB first, no padding character.
 *
 * 16 bytes (128 bits) produce 26 characters: 25 characters consume 125 bits and
 * the remaining 3 bits are left-shifted into the 26th.
 *
 * @param bytes - Raw bytes to encode
 * @returns Crockford Base32 string
 */
export function encodeCrockfordBase32(bytes: Buffer): string {
  let out = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_BASE32_ALPHABET[(buffer >>> (bits - 5)) & 0b11111];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += CROCKFORD_BASE32_ALPHABET[(buffer << (5 - bits)) & 0b11111];
  }

  return out;
}

/**
 * Canonicalize a transcribed pairing code.
 *
 * This is the whole reason Crockford Base32 was picked over RFC 4648 Base32:
 * `i`/`l` are accepted as `1`, `o` as `0`, case is irrelevant, and grouping
 * spaces or hyphens a human inserted are dropped. `generatePairingCode()`
 * already emits the canonical form, so `normalize(generate()) === generate()`
 * and the QR path is unaffected.
 *
 * @param code - Raw user/QR supplied code
 * @returns Canonical uppercase form used for hashing
 */
export function normalizePairingCode(code: string): string {
  return code
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/[ILO]/g, (character) => (character === 'O' ? '0' : '1'));
}

/**
 * Generate a pairing code carrying {@link PAIRING_CODE_BITS} bits of entropy.
 *
 * Reuses `generateToken()` (32 random bytes as hex) rather than calling
 * `randomBytes` again, and keeps the leading 128 bits: at a 10-minute TTL,
 * single use and a rate limit, 128 bits is already extravagant, and a 26-char
 * code keeps the QR small enough to scan from a laptop screen.
 *
 * @returns 26-character Crockford Base32 code
 */
export function generatePairingCode(): string {
  const hexDigits = PAIRING_CODE_BITS / 4;
  return encodeCrockfordBase32(Buffer.from(generateToken().slice(0, hexDigits), 'hex'));
}

/**
 * Absolute path of the default handoff file.
 *
 * @returns `<configDir>/remote-pairing.json`
 */
export function getDefaultPairingFilePath(): string {
  return join(getConfigDir(), PAIRING_FILE_NAME);
}

/**
 * Read the handoff file path out of the environment.
 *
 * @returns The path, or null when `remote` is not running (route answers 404)
 */
export function getPairingFilePathFromEnv(): string | null {
  const value = process.env[PAIRING_FILE_ENV_KEY];
  return value && value.trim().length > 0 ? value : null;
}

/**
 * Write the handoff file with mode 0600.
 *
 * An existing file is unlinked first: `writeFileSync`'s `mode` is only honoured
 * when the file is created, so writing over a stale world-readable file would
 * silently keep the old permissions. `chmodSync` afterwards closes the umask
 * gap for good measure.
 *
 * @param filePath - Absolute path of the handoff file
 * @param handoff - Hash, expiry and plaintext session token
 */
export function writePairingHandoff(filePath: string, handoff: PairingHandoff): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(filePath);
  } catch {
    // Not there yet - the normal case.
  }
  writeFileSync(filePath, JSON.stringify(handoff), { encoding: 'utf8', mode: PAIRING_FILE_MODE });
  chmodSync(filePath, PAIRING_FILE_MODE);
}

/**
 * Mint a pairing code plus its handoff file in one step.
 *
 * @param options - Overrides for path, TTL, session token and clock
 * @returns The plaintext code and token, which the caller must not persist
 */
export function createPairingHandoff(options: CreatePairingHandoffOptions = {}): CreatedPairing {
  const filePath = options.filePath ?? join(ensureConfigDir(), PAIRING_FILE_NAME);
  const now = options.now ?? Date.now();
  const code = generatePairingCode();
  const sessionToken = options.sessionToken ?? generateToken();
  const expiresAt = now + (options.ttlMs ?? DEFAULT_PAIRING_TTL_MS);

  writePairingHandoff(filePath, { pairingHash: hashToken(code), expiresAt, sessionToken });

  return { code, sessionToken, expiresAt, filePath };
}

/**
 * Read and validate the handoff file.
 *
 * Missing and malformed are deliberately the same answer: the caller turns both
 * into 410 Gone, and "already consumed" arrives here as ENOENT.
 *
 * @param filePath - Absolute path of the handoff file
 * @returns The handoff, or null when it is absent or unusable
 */
export function readPairingHandoff(filePath: string): PairingHandoff | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const { pairingHash, expiresAt, sessionToken } = parsed as Record<string, unknown>;

  if (typeof pairingHash !== 'string' || !isValidTokenHash(pairingHash)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) return null;

  return { pairingHash, expiresAt, sessionToken };
}

/**
 * Delete the handoff file. Idempotent — a missing file is success.
 *
 * @param filePath - Absolute path of the handoff file
 */
export function consumePairingHandoff(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Already gone: the state we wanted.
  }
}

/**
 * @param handoff - Handoff read from disk
 * @param now - Epoch ms, injectable for tests
 * @returns true when the pairing window has closed
 */
export function isPairingExpired(handoff: PairingHandoff, now: number = Date.now()): boolean {
  return now > handoff.expiresAt;
}

/**
 * Timing-safe comparison of a supplied code against the stored hash (S001).
 *
 * @param code - Code as supplied by the client
 * @param pairingHash - SHA-256 hex from the handoff file
 * @returns true when the code matches
 */
export function verifyPairingCode(code: string, pairingHash: string): boolean {
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_PAIRING_CODE_LENGTH) {
    return false;
  }
  if (!isValidTokenHash(pairingHash)) {
    return false;
  }

  const candidate = Buffer.from(hashToken(normalizePairingCode(code)), 'hex');
  const expected = Buffer.from(pairingHash, 'hex');

  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
}
