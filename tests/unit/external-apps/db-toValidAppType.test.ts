/**
 * external-apps/db.ts toValidAppType integration test
 * Issue #573: Verify fallback behavior when DB contains invalid app_type
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mapDbRowToExternalApp } from '@/lib/external-apps/db';
import type { DbExternalAppRow } from '@/lib/external-apps/db';

describe('external-apps/db.ts toValidAppType integration (Issue #573)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeRow = (appType: string): DbExternalAppRow => ({
    id: 'test-id',
    name: 'test-app',
    display_name: 'Test App',
    description: null,
    path_prefix: 'test',
    target_port: 3000,
    target_host: 'localhost',
    app_type: appType,
    websocket_enabled: 0,
    websocket_path_pattern: null,
    enabled: 1,
    created_at: Date.now(),
    updated_at: Date.now(),
    issue_no: null,
  });

  it('should map valid app_type correctly', () => {
    const result = mapDbRowToExternalApp(makeRow('nextjs'));
    expect(result.appType).toBe('nextjs');
  });

  it('should fallback to "other" for invalid app_type', () => {
    const result = mapDbRowToExternalApp(makeRow('invalid_type'));
    expect(result.appType).toBe('other');
  });

  it('should emit warning for invalid app_type', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    mapDbRowToExternalApp(makeRow('invalid_type'));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should not emit warning for valid app_type', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    mapDbRowToExternalApp(makeRow('sveltekit'));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should handle all valid app types', () => {
    for (const appType of ['sveltekit', 'streamlit', 'nextjs', 'other']) {
      const result = mapDbRowToExternalApp(makeRow(appType));
      expect(result.appType).toBe(appType);
    }
  });

  it('should produce a valid ExternalApp object with fallback', () => {
    const result = mapDbRowToExternalApp(makeRow('unknown'));
    expect(result).toMatchObject({
      id: 'test-id',
      name: 'test-app',
      displayName: 'Test App',
      appType: 'other',
      targetPort: 3000,
    });
  });
});
