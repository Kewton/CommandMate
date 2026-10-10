/**
 * orchestrate.md 5-2b names the consistency-review.mjs call (Issue #3540).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const orchestrate = fs.readFileSync(path.join(ROOT, '.claude/commands/orchestrate.md'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'scripts/orchestrate/consistency-review.mjs'), 'utf8');

const section = (): string => {
  const start = orchestrate.indexOf('### 5-2b.');
  expect(start).toBeGreaterThan(-1);
  const end = orchestrate.indexOf('\n### ', start + 1);
  return orchestrate.slice(start, end === -1 ? undefined : end);
};

const FLAGS = ['--run-dir', '--issues', '--issue', '--head', '--brief', '--rereview', '--previous'];

describe('orchestrate.md 5-2b calls consistency-review.mjs (#3540)', () => {
  it('names the script inside the 5-2b section', () => {
    expect(section()).toContain('scripts/orchestrate/consistency-review.mjs');
  });

  it('shows every argument name of the call', () => {
    const body = section();
    for (const flag of FLAGS) expect(body).toContain(flag);
  });

  it('uses only argument names the implementation accepts', () => {
    for (const flag of FLAGS) expect(script).toContain(`'${flag}'`);
    const line = section().split('\n').find((l) => l.includes('consistency-review.mjs')) ?? '';
    const used = line.match(/--[a-z-]+/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const flag of used) expect(script).toContain(`'${flag}'`);
  });
});
