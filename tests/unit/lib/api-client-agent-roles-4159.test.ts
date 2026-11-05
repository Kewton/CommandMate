/**
 * Issue #4159: the role API answers a result, and "every call" includes one whose request
 * cannot be put together. Nothing the screen builds today gets here (strings and literals);
 * these hold the promise for the day something does.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roleApi, sendJson, type RoleApiResult } from '@/lib/api-client-agent-roles';
import { createInstanceWithKey, updateRoleExpectingName } from '@/lib/agent-roles/instance-creation-client';

const circular: Record<string, unknown> = {};
circular.self = circular;
const LONE_SURROGATE = 'a\ud800';
const NOT_SENT = { ok: false, status: 0 };

describe('[#4159] a request that cannot be put together', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, unknown]>([
    ['a circular body', circular],
    ['a BigInt', { value: 1n }],
    ['a body with no JSON form at all', undefined],
    ['a function', () => null],
  ])('sendJson, %s: a failure, with fetch not called', async (_label, body) => {
    // Called bare, so a synchronous throw fails here rather than in a rejection matcher.
    const pending = sendJson('/api/roles', 'POST', body);
    await expect(pending).resolves.toEqual(NOT_SENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the calls built on sendJson answer the same', async () => {
    const instance = { id: 'x', cliTool: 'codex', alias: circular as unknown as string };
    await expect(roleApi.createInstance('wt', { instance, role: { kind: 'inherit' } as never })).resolves.toEqual(NOT_SENT);
    await expect(createInstanceWithKey('wt', { instance, role: { kind: 'inherit' } as never }, 'key')).resolves.toEqual(NOT_SENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, () => Promise<RoleApiResult<unknown>>]>([
    ['updateRoleExpectingName, the name in the header', () => updateRoleExpectingName('id', { name: 'n' }, LONE_SURROGATE)],
    ['updateRoleExpectingName, the id in the path', () => updateRoleExpectingName(LONE_SURROGATE, { name: 'n' }, 'old')],
    ['roleApi.get', () => roleApi.get(LONE_SURROGATE)],
    ['roleApi.update', () => roleApi.update(LONE_SURROGATE, { name: 'n' })],
    ['roleApi.remove', () => roleApi.remove(LONE_SURROGATE)],
    ['roleApi.repositoryDefaults', () => roleApi.repositoryDefaults(LONE_SURROGATE)],
    ['roleApi.setRepositoryDefault', () => roleApi.setRepositoryDefault(LONE_SURROGATE, 'codex', { kind: 'inherit' } as never)],
  ])('a path or header that cannot be encoded, %s: the same', async (_label, call) => {
    await expect(call()).resolves.toEqual(NOT_SENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('control: a body that can be sent goes out as it did, once, with its headers', async () => {
    await expect(sendJson('/api/roles', 'PUT', { name: 'n' }, { 'X-Test': '1' })).resolves.toEqual({
      ok: true,
      data: { success: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/roles');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"name":"n"}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Test': '1' });
  });

  it('control: the name still goes in the header encoded', async () => {
    await updateRoleExpectingName('id', { name: 'n' }, '名前');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.values(init.headers as Record<string, string>)).toContain(encodeURIComponent('名前'));
  });

  it('control: a request that fails on the way is still the failure it was', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(sendJson('/api/roles', 'POST', {})).resolves.toEqual(NOT_SENT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
