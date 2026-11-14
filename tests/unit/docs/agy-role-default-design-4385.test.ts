/**
 * The design of Issue #4385 (Antigravity's role on by default, with `tools` in the
 * generated definition) carries what the contract asked of it: invariants, the state
 * table, how each external call fails, the PR split, the test table, the open
 * questions with a recommendation, and the implementation scope. It names the 13
 * tools verified on agy 1.5.8 and leaves `swarm` out, and every file it cites exists.
 * Revision 2 (2-4-4 pre-review): the four application states, the send gate that holds
 * the body until the role is confirmed, and the generation re-check after each await.
 *
 * Line numbers are not pinned: the implementation this design asks for moves them,
 * and a design test that goes red on the PR it describes would block that PR.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const DOC = 'docs/design/agy-role-default-4385.md';

/** The 13 tools of `dev-reports/issue/agy-role-2026-11-14/report.md` (再確認), in order. */
const VERIFIED_TOOLS =
  'read_file, run_command, manage_task, send_message, schedule, invoke_subagent, define_subagent, ' +
  'manage_subagents, write_file, edit_file, search_web, run_workflow, ask_question';

/** What the design must name; each entry is [why, the words it must contain]. */
const REQUIRED: ReadonlyArray<readonly [string, string]> = [
  ['invariants section', '## 4. 不変条件'],
  ['state table', '## 5. 状態と遷移の表'],
  ['external call failures', '## 6. 外部の呼び出しごとの失敗の倒れ方'],
  ['PR split', '## 7. PR の切り方'],
  ['test table', '## 8. 試験の表'],
  ['open questions', '## 9. 未決と人の判断'],
  ['implementation scope', '## 10. 実装の範囲'],
  ['the verified tool list', VERIFIED_TOOLS],
  ['the verified version', '1.5.8'],
  ['the listing check', '`agy agent`'],
  ['the version read', '`agy --version`'],
  ['exit 3 on an unknown tool', 'exit 3'],
  ['the env var to remove', 'CM_AGENT_ROLE_ANTIGRAVITY_ENABLED'],
  ['the function to remove', 'isAgentRoleAdapterEnabled'],
  ['artifacts.ts is cited by file:line', 'artifacts.ts:'],
  ['adapters.ts is cited by file:line', 'adapters.ts:'],
  ['the launch path is cited by file:line', 'role-launch.ts:'],
  ['the home write is bounded', '~/.gemini/config/agents/'],
  ['facts and estimates are told apart', '見立て'],
  ['unverified things say so', '未確認'],
  ['positive controls', '陽性'],
  ['negative controls', '陰性'],
  ['application state: starting', '起動中'],
  ['application state: confirmed', '適用を確認済み'],
  ['application state: not applied', '明確な不適用'],
  ['application state: unknown', '取得不明'],
  ['the body waits for the confirmation', '送信の門'],
  ['generation re-check after awaits', '### D6'],
  ['the listing runs only for a new process', 'if (live) return;'],
  ['revision history', '## 改訂の履歴'],
];

/** The reasons a design text falls short of the contract (empty: it does not). */
export function designFindings(text: string): string[] {
  return REQUIRED.filter(([, words]) => !text.includes(words)).map(([why]) => why);
}

/** Repository paths the text cites as `path:line`. */
export function citedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/((?:src|tests|locales|docs)\/[\w./[\]-]+?\.(?:tsx?|md|json)):\d+/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

describe('design doc of #4385 (Antigravity role on by default)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeTemp = (text: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-4385-'));
    dirs.push(dir);
    const file = path.join(dir, 'doc.md');
    fs.writeFileSync(file, text);
    return file;
  };

  it('(positive control) a design without the required parts is flagged', () => {
    const file = writeTemp('# Antigravity\n\n環境変数を消す。\n');
    const findings = designFindings(fs.readFileSync(file, 'utf8'));
    expect(findings).toContain('invariants section');
    expect(findings).toContain('the verified tool list');
    expect(findings).toContain('the listing check');
  });

  it('(negative control) a text naming every required part is not flagged', () => {
    const file = writeTemp(REQUIRED.map(([, words]) => words).join('\n'));
    expect(designFindings(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('(positive control) a cited path is found, a bare path is not', () => {
    expect(citedPaths('`src/lib/a.ts:12` and `src/lib/b.ts`')).toEqual(['src/lib/a.ts']);
    expect(citedPaths('`src/app/api/worktrees/[id]/send/send-role.ts:188`')).toEqual([
      'src/app/api/worktrees/[id]/send/send-role.ts',
    ]);
  });

  it('the design exists and carries every required part', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(designFindings(text)).toEqual([]);
  });

  it('does not put swarm in the tools to write', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    expect(VERIFIED_TOOLS).not.toContain('swarm');
    expect(text).toContain('`swarm` は入れない');
  });

  it('every file it cites by file:line exists', () => {
    const text = fs.readFileSync(path.join(ROOT, DOC), 'utf8');
    const cited = citedPaths(text);
    expect(cited.length).toBeGreaterThan(10);
    const missing = cited.filter((file) => !fs.existsSync(path.join(ROOT, file)));
    expect(missing).toEqual([]);
  });
});
