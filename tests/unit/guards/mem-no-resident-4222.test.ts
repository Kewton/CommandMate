/**
 * mem makes no resident process and no timer of its own (Issue #4222, design §7 G1・G2).
 *
 * Conditions are evaluated when read (list, check, the brief, the preview); nothing
 * polls. So no source of mem holds an interval, a worker, a detached child or a
 * scheduler, and the one `setTimeout` is the caller's deadline in `eval-deadline.ts`
 * (cleared in `finally`, measured in `tests/unit/lib/mem/eval-timers-4222.test.ts`).
 * And the server's start-up path does not import mem, so nothing of it runs at boot.
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

/**
 * The files that may call `setTimeout`, each with its reason. Nothing of the server's
 * evaluation is here but the deadline helper.
 */
const TIMEOUT_ALLOWED: Record<string, string> = {
  'eval-deadline.ts': 'the one deadline of an evaluation, cleared in finally (§7)',
  'screen-client.ts': "#4221: the screen's fetch timeout, in the browser, cleared in finally (not the server's evaluation)",
};

/** Why a source of mem would leave something running, or null. */
export function residentFinding(file: string, source: string): string | null {
  const code = stripComments(source);
  for (const pattern of RESIDENT) if (pattern.test(code)) return `${pattern}`;
  if (/\bsetTimeout\s*\(/.test(code) && !(path.basename(file) in TIMEOUT_ALLOWED)) return 'setTimeout outside eval-deadline.ts';
  return null;
}

/** Whether a start-up source imports mem. */
export function importsMem(source: string): boolean {
  return /from\s+['"](?:@\/lib\/mem|\.{1,2}\/(?:src\/)?lib\/mem)[/'"]/.test(stripComments(source)) || /require\(\s*['"][^'"]*lib\/mem/.test(source);
}

const memSources = () => [
  ...files(path.join(ROOT, 'src/lib/mem')),
  ...files(path.join(ROOT, 'src/app/api')).filter((file) => file.split(path.sep).includes('mem')),
  ...files(path.join(ROOT, 'src/cli/commands')).filter((file) => /^mem.*\.ts$/.test(path.basename(file))),
];

describe('mem leaves nothing running (G1・G2)', () => {
  it('flags an interval, a worker, a detached child, unref, a scheduler and a stray setTimeout (positive control)', () => {
    expect(residentFinding('src/lib/mem/x.ts', 'setInterval(() => poll(), 1000);')).not.toBeNull();
    expect(residentFinding('src/lib/mem/x.ts', 'const t = setTimeout(() => 1, 5);')).toBe('setTimeout outside eval-deadline.ts');
    expect(residentFinding('src/lib/mem/x.ts', "spawn('gh', [], { detached: true });")).not.toBeNull();
    expect(residentFinding('src/lib/mem/x.ts', 'return { branch: null, detached: true };')).toBeNull();
    expect(residentFinding('src/lib/mem/x.ts', "import { x } from '@/lib/schedule-manager';")).not.toBeNull();
    expect(residentFinding('src/lib/mem/eval-deadline.ts', 'timer = setTimeout(() => resolve(), ms);')).toBeNull();
    expect(residentFinding('src/lib/mem/x.ts', '// setInterval( in a comment')).toBeNull();
    expect(importsMem("import { memList } from '@/lib/mem/service';")).toBe(true);
    expect(importsMem("import { x } from '@/lib/memo';")).toBe(false);
  });

  it('finds the sources at all', () => {
    const names = memSources().map((file) => path.relative(ROOT, file));
    expect(names).toContain(path.join('src', 'lib', 'mem', 'evaluate.ts'));
    expect(names).toContain(path.join('src', 'cli', 'commands', 'mem.ts'));
    expect(names.some((name) => name.includes(path.join('mem', 'check', 'route.ts')))).toBe(true);
  });

  it('no source of mem leaves anything running', () => {
    const findings = memSources()
      .map((file) => [path.relative(ROOT, file), residentFinding(file, readFileSync(file, 'utf8'))] as const)
      .filter(([, finding]) => finding !== null);
    expect(findings).toEqual([]);
  });

  it('the server’s start-up path does not import mem (G2)', () => {
    const startUp = [path.join(ROOT, 'server.ts'), ...files(path.join(ROOT, 'src/lib/server'))].filter((file) => existsSync(file));
    expect(startUp.length).toBeGreaterThan(0);
    expect(startUp.filter((file) => importsMem(readFileSync(file, 'utf8'))).map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
