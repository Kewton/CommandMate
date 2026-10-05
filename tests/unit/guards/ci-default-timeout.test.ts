import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #3340: CI だけ既定のタイムアウトを延ばす。vitest.config.ts は import 時に
// process.env.CI を読むので、環境を差し替えて読み直す。
async function loadTimeouts(ci: string | undefined) {
  vi.resetModules();
  if (ci === undefined) vi.stubEnv('CI', '');
  else vi.stubEnv('CI', ci);
  const mod = await import('../../../vitest.config');
  const test = (mod.default as { test: { testTimeout: number; hookTimeout: number } }).test;
  return { testTimeout: test.testTimeout, hookTimeout: test.hookTimeout };
}

describe('CI default timeout (Issue #3340)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('extends testTimeout and hookTimeout to 20s when CI=true', async () => {
    expect(await loadTimeouts('true')).toEqual({ testTimeout: 20_000, hookTimeout: 20_000 });
  }, 60_000);

  it('keeps the local default at 5s when CI is not set', async () => {
    const t = await loadTimeouts(undefined);
    expect(t.testTimeout).toBe(5_000);
    expect(t.hookTimeout).toBeLessThanOrEqual(10_000);
  }, 60_000);

  it('keeps the local default when CI is something other than "true"', async () => {
    expect((await loadTimeouts('false')).testTimeout).toBe(5_000);
  }, 60_000);
});
