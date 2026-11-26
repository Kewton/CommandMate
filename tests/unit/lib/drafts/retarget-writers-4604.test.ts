/**
 * Issue #4604 T-e (設計書 §3.4.1「1 つの口」): in `src/`, `setItem` / `removeItem` on a draft's
 * `:retarget` key are called by `writeRetarget` alone — the composer, the tile and the pane's hook
 * hand it an op, never a list to write. Comments are taken out before the search.
 *
 * A call is on the `:retarget` key when its first argument is `getRetargetTagKey(…)`, a name bound
 * to one (`const tagKey = getRetargetTagKey(…)`), or a literal ending in `:retarget`. The scanner is
 * shown to find such a call in a source written under `os.tmpdir()` (positive control) and to leave a
 * call on another key alone (negative control).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from '@tests/helpers/draft-store-fault-4604';

const SRC = path.resolve(__dirname, '../../../../src');
const ROAD_FILE = path.join(SRC, 'lib/drafts/message-draft.ts');

function blockAt(src: string, open: number): [number, number] {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return [open, i + 1];
    }
  }
  throw new Error(`unbalanced block at ${open}`);
}

function firstArg(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 1) return src.slice(open + 1, i);
      depth--;
    } else if (c === ',' && depth === 1) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** The `:retarget` writes of a source: where they are, and whether inside `writeRetarget`. */
export function retargetWrites(source: string): Array<{ at: number; call: string; inRoad: boolean }> {
  const src = stripComments(source);
  const names = new Set([...src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*getRetargetTagKey\(/g)].map((m) => m[1]));
  const road = /export function writeRetarget\s*\([^)]*\)[^{]*\{/.exec(src);
  const roadRange = road ? blockAt(src, road.index + road[0].length - 1) : null;
  const out: Array<{ at: number; call: string; inRoad: boolean }> = [];
  for (const m of src.matchAll(/\.(setItem|removeItem)\s*\(/g)) {
    const at = m.index ?? 0;
    const arg = firstArg(src, at + m[0].length - 1).trim();
    const onRetarget =
      /\bgetRetargetTagKey\s*\(/.test(arg) || names.has(arg) || /:retarget['"`]\s*$/.test(arg) || /`[^`]*:retarget`/.test(arg);
    if (!onRetarget) continue;
    out.push({ at, call: `${m[1]}(${arg})`, inRoad: roadRange !== null && at > roadRange[0] && at < roadRange[1] });
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('[#4604 T-e] the one road writes `:retarget`', () => {
  const files = walk(SRC);

  it('no `setItem` / `removeItem` on a `:retarget` key outside `writeRetarget`', () => {
    const outside: string[] = [];
    for (const file of files) {
      for (const w of retargetWrites(fs.readFileSync(file, 'utf8'))) {
        if (!(file === ROAD_FILE && w.inRoad)) outside.push(`${path.relative(SRC, file)}: ${w.call}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('the road itself is found and writes the key (the scan is not empty)', () => {
    const writes = retargetWrites(fs.readFileSync(ROAD_FILE, 'utf8'));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.inRoad)).toBe(true);
  });

  it('nothing hands a list of tags to write: no `writeRetargetTags` in src', () => {
    const users = files.filter((file) => /\bwriteRetargetTags\b/.test(stripComments(fs.readFileSync(file, 'utf8'))));
    expect(users.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it('the composer, the tile and the pane\'s hook write tags through the road only', () => {
    for (const rel of ['components/worktree/MessageInput.tsx', 'components/sessions/SessionTile.tsx', 'hooks/useOptimisticPaneMessages.ts']) {
      const src = stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
      expect({ rel, writes: retargetWrites(src).length }).toEqual({ rel, writes: 0 });
    }
  });

  describe('controls on a source under os.tmpdir()', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = null;
    });
    function sample(body: string): string {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retarget-writers-4604-'));
      const file = path.join(dir, 'sample.ts');
      fs.writeFileSync(file, body);
      return fs.readFileSync(file, 'utf8');
    }

    it('positive: a direct write, one through a bound name, and a literal key are found', () => {
      const s = sample(
        [
          'function a(k: string) { window.localStorage.setItem(getRetargetTagKey(k), "[]"); }',
          'function b(k: string) { const tagKey = getRetargetTagKey(k); window.localStorage.removeItem(tagKey); }',
          'function c(k: string) { window.localStorage.setItem(`${k}:retarget`, "[]"); }',
        ].join('\n'),
      );
      expect(retargetWrites(s).map((w) => w.call)).toEqual([
        'setItem(getRetargetTagKey(k))',
        'removeItem(tagKey)',
        'setItem(`${k}:retarget`)',
      ]);
    });

    it('negative: another key, a write in a comment, and the road\'s own write are not counted outside', () => {
      const s = sample(
        [
          'function a(k: string) { window.localStorage.setItem(k, "text"); }',
          '// window.localStorage.setItem(getRetargetTagKey(k), "[]");',
          '/* storage.removeItem(getRetargetTagKey(k)) */',
          'export function writeRetarget(k: string) { storage.setItem(getRetargetTagKey(k), "[]"); }',
        ].join('\n'),
      );
      expect(retargetWrites(s)).toEqual([expect.objectContaining({ inRoad: true })]);
    });
  });
});
