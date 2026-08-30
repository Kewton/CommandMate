/**
 * The `remote` session record (Issue #1937, R9. Design §6.3).
 *
 * The reader is the interesting half. `remote stop` acts on what this returns,
 * and §6.3-4 says it must do NOTHING when the record is missing or unusable —
 * because the alternative is aiming a Tailscale Serve teardown at configuration
 * the user created, which cannot be restored. So "unreadable" has to be a
 * `null` the caller cannot mistake for a partially-populated record, and every
 * field a teardown reads is validated rather than cast.
 *
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  REMOTE_STATE_FILE_MODE,
  REMOTE_STATE_FILE_NAME,
  REMOTE_STATE_SCHEMA_VERSION,
  isRemoteState,
  readRemoteState,
  removeRemoteState,
  writeRemoteState,
  type RemoteState,
} from '../../../../src/cli/utils/remote-state';

const dir = mkdtempSync(join(tmpdir(), 'cm-remote-state-1937-'));
const statePath = join(dir, REMOTE_STATE_FILE_NAME);

function validState(overrides: Partial<RemoteState> = {}): RemoteState {
  return {
    schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
    provider: 'cloudflare-quick',
    url: 'https://random-words.trycloudflare.com',
    startedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: 1_800_000_000_000,
    pairing: { filePath: join(dir, 'remote-pairing.json'), expiresAt: 1_700_000_000_000 },
    handle: {
      provider: 'cloudflare-quick',
      url: 'https://random-words.trycloudflare.com',
      owned: { pid: 5150, revert: null },
      preexisting: null,
    },
    server: { pid: 4242, port: 3000 },
    ...overrides,
  };
}

describe('remote state file', () => {
  afterEach(() => {
    removeRemoteState(statePath);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a session record', () => {
    const state = validState();
    writeRemoteState(state, statePath);

    expect(readRemoteState(statePath)).toEqual(state);
  });

  it('writes 0600, and repairs the mode of a file left readable', () => {
    // It names a public URL that reaches this machine. `writeFileSync`'s mode
    // only applies at creation, so an overwrite has to re-chmod.
    writeFileSync(statePath, '{}', { mode: 0o644 });
    chmodSync(statePath, 0o644);
    expect(statSync(statePath).mode & 0o777).toBe(0o644);

    writeRemoteState(validState(), statePath);

    expect(statSync(statePath).mode & 0o777).toBe(REMOTE_STATE_FILE_MODE);
    expect(REMOTE_STATE_FILE_MODE).toBe(0o600);
  });

  it('answers null for absent, unparseable and wrong-schema alike', () => {
    expect(readRemoteState(statePath)).toBeNull();

    writeFileSync(statePath, 'not json at all', { mode: 0o600 });
    expect(readRemoteState(statePath)).toBeNull();

    writeRemoteState({ ...validState(), schemaVersion: 99 }, statePath);
    expect(readRemoteState(statePath)).toBeNull();
  });

  it.each([
    ['provider', { provider: 'ngrok' }],
    ['url', { url: '' }],
    ['expiresAt', { expiresAt: Number.NaN }],
    ['pairing', { pairing: { filePath: '', expiresAt: 1 } }],
    ['server', { server: { pid: 'nope', port: 3000 } }],
    ['handle', { handle: { provider: 'cloudflare-quick', url: 'https://x' } }],
  ])('rejects a record with a bad %s', (_field, override) => {
    // Each of these is read by a teardown. Accepting one and acting on it is
    // worse than refusing the whole record and telling the user nothing is known.
    expect(isRemoteState({ ...validState(), ...override })).toBe(false);
  });

  it('accepts a handle whose preexisting snapshot has provider-specific shape', () => {
    // `preexisting` is `unknown` in the interface on purpose: how the snapshot
    // is taken is the Provider's business, and `planStop()` narrows it itself.
    expect(
      isRemoteState(
        validState({
          handle: {
            provider: 'tailscale-serve',
            url: 'https://host.ts.net',
            owned: { pid: null, revert: { 'https://host.ts.net': 'off' } },
            preexisting: { keys: ['https://other.ts.net'], raw: { anything: true } },
          },
        })
      )
    ).toBe(true);
  });

  it('removes idempotently', () => {
    writeRemoteState(validState(), statePath);
    removeRemoteState(statePath);
    expect(existsSync(statePath)).toBe(false);

    expect(() => removeRemoteState(statePath)).not.toThrow();
  });
});
