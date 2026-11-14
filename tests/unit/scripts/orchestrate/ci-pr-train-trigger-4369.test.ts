/**
 * .github/workflows/ci-pr.yml runs on merge-train's refs (Issue #4369, design §8, §10 T-W).
 *
 * @vitest-environment node
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(fs.readFileSync(path.resolve(__dirname, '../../../../.github/workflows/ci-pr.yml'), 'utf8'));
// YAML 1.1 reads the key `on` as true in some parsers; the yaml package keeps it as "on".
const on = workflow.on ?? workflow[true as unknown as string];

describe('T-W the workflow', () => {
  it('W1: on.push.branches includes train/** (merge-train pushes its ref there)', () => {
    expect(on.push.branches).toContain('train/**');
    expect(on.push.branches).toEqual(['main', 'develop', 'train/**']);
  });

  it('W2: on.pull_request.branches stays [main, develop]', () => {
    expect(on.pull_request.branches).toEqual(['main', 'develop']);
  });

  it('W3: only pull_request runs are cancelled in progress; push runs (train ones included) get a group of their own', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
    expect(workflow.concurrency.group).toContain('github.run_id');
  });
});
