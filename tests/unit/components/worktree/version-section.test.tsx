/**
 * Unit tests for VersionSection component
 * Issue #257: Version update notification feature
 *
 * [SF-001] Tests DRY-compliant version section shared between
 * InfoModal and MobileInfoContent.
 * [CONS-005] Tests className prop for style absorption.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionSection } from '@/components/worktree/VersionSection';
import type { UpdateCheckResponse } from '@/lib/api-client';

// Mock useUpdateCheck hook
const mockUseUpdateCheck = vi.fn();
vi.mock('@/hooks/useUpdateCheck', () => ({
  useUpdateCheck: () => mockUseUpdateCheck(),
}));

describe('VersionSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no update, loaded
    mockUseUpdateCheck.mockReturnValue({
      data: null,
      loading: false,
      error: null,
    });
  });

  it('should render version number', () => {
    render(<VersionSection version="v0.2.3" />);

    expect(screen.getByText('v0.2.3')).toBeDefined();
  });

  it('should render version heading with i18n', () => {
    render(<VersionSection version="v0.2.3" />);

    expect(screen.getByText('worktree.update.version')).toBeDefined();
  });

  it('should apply className prop [CONS-005]', () => {
    render(<VersionSection version="v0.2.3" className="bg-gray-50 rounded-lg p-4" />);

    const section = screen.getByTestId('version-section');
    expect(section.className).toContain('bg-gray-50');
    expect(section.className).toContain('rounded-lg');
    expect(section.className).toContain('p-4');
  });

  it('should show loading indicator when loading', () => {
    mockUseUpdateCheck.mockReturnValue({
      data: null,
      loading: true,
      error: null,
    });

    render(<VersionSection version="v0.2.3" />);

    expect(screen.getByTestId('version-loading')).toBeDefined();
  });

  it('should not show loading indicator when not loading', () => {
    render(<VersionSection version="v0.2.3" />);

    expect(screen.queryByTestId('version-loading')).toBeNull();
  });

  it('should show UpdateNotificationBanner when update available', () => {
    const mockData: UpdateCheckResponse = {
      status: 'success',
      hasUpdate: true,
      currentVersion: '0.2.3',
      latestVersion: '0.3.0',
      releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
      releaseName: 'v0.3.0',
      publishedAt: '2026-02-10T00:00:00Z',
      installType: 'global',
      updateCommand: 'npm install -g commandmate@latest',
    };

    mockUseUpdateCheck.mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
    });

    render(<VersionSection version="v0.2.3" />);

    expect(screen.getByTestId('update-notification-banner')).toBeDefined();
  });

  it('should not show banner when no update available', () => {
    const mockData: UpdateCheckResponse = {
      status: 'success',
      hasUpdate: false,
      currentVersion: '0.2.3',
      latestVersion: '0.2.3',
      releaseUrl: null,
      releaseName: null,
      publishedAt: null,
      installType: 'local',
      updateCommand: null,
    };

    mockUseUpdateCheck.mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
    });

    render(<VersionSection version="v0.2.3" />);

    expect(screen.queryByTestId('update-notification-banner')).toBeNull();
  });

  it('should not show banner on degraded status (API failure)', () => {
    const mockData: UpdateCheckResponse = {
      status: 'degraded',
      hasUpdate: false,
      currentVersion: '0.2.3',
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      publishedAt: null,
      installType: 'unknown',
      updateCommand: null,
    };

    mockUseUpdateCheck.mockReturnValue({
      data: mockData,
      loading: false,
      error: null,
    });

    render(<VersionSection version="v0.2.3" />);

    expect(screen.queryByTestId('update-notification-banner')).toBeNull();
  });

  it('should not show banner when data is null (error)', () => {
    mockUseUpdateCheck.mockReturnValue({
      data: null,
      loading: false,
      error: 'Network error',
    });

    render(<VersionSection version="v0.2.3" />);

    expect(screen.queryByTestId('update-notification-banner')).toBeNull();
  });
});
