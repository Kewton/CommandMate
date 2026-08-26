/**
 * The share config gate and URL reader (Issue #2051).
 *
 * Every expectation here is pinned to a measurement against opencode 1.18.22
 * recorded in `docs/design/opencode-server-live-verification.md` §23, not to the
 * Issue text — which was wrong about the URL shape.
 *
 * The property that carries the acceptance criterion is the asymmetry between
 * *unset* and *disabled*: `GET /config` omits `share` entirely unless the
 * operator configured one, and collapsing the two would hide the button on every
 * default installation.
 */

import { describe, expect, it } from 'vitest';
import {
  OPENCODE_SHARE_MODES,
  isOpencodeSharingDisabled,
  readOpencodeShareMode,
  readOpencodeShareUrl,
} from '@/types/opencode-share';

describe('readOpencodeShareMode', () => {
  it('accepts every value opencode\'s own Config.share enum declares', () => {
    // Measured from `GET /doc`: `{"type":"string","enum":["manual","auto","disabled"]}`.
    expect([...OPENCODE_SHARE_MODES]).toEqual(['manual', 'auto', 'disabled']);
    for (const mode of OPENCODE_SHARE_MODES) {
      expect(readOpencodeShareMode({ share: mode })).toBe(mode);
    }
  });

  it('reads the measured body of a server configured with share: disabled', () => {
    // Verbatim from `GET /config` on the probe server.
    const body = {
      $schema: 'https://opencode.ai/config.json',
      command: {},
      plugin: [],
      share: 'disabled',
      model: 'github-copilot/claude-sonnet-4.6',
      username: 'someone',
      mode: {},
      agent: {},
    };
    expect(readOpencodeShareMode(body)).toBe('disabled');
  });

  it('answers null when the key is absent, which is what an unset config sends', () => {
    // Measured: a server whose config file has no `share` key answers with no
    // `share` key at all — not with `"disabled"`.
    const body = {
      $schema: 'https://opencode.ai/config.json',
      command: {},
      plugin: [],
      model: 'github-copilot/claude-sonnet-4.6',
      username: 'someone',
      mode: {},
      agent: {},
    };
    expect(readOpencodeShareMode(body)).toBeNull();
  });

  it('answers null for a word this build does not know', () => {
    expect(readOpencodeShareMode({ share: 'team-only' })).toBeNull();
  });

  it.each([null, undefined, 'disabled', 42, [], [{ share: 'disabled' }]])(
    'answers null for a non-object body (%p)',
    (body) => {
      expect(readOpencodeShareMode(body)).toBeNull();
    }
  );
});

describe('isOpencodeSharingDisabled', () => {
  it('is true only for the one value opencode refuses on', () => {
    expect(isOpencodeSharingDisabled('disabled')).toBe(true);
  });

  it.each(['manual', 'auto'] as const)('is false for %s', (mode) => {
    expect(isOpencodeSharingDisabled(mode)).toBe(false);
  });

  it('is false when the mode is unknown, so an unset config still offers the button', () => {
    // The direction matters: hiding the control on every default installation
    // would be a worse failure than a refusal the operator can read, and the
    // confirmation dialog stands in front of it either way.
    expect(isOpencodeSharingDisabled(null)).toBe(false);
  });
});

describe('readOpencodeShareUrl', () => {
  it('reads the URL shape opencode actually mints', () => {
    // Measured: `https://opncd.ai/share/<last 8 chars of the session id>`. The
    // Issue body says `opncd.ai/s/<id>`, which does not exist on 1.18.22.
    const session = {
      id: 'ses_fc35f3dadffe2uirJpjJBtxFhy',
      share: { url: 'https://opncd.ai/share/jJBtxFhy' },
      title: 'probe',
    };
    expect(readOpencodeShareUrl(session)).toBe('https://opncd.ai/share/jJBtxFhy');
  });

  it('does not hard-code the host, so a later release may move it', () => {
    expect(readOpencodeShareUrl({ share: { url: 'https://share.opencode.ai/abc' } })).toBe(
      'https://share.opencode.ai/abc'
    );
  });

  it.each([
    ['javascript:alert(1)'],
    ['http://opncd.ai/share/jJBtxFhy'],
    ['/share/jJBtxFhy'],
    ['not a url'],
    [''],
  ])('rejects %p rather than letting it reach an href', (url) => {
    expect(readOpencodeShareUrl({ share: { url } })).toBeNull();
  });

  it('answers null for a session that was never shared', () => {
    expect(readOpencodeShareUrl({ id: 'ses_x', share: null })).toBeNull();
    expect(readOpencodeShareUrl({ id: 'ses_x' })).toBeNull();
  });

  it.each([null, undefined, 'ses_x', 7])('answers null for a non-object body (%p)', (body) => {
    expect(readOpencodeShareUrl(body)).toBeNull();
  });
});
