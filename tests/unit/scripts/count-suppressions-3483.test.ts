import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(process.cwd(), 'scripts/count-suppressions.mjs');
let repo: string;

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
const write = (rel: string, body: string): void => {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
};
const run = (): { status: number | null; out: string } => {
  const r = spawnSync('node', [script, '--base', 'base'], { cwd: repo, encoding: 'utf-8' });
  return { status: r.status, out: r.stdout };
};
const reset = (): void => {
  git('checkout', '-q', 'base');
  git('checkout', '-q', '-B', 'work');
};
const commit = (): void => {
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
};

describe('count-suppressions (#3483)', () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'count-suppr-'));
    git('init', '-q', '-b', 'base');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    write('src/a.ts', 'export function f(a: number): number {\n  const b = a + 1;\n  return b * 2;\n}\n');
    write('src/lib/agent-health/metrics.ts', 'export const X = 1;\n');
    commit();
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('陽性対照: eslint-disable を 1 行足すと exit 1', () => {
    reset();
    write('src/a.ts', '// eslint-disable-next-line no-var\nexport function f(a: number): number {\n  const b = a + 1;\n  return b * 2;\n}\n');
    commit();
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/a.ts:1');
  });

  it('陽性対照: @ts-expect-error / knip の ignore も止まる', () => {
    reset();
    write('src/a.ts', 'export const a = 1;\n// @ts-expect-error x\nexport const b: number = "s";\n// knip: ignore\n');
    commit();
    expect(run().status).toBe(1);
  });

  it('陽性対照: 計測の設定を変えると exit 1', () => {
    reset();
    write('src/lib/agent-health/metrics.ts', 'export const X = 2;\n');
    commit();
    expect(run().status).toBe(1);
  });

  it('陰性対照: 関数を分けるだけの変更は exit 0', () => {
    reset();
    write(
      'src/a.ts',
      'function inc(a: number): number {\n  return a + 1;\n}\nexport function f(a: number): number {\n  return inc(a) * 2;\n}\n',
    );
    commit();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('changes: 0');
  });
});
