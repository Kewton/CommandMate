/**
 * GET/PUT /api/settings/sessions-filter (Issue #4388).
 * Real migrated in-memory schema; only the DB handle is injected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ db: null as Database.Database | null }));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => mocks.db }));

import { runMigrations } from '@/lib/db/db-migrations';
import { GET, PUT, dynamic } from '@/app/api/settings/sessions-filter/route';

const URL_ = 'http://localhost:3000/api/settings/sessions-filter';
const valid = { branchPattern: '^feature/', roleIds: ['abc123', 'def-456'], includeNoRole: true, includeAmbiguous: false };

function put(body: unknown, raw = false) {
  return PUT(
    new NextRequest(URL_, {
      method: 'PUT',
      body: raw ? (body as string) : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

describe('/api/settings/sessions-filter (Issue #4388)', () => {
  beforeEach(() => {
    mocks.db = new Database(':memory:');
    runMigrations(mocks.db);
  });
  afterEach(() => {
    mocks.db?.close();
    mocks.db = null;
  });

  it('is force-dynamic', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  it('GET answers an empty condition when nothing is saved', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
    expect(body.filter).toEqual({ branchPattern: '', roleIds: [], includeNoRole: false, includeAmbiguous: false });
  });

  it('saves a valid condition and GET returns the same value', async () => {
    const res = await put(valid);
    expect(res.status).toBe(200);
    expect((await res.json()).filter).toEqual(valid);
    const body = await (await GET()).json();
    expect(body.configured).toBe(true);
    expect(body.filter).toEqual(valid);
  });

  it('GET returns roles as stored even if they no longer exist (no agent_roles rows here)', async () => {
    await put({ ...valid, roleIds: ['deleted-role'] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).filter.roleIds).toEqual(['deleted-role']);
  });

  it('accepts a 200-char pattern and an empty pattern; rejects 201 chars', async () => {
    expect((await put({ ...valid, branchPattern: 'a'.repeat(200) })).status).toBe(200);
    expect((await put({ ...valid, branchPattern: '' })).status).toBe(200);
    expect((await put({ ...valid, branchPattern: 'a'.repeat(201) })).status).toBe(400);
  });

  it('rejects an invalid regular expression (and stores nothing)', async () => {
    const res = await put({ ...valid, branchPattern: '(' });
    expect(res.status).toBe(400);
    expect((await res.json()).success).toBe(false);
    expect((await (await GET()).json()).configured).toBe(false);
  });

  it('rejects malformed role ids', async () => {
    for (const bad of ['', 'UPPER', 'a b', '../x', 'a--b', 'x'.repeat(65), 5, null]) {
      expect((await put({ ...valid, roleIds: [bad] })).status, String(bad)).toBe(400);
    }
    expect((await put({ ...valid, roleIds: 'abc' })).status).toBe(400);
  });

  it('rejects more than 100 role ids, accepts exactly 100', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `role-${i}`);
    expect((await put({ ...valid, roleIds: ids(100) })).status).toBe(200);
    expect((await put({ ...valid, roleIds: ids(101) })).status).toBe(400);
  });

  it('rejects non-boolean flags, missing fields and non-object bodies', async () => {
    expect((await put({ ...valid, includeNoRole: 'yes' })).status).toBe(400);
    expect((await put({ ...valid, includeAmbiguous: 1 })).status).toBe(400);
    expect((await put({ branchPattern: 'x' })).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    expect((await put([])).status).toBe(400);
    expect((await put('not json{', true)).status).toBe(400);
  });

  it('de-duplicates role ids on save', async () => {
    const res = await put({ ...valid, roleIds: ['a', 'a', 'b'] });
    expect((await res.json()).filter.roleIds).toEqual(['a', 'b']);
  });
});
