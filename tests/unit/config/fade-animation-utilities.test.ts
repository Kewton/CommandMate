/**
 * Fade animation utility tests (Issue #1114).
 *
 * usePromptAnimation emits `animate-fade-in` / `animate-fade-out`, but the
 * utilities had never been defined in the Tailwind theme, so the classes were
 * silently no-ops. These tests compile the real tailwind.config.js and assert
 * the utilities (and their keyframes) are actually generated as CSS.
 */

import { describe, it, expect } from 'vitest';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import type { Config } from 'tailwindcss';
import baseConfig from '../../../tailwind.config.js';

/** Compile `@tailwind utilities` against the project config for given content. */
async function compileUtilities(raw: string): Promise<string> {
  const config: Config = {
    ...(baseConfig as Config),
    content: [{ raw }],
  };
  const result = await postcss([tailwindcss(config)]).process(
    '@tailwind utilities;',
    { from: undefined }
  );
  return result.css;
}

describe('animate-fade-in / animate-fade-out generation (Issue #1114)', () => {
  it('generates the animate-fade-in utility backed by motion tokens', async () => {
    const css = await compileUtilities('animate-fade-in');

    expect(css).toContain('.animate-fade-in');
    expect(css).toContain('@keyframes fade-in');
    // Duration / easing come from the #1050 motion tokens.
    expect(css).toMatch(
      /fade-in var\(--motion-duration-base\) var\(--motion-ease-out\) both/
    );
  });

  it('generates the animate-fade-out utility backed by motion tokens', async () => {
    const css = await compileUtilities('animate-fade-out');

    expect(css).toContain('.animate-fade-out');
    expect(css).toContain('@keyframes fade-out');
    expect(css).toMatch(
      /fade-out var\(--motion-duration-base\) var\(--motion-ease-out\) both/
    );
  });

  it('scans src/hooks so classes emitted by hooks survive purging', () => {
    // usePromptAnimation (src/hooks) is the emitter of animate-fade-in/out;
    // without this glob the utilities would be purged from real builds.
    const content = (baseConfig as Config).content as string[];
    expect(
      content.some((glob) => typeof glob === 'string' && glob.includes('./src/hooks/'))
    ).toBe(true);
  });
});
