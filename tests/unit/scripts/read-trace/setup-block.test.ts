/**
 * Pins the read-trace block of tests/setup.ts (Issue #4432 PR3, invariant I2):
 * without CM_TRACE_REPO_READS nothing is imported and nothing is wrapped, so the
 * suite runs exactly as before; with it, the tracer is installed and records.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { readFileSync as namedReadFileSync } from 'node:fs';
import path from 'node:path';
import { ORIGINAL_KEY, STATE_KEY } from '../../../../scripts/read-trace/tracer.mjs';

const SETUP = path.join(process.cwd(), 'tests', 'setup.ts');
const traced = Boolean(process.env.CM_TRACE_REPO_READS);

function functionsOf(target: object): Array<[string, unknown]> {
  return Object.entries(target).filter(([, v]) => typeof v === 'function');
}

describe('tests/setup.ts read-trace block: source shape', () => {
  const source = fs.readFileSync(SETUP, 'utf8');
  const marker = 'if (process.env.CM_TRACE_REPO_READS) {';

  it('mentions read-trace only inside the CM_TRACE_REPO_READS block', () => {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    expect(source.slice(0, start)).not.toMatch(/read-trace\/tracer/);
    // No static import of the tracer anywhere: only the dynamic one in the block.
    expect(source).not.toMatch(/^import[^\n]*read-trace/m);
    expect(source.slice(start)).toContain("await import('../scripts/read-trace/tracer.mjs')");
  });

  it('is the last block of the file', () => {
    const start = source.indexOf(marker);
    const tail = source.slice(start).trimEnd();
    expect(tail.endsWith('}')).toBe(true);
    // The block closes at the end of the file: one top-level `}` at column 0.
    expect(tail.split('\n').filter((l) => l === '}')).toHaveLength(1);
  });
});

describe('tests/setup.ts read-trace block: behaviour', () => {
  it.skipIf(traced)('wraps nothing when CM_TRACE_REPO_READS is unset', () => {
    expect((fs as unknown as Record<symbol, unknown>)[STATE_KEY]).toBeUndefined();
    for (const target of [fs, fsp, childProcess]) {
      for (const [name, fn] of functionsOf(target)) {
        expect((fn as Record<symbol, unknown>)[ORIGINAL_KEY], name).toBeUndefined();
      }
    }
    expect((workerThreads.Worker as unknown as Record<symbol, unknown>)[ORIGINAL_KEY]).toBeUndefined();
    // The CJS export and the ESM named export are still the one original function.
    expect(fs.readFileSync).toBe(namedReadFileSync);
  });

  it.runIf(traced)('installs the tracer and records this file when CM_TRACE_REPO_READS is set', () => {
    const state = (fs as unknown as Record<symbol, { api: { snapshot: () => { testPath: string; reads: Record<string, string[]> } } }>)[STATE_KEY];
    expect(state).toBeDefined();
    const wrapped = fs.readFileSync as unknown as Record<symbol, unknown>;
    expect(typeof wrapped[ORIGINAL_KEY]).toBe('function');
    // M2: the ESM named export is the wrapper too.
    expect(namedReadFileSync).toBe(fs.readFileSync);
    fs.readFileSync(SETUP, 'utf8');
    const record = state.api.snapshot();
    expect(record.testPath).toBe('tests/unit/scripts/read-trace/setup-block.test.ts');
    expect(record.reads['tests/setup.ts']).toContain('fs.readFileSync');
  });
});
