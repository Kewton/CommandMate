/**
 * Motion foundation tests (Issue #1050).
 *
 * Verifies the build-visible / static-file acceptance criteria:
 * - the animation utility library is registered
 * - a prefers-reduced-motion rule exists in globals.css
 * - the shared stagger helper caps and increments delays correctly
 *
 * [Issue #1178] Tailwind 4 moved config from tailwind.config.js to CSS-first
 * `@theme` in globals.css, and tailwindcss-animate (v3-only) was replaced by the
 * drop-in tw-animate-css. The registration assertions follow that move.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  STAGGER_ENTER_CLASS,
  STAGGER_MAX_ITEMS,
  STAGGER_STEP_MS,
  staggerDelay,
} from '@/lib/utils/stagger';

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

describe('tw-animate-css registration', () => {
  it('imports the animation library in globals.css', () => {
    const css = read('src/app/globals.css');
    expect(css).toContain("@import 'tw-animate-css'");
  });

  it('lists tw-animate-css as a dependency in package.json', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all['tw-animate-css']).toBeDefined();
  });

  it('no longer depends on the Tailwind 3-only tailwindcss-animate', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all['tailwindcss-animate']).toBeUndefined();
  });
});

describe('Tailwind 4 CSS-first configuration', () => {
  it('uses tailwindcss on the v4 major', () => {
    const pkg = JSON.parse(read('package.json')) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.tailwindcss).toMatch(/^\^?4\./);
  });

  it('declares the theme in CSS rather than tailwind.config.js', () => {
    const css = read('src/app/globals.css');
    expect(css).toContain('@theme inline');
    expect(existsSync(path.join(root, 'tailwind.config.js'))).toBe(false);
  });

  it('keeps the class-based dark variant', () => {
    const css = read('src/app/globals.css');
    expect(css).toContain('@custom-variant dark');
  });

  it('defines the motion animations consumed by the UI primitives', () => {
    const css = read('src/app/globals.css');
    for (const name of [
      '--animate-fade-in',
      '--animate-fade-out',
      '--animate-slide-in',
      '--animate-slide-up',
      '--animate-status-glow',
      '--animate-status-blink',
    ]) {
      expect(css).toContain(name);
    }
  });
});

describe('prefers-reduced-motion support', () => {
  it('includes a reduce-motion media query in globals.css', () => {
    const css = read('src/app/globals.css');
    expect(css).toContain('prefers-reduced-motion: reduce');
    // The blanket rule neutralizes animations and transitions.
    expect(css).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it('defines motion duration tokens on :root', () => {
    const css = read('src/app/globals.css');
    expect(css).toContain('--motion-duration-base');
    expect(css).toContain('--motion-ease-out');
  });
});

describe('staggerDelay', () => {
  it('returns no delay for the first item', () => {
    expect(staggerDelay(0)).toBeUndefined();
  });

  it('increments by the step for subsequent items', () => {
    expect(staggerDelay(1)).toBe(`${STAGGER_STEP_MS}ms`);
    expect(staggerDelay(3)).toBe(`${3 * STAGGER_STEP_MS}ms`);
  });

  it('caps: items at or beyond the max get no delay', () => {
    expect(staggerDelay(STAGGER_MAX_ITEMS)).toBeUndefined();
    expect(staggerDelay(STAGGER_MAX_ITEMS + 5)).toBeUndefined();
  });

  it('is robust to non-finite / negative indices', () => {
    expect(staggerDelay(-1)).toBeUndefined();
    expect(staggerDelay(NaN)).toBeUndefined();
  });

  it('exposes entrance classes using fill-mode-backwards (hover-safe)', () => {
    expect(STAGGER_ENTER_CLASS).toContain('animate-in');
    expect(STAGGER_ENTER_CLASS).toContain('fill-mode-backwards');
  });
});
