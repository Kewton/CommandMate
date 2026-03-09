export function isTmuxControlModeEnabled(): boolean {
  return process.env.TMUX_CONTROL_MODE_ENABLED === 'true';
}

export function isTmuxControlModeTerminalPageOnly(): boolean {
  const value = process.env.TMUX_CONTROL_MODE_TERMINAL_PAGE_ONLY;
  return value !== 'false';
}

export function isTmuxControlModeEnabledForClient(): boolean {
  return process.env.NEXT_PUBLIC_TMUX_CONTROL_MODE_ENABLED === 'true';
}
