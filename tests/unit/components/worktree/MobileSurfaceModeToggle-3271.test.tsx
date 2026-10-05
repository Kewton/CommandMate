/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileSurfaceModeToggle } from '@/components/worktree/MobileSurfaceModeToggle';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

const base = {
  showSessionRow: false,
  directInputOpen: false,
  onSurfaceToggle: vi.fn(),
  showToolActivity: false,
  onToggleToolActivity: vi.fn(),
};

describe('MobileSurfaceModeToggle (#3271)', () => {
  it('shows the tool-activity toggle only on the chat surface', () => {
    const { rerender } = render(<MobileSurfaceModeToggle {...base} surfaceMode="terminal" />);
    expect(screen.queryByTestId('mobile-chat-tool-activity-toggle')).toBeNull();
    rerender(<MobileSurfaceModeToggle {...base} surfaceMode="chat" />);
    expect(screen.getByTestId('mobile-chat-tool-activity-toggle')).toBeTruthy();
  });

  it('moves down to top-9 while the session row shows', () => {
    render(<MobileSurfaceModeToggle {...base} surfaceMode="terminal" showSessionRow />);
    expect(screen.getByTestId('mobile-surface-mode-toggle').className).toContain('top-9');
  });

  it('reports the tapped mode', () => {
    const onSurfaceToggle = vi.fn();
    render(<MobileSurfaceModeToggle {...base} onSurfaceToggle={onSurfaceToggle} surfaceMode="terminal" />);
    fireEvent.click(screen.getByTestId('mobile-surface-mode-chat'));
    expect(onSurfaceToggle).toHaveBeenCalledWith('chat');
  });
});
