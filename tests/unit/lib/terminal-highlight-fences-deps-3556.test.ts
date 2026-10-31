/**
 * Issue #3556: terminal-highlight-fences.ts imports unified / remark-parse
 * directly, so they must be declared and must resolve to the very copy that
 * react-markdown renders with (same parser => same fence positions).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** Real path of `name` as resolved from the directory containing `from`. */
function resolveFrom(name: string, fromDir: string): string {
  return fs.realpathSync(require.resolve(name, { paths: [fromDir] }));
}

/** Names whose direct resolution differs from react-markdown's (empty = ok). */
function mismatches(names: string[], directDir: string, viaDir: string): string[] {
  return names.filter((n) => resolveFrom(n, directDir) !== resolveFrom(n, viaDir));
}

const reactMarkdownDir = path.dirname(require.resolve('react-markdown'));
const SHARED = ['remark-parse', 'unified'];

describe('direct parser dependencies (#3556)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('declares unified / remark-parse / @types/mdast / @types/hast', () => {
    expect(pkg.dependencies.unified).toBeTruthy();
    expect(pkg.dependencies['remark-parse']).toBeTruthy();
    expect(pkg.devDependencies['@types/mdast']).toBeTruthy();
    expect(pkg.devDependencies['@types/hast']).toBeTruthy();
  });

  it('resolves to the same entity as react-markdown does (positive)', () => {
    expect(mismatches(SHARED, process.cwd(), reactMarkdownDir)).toEqual([]);
  });

  it('fails when a different copy is resolved (negative)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-3556-'));
    tmpDirs.push(tmp);
    for (const n of SHARED) {
      const dir = path.join(tmp, 'node_modules', n);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: n, main: 'index.js' }));
      fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};');
    }
    expect(mismatches(SHARED, tmp, reactMarkdownDir)).toEqual(SHARED);
  });
});
