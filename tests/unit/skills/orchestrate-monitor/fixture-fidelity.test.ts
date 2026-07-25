import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

const liveFixtures = readdirSync(FIXTURES).filter(
  (f) => f.startsWith('live-') && f.endsWith('.json'),
);

function raw(fixture: string): string {
  return readFileSync(path.join(FIXTURES, fixture), 'utf8');
}

// Issue #1522's root cause was not a bad regex — it was a bad fixture. The
// original set was hand-written with the ANSI already stripped, so it described a
// payload the product never emits, and the anchors it "proved" never fired once
// in production. These assertions exist so that stripping the ANSI out of a
// fixture (to make a failing test pass, say) breaks the suite instead of
// silently recreating the same blind spot.
describe('live-* fixtures stay faithful to real capture --json payloads', () => {
  it('finds the live fixtures', () => {
    // Guard against an empty glob quietly passing this whole file.
    expect(liveFixtures.length).toBeGreaterThanOrEqual(7);
  });

  it.each(liveFixtures)('%s carries JSON-escaped ANSI', (fixture) => {
    expect(raw(fixture)).toMatch(/\\u001b\[[0-9;]*m/);
  });

  it.each(liveFixtures)('%s is the pretty-printed shape capture --json emits', (fixture) => {
    const text = raw(fixture);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toHaveProperty('isRunning');
    // ml_json_scalar anchors on exactly two spaces of indent for top-level keys,
    // which is what `JSON.stringify(payload, null, 2)` produces.
    expect(text).toMatch(/^ {2}"isRunning":/m);
  });

  it.each([
    'live-generating-token.json',
    'live-generating-task-text-scrollback.json',
    'live-generating-rate-limit-source.json',
  ])('%s keeps the token counter ANSI-split, so a naive grep still cannot match', (fixture) => {
    const text = raw(fixture);
    // The live TUI writes the arrow, then a colour reset, then the count.
    expect(text).toMatch(/↓\\u001b\[/);
    // …which is precisely why the pre-#1522 anchor `↓ [0-9]` found nothing.
    expect(text).not.toMatch(/↓ ?[0-9]/);
  });

  it.each(liveFixtures)('%s is sanitized (no real session id or checkout path)', (fixture) => {
    const text = raw(fixture);
    expect(text).not.toMatch(/session_01[A-Za-z0-9]+/);
    expect(text).not.toContain('github_kewton');
  });
});
