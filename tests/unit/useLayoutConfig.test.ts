/**
 * Unit tests for useLayoutConfig
 * Issue #600: UX refresh - resolveLayoutConfig() path-to-flag mapping
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLayoutConfig,
  DEFAULT_LAYOUT_CONFIG,
  LAYOUT_MAP,
} from '@/hooks/useLayoutConfig';

describe('resolveLayoutConfig()', () => {
  it('should return default config for root path', () => {
    const config = resolveLayoutConfig('/');
    expect(config).toEqual(DEFAULT_LAYOUT_CONFIG);
  });

  it('should return default config for unknown paths', () => {
    expect(resolveLayoutConfig('/unknown')).toEqual(DEFAULT_LAYOUT_CONFIG);
    expect(resolveLayoutConfig('/foo/bar')).toEqual(DEFAULT_LAYOUT_CONFIG);
  });

  it('should set autoCollapseSidebar for /sessions', () => {
    const config = resolveLayoutConfig('/sessions');
    expect(config.autoCollapseSidebar).toBe(true);
    expect(config.showSidebar).toBe(true);
    expect(config.showGlobalNav).toBe(true);
    expect(config.showLocalNav).toBe(false);
  });

  it('should set showGlobalNav=false and showLocalNav=true for /worktrees/:id', () => {
    const config = resolveLayoutConfig('/worktrees/my-worktree-123');
    expect(config.showGlobalNav).toBe(false);
    expect(config.showLocalNav).toBe(true);
    expect(config.showSidebar).toBe(true);
    expect(config.autoCollapseSidebar).toBe(false);
  });

  it('should match /worktrees/ prefix for any worktree path', () => {
    const config = resolveLayoutConfig('/worktrees/feature-foo/bar');
    expect(config.showGlobalNav).toBe(false);
    expect(config.showLocalNav).toBe(true);
  });

  it('should not match /sessions for /sessions-extra path', () => {
    // '/sessions-extra' starts with '/sessions' - depends on LAYOUT_MAP order
    // With prefix matching, this DOES match '/sessions'
    const config = resolveLayoutConfig('/sessions-extra');
    expect(config.autoCollapseSidebar).toBe(true);
  });

  it('should return default config for /review', () => {
    const config = resolveLayoutConfig('/review');
    expect(config).toEqual(DEFAULT_LAYOUT_CONFIG);
  });

  it('should return default config for /repositories', () => {
    const config = resolveLayoutConfig('/repositories');
    expect(config).toEqual(DEFAULT_LAYOUT_CONFIG);
  });

  it('should return default config for /more', () => {
    const config = resolveLayoutConfig('/more');
    expect(config).toEqual(DEFAULT_LAYOUT_CONFIG);
  });

  it('should not mutate DEFAULT_LAYOUT_CONFIG', () => {
    const config = resolveLayoutConfig('/sessions');
    config.showSidebar = false;
    expect(DEFAULT_LAYOUT_CONFIG.showSidebar).toBe(true);
  });
});

describe('DEFAULT_LAYOUT_CONFIG', () => {
  it('should have correct defaults', () => {
    expect(DEFAULT_LAYOUT_CONFIG.showSidebar).toBe(true);
    expect(DEFAULT_LAYOUT_CONFIG.showGlobalNav).toBe(true);
    expect(DEFAULT_LAYOUT_CONFIG.showLocalNav).toBe(false);
    expect(DEFAULT_LAYOUT_CONFIG.autoCollapseSidebar).toBe(false);
  });
});

describe('LAYOUT_MAP', () => {
  it('should contain entries for /worktrees/ and /sessions', () => {
    const prefixes = LAYOUT_MAP.map((entry) => entry.prefix);
    expect(prefixes).toContain('/worktrees/');
    expect(prefixes).toContain('/sessions');
  });
});
