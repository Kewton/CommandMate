/**
 * Unit test for /api/todos route configuration (Issue #911)
 *
 * Regression guard: the global Home ToDo widget reads /api/todos, which must be
 * dynamically rendered so each request hits the live DB. If the route is
 * statically prerendered at build time, ToDo add/done/delete mutations are not
 * reflected until a hard reload. Mirrors the update-check route config test.
 */

import { describe, it, expect } from 'vitest';
import { dynamic } from '@/app/api/todos/route';

describe('Route configuration: /api/todos', () => {
  it('exports dynamic as force-dynamic to prevent static prerendering', () => {
    // Issue #911: ensures Next.js treats this route as dynamic (ƒ), not a
    // build-time static snapshot (○), so the live DB is read per request.
    expect(dynamic).toBe('force-dynamic');
  });
});
