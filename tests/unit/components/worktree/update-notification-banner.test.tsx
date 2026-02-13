/**
 * Unit tests for UpdateNotificationBanner component
 * Issue #257: Version update notification feature
 *
 * [MF-001] Tests that banner is independently testable
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  UpdateNotificationBanner,
  type UpdateNotificationBannerProps,
} from '@/components/worktree/UpdateNotificationBanner';

describe('UpdateNotificationBanner', () => {
  const defaultProps: UpdateNotificationBannerProps = {
    hasUpdate: true,
    latestVersion: '0.3.0',
    releaseUrl: 'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0',
    updateCommand: 'npm install -g commandmate@latest',
    installType: 'global',
  };

  it('should render when hasUpdate is true', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    const banner = screen.getByTestId('update-notification-banner');
    expect(banner).toBeDefined();
  });

  it('should not render when hasUpdate is false', () => {
    render(<UpdateNotificationBanner {...defaultProps} hasUpdate={false} />);

    const banner = screen.queryByTestId('update-notification-banner');
    expect(banner).toBeNull();
  });

  it('should display "available" i18n text', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    // The mock useTranslations returns the full key path
    expect(screen.getByText('worktree.update.available')).toBeDefined();
  });

  it('should display latest version with i18n', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    // Mock translates "update.latestVersion" with {version: "0.3.0"} param
    expect(screen.getByText('worktree.update.latestVersion')).toBeDefined();
  });

  it('should display update command for global install', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    expect(screen.getByText('npm install -g commandmate@latest')).toBeDefined();
  });

  it('should not display update command for local install', () => {
    render(
      <UpdateNotificationBanner
        {...defaultProps}
        installType="local"
        updateCommand={null}
      />
    );

    expect(screen.queryByText('npm install -g commandmate@latest')).toBeNull();
  });

  it('should render release link with correct attributes', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    const link = screen.getByText('worktree.update.viewRelease');
    expect(link).toBeDefined();
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/Kewton/CommandMate/releases/tag/v0.3.0'
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('should not render release link when releaseUrl is null', () => {
    render(<UpdateNotificationBanner {...defaultProps} releaseUrl={null} />);

    expect(screen.queryByText('worktree.update.viewRelease')).toBeNull();
  });

  it('should display data preservation message', () => {
    render(<UpdateNotificationBanner {...defaultProps} />);

    expect(screen.getByText('worktree.update.dataPreserved')).toBeDefined();
  });

  it('should not display latest version when null', () => {
    render(<UpdateNotificationBanner {...defaultProps} latestVersion={null} />);

    // Should not find the version line since latestVersion is null
    expect(screen.queryByText(/worktree\.update\.latestVersion/)).toBeNull();
  });
});
