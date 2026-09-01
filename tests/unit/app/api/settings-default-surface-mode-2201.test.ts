/**
 * GET/PUT /api/settings/default-surface-mode (Issue #2201).
 *
 * Runs against a REAL migrated in-memory schema rather than a mocked DB module,
 * because the two things most likely to be wrong here are both storage-shaped:
 * that `configured` distinguishes "unset" from "stored", and that a value which
 * reached the row without passing `isSurfaceMode()` reads back as unset instead
 * of being served to every device. A mocked `getDefaultSurfaceMode` would
 * answer both by construction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => mocks.db }));

import { runMigrations } from '@/lib/db/db-migrations';
import { GET, PUT, dynamic } from '@/app/api/settings/default-surface-mode/route';
import { getDefaultSurfaceMode, setDefaultSurfaceMode } from '@/lib/db/app-settings-db';
import { DEFAULT_SURFACE_MODE } from '@/types/ui-state';

const URL_ = 'http://localhost:3000/api/settings/default-surface-mode';

function put(body: unknown) {
  return PUT(
    new NextRequest(URL_, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

describe('GET/PUT /api/settings/default-surface-mode (Issue #2201)', () => {
  beforeEach(() => {
    mocks.db = new Database(':memory:');
    runMigrations(mocks.db);
  });

  afterEach(() => {
    mocks.db?.close();
    mocks.db = null;
  });

  it('is force-dynamic, so the answer is not frozen at build time', () => {
    expect(dynamic).toBe('force-dynamic');
  });

  describe('GET', () => {
    it('answers the compiled-in default, and says nothing is configured', async () => {
      const response = await GET();
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      // Written as a literal as well as against the import: comparing only
      // against `DEFAULT_SURFACE_MODE` would be `expect(A).toBe(A)` and could
      // not fail whatever the route answered.
      expect(body.defaultSurfaceMode).toBe('terminal');
      expect(body.defaultSurfaceMode).toBe(DEFAULT_SURFACE_MODE);
      expect(body.configured).toBe(false);
      expect(body.constantDefault).toBe('terminal');
    });

    it('publishes the whole vocabulary so the UI hardcodes nothing', async () => {
      const body = await (await GET()).json();
      expect(body.available).toEqual(['terminal', 'chat']);
    });

    it('reports a stored mode, and flips `configured`', async () => {
      setDefaultSurfaceMode(mocks.db!, 'chat');

      const body = await (await GET()).json();
      expect(body.defaultSurfaceMode).toBe('chat');
      expect(body.configured).toBe(true);
      // The constant is still what an install with no setting would use, so it
      // must not follow the stored value.
      expect(body.constantDefault).toBe('terminal');
    });

    /**
     * The row is TEXT with no CHECK constraint, so "how did that get in there"
     * has an answer: a hand-edited DB, or a build that shipped `'xterm'` (the
     * value Epic #2192 keeps reserved) and was rolled back. Serving it would
     * hand every browser a mode no component switches on.
     */
    it('reads an unparseable stored value as unset rather than serving it', async () => {
      mocks.db!.prepare(
        `INSERT INTO app_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run('default_surface_mode', 'xterm', Date.now(), Date.now());

      const body = await (await GET()).json();
      expect(body.defaultSurfaceMode).toBe('terminal');
      expect(body.configured).toBe(false);
    });
  });

  describe('PUT', () => {
    it('stores a valid mode and echoes the new state', async () => {
      const response = await put({ mode: 'chat' });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.defaultSurfaceMode).toBe('chat');
      expect(body.configured).toBe(true);

      // Read back through the DAL, not just off the response: an echo that
      // never touched the row would pass the assertions above.
      expect(getDefaultSurfaceMode(mocks.db!)).toBe('chat');
    });

    it('round-trips through GET', async () => {
      await put({ mode: 'chat' });
      expect((await (await GET()).json()).defaultSurfaceMode).toBe('chat');

      await put({ mode: 'terminal' });
      expect((await (await GET()).json()).defaultSurfaceMode).toBe('terminal');
      // Choosing the built-in value is still a choice, not a reset.
      expect((await (await GET()).json()).configured).toBe(true);
    });

    it.each([
      ['a reserved but unshipped mode', 'xterm'],
      ['the wrong case', 'Chat'],
      ['a padded value', 'chat '],
      ['the empty string', ''],
      ['null, which is not a reset here', null],
      ['a number', 0],
      ['an object', { mode: 'chat' }],
      ['an array', ['chat']],
    ])('rejects %s with 400 and stores nothing', async (_label, mode) => {
      const response = await put({ mode });
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe('string');

      expect(getDefaultSurfaceMode(mocks.db!)).toBeNull();
    });

    it('rejects a body with no "mode" at all', async () => {
      expect((await put({})).status).toBe(400);
      expect((await put({ surfaceMode: 'chat' })).status).toBe(400);
      expect((await put(null)).status).toBe(400);
    });

    it('leaves a previously stored mode alone when a bad write is rejected', async () => {
      await put({ mode: 'chat' });
      expect((await put({ mode: 'xterm' })).status).toBe(400);
      expect(getDefaultSurfaceMode(mocks.db!)).toBe('chat');
    });

    /**
     * A write has no fallback answer, so it must surface. (A read does: the DAL
     * swallows a failed query and reports "unset", which is a correct answer —
     * that asymmetry is why only PUT is asserted here.)
     */
    it('answers 500 rather than throwing when the DB is unavailable', async () => {
      mocks.db?.close();
      mocks.db = null;

      const response = await put({ mode: 'chat' });
      expect(response.status).toBe(500);
      expect((await response.json()).success).toBe(false);
    });
  });
});
