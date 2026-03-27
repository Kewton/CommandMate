/**
 * Unit Tests for WorktreeInfoFields copy-to-clipboard functionality (Issue #552)
 *
 * Tests that Path and Repository Path fields have copy icons that work correctly.
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { WorktreeInfoFields, useDescriptionEditor } from '@/components/worktree/WorktreeDetailSubComponents';
import type { Worktree } from '@/types/models';

// Mock clipboard-utils
const mockCopyToClipboard = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/clipboard-utils', () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

// Mock child components that are not relevant to copy tests
vi.mock('@/components/worktree/LogViewer', () => ({
  LogViewer: () => <div data-testid="log-viewer" />,
}));

vi.mock('@/components/worktree/VersionSection', () => ({
  VersionSection: () => <div data-testid="version-section" />,
}));

vi.mock('@/components/worktree/FeedbackSection', () => ({
  FeedbackSection: () => <div data-testid="feedback-section" />,
}));

// Helper: create a mock worktree
function createMockWorktree(overrides?: Partial<Worktree>): Worktree {
  return {
    id: 'wt-1',
    name: 'test-worktree',
    path: '/home/user/projects/my-app',
    repositoryName: 'my-repo',
    repositoryPath: '/home/user/repos/my-repo',
    description: 'A test worktree',
    status: 'doing',
    link: '',
    isSessionRunning: false,
    isProcessing: false,
    isWaitingForResponse: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Worktree;
}

// Helper: create mock description editor
function createMockDescriptionEditor() {
  return {
    isEditing: false,
    text: '',
    setText: vi.fn(),
    isSaving: false,
    handleSave: vi.fn(),
    handleCancel: vi.fn(),
    startEditing: vi.fn(),
  } as ReturnType<typeof useDescriptionEditor>;
}

// Helper: render WorktreeInfoFields with defaults
function renderInfoFields(worktreeOverrides?: Partial<Worktree>) {
  const worktree = createMockWorktree(worktreeOverrides);
  const descriptionEditor = createMockDescriptionEditor();
  const onToggleLogs = vi.fn();

  const result = render(
    <WorktreeInfoFields
      worktreeId={worktree.id}
      worktree={worktree}
      cardClassName="test-card"
      descriptionEditor={descriptionEditor}
      showLogs={false}
      onToggleLogs={onToggleLogs}
    />
  );

  return { worktree, result };
}

describe('WorktreeInfoFields copy buttons (Issue #552)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCopyToClipboard.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  // TC-001: Copy icons are rendered for Path and Repository Path
  it('renders copy buttons for Path and Repository Path fields', () => {
    renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });
    const repoCopyBtn = screen.getByRole('button', { name: 'Copy repository path' });

    expect(pathCopyBtn).toBeDefined();
    expect(repoCopyBtn).toBeDefined();
  });

  // TC-002: Clicking Path copy calls copyToClipboard with worktree.path
  it('calls copyToClipboard with worktree.path when Path copy is clicked', async () => {
    const { worktree } = renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });

    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith(worktree.path);
  });

  // TC-003: Clicking Repo Path copy calls copyToClipboard with worktree.repositoryPath
  it('calls copyToClipboard with worktree.repositoryPath when Repo Path copy is clicked', async () => {
    const { worktree } = renderInfoFields();

    const repoCopyBtn = screen.getByRole('button', { name: 'Copy repository path' });

    await act(async () => {
      fireEvent.click(repoCopyBtn);
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith(worktree.repositoryPath);
  });

  // TC-004: After copy, icon changes to Check (green)
  it('shows Check icon after successful copy', async () => {
    renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });

    // Before click: title should be "Copy path"
    expect(pathCopyBtn.getAttribute('title')).toBe('Copy path');

    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    // After click: title should change to "Copied!"
    expect(pathCopyBtn.getAttribute('title')).toBe('Copied!');
  });

  // TC-005: After 2 seconds, icon reverts back
  it('reverts icon back to ClipboardCopy after 2 seconds', async () => {
    renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });

    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    expect(pathCopyBtn.getAttribute('title')).toBe('Copied!');

    // Advance timers by 2 seconds
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(pathCopyBtn.getAttribute('title')).toBe('Copy path');
  });

  // TC-006: Accessibility attributes are correctly set
  it('has correct aria-label and title attributes', () => {
    renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });
    const repoCopyBtn = screen.getByRole('button', { name: 'Copy repository path' });

    expect(pathCopyBtn.getAttribute('aria-label')).toBe('Copy worktree path');
    expect(pathCopyBtn.getAttribute('title')).toBe('Copy path');
    expect(pathCopyBtn.getAttribute('type')).toBe('button');

    expect(repoCopyBtn.getAttribute('aria-label')).toBe('Copy repository path');
    expect(repoCopyBtn.getAttribute('title')).toBe('Copy repository path');
    expect(repoCopyBtn.getAttribute('type')).toBe('button');
  });

  // TC-007: Unmount cleanup clears timers (DR1-005)
  it('clears timers on unmount', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    const { result } = renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });

    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    // Unmount the component
    result.unmount();

    // clearTimeout should have been called during cleanup
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0);

    clearTimeoutSpy.mockRestore();
  });

  // TC-008: Rapid clicks clear previous timer (IA3-004)
  it('clears previous timer on rapid clicks', async () => {
    renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });

    // Click once
    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    // Advance 1 second (not enough for revert)
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    // Title should still be "Copied!"
    expect(pathCopyBtn.getAttribute('title')).toBe('Copied!');

    // Click again (should reset the timer)
    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    // Advance another 1.5 seconds (total 2.5s from first click, but only 1.5s from second)
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    // Should still show "Copied!" because second click reset the 2s timer
    expect(pathCopyBtn.getAttribute('title')).toBe('Copied!');

    // Advance another 0.5 seconds (total 2s from second click)
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // Now it should revert
    expect(pathCopyBtn.getAttribute('title')).toBe('Copy path');
  });

  // TC-009: Repository path copy also shows Check and reverts
  it('shows Check icon for repository path copy and reverts after 2 seconds', async () => {
    renderInfoFields();

    const repoCopyBtn = screen.getByRole('button', { name: 'Copy repository path' });

    expect(repoCopyBtn.getAttribute('title')).toBe('Copy repository path');

    await act(async () => {
      fireEvent.click(repoCopyBtn);
    });

    expect(repoCopyBtn.getAttribute('title')).toBe('Copied!');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(repoCopyBtn.getAttribute('title')).toBe('Copy repository path');
  });

  // TC-010: Copy failure is handled silently
  it('handles copy failure silently without crashing', async () => {
    mockCopyToClipboard.mockRejectedValueOnce(new Error('Clipboard API failed'));

    renderInfoFields();

    const pathCopyBtn = screen.getByRole('button', { name: 'Copy worktree path' });

    // Should not throw
    await act(async () => {
      fireEvent.click(pathCopyBtn);
    });

    // Title should remain unchanged (not "Copied!") on failure
    expect(pathCopyBtn.getAttribute('title')).toBe('Copy path');
  });
});
