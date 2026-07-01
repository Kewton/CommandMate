/**
 * Tests for assistant tool-capabilities (non-interactive execution mode).
 * Issue #990 (Phase C): Antigravity is a non-interactive tool.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  getAssistantExecutionMode,
  isAssistantNonInteractiveTool,
} from '@/lib/assistant/tool-capabilities';

describe('tool-capabilities: non-interactive tools', () => {
  it('treats antigravity as a non-interactive tool', () => {
    expect(getAssistantExecutionMode('antigravity')).toBe('non_interactive');
    expect(isAssistantNonInteractiveTool('antigravity')).toBe(true);
  });

  it('keeps claude and codex non-interactive (regression)', () => {
    expect(isAssistantNonInteractiveTool('claude')).toBe(true);
    expect(isAssistantNonInteractiveTool('codex')).toBe(true);
  });

  it('treats other tools as interactive', () => {
    expect(isAssistantNonInteractiveTool('gemini')).toBe(false);
    expect(isAssistantNonInteractiveTool('opencode')).toBe(false);
  });
});
