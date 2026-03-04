# Issue #405 仮説検証レポート

## 検証日時
- 2026-03-04

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `route.ts` (L35-99) で全CLIツールに `isRunning()` + `captureSessionOutput()` を実行 | Confirmed | L44-78にforループ、全5ツールに対してisRunning()+captureSessionOutput()実行 |
| 2 | 10 worktree × 5 CLI = 50回のtmux操作 | Confirmed | CLI_TOOL_IDSは5ツール確認: `['claude', 'codex', 'gemini', 'vibe-local', 'opencode']` |
| 3 | `WorktreeSelectionContext.tsx` (L29-36) ポーリング間隔2/5/10秒 | Confirmed | L29-36: PROCESSING:2000, SESSION_RUNNING:5000, IDLE:10000 完全一致 |
| 4 | `auto-yes-manager.ts` (L69) 2秒間隔でtmux capture | Confirmed | L69: `POLLING_INTERVAL_MS = 2000` 完全一致 |
| 5 | 同一セッション出力を複数APIから重複取得 | Confirmed | 4箇所全てでcaptureSessionOutput()直接呼び出し確認 |

## 詳細検証

### 仮説 1: GET /api/worktrees の N+1 パターン

**Issue内の記述**: `src/app/api/worktrees/route.ts` (L35-99) で、各worktreeに対して5つのCLIツール全てに `isRunning()` + `captureSessionOutput()` を実行

**検証手順**:
1. `src/app/api/worktrees/route.ts` を確認 (L35-99)
2. L44-78: `for (const cliToolId of allCliTools)` ループを確認
3. L46: `cliTool.isRunning(worktree.id)` を全CLIツールに実行
4. L53-78: `isRunning`がtrueの場合に `captureSessionOutput()` を実行

**判定**: Confirmed

**根拠**:
```typescript
// route.ts L44-78
for (const cliToolId of allCliTools) {  // allCliTools = CLI_TOOL_IDS (5ツール)
  const cliTool = manager.getTool(cliToolId);
  const isRunning = await cliTool.isRunning(worktree.id);
  if (isRunning) {
    const output = await captureSessionOutput(worktree.id, cliToolId, captureLines);
    ...
  }
}
```

**注意**: isRunning()はtrue時のみcaptureSessionOutput()を呼ぶが、isRunning()自体は全5ツールに実行される。全ツールが実行中の最悪ケースは5N capture。

---

### 仮説 2: CLI_TOOL_IDS = 5ツール

**Issue内の記述**: 10 worktree × 5 CLI = 50回のtmux操作が1回のAPIコールで発生

**検証手順**:
1. `src/lib/cli-tools/types.ts` L10 確認

**判定**: Confirmed

**根拠**:
```typescript
// types.ts L10
export const CLI_TOOL_IDS = ['claude', 'codex', 'gemini', 'vibe-local', 'opencode'] as const;
```

5ツール存在。10worktree × 5 = 50回のisRunning()が確認。

---

### 仮説 3: クライアントポーリング間隔

**Issue内の記述**: `WorktreeSelectionContext.tsx` (L29-36) で処理中2秒、セッション実行中5秒、アイドル10秒

**検証手順**:
1. `src/contexts/WorktreeSelectionContext.tsx` L29-36 確認

**判定**: Confirmed

**根拠**:
```typescript
// WorktreeSelectionContext.tsx L29-36
export const POLLING_INTERVALS = {
  PROCESSING: 2000,
  SESSION_RUNNING: 5000,
  IDLE: 10000,
} as const;
```

完全一致。

---

### 仮説 4: auto-yesポーラー2秒間隔

**Issue内の記述**: `auto-yes-manager.ts` (L69) でworktreeごとに独立して2秒ごとにtmux capture

**検証手順**:
1. `src/lib/auto-yes-manager.ts` L69 確認

**判定**: Confirmed

**根拠**:
```typescript
// auto-yes-manager.ts L69
export const POLLING_INTERVAL_MS = 2000;
```

L510でもcaptureSessionOutput()直接呼び出し確認。

---

### 仮説 5: tmux capture重複取得

**Issue内の記述**: 同一セッションの出力を複数APIから重複取得

**検証手順**:
1. `src/app/api/worktrees/route.ts` L57: `captureSessionOutput()` 呼び出し確認
2. `src/app/api/worktrees/[id]/current-output/route.ts` L70: `captureSessionOutput(params.id, cliToolId, 10000)` 確認
3. `src/lib/auto-yes-manager.ts` L510: `captureSessionOutput(worktreeId, cliToolId, 5000)` 確認
4. `src/lib/response-poller.ts` L1031: `captureSessionOutput(worktreeId, cliToolId, 10000)` 確認

**判定**: Confirmed

**根拠**: 4箇所全てで `captureSessionOutput()` を独立して呼び出し、キャッシュ共有なし。

---

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedであり、Issueの記述は正確
- `captureLines` が箇所によって異なる（route.ts:100行、current-output:10000行、auto-yes:5000行、response-poller:10000行）点をキャッシュ設計時に考慮が必要
- isRunning()もtmuxセッション確認のためI/Oを伴う可能性があり、キャッシュ対象に含めるか検討が必要
- 行数の差異（100行 vs 10000行）はキャッシュキー設計に影響する可能性がある
