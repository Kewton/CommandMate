import { describe, expect, it } from 'vitest';
import {
  isTmuxControlModeEnabled,
  isTmuxControlModeEnabledForClient,
  isTmuxControlModeTerminalPageOnly,
} from '@/lib/tmux/tmux-control-mode-flags';

describe('tmux-control-mode-flags', () => {
  it('should read server enable flag', () => {
    process.env.TMUX_CONTROL_MODE_ENABLED = 'true';
    expect(isTmuxControlModeEnabled()).toBe(true);
    process.env.TMUX_CONTROL_MODE_ENABLED = 'false';
    expect(isTmuxControlModeEnabled()).toBe(false);
  });

  it('should default terminal-page-only flag to true', () => {
    delete process.env.TMUX_CONTROL_MODE_TERMINAL_PAGE_ONLY;
    expect(isTmuxControlModeTerminalPageOnly()).toBe(true);
  });

  it('should read client enable flag', () => {
    process.env.NEXT_PUBLIC_TMUX_CONTROL_MODE_ENABLED = 'true';
    expect(isTmuxControlModeEnabledForClient()).toBe(true);
    process.env.NEXT_PUBLIC_TMUX_CONTROL_MODE_ENABLED = 'false';
    expect(isTmuxControlModeEnabledForClient()).toBe(false);
  });
});
