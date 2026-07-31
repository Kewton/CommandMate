/**
 * The contract template embedded in `/work-plan` must actually parse (Issue #1582).
 *
 * `.claude/commands/work-plan.md` tells the planner to emit
 * `.commandmate/tasks/issue-<N>.yaml` from a yaml template. A template that no
 * longer satisfies the parser would be copied verbatim into every plan and only
 * fail at `send --contract` time, one Issue at a time, so it is checked here
 * against the same parser the server uses.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { parseTaskContract } from '@/lib/tasks/contract-parser';
import { loadVerifyConfig } from '@/lib/verification/verify-config';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORK_PLAN_PATH = '.claude/commands/work-plan.md';

const source = readFileSync(path.join(REPO_ROOT, WORK_PLAN_PATH), 'utf8');

/** Fenced ```yaml blocks only: the file also carries bash / markdown / mermaid fences. */
function yamlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

describe('work-plan contract template', () => {
  it('embeds exactly one contract template', () => {
    expect(yamlBlocks(source)).toHaveLength(1);
  });

  it('parses as a valid v1 contract', () => {
    const [template] = yamlBlocks(source);
    const contract = parseTaskContract(template, WORK_PLAN_PATH);

    expect(contract.version).toBe(1);
    expect(contract.title).not.toBe('');
    expect(contract.goal).not.toBe('');
    // requireScopeClean defaults to true, so an empty allow list would be rejected
    // above; asserted anyway because that default is what makes the template usable.
    expect(contract.success.requireScopeClean).toBe(true);
    expect(contract.scope.allow.length).toBeGreaterThan(0);
  });

  it('names only gate ids that exist in this repository verify.yaml', () => {
    const [template] = yamlBlocks(source);
    const contract = parseTaskContract(template, WORK_PLAN_PATH);
    const config = loadVerifyConfig(REPO_ROOT);
    const declared = new Set((config?.gates ?? []).map((gate) => gate.id));

    expect(declared.size).toBeGreaterThan(0);
    for (const id of contract.verify.gates ?? []) {
      expect(declared).toContain(id);
    }
  });

  it('points the planner at the canonical contract spec', () => {
    expect(source).toContain('docs/design/task-contract.md');
    expect(source).toContain('.commandmate/tasks/issue-{issue_number}.yaml');
  });
});
