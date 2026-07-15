/**
 * Fade animation utility tests (Issue #1114).
 *
 * usePromptAnimation emits `animate-fade-in` / `animate-fade-out`, but the
 * utilities had never been defined in the Tailwind theme, so the classes were
 * silently no-ops. These tests compile the real stylesheet and assert the
 * utilities (and their keyframes) are actually generated as CSS.
 *
 * [Issue #1178] Tailwind 4 is CSS-first: the theme now lives in
 * `@theme` inside globals.css instead of tailwind.config.js, and content globs
 * are `@source` directives. Compiling globals.css against the real source tree
 * (rather than a synthetic `content: [{ raw }]`) means these tests now also
 * cover the purge behaviour end-to-end: the utilities only survive because
 * `@source` still scans src/hooks, where usePromptAnimation emits them.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

const ROOT = path.resolve(__dirname, '../../..');
const CSS_PATH = path.join(ROOT, 'src/app/globals.css');

let css: string;

beforeAll(async () => {
  const source = fs.readFileSync(CSS_PATH, 'utf-8');
  const result = await postcss([tailwindcss({ base: ROOT, optimize: false })]).process(source, {
    from: CSS_PATH,
  });
  css = result.css;
}, 120_000);

describe('animate-fade-in / animate-fade-out generation (Issue #1114)', () => {
  it('generates the animate-fade-in utility backed by motion tokens', () => {
    expect(css).toContain('.animate-fade-in');
    expect(css).toContain('@keyframes fade-in');
    // Duration / easing come from the #1050 motion tokens.
    expect(css).toMatch(/fade-in var\(--motion-duration-base\) var\(--motion-ease-out\) both/);
  });

  it('generates the animate-fade-out utility backed by motion tokens', () => {
    expect(css).toContain('.animate-fade-out');
    expect(css).toContain('@keyframes fade-out');
    expect(css).toMatch(/fade-out var\(--motion-duration-base\) var\(--motion-ease-out\) both/);
  });

  it('scans src/hooks so classes emitted by hooks survive purging', () => {
    // usePromptAnimation (src/hooks) is the only emitter of animate-fade-in/out;
    // without this glob the utilities would be purged from real builds. The
    // compiled output above is the real proof — this pins the directive itself
    // so the glob cannot be dropped silently.
    const source = fs.readFileSync(CSS_PATH, 'utf-8');
    expect(source).toMatch(/@source\s+'\.\.\/hooks\//);
  });
});
