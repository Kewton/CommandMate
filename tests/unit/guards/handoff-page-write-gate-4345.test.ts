/**
 * Issue #4345 1c 再指示 2 (K1, T10): every write a worktree page owns goes through the hand-off page's
 * gate — the gateway that refuses a new operation the page may not start before anything is sent
 * (`@/lib/handoff/page-owner`: `fetchForHandoffPage`, `sendMessageForHandoffPage`,
 * `uploadImageFileForHandoffPage`, an `api-client` request carrying `beforeFetch`).
 *
 * Scanned: the page-owned sources — `src/components/worktree/**`, `src/components/mem/**`,
 * `src/hooks/**`, and the two components the page draws in its agents pane
 * (`src/components/settings/AgentUpdatesCard.tsx`, `src/components/roles/InstanceRolesSection.tsx`).
 * A write is a raw `fetch(` or a `fetchApiResponse(` whose options name a method other than GET /
 * HEAD and carry no `beforeFetch`, or a write of an API client (`worktreeApi.sendMessage` …,
 * `memoApi.create` …, `roleApi.setInstanceRole` …) called directly. Each must be 0 outside the named
 * exceptions below, each with its reason (the 1d follow-up: Git, timers, OpenCode's session, the
 * description, memos — PM's disposition (a); or not a page's at all).
 *
 * Controls: a raw POST, a write `fetchApiResponse` without `beforeFetch` and a direct
 * `worktreeApi.sendMessage(` are found; the gateway's calls, a GET and a comment are not.
 * An exception that no longer has its write behind it fails too (the list is kept exact).
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
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

const PAGE_OWNED = (): string[] => [
  ...files(path.join(ROOT, 'src/components/worktree')),
  ...files(path.join(ROOT, 'src/components/mem')),
  ...files(path.join(ROOT, 'src/hooks')),
  path.join(ROOT, 'src/components/settings/AgentUpdatesCard.tsx'),
  path.join(ROOT, 'src/components/roles/InstanceRolesSection.tsx'),
];

/** Comments out, strings kept (a URL or a method is in a string). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The text between the call's parentheses (`open` is the index of its `(`). */
function argsOf(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

const WRITE_METHOD = /method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i;
const CLIENT_WRITES =
  /\b(?:worktreeApi\.(?:sendMessage|uploadImageFile|updateDescription|updateLink|toggleFavorite|updateStatus|updateCliTool|markAsViewed|killSession)|memoApi\.(?:create|update|delete|reorder)|roleApi\.(?:setInstanceRole|create|update|delete|saveRoster|addInstance|removeInstance|createInstance))\s*\(/g;

export interface WriteFinding {
  readonly line: number;
  readonly what: string;
}

/** The writes in `source` that do not go through the page's gate. */
export function pageWriteFindings(source: string): WriteFinding[] {
  const code = stripComments(source);
  const lineOf = (index: number) => code.slice(0, index).split('\n').length;
  const found: WriteFinding[] = [];
  const call = /(?<![\w.$])(fetch|fetchApiResponse)\s*\(/g;
  for (let m = call.exec(code); m; m = call.exec(code)) {
    const args = argsOf(code, m.index + m[0].length - 1);
    if (!WRITE_METHOD.test(args)) continue;
    if (m[1] === 'fetchApiResponse' && /\bbeforeFetch\s*:/.test(args)) continue;
    found.push({ line: lineOf(m.index), what: `${m[1]} ${WRITE_METHOD.exec(args)![1].toUpperCase()}` });
  }
  for (let m = CLIENT_WRITES.exec(code); m; m = CLIENT_WRITES.exec(code)) {
    found.push({ line: lineOf(m.index), what: m[0].replace(/\s*\($/, '') });
  }
  return found;
}

/**
 * The writes left outside the gate on purpose: file → how many, and why. PM's disposition (a): the
 * gate covers 1c's entries (sends, prompt answers, file operations, the three panes, the settings /
 * roles kill and what was added since); the rest is the 1d follow-up or is not a page's.
 */
const EXCEPTIONS: Record<string, { count: number; reason: string }> = {
  // Not a write: a POST that only renders, reported as a read (`beginHandoffPageResponseReport` kind read).
  'src/components/worktree/FilePanelContent.tsx': { count: 1, reason: 'MARP の描画（副作用の無い POST＝read）' },
  // 1d (PM's disposition (a)): Git, timers, OpenCode's session, the description and notes, memos.
  'src/components/worktree/OpencodeSessionControls.tsx': { count: 3, reason: '1d: OpenCode のセッション（share・session）' },
  'src/components/worktree/OpencodeTurnDiffPanel.tsx': { count: 1, reason: '1d: OpenCode のセッション（diff）' },
  'src/components/worktree/TerminalSplitPane.tsx': { count: 1, reason: '1d: インスタンスのメモ（notes の PUT。説明の編集の系統）' },
  'src/components/worktree/TimerPane.tsx': { count: 2, reason: '1d: タイマー' },
  'src/components/worktree/timers/TimerEditDialog.tsx': { count: 1, reason: '1d: タイマー' },
  'src/hooks/useBranches.ts': { count: 3, reason: '1d: Git' },
  'src/hooks/useChanges.ts': { count: 3, reason: '1d: Git' },
  'src/hooks/useDangerZone.ts': { count: 2, reason: '1d: Git（reset／revert）' },
  'src/hooks/useGitPaneNetworkOps.ts': { count: 1, reason: '1d: Git' },
  'src/components/worktree/MemoPane.tsx': { count: 4, reason: '1d: メモ（memoApi）' },
  'src/components/worktree/WorktreeDetailSubComponents.tsx': { count: 1, reason: '1d: 説明の編集（worktreeApi.updateDescription）' },
  'src/components/roles/InstanceRolesSection.tsx': { count: 1, reason: '1d: ロールの保存（roleApi は scope 外の api-client-agent-roles。口を受ける形が要る）' },
  // Not a page's operation: the app's, whatever screen draws it.
  'src/hooks/useAgentDefaults.ts': { count: 2, reason: 'アプリ全体の既定のエージェント（保存・未変更の作業木への適用）' },
  'src/hooks/useAgentUpdates.ts': { count: 1, reason: 'アプリ全体の CLI の更新（npm の更新）' },
  'src/hooks/useFragmentLogin.ts': { count: 1, reason: 'ログイン（認証の流れ。ページの外）' },
  'src/hooks/useSessionTileAutoYes.ts': { count: 1, reason: 'セッション一覧のタイル（ページの外）' },
};

describe('[#4345 1c 再指示 2] (T10) a page-owned write goes through the gate', () => {
  it('(positive control) finds a raw POST, a write fetchApiResponse without beforeFetch and a direct client write', () => {
    expect(pageWriteFindings("await fetch(`/api/x`, { method: 'POST', body });")).toHaveLength(1);
    expect(pageWriteFindings("await fetchApiResponse(url, { method: 'DELETE' });")).toHaveLength(1);
    expect(pageWriteFindings('await worktreeApi.sendMessage(id, text, options);')).toHaveLength(1);
    expect(pageWriteFindings('void memoApi.update(id, memo, patch);')).toHaveLength(1);
  });

  it('(negative control) the gateway, a read, a gated request and a comment are not writes', () => {
    expect(pageWriteFindings("await fetchForHandoffPage(owner, url, { method: 'POST' });")).toEqual([]);
    expect(pageWriteFindings('await fetch(url);')).toEqual([]);
    expect(pageWriteFindings("await fetch(url, { signal });")).toEqual([]);
    expect(pageWriteFindings("await fetchApiResponse(url, { method: 'POST', beforeFetch: () => gate() });")).toEqual([]);
    expect(pageWriteFindings("// await fetch(url, { method: 'POST' })")).toEqual([]);
    expect(pageWriteFindings('/* worktreeApi.sendMessage(id, text) */')).toEqual([]);
  });

  it('every page-owned write outside the named exceptions goes through the gate', () => {
    const counts: Record<string, WriteFinding[]> = {};
    for (const file of PAGE_OWNED()) {
      if (!existsSync(file)) continue;
      const findings = pageWriteFindings(readFileSync(file, 'utf8'));
      if (findings.length > 0) counts[path.relative(ROOT, file)] = findings;
    }
    const outside = Object.entries(counts)
      .filter(([file, findings]) => EXCEPTIONS[file]?.count !== findings.length)
      .map(([file, findings]) => [file, findings.map((f) => `${f.line}: ${f.what}`)]);
    expect(outside).toEqual([]);
    // The list is exact: an exception with nothing behind it any more is taken out.
    const stale = Object.keys(EXCEPTIONS).filter((file) => !counts[file]);
    expect(stale).toEqual([]);
  });
});
