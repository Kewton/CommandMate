/**
 * The screen's mark on a mode change (Issue #4221, design §11.2, R8・2nd review 7):
 * the custom header plus an `Origin` equal to where the request was addressed, with
 * the forwarded host and scheme of a tunnel.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { isScreenRequest, SCREEN_CLIENT_HEADER } from '@/lib/security/screen-request';

function request(headers: Record<string, string>, url = 'http://localhost:3000/api/x') {
  const map = new Headers(headers);
  return { headers: map, nextUrl: { protocol: new URL(url).protocol }, url };
}

const mark = { [SCREEN_CLIENT_HEADER]: 'screen' };

describe('isScreenRequest', () => {
  it('accepts localhost, a phone on LAN HTTP without Sec-Fetch-Site, and HTTPS', () => {
    expect(isScreenRequest(request({ ...mark, origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(true);
    expect(
      isScreenRequest(request({ ...mark, origin: 'http://192.168.1.10:3000', host: '192.168.1.10:3000' }, 'http://192.168.1.10:3000/x'))
    ).toBe(true);
    expect(isScreenRequest(request({ ...mark, origin: 'https://pc.local:3000', host: 'pc.local:3000' }, 'https://pc.local:3000/x'))).toBe(true);
    expect(
      isScreenRequest(request({ ...mark, origin: 'http://localhost:3000', host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }))
    ).toBe(true);
  });

  it('accepts a tunnel by its forwarded host and scheme (2nd review 7)', () => {
    expect(
      isScreenRequest(
        request({
          ...mark,
          origin: 'https://pc.tail1234.ts.net',
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'pc.tail1234.ts.net',
          'x-forwarded-proto': 'https',
        })
      )
    ).toBe(true);
  });

  it('refuses a scheme that differs from the forwarded one', () => {
    expect(
      isScreenRequest(request({ ...mark, origin: 'http://pc.ts.net', host: 'pc.ts.net', 'x-forwarded-proto': 'https' }))
    ).toBe(false);
  });

  it('refuses another origin, no Origin, a cross-site fetch, and no mark (with or without Bearer)', () => {
    expect(isScreenRequest(request({ ...mark, origin: 'http://evil.example', host: 'localhost:3000' }))).toBe(false);
    expect(isScreenRequest(request({ ...mark, host: 'localhost:3000' }))).toBe(false);
    expect(
      isScreenRequest(request({ ...mark, origin: 'http://localhost:3000', host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))
    ).toBe(false);
    expect(isScreenRequest(request({ origin: 'http://localhost:3000', host: 'localhost:3000' }))).toBe(false);
    expect(isScreenRequest(request({ origin: 'http://localhost:3000', host: 'localhost:3000', authorization: 'Bearer t' }))).toBe(false);
    expect(isScreenRequest(request({ authorization: 'Bearer t', host: 'localhost:3000' }))).toBe(false);
  });
});
