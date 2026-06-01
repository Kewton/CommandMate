/**
 * Unit tests for CLI / TUI / session interaction timing constants.
 * Issue #760: Validates that consolidated delay values match the original
 * hardcoded literals (behavior-preserving refactor).
 */

import { describe, it, expect } from 'vitest';
import {
  TUI_SESSION_CREATE_WAIT_MS,
  TUI_TEXT_INPUT_WAIT_MS,
  TUI_MESSAGE_PROCESSED_WAIT_MS,
  TUI_INTERRUPT_SETTLE_MS,
  TUI_EXIT_WAIT_MS,
  CODEX_DIALOG_SETTLE_MS,
  OPENCODE_EXIT_WAIT_MS,
  VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS,
  CLAUDE_ENV_SANITIZE_WAIT_MS,
  CLAUDE_RESTART_DELAY_MS,
} from '@/config/cli-tool-timing-config';

describe('cli-tool-timing-config', () => {
  it('preserves the original literal values (no behavior change)', () => {
    expect(TUI_SESSION_CREATE_WAIT_MS).toBe(100);
    expect(TUI_TEXT_INPUT_WAIT_MS).toBe(100);
    expect(TUI_MESSAGE_PROCESSED_WAIT_MS).toBe(200);
    expect(TUI_INTERRUPT_SETTLE_MS).toBe(300);
    expect(TUI_EXIT_WAIT_MS).toBe(500);
    expect(CODEX_DIALOG_SETTLE_MS).toBe(500);
    expect(OPENCODE_EXIT_WAIT_MS).toBe(2000);
    expect(VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS).toBe(200);
    expect(CLAUDE_ENV_SANITIZE_WAIT_MS).toBe(100);
    expect(CLAUDE_RESTART_DELAY_MS).toBe(1000);
  });

  it('exposes positive numbers for every constant', () => {
    const all = [
      TUI_SESSION_CREATE_WAIT_MS,
      TUI_TEXT_INPUT_WAIT_MS,
      TUI_MESSAGE_PROCESSED_WAIT_MS,
      TUI_INTERRUPT_SETTLE_MS,
      TUI_EXIT_WAIT_MS,
      CODEX_DIALOG_SETTLE_MS,
      OPENCODE_EXIT_WAIT_MS,
      VIBE_LOCAL_DOUBLE_ENTER_WAIT_MS,
      CLAUDE_ENV_SANITIZE_WAIT_MS,
      CLAUDE_RESTART_DELAY_MS,
    ];
    for (const value of all) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
    }
  });
});
