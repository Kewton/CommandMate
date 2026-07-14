/**
 * Unit tests for the Web App Manifest (Issue #1124).
 * Verifies the required installability fields and icon set.
 */
import { describe, it, expect } from 'vitest';
import manifest from '@/app/manifest';

describe('web app manifest', () => {
  const m = manifest();

  it('includes the required top-level fields', () => {
    expect(m.name).toBe('CommandMate');
    expect(m.short_name).toBe('CommandMate');
    expect(m.description).toBeTruthy();
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
  });

  it('uses the dark theme tokens for the install chrome', () => {
    expect(m.background_color).toBe('#0a0c12');
    expect(m.theme_color).toBe('#0a0c12');
  });

  it('provides 192 and 512 icons required for installability', () => {
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('provides a maskable icon for adaptive Android launchers', () => {
    const maskable = (m.icons ?? []).filter((i) => i.purpose === 'maskable');
    expect(maskable.length).toBeGreaterThanOrEqual(1);
    expect(maskable.every((i) => i.type === 'image/png')).toBe(true);
  });

  it('references icons under the /icons static path', () => {
    for (const icon of m.icons ?? []) {
      expect(icon.src.startsWith('/icons/')).toBe(true);
    }
  });
});
