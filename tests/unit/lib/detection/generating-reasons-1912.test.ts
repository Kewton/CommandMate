import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  GENERATING_REASONS,
  STATUS_REASON,
  detectSessionStatus,
  isGeneratingStatus,
} from '@/lib/detection/status-detector';

/**
 * Issue #1912 item 3: the set of `running` reasons that mean "the agent is
 * producing output right now", which `current-output-builder` publishes as
 * `thinking` / `isGenerating`.
 */
describe('Issue #1912: GENERATING_REASONS', () => {
  const fixture = (name: string): string =>
    fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

  it('covers both running reasons the detector can answer', () => {
    expect([...GENERATING_REASONS].sort()).toEqual(
      [STATUS_REASON.THINKING_INDICATOR, STATUS_REASON.OPENCODE_PROCESSING_INDICATOR].sort(),
    );
  });

  it('excludes the "output changed recently" fallback', () => {
    // `default` is the stale-output heuristic, not an announcement from the
    // agent: promoting it would light the indicator on any repainting frame.
    expect(GENERATING_REASONS.has(STATUS_REASON.DEFAULT)).toBe(false);
  });

  it('requires status running as well as the reason', () => {
    expect(
      isGeneratingStatus({ status: 'ready', reason: STATUS_REASON.THINKING_INDICATOR }),
    ).toBe(false);
    expect(
      isGeneratingStatus({ status: 'running', reason: STATUS_REASON.THINKING_INDICATOR }),
    ).toBe(true);
  });

  it('answers true for the live opencode generating frames', () => {
    for (const name of [
      'opencode-live-1883/turn-running.txt',
      'opencode-live-1896/numbered-answer-running.txt',
    ]) {
      const result = detectSessionStatus(fixture(name), 'opencode');
      expect(result.reason, name).toBe(STATUS_REASON.OPENCODE_PROCESSING_INDICATOR);
      expect(isGeneratingStatus(result), name).toBe(true);
    }
  });

  it('answers false for the live opencode idle / complete / dialog frames', () => {
    for (const name of [
      'opencode-live-1883/boot-idle.txt',
      'opencode-live-1883/turn-complete.txt',
      'opencode-live-1893/permission-bash.txt',
    ]) {
      expect(isGeneratingStatus(detectSessionStatus(fixture(name), 'opencode')), name).toBe(false);
    }
  });
});
