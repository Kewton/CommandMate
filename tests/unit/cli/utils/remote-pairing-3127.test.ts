/**
 * Re-issuing the pairing code of a live `remote` session (Issue #3127).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { getReissueClaimPath, reissuePairingCode } from '../../../../src/cli/utils/remote-pairing';
import {
  PAIRING_FILE_MODE,
  readPairingHandoff,
  verifyPairingCode,
  writePairingHandoff,
} from '../../../../src/lib/security/pairing-code';
import { hashToken } from '../../../../src/lib/security/auth';

const dir = mkdtempSync(join(tmpdir(), 'cm-remote-pair-3127-'));
const filePath = join(dir, 'remote-pairing.json');

describe('reissuePairingCode', () => {
  beforeEach(() => {
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('swaps in a new code, keeping the session token and the expiry', () => {
    const expiresAt = Date.now() + 60_000;
    writePairingHandoff(filePath, { pairingHash: hashToken('ABC123'), expiresAt, sessionToken: 'tok' });

    const result = reissuePairingCode(filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expiresAt).toBe(expiresAt);
    const handoff = readPairingHandoff(filePath);
    expect(handoff?.sessionToken).toBe('tok');
    expect(handoff?.expiresAt).toBe(expiresAt);
    expect(verifyPairingCode(result.code, handoff!.pairingHash)).toBe(true);
    // The previous link stops working.
    expect(verifyPairingCode('ABC123', handoff!.pairingHash)).toBe(false);
    expect(statSync(filePath).mode & 0o777).toBe(PAIRING_FILE_MODE);
    expect(existsSync(getReissueClaimPath(filePath))).toBe(false);
  });

  it('never recreates a consumed handoff', () => {
    expect(reissuePairingCode(filePath)).toEqual({ ok: false, reason: 'consumed' });
    expect(existsSync(filePath)).toBe(false);
  });

  it('refuses an expired code and leaves the file as it was', () => {
    writePairingHandoff(filePath, {
      pairingHash: hashToken('ABC123'),
      expiresAt: Date.now() - 1,
      sessionToken: 'tok',
    });

    expect(reissuePairingCode(filePath)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyPairingCode('ABC123', readPairingHandoff(filePath)!.pairingHash)).toBe(true);
  });

  it('is fail-closed on a malformed file', () => {
    writeFileSync(filePath, 'not json', { mode: 0o600 });

    expect(reissuePairingCode(filePath)).toEqual({ ok: false, reason: 'unreadable' });
    expect(existsSync(getReissueClaimPath(filePath))).toBe(false);
  });
});
