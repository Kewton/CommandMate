/**
 * "This write came from CommandMate's own screen" (Issue #4221, design §11.2).
 *
 * A check and not a guarantee: a process with the same OS rights can send every
 * header below (§11.3). What it does stop is the regular CLI (which sends none of
 * them), a page of another origin through the user's browser (a custom header
 * makes its request preflight, and nothing here answers CORS), and a user changing
 * the mode without knowing it.
 *
 * Both must hold:
 * - `X-CommandMate-Client: screen`, which only the screen's client sends;
 * - `Origin` equal to where the request was addressed. The host is the first
 *   `X-Forwarded-Host` or else `Host`; the scheme is the first `X-Forwarded-Proto`
 *   or else the scheme the server was reached by. A tunnel (`remote`) is HTTPS
 *   outside and HTTP to this server, so without the forwarded scheme they differ
 *   (2nd review 7; what real tunnels send is not yet measured, §15 U2).
 *
 * `Sec-Fetch-Site` is not required (a phone on LAN HTTP does not send it), but one
 * that is sent and is not `same-origin` refuses.
 *
 * @module lib/security/screen-request
 */

export const SCREEN_CLIENT_HEADER = 'X-CommandMate-Client';
export const SCREEN_CLIENT_VALUE = 'screen';

/** The headers the screen adds to a write that only the screen may make. */
export function screenRequestHeaders(): Record<string, string> {
  return { [SCREEN_CLIENT_HEADER]: SCREEN_CLIENT_VALUE };
}

interface RequestLike {
  headers: { get(name: string): string | null };
  nextUrl?: { protocol: string };
  url?: string;
}

const firstValue = (value: string | null): string | null => {
  if (value === null) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first : null;
};

function requestScheme(request: RequestLike): string | null {
  const forwarded = firstValue(request.headers.get('x-forwarded-proto'));
  if (forwarded) return forwarded.replace(/:$/, '').toLowerCase();
  const protocol = request.nextUrl?.protocol ?? (request.url ? new URL(request.url).protocol : null);
  return protocol ? protocol.replace(/:$/, '').toLowerCase() : null;
}

/** Whether a write carries the screen's mark (§11.2). */
export function isScreenRequest(request: RequestLike): boolean {
  if (request.headers.get(SCREEN_CLIENT_HEADER) !== SCREEN_CLIENT_VALUE) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') return false;

  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = (firstValue(request.headers.get('x-forwarded-host')) ?? request.headers.get('host'))?.toLowerCase();
  const scheme = requestScheme(request);
  if (!host || !scheme) return false;
  const defaultPort = scheme === 'https' ? ':443' : scheme === 'http' ? ':80' : null;
  const target = defaultPort && host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host;
  return parsed.protocol.replace(/:$/, '') === scheme && parsed.host.toLowerCase() === target;
}
