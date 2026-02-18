# Issue #306 仮説検証レポート

## 検証日時
- 2026-02-18

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `SHELL_PROMPT_ENDINGS`が`['$', '%', '#']`で定義され`endsWith`判定している | Confirmed | `claude-session.ts:58,288`で確認 |
| 2 | `pollAutoYes()`サーバー側に重複防止メカニズムがない | Confirmed | `auto-yes-manager.ts:274-369`に`lastAnsweredPromptKey`等の比較ロジックなし |
| 3 | クライアント側`useAutoYes.ts`に重複防止がある | Confirmed | `useAutoYes.ts:68-78`で`promptKey`/`lastServerResponseTimestamp`チェックあり |
| 4 | `AutoYesPollerState`に`lastAnsweredPromptKey`フィールドがない | Confirmed | `auto-yes-manager.ts:31-42`で型定義確認、該当フィールドなし |
| 5 | `ensureHealthySession()`でkill時にログが出力されない | Confirmed | `claude-session.ts:306-313`でkill理由のログ出力なし |

## 詳細検証

### 仮説 1: SHELL_PROMPT_ENDINGSの定義と判定ロジック

**Issue内の記述**: `claude-session.ts:58` で `SHELL_PROMPT_ENDINGS = ['$', '%', '#']` が定義され、`claude-session.ts:288` の `endsWith` チェックが `7%` の `%` を誤検出する

**検証手順**:
1. `src/lib/claude-session.ts:58` を確認
2. `src/lib/claude-session.ts:288` を確認

**判定**: Confirmed

**根拠**:
```typescript
// claude-session.ts:58
const SHELL_PROMPT_ENDINGS: readonly string[] = ['$', '%', '#'] as const;

// claude-session.ts:288
if (SHELL_PROMPT_ENDINGS.some(ending => trimmed.endsWith(ending))) {
  return false;  // ← %で終わる全ての文字列が不健全判定
}
```

**Issueへの影響**: Issue記載内容は正確。`N%` パターンを除外する修正が必要。

---

### 仮説 2: サーバー側pollAutoYes()の重複防止欠如

**Issue内の記述**: `auto-yes-manager.ts:274-369` の `pollAutoYes()` にサーバー側の重複防止メカニズムがない

**検証手順**:
1. `src/lib/auto-yes-manager.ts:274-369` を読み取り
2. 前回応答済みプロンプトとの比較ロジックを確認

**判定**: Confirmed

**根拠**:
- `pollAutoYes()` はプロンプト検出 → 応答送信 → `scheduleNextPoll` のループ
- `lastServerResponseTimestamp` は更新されるが（351行）、次回ポーリング時に同じプロンプトに再度応答するかの比較は行っていない
- `AutoYesPollerState`（31-42行）に `lastAnsweredPromptKey` フィールドは存在しない
- Claude CLIが応答を処理する前（2秒以内）に次のポーリングが発生した場合、同一プロンプトに重複応答が送られる可能性がある

**Issueへの影響**: Issue記載内容は正確。`lastAnsweredPromptKey` フィールドの追加と比較ロジックが必要。

---

### 仮説 3: クライアント側useAutoYes.tsの重複防止機能

**Issue内の記述**: `useAutoYes.ts` の `promptKey` による判定（77-78行）と `lastServerResponseTimestamp` による3秒ウィンドウ（68-73行）がある

**検証手順**:
1. `src/hooks/useAutoYes.ts:60-98` を確認

**判定**: Confirmed

**根拠**:
```typescript
// useAutoYes.ts:68-73: lastServerResponseTimestamp チェック
if (lastServerResponseTimestamp) {
  const timeSinceServerResponse = Date.now() - lastServerResponseTimestamp;
  if (timeSinceServerResponse < DUPLICATE_PREVENTION_WINDOW_MS) {
    return;  // 3秒以内はスキップ
  }
}
// useAutoYes.ts:77-78: promptKey チェック
const promptKey = `${promptData.type}:${promptData.question}`;
if (lastAutoRespondedRef.current === promptKey) return;
```

**Issueへの影響**: Issue記載内容は正確。クライアント側には重複防止があるが、サーバー側ポーラーには同様の機能がない非対称な状態が問題。

---

### 仮説 4: AutoYesPollerStateにlastAnsweredPromptKeyがない

**Issue内の記述**: `AutoYesPollerState` に `lastAnsweredPromptKey` フィールドを追加する必要がある

**検証手順**:
1. `src/lib/auto-yes-manager.ts:31-42` の型定義を確認

**判定**: Confirmed

**根拠**:
```typescript
export interface AutoYesPollerState {
  timerId: ReturnType<typeof setTimeout> | null;
  cliToolId: CLIToolType;
  consecutiveErrors: number;
  currentInterval: number;
  lastServerResponseTimestamp: number | null;
  // lastAnsweredPromptKey フィールドは存在しない
}
```

**Issueへの影響**: Issue記載の修正案は適切。フィールド追加が必要。

---

### 仮説 5: ensureHealthySession()のログ不足

**Issue内の記述**: `ensureHealthySession()` がセッションをkillする際、なぜ不健全と判定されたかのログが出力されない

**検証手順**:
1. `src/lib/claude-session.ts:306-313` を確認

**判定**: Confirmed

**根拠**:
```typescript
async function ensureHealthySession(sessionName: string): Promise<boolean> {
  const healthy = await isSessionHealthy(sessionName);
  if (!healthy) {
    await killSession(sessionName);  // ← ログなしでkill
    return false;
  }
  return true;
}
```
killの理由（何が不健全を示したか）がログに出力されない。

---

## Stage 1レビューへの申し送り事項

- 全仮説がConfirmedのため、Issue記載内容の技術的正確性は高い
- 対策案の優先順位（必須・推奨）は妥当
- 原因3（SHELL_PROMPT_ENDINGS誤判定）が最も緊急度が高い（正常稼働中のセッションをkillするため）
- 原因1（重複応答）は129回の重複送信が確認されており、安定性に深刻な影響
- コンテキスト枯渇（原因2）はAuto-Yes自動停止等での対応が現実的かも確認が必要
