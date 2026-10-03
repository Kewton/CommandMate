/**
 * Issue #3142: the report path (release-report-main → gh pr view → rollup)
 * must not turn a merged PR's auto-cancelled check into a NO-GO.
 * Real gh shape: __typename CheckRun, status COMPLETED, conclusion CANCELLED.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Exec } from '../../../../scripts/agent-health/release-report-main';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-release-report-3142-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const check = (name: string, conclusion: string) => ({
  __typename: 'CheckRun',
  name,
  workflowName: 'CI',
  status: 'COMPLETED',
  conclusion,
});

async function reportFor(rollup: unknown[]): Promise<string> {
  const exec: Exec = (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    if (key.startsWith('gh pr list')) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 3114, title: 'fix: x', url: 'https://github.com/o/r/pull/3114', state: 'MERGED', headRefName: 'fix/1-x', baseRefName: 'develop', mergedAt: '2026-10-03T03:00:00Z', mergeCommit: { oid: 'aaaa' }, headRefOid: 'bbbb', body: '' },
        ]),
      };
    }
    if (key.startsWith('gh pr view')) return { status: 0, stdout: JSON.stringify({ state: 'MERGED', statusCheckRollup: rollup }) };
    return { status: null, stdout: '' };
  };
  const out = path.join(root, 'out', 'r.html');
  await main(
    ['--date', '2026-10-03', '--out', out, '--state-dir', path.join(root, 'state'), '--runs-dir', path.join(root, 'runs'), '--no-audit'],
    {
      exec,
      now: () => new Date('2026-10-03T10:00:00Z'),
      env: {} as NodeJS.ProcessEnv,
      homedir: path.join(root, 'home'),
      repoDir: root,
      stdout: () => {},
      stderr: () => {},
    }
  );
  return fs.readFileSync(out, 'utf8');
}

describe('release-report: merged PR with an auto-cancelled check (#3142)', () => {
  it('does not list the PR as not green and shows the cancel count', async () => {
    const html = await reportFor([check('Unit', 'SUCCESS'), check('E2E Tests', 'CANCELLED')]);
    expect(html).not.toContain('緑でないものがある');
    expect(html).toContain('cancel 1');
  });

  it('still reports the PR when a check failed', async () => {
    const html = await reportFor([check('Unit', 'FAILURE'), check('E2E Tests', 'CANCELLED')]);
    expect(html).toContain('緑でないものがある');
  });
});
