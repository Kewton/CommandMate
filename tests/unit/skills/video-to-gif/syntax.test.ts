/**
 * Shell-level gate for the video-to-gif skill.
 *
 * `npm run lint` is scoped to `eslint src` and the root tsconfig deliberately
 * excludes `.claude/**` (Issue #1265), so nothing else in CI ever looks at these
 * files. This is the equivalent of demo-video's scripts-syntax.test.ts.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SKILL_ROOTS = [
  path.join(REPO_ROOT, '.claude/skills/video-to-gif'),
  path.join(REPO_ROOT, '.agents/skills/video-to-gif'),
];

function shellScripts(root: string): string[] {
  const dir = path.join(root, 'scripts');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sh'))
    .map((name) => path.join(dir, name));
}

// Comment lines are stripped so that prose *about* a banned construct (the
// script explains at length why it avoids `du`) is not mistaken for the
// construct itself.
const code = (script: string): string =>
  fs
    .readFileSync(script, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('video-to-gif shell scripts', () => {
  const all = SKILL_ROOTS.flatMap(shellScripts);

  it('finds the scripts in both install roots', () => {
    // Guards against an empty glob quietly passing this whole file.
    expect(all.length).toBe(2);
  });

  it.each(all)('%s parses under bash -n', (script) => {
    expect(() => execFileSync('bash', ['-n', script], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(all)('%s is executable', (script) => {
    // SKILL.md invokes it without an explicit interpreter.
    expect(fs.statSync(script).mode & 0o111).toBeGreaterThan(0);
  });

  // macOS ships bash 3.2, which is what this runs on in practice.
  it.each(all)('%s avoids bash 4+ only constructs', (script) => {
    const source = code(script);
    expect(source).not.toMatch(/\bdeclare\s+-A\b/);
    expect(source).not.toMatch(/^\s*(mapfile|readarray)\b/m);
    expect(source).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^/);
    expect(source).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,/);
    expect(source).not.toMatch(/\blocal\s+-n\b/);
  });

  it.each(all)('%s measures bytes with wc, never du', (script) => {
    // `du -h` reported a 1,536,216 byte file as 2.3M on APFS — block
    // accounting, not content. Every size this script prints feeds a decision
    // about what to commit, so it has to be the size git stores.
    expect(code(script)).not.toMatch(/\bdu\b/);
    expect(code(script)).toMatch(/wc -c/);
  });

  it.each(all)('%s never pattern-kills by process name', (script) => {
    expect(code(script)).not.toMatch(/\bpkill\b/);
  });

  it.each(all)('%s never pipes ffmpeg into another command', (script) => {
    // A pipeline reports the reader's exit status, so a failed encode would be
    // logged as a success.
    expect(code(script)).not.toMatch(/ffmpeg[^\n]*\|[^|]/);
  });

  it('the construct guards are not vacuous', () => {
    // A comment-stripping bug would make every assertion above pass on any
    // input, so prove the patterns still fire on code that uses them.
    const offending = [
      'declare -A map',
      'mapfile -t rows < file',
      'local -n ref=x',
      'pkill -f commandmate',
      'du -h "$out"',
      'ffmpeg -i a.mp4 out.gif | grep ok',
    ].join('\n');
    expect(offending).toMatch(/\bdeclare\s+-A\b/);
    expect(offending).toMatch(/^\s*(mapfile|readarray)\b/m);
    expect(offending).toMatch(/\blocal\s+-n\b/);
    expect(offending).toMatch(/\bpkill\b/);
    expect(offending).toMatch(/\bdu\b/);
    expect(offending).toMatch(/ffmpeg[^\n]*\|[^|]/);
  });
});
