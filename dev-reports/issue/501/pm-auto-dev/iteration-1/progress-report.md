# 進捗報告: Issue #501

## 概要

| 項目 | 値 |
|------|-----|
| **Issue** | #501: fix: Auto-Yesサーバー/クライアント二重応答とポーラー再作成によるステータス不安定 |
| **イテレーション** | 1 |
| **ブランチ** | feature/501-worktree |
| **ステータス** | 完了 (全フェーズ成功) |
| **コミット** | 50e6536: fix(auto-yes): prevent dual response and status instability |

---

## フェーズ結果

### TDD実装

- **ステータス**: 成功
- **追加テスト数**: 7
- **変更ファイル数**: 5 (修正4 + 新規1)
- **TypeScript型チェック**: パス
- **ESLint**: エラー0件

実装した修正:

1. **Fix 1 (クライアント側タイムスタンプ伝播)**: `WorktreeDetailRefactored.tsx` で `lastServerResponseTimestamp` をAPIレスポンスから取得し、`useAutoYes()` に渡すことで、サーバー応答後3秒以内のクライアント側重複応答を防止
2. **Fix 2 (ポーラー冪等性)**: `startAutoYesPolling()` が同一 `cliToolId` で再呼び出しされた場合にポーラーを再作成せず `already_running` を返すよう修正。`cliToolId` が変更された場合のみ再作成を実行
3. **Fix 3 (ステータス検出改善)**: `current-output/route.ts` と `worktree-status-helper.ts` の両方で `detectSessionStatus()` に `lastOutputTimestamp` を渡し、時間ベースヒューリスティックを有効化

### 受入テスト

- **ステータス**: 合格
- **合格基準**: 15/15 (100%)
- **ブロッカー**: なし

検証シナリオ (全5件パス):

| シナリオ | 結果 |
|---------|------|
| ポーラー冪等性 - 同一cliToolIdで再呼び出し時にポーラー状態が保持される | パス |
| ポーラー再作成 - 異なるcliToolIdで呼び出し時にポーラーが再作成される | パス |
| タイムスタンプ伝播 - APIレスポンスのlastServerResponseTimestampがクライアントに正しく渡される | パス |
| ステータス検出改善 - サーバー応答後にdetectSessionStatus()がlastOutputTimestampを受け取る | パス |
| 静的解析 - tsc/lint全パス | パス |

### リファクタリング

- **ステータス**: 成功
- **変更数**: 1件
- **内容**: `worktree-status-helper.ts` の変数名 `ts` を `lastServerResponseTs` にリネーム (可読性向上、`current-output/route.ts` との命名一貫性)

他の修正ファイルはレビューの結果、リファクタリング不要と判断された。

### ドキュメント

- **ステータス**: 変更不要

---

## 変更ファイル一覧

| ファイル | 変更種別 | 変更内容 |
|---------|---------|---------|
| `src/lib/auto-yes-poller.ts` | 修正 | ポーラー冪等性ロジック追加 (cliToolId比較、already_running返却) |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 修正 | lastServerResponseTimestamp state追加、useAutoYesへの伝播 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 修正 | detectSessionStatus()へのlastOutputTimestamp渡し |
| `src/lib/session/worktree-status-helper.ts` | 修正 | detectSessionStatus()へのlastOutputTimestamp渡し、変数名リファクタリング |
| `tests/unit/lib/auto-yes-manager.test.ts` | 修正 | 冪等性テスト4件追加 |
| `tests/unit/lib/worktree-status-helper.test.ts` | 新規 | タイムスタンプ伝播テスト3件 |

合計: +228行 / -9行

---

## 検証結果

### テスト実行結果

| 指標 | 値 |
|------|-----|
| テスト総数 | 5,008 |
| パス | 5,007 |
| 失敗 | 1 (既存の無関係な失敗 *) |
| スキップ | 7 |
| カバレッジ | 80% |

(*) `tests/unit/git-utils.test.ts` の detached HEAD state テスト -- Issue #501とは無関係の既存失敗。

### 静的解析

| チェック | 結果 |
|---------|------|
| `npx tsc --noEmit` | パス (エラー0) |
| `npm run lint` | パス (警告/エラー0) |

---

## ブロッカー

なし。全フェーズが正常に完了した。

---

## 次のアクション

1. **PR作成**: `feature/501-worktree` から `develop` へのPRを作成する
2. **既存テスト失敗の調査**: `git-utils.test.ts` の detached HEAD state テスト失敗は別Issueで対応を検討
3. **統合テスト**: Auto-Yes機能の実環境での動作確認 (サーバー起動後にプロンプト待ちからの自動応答が二重にならないこと、ステータスが安定することを手動確認)
