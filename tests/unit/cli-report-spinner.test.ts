/**
 * Unit tests for CLI report generate spinner/progress display
 * Issue #638: Report generation status visibility - CLI progress
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpinner, type Spinner } from '@/cli/utils/spinner';

describe('CLI spinner', () => {
  let writeStderr: (text: string) => void;
  let writeCalls: string[];
  let spinner: Spinner;

  beforeEach(() => {
    vi.useFakeTimers();
    writeCalls = [];
    writeStderr = (text: string) => { writeCalls.push(text); };
    spinner = createSpinner('Generating report...', writeStderr);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start displaying spinner frames', () => {
    spinner.start();

    // Advance timer to trigger at least one frame
    vi.advanceTimersByTime(200);

    expect(writeCalls.length).toBeGreaterThan(0);
    const output = writeCalls.join('');
    expect(output).toContain('Generating report...');

    spinner.stop();
  });

  it('should stop and show succeed message', () => {
    spinner.start();
    vi.advanceTimersByTime(200);
    spinner.succeed('Done!');

    const output = writeCalls.join('');
    expect(output).toContain('Done!');
  });

  it('should stop and show fail message', () => {
    spinner.start();
    vi.advanceTimersByTime(200);
    spinner.fail('Failed!');

    const output = writeCalls.join('');
    expect(output).toContain('Failed!');
  });

  it('should not throw if stopped without starting', () => {
    expect(() => spinner.stop()).not.toThrow();
  });
});

describe('CLI report generate with spinner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should import createSpinner from spinner module', async () => {
    const mod = await import('@/cli/utils/spinner');
    expect(mod.createSpinner).toBeDefined();
    expect(typeof mod.createSpinner).toBe('function');
  });
});
