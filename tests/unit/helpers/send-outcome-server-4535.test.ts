/**
 * The fake `/send` server for Issue #4535's HTTP tests: what it answers reaches a
 * real `fetch` exactly as written (status, type, body, redirects, a dropped
 * socket, a refused port), and it counts the POSTs that reached it.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  startSendOutcomeServer,
  refusedPortUrl,
  type SendOutcomeServer,
} from '../../helpers/send-outcome-server-4535';

let server: SendOutcomeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('startSendOutcomeServer', () => {
  it('listens on 127.0.0.1 with a port of its own', async () => {
    server = await startSendOutcomeServer({});
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.url).not.toContain(':3000');
  });

  it('answers an empty 2xx with no body and no content-type', async () => {
    server = await startSendOutcomeServer({ '/send': { kind: 'reply', status: 204 } });
    const res = await fetch(`${server.url}/send`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(204);
    expect(res.headers.get('content-type')).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('answers a non-JSON 200 as written', async () => {
    server = await startSendOutcomeServer({ '/send': { kind: 'reply', status: 200, contentType: 'text/plain', body: 'ok' } });
    const res = await fetch(`${server.url}/send`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('ok');
  });

  it('answers an HTML 408 as written', async () => {
    server = await startSendOutcomeServer({ '/send': { kind: 'reply', status: 408, contentType: 'text/html', body: '<html>Request Timeout</html>' } });
    const res = await fetch(`${server.url}/send`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(408);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<html>Request Timeout</html>');
  });

  it('a JSON reply carries the JSON type', async () => {
    server = await startSendOutcomeServer({ '/send': { kind: 'json', status: 201, body: { id: 'm', role: 'user' } } });
    const res = await fetch(`${server.url}/send`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ id: 'm', role: 'user' });
  });

  it.each([307, 308] as const)('a %i is followed by fetch with the same body, and the handler sees one POST', async (status) => {
    server = await startSendOutcomeServer({
      '/front': { kind: 'redirect', status, location: '/send' },
      '/send': { kind: 'json', status: 201, body: { id: 'm', role: 'user' } },
    });
    const res = await fetch(`${server.url}/front`, { method: 'POST', body: '{"content":"hi"}' });
    expect(res.status).toBe(201);
    expect(res.redirected).toBe(true);
    expect(server.posts('/send')).toEqual(['{"content":"hi"}']);
    expect(server.posts('/front')).toEqual(['{"content":"hi"}']);
  });

  it('a 303 turns the POST into a GET (no POST reaches the target)', async () => {
    server = await startSendOutcomeServer({
      '/front': { kind: 'redirect', status: 303, location: '/page' },
      '/page': { kind: 'reply', status: 200, contentType: 'text/html', body: '<html></html>' },
    });
    const res = await fetch(`${server.url}/front`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(server.posts('/page')).toEqual([]);
    expect(server.requests('/page')).toEqual([{ method: 'GET', body: '' }]);
  });

  it('with redirect: manual the 3xx itself comes back', async () => {
    server = await startSendOutcomeServer({ '/front': { kind: 'redirect', status: 308, location: '/send' } });
    const res = await fetch(`${server.url}/front`, { method: 'POST', body: '{}', redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/send');
    expect(server.posts('/send')).toEqual([]);
  });

  it('a drop after the body was read rejects fetch, and the POST is still counted', async () => {
    server = await startSendOutcomeServer({ '/send': { kind: 'drop' } });
    const error = await fetch(`${server.url}/send`, { method: 'POST', body: '{"content":"hi"}' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe('fetch failed');
    expect(((error as Error).cause as { code?: string } | undefined)?.code).not.toBe('ECONNREFUSED');
    expect(server.posts('/send')).toEqual(['{"content":"hi"}']);
  });

  it('an unconfigured path is a 404 with no body, and is recorded', async () => {
    server = await startSendOutcomeServer({});
    const res = await fetch(`${server.url}/nowhere`, { method: 'POST', body: 'x' });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(server.posts('/nowhere')).toEqual(['x']);
  });

  it('close() stops listening', async () => {
    const s = await startSendOutcomeServer({});
    const url = s.url;
    await s.close();
    await expect(fetch(`${url}/send`, { method: 'POST' })).rejects.toThrow('fetch failed');
  });
});

describe('refusedPortUrl', () => {
  it('names a port nothing listens on: fetch fails with ECONNREFUSED', async () => {
    const url = await refusedPortUrl();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const error = await fetch(`${url}/send`, { method: 'POST', body: '{}' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as Error).cause as { code?: string } | undefined)?.code).toBe('ECONNREFUSED');
  });
});
