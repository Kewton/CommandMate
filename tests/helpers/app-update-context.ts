/**
 * Test values for AppUpdateContext (Issue #2654).
 */
import { vi } from 'vitest';
import {
  APP_UPDATE_DEFAULT_VALUE,
  type AppUpdateContextValue,
} from '@/contexts/AppUpdateContext';
import type { UpdateCheckResponse } from '@/lib/api-client';

export function makeUpdateInfo(overrides: Partial<UpdateCheckResponse> = {}): UpdateCheckResponse {
  return {
    status: 'success',
    hasUpdate: true,
    currentVersion: '0.38.1',
    latestVersion: '0.39.0',
    releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.39.0',
    releaseName: 'v0.39.0',
    publishedAt: '2026-09-20T00:00:00Z',
    installType: 'global',
    updateCommand: 'npm install -g commandmate@latest',
    ...overrides,
  };
}

/** hasUpdate / canSelfUpdate follow updateInfo unless overridden */
export function makeAppUpdateValue(
  overrides: Partial<AppUpdateContextValue> = {}
): AppUpdateContextValue {
  const updateInfo = overrides.updateInfo ?? null;
  return {
    ...APP_UPDATE_DEFAULT_VALUE,
    hasUpdate: updateInfo?.hasUpdate === true,
    canSelfUpdate: updateInfo?.installType === 'global' || updateInfo?.installType === 'npx',
    openConfirm: vi.fn(),
    cancel: vi.fn(),
    confirm: vi.fn(async () => {}),
    ...overrides,
  };
}
