/**
 * Tests for SUMMARY_ALLOWED_TOOLS in review-config.
 * Issue #990 (Phase C): Antigravity added to non-interactive summary tools.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import { SUMMARY_ALLOWED_TOOLS } from '@/config/review-config';

describe('SUMMARY_ALLOWED_TOOLS', () => {
  it('includes antigravity', () => {
    expect(SUMMARY_ALLOWED_TOOLS).toContain('antigravity');
  });

  it('keeps the previously supported non-interactive tools (regression)', () => {
    expect(SUMMARY_ALLOWED_TOOLS).toContain('claude');
    expect(SUMMARY_ALLOWED_TOOLS).toContain('codex');
    expect(SUMMARY_ALLOWED_TOOLS).toContain('copilot');
  });
});
