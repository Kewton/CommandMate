/**
 * Issue #4257: `localStorage.getItem/setItem/removeItem` の直呼びは try/catch の中だけ。
 * 守られていない直呼びは `@/lib/safe-local-storage` へ寄せる。
 * 例外: 入口そのもの（safe-local-storage.ts）と mem（別 Issue で並行）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SRC = path.resolve(__dirname, '../../../src');
const CALL = /\blocalStorage\.(getItem|setItem|removeItem)\s*\(/;
const EXEMPT = [/lib\/safe-local-storage\.ts$/, /lib\/mem(\/|\.ts$)/, /\/mem\//];

function findUnguardedCalls(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/^\s*(\*|\/\*)/.test(line) || !CALL.test(code)) return;
    // 同じ行に try がある、または未閉じの `{` を上へ辿って try { に当たる
    let depth = 0;
    let guarded = /\btry\s*\{/.test(code.slice(0, code.search(CALL)));
    for (let j = i; j >= 0 && !guarded; j--) {
      const text = lines[j].replace(/\/\/.*$/, '');
      const upto = j === i ? text.slice(0, text.search(CALL)) : text;
      for (let k = upto.length - 1; k >= 0; k--) {
        if (upto[k] === '}') depth++;
        else if (upto[k] === '{') {
          if (depth === 0) {
            if (/\btry\s*$/.test(upto.slice(0, k))) guarded = true;
            else if (/\}\s*catch\b[^{]*$/.test(upto.slice(0, k))) guarded = false;
            // 外側の `{` へ進む
          } else depth--;
          if (guarded) break;
        }
      }
    }
    if (!guarded) hits.push(i + 1);
  });
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('localStorage 直呼びの検出 (Issue #4257)', () => {
  it('src に try/catch で守られていない直呼びが無い', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const rel = path.relative(SRC, f);
      if (EXEMPT.some((r) => r.test('/' + rel))) continue;
      for (const n of findUnguardedCalls(fs.readFileSync(f, 'utf8'))) {
        offenders.push(`src/${rel}:${n}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe('検出器の対照（一時ディレクトリ）', () => {
    it('陽性: 守られていない直呼びを検出する', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-guard-'));
      try {
        const f = path.join(dir, 'a.ts');
        fs.writeFileSync(f, "function a() {\n  return localStorage.getItem('k');\n}\n");
        expect(findUnguardedCalls(fs.readFileSync(f, 'utf8'))).toEqual([2]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('陰性: try の中・catch の中身でない呼び出しは検出しない', () => {
      const ok = [
        "function a() {",
        "  try {",
        "    if (x) {",
        "      window.localStorage.setItem('k', 'v');",
        "    }",
        "  } catch {",
        "    /* ignore */",
        "  }",
        "}",
        "try { localStorage.removeItem('k'); } catch { /* ignore */ }",
      ].join('\n');
      expect(findUnguardedCalls(ok)).toEqual([]);
    });

    it('陽性: catch の中の直呼びは検出する', () => {
      const bad = "try {\n  x();\n} catch {\n  localStorage.setItem('k', 'v');\n}\n";
      expect(findUnguardedCalls(bad)).toEqual([4]);
    });
  });
});
