/**
 * I-F4 and I-F3, statically (Issue #4226, design `docs/design/mem-prompt-4226.md` §7.3).
 *
 *  - The prompts run no model and leave nothing running: no timer, interval, worker,
 *    detached child, scheduler, LLM SDK, report generator or `child_process` in the
 *    sources of #4226 (git goes through `execGitCommandCapture`).
 *  - The server's start-up path does not import them (nothing of it runs at boot).
 *  - They change no hook settings: none of them, nor the CLI files #4226 changes,
 *    imports the hook settings' generators (`@/lib/hooks/**`). S1 was not taken.
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

const FORBIDDEN: RegExp[] = [
  /\bsetInterval\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetImmediate\s*\(/,
  /\bnew\s+Worker\s*\(/,
  /\bfork\s*\(/,
  /detached\s*:\s*true/,
  /\.unref\s*\(/,
  /schedule-manager|timer-manager/,
  /['"](?:@anthropic-ai\/[^'"]*|openai|@google\/generative-ai|@google\/genai)['"]/,
  /['"]@\/lib\/report(?:\/[^'"]*)?['"]/,
  /['"](?:node:)?child_process['"]/,
];

/** Why a source of #4226 would run a model or leave something running, or null. */
export function residentFinding(source: string): string | null {
  const code = stripComments(source);
  for (const pattern of FORBIDDEN) if (pattern.test(code)) return `${pattern}`;
  return null;
}

/** Whether a source imports the hook settings' side (`@/lib/hooks/**`). */
export function importsHooks(source: string): boolean {
  return /from\s+['"](?:@\/lib\/hooks|(?:\.\.\/)+(?:src\/)?lib\/hooks)[/'"]/.test(stripComments(source));
}

const importsSuggest = (source: string) => /from\s+['"](?:@\/lib\/mem-suggest|\.{1,2}\/[^'"]*mem-suggest)[/'"]/.test(stripComments(source));

const SUGGEST_SOURCES = () => [
  ...files(path.join(ROOT, 'src/lib/mem-suggest')),
  path.join(ROOT, 'src/lib/db/suggestion-shown-db.ts'),
  path.join(ROOT, 'src/app/api/worktrees/[id]/mem/suggest/route.ts'),
];
const CLI_SOURCES = [path.join(ROOT, 'src/cli/commands/mem.ts'), path.join(ROOT, 'src/cli/commands/send.ts')];

describe('#4226 runs no model and leaves nothing running (I-F4); it does not touch the hook settings (I-F3)', () => {
  it('(positive control) flags a timer, a worker, a detached child, a scheduler, an LLM SDK, child_process and a hooks import', () => {
    expect(residentFinding('setInterval(() => poll(), 1000);')).not.toBeNull();
    expect(residentFinding('const t = setTimeout(() => 1, 5);')).not.toBeNull();
    expect(residentFinding("spawn('x', [], { detached: true });")).not.toBeNull();
    expect(residentFinding("import Anthropic from '@anthropic-ai/sdk';")).not.toBeNull();
    expect(residentFinding("import { execFile } from 'child_process';")).not.toBeNull();
    expect(residentFinding("import { x } from '@/lib/schedule-manager';")).not.toBeNull();
    expect(residentFinding("import { x } from '@/lib/report/generator';")).not.toBeNull();
    expect(residentFinding('// setInterval( only in a comment')).toBeNull();
    expect(residentFinding('return { branch: null, detached: false };')).toBeNull();
    expect(importsHooks("import { generateHookSettings } from '@/lib/hooks/hook-settings-generator';")).toBe(true);
    expect(importsHooks("import { x } from '@/lib/hooksy';")).toBe(false);
    expect(importsSuggest("import { memSuggest } from '@/lib/mem-suggest/service';")).toBe(true);
  });

  it('finds the sources at all', () => {
    const names = SUGGEST_SOURCES().map((file) => path.relative(ROOT, file));
    expect(names).toContain(path.join('src', 'lib', 'mem-suggest', 'service.ts'));
    expect(names).toContain(path.join('src', 'lib', 'mem-suggest', 'rules.ts'));
    for (const file of [...SUGGEST_SOURCES(), ...CLI_SOURCES]) expect(existsSync(file), file).toBe(true);
  });

  it('no source of #4226 runs a model or leaves anything running', () => {
    const findings = SUGGEST_SOURCES()
      .map((file) => [path.relative(ROOT, file), residentFinding(readFileSync(file, 'utf8'))] as const)
      .filter(([, finding]) => finding !== null);
    expect(findings).toEqual([]);
  });

  it('none of them, nor mem.ts / send.ts, imports the hook settings’ side', () => {
    const offenders = [...SUGGEST_SOURCES(), ...CLI_SOURCES].filter((file) => importsHooks(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });

  it('the server’s start-up path does not import the prompts', () => {
    const startUp = [path.join(ROOT, 'server.ts'), ...files(path.join(ROOT, 'src/lib/server'))].filter((file) => existsSync(file));
    expect(startUp.length).toBeGreaterThan(0);
    expect(startUp.filter((file) => importsSuggest(readFileSync(file, 'utf8'))).map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});
