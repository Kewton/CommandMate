/**
 * Persisted state of one `commandmate remote` session (Issue #1937, R9).
 *
 * Design: `docs/design/remote-qr-pairing-1937.md` §6.3.
 *
 * ## Why this file exists at all
 *
 * `remote stop` must undo exactly what `remote up` created and nothing else.
 * The Provider interface enforces that structurally — `stop()` takes a
 * `RemoteHandle` and there is no `reset()` / `cleanupAll()` to reach for — but
 * the two commands are separate processes, so the handle has to survive on
 * disk between them. This module is that hop, and nothing more: it stores, it
 * does not interpret.
 *
 * ## Why "unreadable" is not "guess"
 *
 * `readRemoteState()` answers `null` for absent, unparseable and structurally
 * wrong alike, and `remote stop` turns all three into "I do not know what to
 * clean up" and exits SUCCESS (§6.3-4). That is deliberate and is the whole
 * reason the reader validates rather than casts: a half-read state file must
 * never become a Provider teardown aimed at configuration the user created.
 * `stop.ts` treats a stale PID file the same way.
 *
 * ## Format
 *
 * Plain JSON with a `schemaVersion`, not `PidManager`'s hybrid
 * "bare PID line + JSON line" shape. That format exists so a CLI predating
 * #1354 can still `parseInt()` the first line; nothing has ever read this file,
 * so there is no such reader to stay compatible with, and a PID is not what
 * this record is about.
 *
 * The file is written 0600 like the pairing handoff. It holds no secret — the
 * pairing code and the session token are never in it — but it names a public
 * URL that reaches this machine, and that is not something to leave
 * world-readable.
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { ensureConfigDir, getConfigDir } from './install-context';
import type { RemoteHandle, RemoteProviderId } from '../../lib/remote';

/** File name inside the config directory (`~/.commandmate` for global installs). */
export const REMOTE_STATE_FILE_NAME = 'remote.json';

/** Owner read/write only. Asserted by tests, not merely intended. */
export const REMOTE_STATE_FILE_MODE = 0o600;

/**
 * Bumped when a field changes meaning. A reader that does not recognise the
 * version returns null, which routes to "nothing to clean up" rather than to a
 * teardown driven by a record it does not understand.
 */
export const REMOTE_STATE_SCHEMA_VERSION = 1;

/** What one remote session recorded for the commands that come after it. */
export interface RemoteState {
  schemaVersion: number;
  /** Which Provider is holding the door open. */
  provider: RemoteProviderId;
  /** Public URL the Provider published. Not a secret; the pairing code is. */
  url: string;
  /** ISO timestamp of when `remote up` finished. */
  startedAt: string;
  /**
   * Epoch ms at which the outside door closes (`--expires`).
   *
   * This is the Provider's deadline only. The server's own token expiry is
   * fixed independently at startup by `CM_AUTH_EXPIRE` -> `computeExpireAt()`,
   * and the server is NOT stopped when this passes: killing it would take the
   * user's local session down with the remote one (§5.3).
   */
  expiresAt: number;
  /** Where the pairing handoff went, and when the code dies. */
  pairing: {
    /** Absolute path passed to the server as `CM_REMOTE_PAIRING_FILE`. */
    filePath: string;
    /** Epoch ms after which the pairing code is refused (`--pairing-expires`). */
    expiresAt: number;
  };
  /** The Provider's own receipt. The only thing `stop()` is allowed to act on. */
  handle: RemoteHandle;
  /** The server this session exposed, for `remote status`. */
  server: {
    pid: number | null;
    port: number;
  };
}

/**
 * Absolute path of the state file.
 *
 * @returns `<configDir>/remote.json`
 */
export function getRemoteStatePath(): string {
  return join(getConfigDir(), REMOTE_STATE_FILE_NAME);
}

