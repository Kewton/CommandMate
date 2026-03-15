# Issue #501 仮説検証レポート

## 検証日時
- 2026-03-16

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| A | `lastServerResponseTimestamp` がクライアントに伝播していない | Confirmed | 型定義・抽出・引数渡し全て欠落 |
| B | `startAutoYesPolling()` が毎回ポーラーを破棄・再作成する | Confirmed | 既存ポーラーをstop→全状態リセットで再作成 |
| C | サーバー応答後のステータス検出タイムラグ | Partially Confirmed | 時間ベースフォールバック機構は存在するが未使用 |

## 詳細検証

### 仮説 A: `lastServerResponseTimestamp` がクライアントに伝播していない

**Issue内の記述**: API は `lastServerResponseTimestamp` を返しているが、`CurrentOutputResponse` 型に未定義、`fetchCurrentOutput()` で未保存、`useAutoYes()` に未渡し

**検証手順**:
1. `src/app/api/worktrees/[id]/current-output/route.ts` L111, L139 を確認
2. `src/components/worktree/WorktreeDetailRefactored.tsx` L116-132（型定義）、L352-398（fetch関数）、L961-967（useAutoYes呼出し）を確認
3. `src/hooks/useAutoYes.ts` L36（引数定義）、L75-81（重複防止ロジック）を確認

**判定**: **Confirmed**

**根拠**:
- API側: `getLastServerResponseTimestamp(params.id)` でタイムスタンプ取得しレスポンスに含めている
- `CurrentOutputResponse` 型: `lastServerResponseTimestamp` フィールドが**存在しない**
- `fetchCurrentOutput()`: レスポンスから `lastServerResponseTimestamp` を**抽出していない**
- `useAutoYes()` 呼出し: パラメータに `lastServerResponseTimestamp` を**渡していない**
- ただし `useAutoYes` フック自体はオプショナルパラメータとして `lastServerResponseTimestamp` を受け付ける設計（L36）であり、重複防止ロジック（L75-81）も実装済み → パイプラインの途中で切断されている

**Issueへの影響**: Issue記載の内容は正確。修正方法も適切。

---

### 仮説 B: `startAutoYesPolling()` が毎回ポーラーを破棄・再作成する

**Issue内の記述**: L525-528で既存ポーラーをstopAutoYesPolling()で破棄、L531-540で全状態リセットで新規作成

**検証手順**:
1. `src/lib/auto-yes-poller.ts` の `startAutoYesPolling()` 関数を確認
2. `src/app/api/worktrees/[id]/auto-yes/route.ts` のPOSTハンドラを確認

**判定**: **Confirmed**

**根拠**:
- L486-494: `existingPoller` チェック後、`stopAutoYesPolling(worktreeId)` で完全破棄
- L496-506: 新規 `AutoYesPollerState` を以下の初期値で作成:
  - `consecutiveErrors: 0`（リセット）
  - `lastAnsweredPromptKey: null`（リセット）
  - `lastAnsweredAt: null`（リセット）
  - `stopCheckBaselineLength: -1`（リセット）
  - `lastServerResponseTimestamp: null`（リセット）
  - `currentInterval: POLLING_INTERVAL_MS`（リセット）
- auto-yes APIのPOSTハンドラ（L160-171）: `enabled: true` の度に `startAutoYesPolling()` を呼び出す

**Issueへの影響**: Issue記載の行番号はやや異なる（L486-506）が、問題の本質は正確。

---

### 仮説 C: サーバー応答後のステータス検出タイムラグ

**Issue内の記述**: サーバー応答後、tmuxバッファ更新前に `detectSessionStatus()` がプロンプトを検出 → `waiting`(orange)を返す

**検証手順**:
1. `src/lib/detection/status-detector.ts` のプロンプト検出優先度を確認
2. `src/app/api/worktrees/[id]/current-output/route.ts` でのステータス検出呼出しを確認
3. `src/lib/session/worktree-status-helper.ts` でのステータス検出呼出しを確認

**判定**: **Partially Confirmed**

**根拠**:
- L172-196: プロンプト検出は最高優先度（priority 1）で、バッファにプロンプトパターンが残っていれば `waiting` を返す
- L404-417: 時間ベースヒューリスティック（`STALE_OUTPUT_THRESHOLD_MS = 5000ms`）が存在する
- **しかし**: `current-output/route.ts` L86 および `worktree-status-helper.ts` L90-91 では `detectSessionStatus()` をオプショナルパラメータ `lastOutputTimestamp` **なし**で呼び出している
- 結果: 時間ベースフォールバックは利用されておらず、パターンマッチのみで判定 → タイムラグ問題が発生

**Issueへの影響**: 問題の存在は確認されたが、既存の時間ベースフォールバック機構の存在がIssueに記載されていない。対策3は既存機構の活用で簡素化できる可能性あり。

---

## Stage 1レビューへの申し送り事項

- 仮説A, B は完全に確認済み。Issue記載内容は正確
- 仮説C は部分確認: `detectSessionStatus()` に `lastOutputTimestamp` パラメータが既に存在するが未使用。対策3はこの既存パラメータの活用を検討すべき
- Issue記載の行番号は概ね正確だが、仮説Bの行番号にズレあり（Issue: L525-540, 実際: L486-506）
