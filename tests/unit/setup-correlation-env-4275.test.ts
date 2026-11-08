/**
 * Issue #4275: tests/setup.ts removes the agent correlation keys that a suite
 * run from inside an agent tmux session inherits.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { AGENT_CORRELATION_ENV_KEYS } from '@/lib/security/env-sanitizer';

const printEnv = (key: string, env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(process.execPath, ['-e', `process.stdout.write(process.env[${JSON.stringify(key)}] ?? '')`], {
    env,
    encoding: 'utf8',
  });

describe('setup removes agent correlation env (#4275)', () => {
  it('leaves no correlation key in process.env, so children inherit none', () => {
    for (const key of AGENT_CORRELATION_ENV_KEYS) {
      expect(process.env[key], key).toBeUndefined();
      expect(printEnv(key), key).toBe('');
    }
  });

  it('still reads a value the test sets explicitly', () => {
    for (const key of AGENT_CORRELATION_ENV_KEYS) {
      expect(printEnv(key, { ...process.env, [key]: 'explicit-4275' }), key).toBe('explicit-4275');
    }
  });
});
