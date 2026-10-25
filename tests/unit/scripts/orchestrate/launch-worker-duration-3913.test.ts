/**
 * scripts/orchestrate/launch-worker.mjs accepts the same `--duration` range as
 * the CLI: 1h〜24h, whole hours (Issue #3913).
 *
 * The .mjs cannot import TypeScript, so it carries a copy of the format; this
 * test keeps the copy equal to src/config/auto-yes-duration.ts, on the source
 * and on every one of the 24 values (plus the rejected shapes).
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { DURATION_FLAG_PATTERN, parseArgs } from '../../../../scripts/orchestrate/launch-worker.mjs';
import {
  AUTO_YES_DURATION_FLAG_PATTERN,
  parseAutoYesDurationFlag,
} from '../../../../src/config/auto-yes-duration';

const sendArgv = (...extra: string[]) => [
  'send', '--run-dir', '/nonexistent/run', '--issue', '3913', '--wt', 'wt-1', '--worktree', '/nonexistent/wt',
  '--instance', 'claude', '--contract', '.commandmate/tasks/issue-3913.yaml', ...extra,
];

const REJECTED = ['0h', '25h', '1.5h', '90m', '01h', '+1h', '1H', ' 1h', '1hX', '2d', ''];

describe('[#3913] launch-worker --duration', () => {
  it('copies the CLI format exactly', () => {
    expect(DURATION_FLAG_PATTERN.source).toBe(AUTO_YES_DURATION_FLAG_PATTERN.source);
    expect(DURATION_FLAG_PATTERN.flags).toBe(AUTO_YES_DURATION_FLAG_PATTERN.flags);
  });

  it('agrees with the CLI on all 24 values', () => {
    for (let hours = 1; hours <= 24; hours++) {
      const flag = `${hours}h`;
      expect(DURATION_FLAG_PATTERN.test(flag)).toBe(true);
      expect(parseAutoYesDurationFlag(flag)).toBe(hours * 3_600_000);
    }
  });

  it.each(REJECTED)('agrees with the CLI on rejecting %j', (flag) => {
    expect(DURATION_FLAG_PATTERN.test(flag)).toBe(false);
    expect(parseAutoYesDurationFlag(flag)).toBeNull();
  });

  it.each(['1h', '5h', '24h'])('parseArgs accepts --duration %s', (flag) => {
    const parsed = parseArgs(sendArgv('--duration', flag));
    expect(parsed.error).toBeUndefined();
    expect(parsed.options).toMatchObject({ duration: flag });
  });

  it.each(['0h', '25h'])('parseArgs rejects --duration %s', (flag) => {
    expect(parseArgs(sendArgv('--duration', flag)).error).toMatch(/--duration must be 1h\.\.24h/);
  });

  it('keeps 3h as the default when --duration is omitted (negative control)', () => {
    expect(parseArgs(sendArgv()).options).toMatchObject({ duration: '3h' });
  });
});
