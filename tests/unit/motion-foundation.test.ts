/**
 * Motion foundation tests (Issue #1050).
 *
 * Verifies the build-visible / static-file acceptance criteria:
 * - tailwindcss-animate is registered as a Tailwind plugin
 * - a prefers-reduced-motion rule exists in globals.css
 * - the shared stagger helper caps and increments delays correctly
 */

import { readFileSync } from 'fs';
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

describe('tailwindcss-animate registration', () => {
  it('registers the plugin in tailwind.config.js', () => {
    const config = read('tailwind.config.js');
    expect(config).toContain('tailwindcss-animate');
  });

  it('lists tailwindcss-animate as a dependency in package.json', () => {
    const pkg = JSON.parse(read('package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all['tailwindcss-animate']).toBeDefined();
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
