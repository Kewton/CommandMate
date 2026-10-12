/**
 * Tests for agent-status-display (Issue #1078).
 */

import { describe, it, expect } from 'vitest';
import { isWorkingStatus } from '@/lib/agent-status-display';

describe('isWorkingStatus', () => {
  it('treats running / generating / waiting as working', () => {
    expect(isWorkingStatus('running')).toBe(true);
    expect(isWorkingStatus('generating')).toBe(true);
    expect(isWorkingStatus('waiting')).toBe(true);
  });

  it('treats idle / ready as not working', () => {
    expect(isWorkingStatus('idle')).toBe(false);
    expect(isWorkingStatus('ready')).toBe(false);
  });
});
