/**
 * Shell-level gate for the demo-video skill (Issue #1553).
 *
 * `npm run lint` is scoped to `eslint src` and the root tsconfig deliberately
 * excludes `.claude/**` (Issue #1265), so nothing else in CI ever looks at these
 * files. `bash -n` here is the equivalent of orchestrate-monitor's syntax.test.ts.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SKILL_ROOTS = [
  path.join(REPO_ROOT, '.claude/skills/demo-video'),
  path.join(REPO_ROOT, '.agents/skills/demo-video'),
];

function shellScripts(root: string): string[] {
  const dir = path.join(root, 'scripts');
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sh'))
    .map((name) => path.join(dir, name));
}

describe('demo-video shell scripts', () => {
  const all = SKILL_ROOTS.flatMap(shellScripts);

  it('finds the scripts in both install roots', () => {
    // Guards against an empty glob quietly passing this whole file.
    expect(all.length).toBe(6);
  });

  it.each(all)('%s parses under bash -n', (script) => {
    expect(() => execFileSync('bash', ['-n', script], { stdio: 'pipe' })).not.toThrow();
  });

  it.each(all)('%s is executable', (script) => {
    // tmux runs fake-agent.sh directly and SKILL.md invokes the others without
    // an explicit interpreter.
    expect(fs.statSync(script).mode & 0o111).toBeGreaterThan(0);
  });

  // Comment lines are stripped so that prose *about* a banned construct (the
  // scripts explain why they avoid these) is not mistaken for the construct.
  const code = (script: string): string =>
    fs
      .readFileSync(script, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  // macOS ships bash 3.2, which is what these scripts run on in practice.
  it.each(all)('%s avoids bash 4+ only constructs', (script) => {
    const source = code(script);
    expect(source).not.toMatch(/\bdeclare\s+-A\b/);
    expect(source).not.toMatch(/^\s*(mapfile|readarray)\b/m);
    expect(source).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^/);
    expect(source).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,/);
    expect(source).not.toMatch(/\blocal\s+-n\b/);
  });

  it.each(all)('%s never pattern-kills by process name', (script) => {
    // `pkill -f commandmate` has taken unrelated processes down before; teardown
    // has to go through the recorded pid.
    expect(code(script)).not.toMatch(/\bpkill\b/);
  });

  it('the bash-4 guard is not vacuous', () => {
    // A comment-stripping bug would make every assertion above pass on any
    // input, so prove the patterns still fire on code that uses them.
    const offending = 'declare -A map\nmapfile -t rows < file\nlocal -n ref=x\npkill -f commandmate\n';
    expect(offending).toMatch(/\bdeclare\s+-A\b/);
    expect(offending).toMatch(/^\s*(mapfile|readarray)\b/m);
    expect(offending).toMatch(/\blocal\s+-n\b/);
    expect(offending).toMatch(/\bpkill\b/);
  });
});
