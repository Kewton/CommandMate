/**
 * Pins .github/workflows/read-trace.yml (Issue #4432 PR3, invariant I3):
 * one job, develop pushes only, read-only, capped, and its only output is an
 * artifact — no comment, status, commit or anything a gate could read.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  'timeout-minutes'?: unknown;
  permissions?: unknown;
  steps?: Step[];
}

const FILE = join(process.cwd(), '.github', 'workflows', 'read-trace.yml');
const source = readFileSync(FILE, 'utf8');
const wf = parse(source) as { on?: Record<string, unknown>; permissions?: unknown; jobs?: Record<string, Job> };
const jobs = Object.values(wf.jobs ?? {});
const steps = jobs.flatMap((j) => j.steps ?? []);

describe('.github/workflows/read-trace.yml', () => {
  it('declares exactly one job', () => {
    expect(jobs).toHaveLength(1);
  });

  it('runs on push to develop only, never on pull_request', () => {
    expect(Object.keys(wf.on ?? {})).toEqual(['push']);
    expect(wf.on?.push).toEqual({ branches: ['develop'] });
  });

  it('is read-only and the job does not widen it', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(jobs[0].permissions).toBeUndefined();
  });

  it('caps the job with timeout-minutes', () => {
    expect(Number.isInteger(jobs[0]['timeout-minutes'])).toBe(true);
    expect(jobs[0]['timeout-minutes'] as number).toBeGreaterThan(0);
    expect(jobs[0]['timeout-minutes'] as number).toBeLessThan(360);
  });

  it('runs the suite with the tracer and builds the table with its gate-env', () => {
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('CM_TRACE_REPO_READS=');
    expect(runs).toContain('node scripts/read-trace/gate-env.mjs');
    expect(runs).toContain('node scripts/read-trace/build-table.mjs');
    expect(runs).toContain('--gate-env');
  });

  it('only publishes through actions/upload-artifact', () => {
    const uses = steps.map((s) => s.uses).filter(Boolean);
    expect(uses.sort()).toEqual(['actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4']);
    const runs = steps.map((s) => s.run ?? '').join('\n');
    expect(runs).not.toMatch(/\bgh\s|git\s+(push|commit)|statuses|github-script|curl\s/);
  });

  it('does not run the tests as a verdict: a red suite still yields a table', () => {
    const run = steps.find((s) => (s.run ?? '').includes('CM_TRACE_REPO_READS='))?.run ?? '';
    expect(run).toMatch(/\|\|\s*status=\$\?/);
  });
});
