/**
 * Issue #4191, item 1: the fence of `tests/setup.ts` keeps the requests it
 * refused, and `mockFetchUnreachable` answers like a closed port without
 * sending anything. Every target here is a private object or a mock; nothing
 * is sent to any port.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRealServerFence, refusedRealServerRequests } from '../../helpers/real-server-fence';
import { connectionRefusedError, mockFetchUnreachable, restoreFetch } from '../../helpers/mock-api';

afterEach(() => {
  restoreFetch();
});

describe('refusedRealServerRequests (Issue #4191)', () => {
  it('records each request the installed fence refused, and only those', async () => {
    const realFetch = vi.fn(() => Promise.resolve(new Response('ok')));
    const target = { fetch: realFetch as unknown as typeof fetch } as { fetch?: typeof fetch } & Record<symbol, unknown>;
    installRealServerFence({}, [], () => '', target);
    expect(refusedRealServerRequests(target)).toEqual([]);

    await expect(target.fetch!('http://127.0.0.1:3000/api/x')).rejects.toBeInstanceOf(TypeError);
    await target.fetch!('http://127.0.0.1:45678/api/y');

    expect(refusedRealServerRequests(target)).toEqual([{ url: 'http://127.0.0.1:3000/api/x', port: 3000 }]);
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(String((realFetch.mock.calls[0] as unknown[])[0])).toContain(':45678/');
  });

  it('is empty for a target no fence was installed on', () => {
    expect(refusedRealServerRequests({})).toEqual([]);
  });
});

describe('mockFetchUnreachable (Issue #4191)', () => {
  it('refuses as a closed port does, with the URL it was given', async () => {
    const mock = mockFetchUnreachable();
    const error = await fetch('http://127.0.0.1:3000/api/worktrees/wt1/send').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as TypeError).cause as { code?: string }).code).toBe('ECONNREFUSED');
    expect(mock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/worktrees/wt1/send');
  });

  it('connectionRefusedError names the port of the URL', () => {
    const cause = connectionRefusedError('http://127.0.0.1:4567/x').cause as { port?: number };
    expect(cause.port).toBe(4567);
  });
});
