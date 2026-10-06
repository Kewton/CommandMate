/**
 * Issue #3312: the product-path check's execution result — its shape, what it
 * never carries, building it from a run's state and ledger, and the atomic
 * publish that refuses symlinks.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildProductRunResult,
  DEFAULT_PRODUCT_PUBLISH_DIR,
  normalizeProductRunResult,
  parseProductRunResult,
  parseStateFile,
  ProductPublishError,
  publishProductRunResult,
  resolveProductPublishDir,
  sanitizeReason,
  type ProductRunResult,
} from '@/lib/agent-health/product-result';

const sample = (): ProductRunResult => ({
  schemaVersion: 1,
  date: '2026-10-06',
  runId: '261006071500-ab12',
  sha: 'abcdef1',
  startedAt: '2026-10-05T22:15:00.000Z',
  finishedAt: '2026-10-05T22:30:00.000Z',
  lateStart: false,
  stages: [{ id: 'run', status: 'pass', reason: null }],
  cleanup: { status: 'pass', unknown: [] },
  reclaim: { status: 'pass', by: 'supervisor', reclaimed: [], unknown: [] },
  usage: [{ tool: 'claude', turns: 2, inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 }],
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'product-result-3312-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the result shape', () => {
  it('keeps only its own fields: a prompt, a token or a reply put beside them is dropped', () => {
    const leaky = {
      ...sample(),
      prompt: 'Run sleep 5, then reply with WORD',
      token: 'sk-secret',
      stages: [{ id: 'run', status: 'pass', reason: null, reply: 'WORD' }],
    };
    const text = JSON.stringify(normalizeProductRunResult(leaky));
    expect(text).not.toContain('sleep 5');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('WORD');
  });

  it('cuts a reason to one short line without control characters', () => {
    expect(sanitizeReason('a\nb\u001b[31mc')).toBe('a b [31mc');
    expect(sanitizeReason('x'.repeat(500))!.length).toBe(200);
    expect(sanitizeReason('  ')).toBeNull();
  });

  it('turns an unknown status into unknown, never pass, and refuses a result without its keys', () => {
    const odd = normalizeProductRunResult({ ...sample(), stages: [{ id: 'run', status: 'great' }] });
    expect(odd!.stages[0].status).toBe('unknown');
    expect(normalizeProductRunResult({ ...sample(), runId: '../x' })).toBeNull();
    expect(normalizeProductRunResult({ ...sample(), date: 'today' })).toBeNull();
    expect(normalizeProductRunResult({ ...sample(), schemaVersion: 2 })).toBeNull();
    expect(parseProductRunResult('{ broken')).toBeNull();
    expect(parseProductRunResult(JSON.stringify(sample()))).toEqual(sample());
  });

  it('defaults the publish dir to /Users/Shared/commandmate-check, overridable', () => {
    expect(DEFAULT_PRODUCT_PUBLISH_DIR).toBe('/Users/Shared/commandmate-check');
    expect(resolveProductPublishDir({})).toBe(DEFAULT_PRODUCT_PUBLISH_DIR);
    expect(resolveProductPublishDir({ CM_PRODUCT_PUBLISH_DIR: dir })).toBe(dir);
  });
});

describe('buildProductRunResult', () => {
  const state = () =>
    parseStateFile(
      [
        'date=2026-10-06',
        'run_id=261006071500-ab12',
        'sha=abcdef1',
        'started_at=1791324900',
        'late_start=0',
        'stages=reclaim run',
        'stage_reclaim=pass',
        'stage_reclaim_reason=',
        'stage_run=pass',
      ].join('\n')
    );

  it('builds a passing result when every resource was released', () => {
    const result = buildProductRunResult(
      state(),
      { runId: 'x', status: 'open', resources: [{ id: 'server', kind: 'server', state: 'released' }] },
      { by: 'supervisor', finishedAt: new Date('2026-10-05T22:30:00Z') }
    )!;
    expect(result.cleanup).toEqual({ status: 'pass', unknown: [] });
    expect(result.reclaim.status).toBe('pass');
    expect(result.startedAt).toBe(new Date(1791324900 * 1000).toISOString());
  });

  it('a stage that never finished is unknown; a resource left over makes cleanup and reclaim unknown', () => {
    const s = state();
    s.set('stages', 'reclaim run down');
    s.delete('stage_run');
    const result = buildProductRunResult(
      s,
      {
        runId: 'x',
        status: 'open',
        resources: [{ id: 'server', kind: 'server', state: 'unknown' }],
        unknownElsewhere: ['old/runner'],
      },
      { by: 'deadline-guard', finishedAt: new Date() }
    )!;
    expect(result.stages.find((stage) => stage.id === 'run')).toEqual({ id: 'run', status: 'unknown', reason: 'did not finish' });
    expect(result.cleanup).toEqual({ status: 'unknown', unknown: ['server'] });
    expect(result.reclaim).toMatchObject({ status: 'unknown', by: 'deadline-guard', unknown: ['server', 'old_runner'] });
  });

  it('without a ledger nothing is claimed clean', () => {
    const result = buildProductRunResult(state(), null, { by: 'supervisor', finishedAt: new Date() })!;
    expect(result.cleanup.status).toBe('unknown');
    expect(result.reclaim.status).toBe('unknown');
  });
});

describe('publishProductRunResult', () => {
  it('writes product-<date>.json atomically, 0644, leaving no temp file', () => {
    const file = publishProductRunResult(sample(), dir);
    expect(file).toBe(path.join(dir, 'product-2026-10-06.json'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(parseProductRunResult(fs.readFileSync(file, 'utf8'))).toEqual(sample());
    expect(fs.readdirSync(dir)).toEqual(['product-2026-10-06.json']);
    // Replaced, not appended, on a second publish.
    publishProductRunResult({ ...sample(), sha: 'abcdef2' }, dir);
    expect(parseProductRunResult(fs.readFileSync(file, 'utf8'))!.sha).toBe('abcdef2');
  });

  it('refuses a target that is a symlink and leaves what it points to alone', () => {
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'keep\n');
    fs.symlinkSync(victim, path.join(dir, 'product-2026-10-06.json'));
    expect(() => publishProductRunResult(sample(), dir)).toThrow(ProductPublishError);
    expect(() => publishProductRunResult(sample(), dir)).toThrow(/is a symlink/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep\n');
  });

  it('refuses a directory that is a symlink, or missing', () => {
    const real = path.join(dir, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(dir, 'link'));
    expect(() => publishProductRunResult(sample(), path.join(dir, 'link'))).toThrow(/is a symlink/);
    expect(fs.readdirSync(real)).toEqual([]);
    expect(() => publishProductRunResult(sample(), path.join(dir, 'missing'))).toThrow(/does not exist/);
  });
});
