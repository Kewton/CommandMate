/**
 * The hand-off makes no resident process and no timer of its own (Issue #4227 G-PR2, design
 * `mem-ui-4227.md` §4.3・§7.3 `handoff-no-resident-4227`): its deadlines are judged when a
 * request is read, never by a timer. The same judgement as mem's (`mem-no-resident-4222`):
 * no interval, no immediate, no worker, no detached child, no `unref`, no scheduler, and
 * `setTimeout` only for the screen client's fetch deadline (in the browser, cleared in finally).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const ROOT = process.cwd();
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const RESIDENT = [
  /\bsetInterval\s*\(/,
  /\bsetImmediate\s*\(/,
  /\bnew\s+Worker\s*\(/,
  /\bfork\s*\(/,
  /\b(?:spawn|execFile|exec)\s*\([\s\S]{0,300}?detached\s*:\s*true/,
  /\.unref\s*\(/,
  /schedule-manager|timer-manager/,
];
const TIMEOUT_ALLOWED: Record<string, string> = {
  'screen-client.ts': "the screen's fetch deadline (an AbortController), in the browser, cleared in finally",
};

export function handoffResidentFinding(file: string, source: string): string | null {
  const code = stripComments(source);
  for (const pattern of RESIDENT) if (pattern.test(code)) return `${pattern}`;
  if (/\bsetTimeout\s*\(/.test(code) && !(path.basename(file) in TIMEOUT_ALLOWED)) return 'setTimeout outside the screen client';
  return null;
}

const sources = () => [...files(path.join(ROOT, 'src/lib/handoff')), ...files(path.join(ROOT, 'src/app/api/worktrees/[id]/mem/handoff'))];

describe('the hand-off leaves nothing running (Issue #4227)', () => {
  it('(positive control) flags an interval, a stray setTimeout, unref and a detached child', () => {
    expect(handoffResidentFinding('src/lib/handoff/x.ts', 'setInterval(() => expire(), 1000);')).not.toBeNull();
    expect(handoffResidentFinding('src/lib/handoff/end.ts', 'setTimeout(() => kill(), 5);')).toBe('setTimeout outside the screen client');
    expect(handoffResidentFinding('src/lib/handoff/x.ts', 'timer.unref();')).not.toBeNull();
    expect(handoffResidentFinding('src/lib/handoff/x.ts', "spawn('x', [], { detached: true });")).not.toBeNull();
  });

  it('(negative control) the screen client’s deadline and a comment pass', () => {
    expect(handoffResidentFinding('src/lib/handoff/screen-client.ts', 'const timer = setTimeout(() => controller.abort(), ms);')).toBeNull();
    expect(handoffResidentFinding('src/lib/handoff/x.ts', '// setInterval( in a comment')).toBeNull();
  });

  it('no source of the hand-off leaves anything running', () => {
    const all = sources();
    expect(all.map((file) => path.basename(file))).toContain('decide.ts');
    const findings = all.map((file) => [path.relative(ROOT, file), handoffResidentFinding(file, readFileSync(file, 'utf8'))] as const).filter(([, finding]) => finding !== null);
    expect(findings).toEqual([]);
  });
});
