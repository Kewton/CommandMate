/**
 * #4106: /release の日付取得行が、引数の置き換え（$0..$9 → 引数）を受けても動くこと。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../../..');
const skill = fs.readFileSync(path.join(ROOT, '.claude/skills/release/SKILL.md'), 'utf-8');
const line = skill.split('\n').find((l) => l.startsWith('RELEASE_DATE=')) ?? '';

let tmp = '';
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('/release RELEASE_DATE extraction (#4106)', () => {
  it('line exists and survives positional-argument substitution', () => {
    expect(line).not.toBe('');
    expect(line).not.toMatch(/\$\d+(?!\w)/);
    // simulate "/release v0.49.3": every $<digit> would become the argument
    const substituted = line.replace(/\$\d+(?!\w)/g, 'v0.49.3');
    expect(substituted).toBe(line);
  });

  it('positive control: the pre-fix awk line is broken by substitution', () => {
    const old = `RELEASE_DATE=$(awk -v v="## [\${NEXT_VERSION}] - " 'index($0, v) == 1 { print substr($0, length(v) + 1); exit }' CHANGELOG.md)`;
    expect(old.replace(/\$\d+(?!\w)/g, 'v0.49.3')).not.toBe(old);
  });

  it('extracts the date from a sample CHANGELOG with a real shell', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-4106-'));
    fs.writeFileSync(
      path.join(tmp, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [0.49.3] - 2026-11-01\n\n## [0.49.2] - 2026-10-30\n',
    );
    const r = spawnSync('bash', ['-c', `${line}\nprintf '%s' "$RELEASE_DATE"`], {
      cwd: tmp,
      encoding: 'utf-8',
      env: { ...process.env, NEXT_VERSION: '0.49.3' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('2026-11-01');
  });
});
