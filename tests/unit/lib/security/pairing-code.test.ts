/**
 * Pairing code lifecycle (Issue #1937, R5)
 * Design: docs/design/remote-qr-pairing-1937.md §7
 *
 * The properties pinned here are the ones the design calls load-bearing: the
 * code carries 128 bits in 26 Crockford characters, the handoff file is 0600,
 * and consumption is the file's disappearance rather than a flag anybody could
 * fail to persist.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  CROCKFORD_BASE32_ALPHABET,
  DEFAULT_PAIRING_TTL_MS,
  MAX_PAIRING_CODE_LENGTH,
  PAIRING_CODE_BITS,
  PAIRING_CODE_LENGTH,
  PAIRING_FILE_ENV_KEY,
  PAIRING_FILE_MODE,
  PAIRING_FILE_NAME,
  consumePairingHandoff,
  createPairingHandoff,
  encodeCrockfordBase32,
  generatePairingCode,
  getPairingFilePathFromEnv,
  isPairingExpired,
  normalizePairingCode,
  readPairingHandoff,
  verifyPairingCode,
  writePairingHandoff,
} from '@/lib/security/pairing-code';

let workDir: string;
let pairingFile: string;
let previousEnv: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cm-pairing-'));
  pairingFile = join(workDir, PAIRING_FILE_NAME);
  previousEnv = process.env[PAIRING_FILE_ENV_KEY];
  delete process.env[PAIRING_FILE_ENV_KEY];
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env[PAIRING_FILE_ENV_KEY];
  else process.env[PAIRING_FILE_ENV_KEY] = previousEnv;
  rmSync(workDir, { recursive: true, force: true });
});

describe('generatePairingCode', () => {
  it('produces 26 Crockford Base32 characters (128 bits)', () => {
    const code = generatePairingCode();

    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    expect(PAIRING_CODE_LENGTH).toBe(Math.ceil(PAIRING_CODE_BITS / 5));
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  });

  it('omits the letters Crockford drops so a transcribed code cannot be ambiguous', () => {
    // I / L / O / U are the four Crockford excludes. Their absence from the
    // alphabet is what makes normalizePairingCode's folding unambiguous.
    expect(CROCKFORD_BASE32_ALPHABET).toHaveLength(32);
    for (const excluded of ['I', 'L', 'O', 'U']) {
      expect(CROCKFORD_BASE32_ALPHABET).not.toContain(excluded);
    }
  });

  it('does not repeat itself across many draws', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generatePairingCode()));
    expect(codes.size).toBe(200);
  });
});

describe('encodeCrockfordBase32', () => {
  it('encodes MSB first against a hand-computed vector', () => {
    // 0x00 0x44 0x32 -> 000000000100010000110010 -> 00000 00001 00010 00011 0010(0)
    //                -> 0     1     2     3     4
    expect(encodeCrockfordBase32(Buffer.from([0x00, 0x44, 0x32]))).toBe('01234');
  });

  it('encodes 16 bytes as 26 characters', () => {
    expect(encodeCrockfordBase32(Buffer.alloc(16, 0xff))).toHaveLength(PAIRING_CODE_LENGTH);
    expect(encodeCrockfordBase32(Buffer.alloc(16, 0))).toBe('0'.repeat(PAIRING_CODE_LENGTH));
  });
});

describe('normalizePairingCode', () => {
  it('folds the transcription confusions Crockford defines', () => {
    expect(normalizePairingCode('oil')).toBe('011');
    expect(normalizePairingCode('abc')).toBe('ABC');
    expect(normalizePairingCode(' AB-CD EF ')).toBe('ABCDEF');
  });

  it('leaves a freshly generated code untouched', () => {
    const code = generatePairingCode();
    expect(normalizePairingCode(code)).toBe(code);
  });
});

describe('writePairingHandoff', () => {
  it('creates the file with mode 0600', () => {
    writePairingHandoff(pairingFile, {
      pairingHash: createHash('sha256').update('x').digest('hex'),
      expiresAt: Date.now() + 1000,
      sessionToken: 'session-token',
    });

    expect(statSync(pairingFile).mode & 0o777).toBe(0o600);
    expect(PAIRING_FILE_MODE).toBe(0o600);
  });

  it('narrows a pre-existing world-readable file back to 0600', () => {
    // writeFileSync's `mode` only applies at creation, so overwriting a stale
    // file would otherwise keep whatever permissions it already had.
    writeFileSync(pairingFile, '{}', { mode: 0o644 });
    expect(statSync(pairingFile).mode & 0o777).toBe(0o644);

    writePairingHandoff(pairingFile, {
      pairingHash: createHash('sha256').update('x').digest('hex'),
      expiresAt: Date.now() + 1000,
      sessionToken: 'session-token',
    });

    expect(statSync(pairingFile).mode & 0o777).toBe(0o600);
  });

  it('never writes the plaintext pairing code to disk', () => {
    const created = createPairingHandoff({ filePath: pairingFile });
    const onDisk = readFileSync(pairingFile, 'utf8');

    expect(onDisk).not.toContain(created.code);
    expect(JSON.parse(onDisk).pairingHash).toBe(
      createHash('sha256').update(created.code).digest('hex')
    );
  });
});

describe('createPairingHandoff', () => {
  it('defaults to a 10 minute TTL', () => {
    const now = 1_700_000_000_000;
    const created = createPairingHandoff({ filePath: pairingFile, now });

    expect(created.expiresAt).toBe(now + DEFAULT_PAIRING_TTL_MS);
    expect(DEFAULT_PAIRING_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('mints a session token when the caller supplies none', () => {
    const created = createPairingHandoff({ filePath: pairingFile });
    expect(created.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(readPairingHandoff(pairingFile)?.sessionToken).toBe(created.sessionToken);
  });
});

describe('readPairingHandoff', () => {
  it('returns null when the file is absent (an already-consumed code)', () => {
    expect(readPairingHandoff(pairingFile)).toBeNull();
  });

  it('returns null for unparseable or structurally wrong content', () => {
    writeFileSync(pairingFile, 'not json', { mode: 0o600 });
    expect(readPairingHandoff(pairingFile)).toBeNull();

    writeFileSync(pairingFile, JSON.stringify({ pairingHash: 'nope', expiresAt: 1, sessionToken: 't' }));
    expect(readPairingHandoff(pairingFile)).toBeNull();

    writeFileSync(
      pairingFile,
      JSON.stringify({
        pairingHash: createHash('sha256').update('x').digest('hex'),
        expiresAt: 'soon',
        sessionToken: 't',
      })
    );
    expect(readPairingHandoff(pairingFile)).toBeNull();

    writeFileSync(
      pairingFile,
      JSON.stringify({
        pairingHash: createHash('sha256').update('x').digest('hex'),
        expiresAt: 1,
        sessionToken: '',
      })
    );
    expect(readPairingHandoff(pairingFile)).toBeNull();
  });
});

describe('consumePairingHandoff', () => {
  it('removes the file and is idempotent', () => {
    createPairingHandoff({ filePath: pairingFile });
    expect(existsSync(pairingFile)).toBe(true);

    consumePairingHandoff(pairingFile);
    expect(existsSync(pairingFile)).toBe(false);

    expect(() => consumePairingHandoff(pairingFile)).not.toThrow();
  });
});

describe('isPairingExpired', () => {
  it('is false up to expiresAt and true past it', () => {
    const handoff = { pairingHash: 'a'.repeat(64), expiresAt: 1000, sessionToken: 't' };

    expect(isPairingExpired(handoff, 999)).toBe(false);
    expect(isPairingExpired(handoff, 1000)).toBe(false);
    expect(isPairingExpired(handoff, 1001)).toBe(true);
  });
});

describe('verifyPairingCode', () => {
  it('accepts the generated code and rejects a near miss', () => {
    const created = createPairingHandoff({ filePath: pairingFile });
    const handoff = readPairingHandoff(pairingFile);

    expect(handoff).not.toBeNull();
    expect(verifyPairingCode(created.code, handoff!.pairingHash)).toBe(true);
    expect(verifyPairingCode(generatePairingCode(), handoff!.pairingHash)).toBe(false);
  });

  it('accepts a lower-case / hyphenated transcription of the same code', () => {
    const created = createPairingHandoff({ filePath: pairingFile });
    const typed = `${created.code.slice(0, 13)}-${created.code.slice(13)}`.toLowerCase();

    expect(typed).not.toBe(created.code);
    expect(verifyPairingCode(typed, readPairingHandoff(pairingFile)!.pairingHash)).toBe(true);
  });

  it('rejects an empty code, an oversized code and a malformed stored hash', () => {
    const created = createPairingHandoff({ filePath: pairingFile });
    const hash = readPairingHandoff(pairingFile)!.pairingHash;

    expect(verifyPairingCode('', hash)).toBe(false);
    expect(verifyPairingCode('A'.repeat(MAX_PAIRING_CODE_LENGTH + 1), hash)).toBe(false);
    expect(verifyPairingCode(created.code, 'not-a-hash')).toBe(false);
  });
});

describe('getPairingFilePathFromEnv', () => {
  it('is null when remote is not running, and the path when it is', () => {
    expect(getPairingFilePathFromEnv()).toBeNull();

    process.env[PAIRING_FILE_ENV_KEY] = '   ';
    expect(getPairingFilePathFromEnv()).toBeNull();

    process.env[PAIRING_FILE_ENV_KEY] = pairingFile;
    expect(getPairingFilePathFromEnv()).toBe(pairingFile);
  });
});
