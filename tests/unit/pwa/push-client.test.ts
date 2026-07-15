/**
 * Unit tests for client-side push helpers (Issue #1125).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { urlBase64ToUint8Array } from '@/lib/pwa/push-client';

describe('urlBase64ToUint8Array', () => {
  it('decodes a base64url string into the expected bytes', () => {
    // "hello" -> base64url "aGVsbG8"
    const bytes = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it('handles base64url-specific characters (- and _)', () => {
    // bytes [251, 255] -> standard base64 "+/8=" -> base64url "-_8"
    const bytes = urlBase64ToUint8Array('-_8');
    expect(Array.from(bytes)).toEqual([251, 255]);
  });

  it('pads correctly for strings needing padding', () => {
    // "f" -> base64 "Zg==" -> base64url "Zg"
    const bytes = urlBase64ToUint8Array('Zg');
    expect(Array.from(bytes)).toEqual([102]);
  });
});
