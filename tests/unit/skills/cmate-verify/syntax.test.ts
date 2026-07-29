import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [
  path.join(process.cwd(), '.claude/skills/cmate-verify/scripts'),
  path.join(process.cwd(), '.agents/skills/cmate-verify/scripts'),
];

function shellScripts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sh')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

const scripts = ROOTS.flatMap(shellScripts);

/**
 * bash 3.2 is what macOS ships (/bin/bash 3.2.57), so the skill cannot use the
 * bash 4 builtins. Prose mentioning them is stripped first: a guard that counts
 * matches inside its own explanatory comments false-positives on the very file
 * documenting the rule.
 */
const BASH4_ONLY: Array<{ name: string; re: RegExp }> = [
  { name: 'declare -A (associative array)', re: /\bdeclare\s+-A\b/ },
  { name: 'local -A (associative array)', re: /\blocal\s+-A\b/ },
  { name: 'mapfile', re: /\bmapfile\b/ },
  { name: 'readarray', re: /\breadarray\b/ },
  { name: '${var,,} / ${var^^} case conversion', re: /\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)/ },
];

function stripComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('cmate-verify shell scripts', () => {
  it('finds the scripts to check in both roots', () => {
    // Guard against an empty glob silently passing the whole suite.
    expect(scripts.length).toBe(4);
  });

  it.each(scripts)('passes bash -n: %s', (file) => {
    // Throws (non-zero exit) if the script has a syntax error.
    execFileSync('bash', ['-n', file], { encoding: 'utf8' });
  });

  it.each(scripts)('uses no bash 4 only construct: %s', (file) => {
    const code = stripComments(readFileSync(file, 'utf8'));
    // Non-vacuity: the stripped source must still be the script, not an empty string.
    expect(code).toContain('set -u');
    for (const { name, re } of BASH4_ONLY) {
      expect(re.test(code), `${path.basename(file)} uses ${name}`).toBe(false);
    }
  });

  it('detects a bash 4 only construct when one is present', () => {
    // Proves the matchers above are not vacuously green.
    const injected = stripComments('set -u\ndeclare -A seen\nfoo=${bar,,}\n');
    expect(BASH4_ONLY.filter(({ re }) => re.test(injected)).map(({ name }) => name)).toEqual([
      'declare -A (associative array)',
      '${var,,} / ${var^^} case conversion',
    ]);
  });
});
