/**
 * `commandmate init` can produce a VAPID key pair (Issue #2123).
 *
 * The Issue's acceptance condition is "key generation completes with a means
 * CommandMate provides (no external command typed by hand)". Before this, the
 * only route was knowing that the bundled `web-push` exports
 * `generateVAPIDKeys()` and typing a `node -e` one-liner.
 *
 * Two things are pinned:
 *  - the SHAPE of what is accepted, so a `web-push` that ever returned something
 *    else is caught at generation rather than at the first push (a wrong-length
 *    key fails at the push service, i.e. exactly the silent failure this Issue
 *    pair exists to end);
 *  - that a loader failure is REPORTED and not thrown, because push is optional
 *    and a missing optional dependency must not break `init`.
 *
 * The real `web-push` is exercised in the last block, which is what makes this a
 * test of the shipped path rather than of the injected stub.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  generateVapidKeyPair,
  isBase64UrlOfLength,
  isVapidKeyPair,
} from '../../../../src/cli/utils/vapid-keygen';

/** A P-256 point / scalar of the right length, in base64url. */
const GOOD_PUBLIC = Buffer.alloc(65, 7).toString('base64url');
const GOOD_PRIVATE = Buffer.alloc(32, 9).toString('base64url');

describe('isBase64UrlOfLength (Issue #2123)', () => {
  it('accepts a base64url string of exactly the expected byte length', () => {
    expect(isBase64UrlOfLength(GOOD_PUBLIC, 65)).toBe(true);
    expect(isBase64UrlOfLength(GOOD_PRIVATE, 32)).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(isBase64UrlOfLength(GOOD_PUBLIC, 32)).toBe(false);
    expect(isBase64UrlOfLength(GOOD_PRIVATE, 65)).toBe(false);
  });

  it('rejects standard base64 padding and alphabet', () => {
    // A `+`/`/`/`=` key is what a naive `toString('base64')` produces, and it is
    // not what PushManager.subscribe() accepts.
    expect(isBase64UrlOfLength(`${GOOD_PRIVATE}=`, 32)).toBe(false);
    expect(isBase64UrlOfLength('a+b/c', 32)).toBe(false);
  });

  it('rejects non-strings and the empty string', () => {
    expect(isBase64UrlOfLength(undefined, 32)).toBe(false);
    expect(isBase64UrlOfLength(42, 32)).toBe(false);
    expect(isBase64UrlOfLength('', 32)).toBe(false);
  });
});

describe('isVapidKeyPair (Issue #2123)', () => {
  it('accepts a well-formed pair', () => {
    expect(isVapidKeyPair({ publicKey: GOOD_PUBLIC, privateKey: GOOD_PRIVATE })).toBe(true);
  });

  it('rejects a pair with the halves swapped', () => {
    expect(isVapidKeyPair({ publicKey: GOOD_PRIVATE, privateKey: GOOD_PUBLIC })).toBe(false);
  });

  it.each([null, undefined, 'keys', {}, { publicKey: GOOD_PUBLIC }])('rejects %s', (value) => {
    expect(isVapidKeyPair(value)).toBe(false);
  });
});

describe('generateVapidKeyPair (Issue #2123)', () => {
  it('returns the pair from the loaded generator', async () => {
    const result = await generateVapidKeyPair(async () => ({
      generateVAPIDKeys: () => ({ publicKey: GOOD_PUBLIC, privateKey: GOOD_PRIVATE }),
    }));
    expect(result).toEqual({
      ok: true,
      keys: { publicKey: GOOD_PUBLIC, privateKey: GOOD_PRIVATE },
    });
  });

  it('reports rather than throws when the module cannot be loaded', async () => {
    const result = await generateVapidKeyPair(async () => {
      throw new Error('Cannot find module web-push');
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('web-push');
  });

  it('reports rather than throws when the generator throws', async () => {
    const result = await generateVapidKeyPair(async () => ({
      generateVAPIDKeys: () => {
        throw new Error('no entropy');
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('no entropy');
  });

  it('rejects a pair of an unexpected shape instead of writing it into .env', async () => {
    const result = await generateVapidKeyPair(async () => ({
      generateVAPIDKeys: () => ({ publicKey: 'too-short', privateKey: 'also-short' }),
    }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('unexpected shape');
  });

  it('produces a usable pair through the real bundled web-push', async () => {
    // The default loader, i.e. the path `commandmate init` actually runs.
    const result = await generateVapidKeyPair();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isVapidKeyPair(result.keys)).toBe(true);
      // A P-256 public key is an uncompressed point: 0x04 followed by X and Y.
      expect(Buffer.from(result.keys.publicKey, 'base64url')[0]).toBe(0x04);
    }
  });

  it('produces a different pair on every call', async () => {
    const [a, b] = await Promise.all([generateVapidKeyPair(), generateVapidKeyPair()]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.keys.privateKey).not.toBe(b.keys.privateKey);
  });
});