/**
 * Write the state file with mode 0600.
 *
 * An existing file is unlinked first: `writeFileSync`'s `mode` is only honoured
 * on creation, so writing over a file left world-readable by something else
 * would silently keep those permissions. Mirrors `writePairingHandoff()`.
 *
 * @param state - The session record to persist
 * @param filePath - Override for the destination, for tests
 */
export function writeRemoteState(state: RemoteState, filePath?: string): void {
  const target = filePath ?? join(ensureConfigDir(), REMOTE_STATE_FILE_NAME);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(target);
  } catch {
    // Not there yet - the normal case.
  }
  writeFileSync(target, JSON.stringify(state, null, 2), {
    encoding: 'utf8',
    mode: REMOTE_STATE_FILE_MODE,
  });
  chmodSync(target, REMOTE_STATE_FILE_MODE);
}

/**
 * Read and validate the state file.
 *
 * @param filePath - Override for the source, for tests
 * @returns The state, or null when it is absent, unreadable or not this schema
 */
export function readRemoteState(filePath?: string): RemoteState | null {
  const target = filePath ?? getRemoteStatePath();

  let raw: string;
  try {
    raw = readFileSync(target, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isRemoteState(parsed) ? parsed : null;
}

/**
 * Delete the state file. Idempotent — a missing file is success.
 *
 * @param filePath - Override for the target, for tests
 */
export function removeRemoteState(filePath?: string): void {
  try {
    unlinkSync(filePath ?? getRemoteStatePath());
  } catch {
    // Already gone: the state we wanted.
  }
}

/**
 * Structural check for a parsed state file.
 *
 * Every field `remote stop` and `remote status` read is checked, because the
 * cost of being wrong is asymmetric: a rejected record costs the user one
 * "nothing to clean up" message, an accepted-but-wrong one aims a Provider
 * teardown at a handle nobody wrote.
 *
 * @param value - Parsed JSON
 * @returns true when the value is a state record of the current schema
 */
export function isRemoteState(value: unknown): value is RemoteState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;

  if (record.schemaVersion !== REMOTE_STATE_SCHEMA_VERSION) return false;
  if (record.provider !== 'tailscale-serve' && record.provider !== 'cloudflare-quick') return false;
  if (typeof record.url !== 'string' || record.url.length === 0) return false;
  if (typeof record.startedAt !== 'string') return false;
  if (typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return false;

  const pairing = record.pairing as Record<string, unknown> | undefined;
  if (typeof pairing !== 'object' || pairing === null) return false;
  if (typeof pairing.filePath !== 'string' || pairing.filePath.length === 0) return false;
  if (typeof pairing.expiresAt !== 'number' || !Number.isFinite(pairing.expiresAt)) return false;

  const server = record.server as Record<string, unknown> | undefined;
  if (typeof server !== 'object' || server === null) return false;
  if (server.pid !== null && typeof server.pid !== 'number') return false;
  if (typeof server.port !== 'number') return false;

  return isRemoteHandle(record.handle);
}

/**
 * @param value - Candidate handle from a parsed state file
 * @returns true when the value carries everything `stop()` needs
 */
function isRemoteHandle(value: unknown): value is RemoteHandle {
  if (typeof value !== 'object' || value === null) return false;
  const handle = value as Record<string, unknown>;

  if (handle.provider !== 'tailscale-serve' && handle.provider !== 'cloudflare-quick') return false;
  if (typeof handle.url !== 'string') return false;

  const owned = handle.owned as Record<string, unknown> | undefined;
  if (typeof owned !== 'object' || owned === null) return false;
  if (owned.pid !== null && typeof owned.pid !== 'number') return false;
  if (owned.revert !== null && (typeof owned.revert !== 'object' || owned.revert === undefined)) {
    return false;
  }

  // `preexisting` is deliberately `unknown` in the interface: its shape is the
  // Provider's business, and `planStop()` narrows it itself. Requiring the key
  // to be present is as far as this reader can honestly go.
  return 'preexisting' in handle;
}
