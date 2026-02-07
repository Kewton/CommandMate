# Issue #180 影響範囲レビュー（Stage 3）

**レビュー日**: 2026-02-07
**レビュー対象**: fix: ステータス表示の不整合 - CLIがidle状態でもrunning/waitingと誤表示
**レビューフォーカス**: 影響範囲（Impact Scope）

---

## 概要

Issue #180 はステータス検出ロジックの修正を提案している。`detectPrompt()` の検索範囲制限、検出優先順位の変更、およびロジック重複の解消が主な変更内容である。

本レビューでは、`detectPrompt()` と `detectThinking()` の全呼び出し箇所をコードベース全体でトレースし、Issue に記載されている影響範囲の網羅性を検証した。

---

## 発見事項サマリー

| 重要度 | 件数 |
|--------|------|
| must_fix | 4 |
| should_fix | 5 |
| nice_to_have | 2 |
| **合計** | **11** |

---

## must_fix 項目

### S3-001: status-detector.ts の未言及

**ファイル**: `src/lib/status-detector.ts`, `src/lib/__tests__/status-detector.test.ts`

`src/lib/status-detector.ts` に `detectSessionStatus()` 関数が存在し、Issue #180 が提案する優先順位変更と非常に類似した構造を既に実装している:

```
1. Interactive prompt (detectPrompt) -> waiting
2. Thinking indicator (detectThinking) -> running
3. Input prompt (promptPattern) -> ready
4. Time-based heuristic -> ready (low confidence)
5. Default -> running (low confidence)
```

しかし、このファイルはアプリケーション内で使用されておらず（テストのみ）、Issue にも全く言及されていない。route.ts のロジック重複を解消する際に、このモジュールを共通関数として活用すべきかの検討が必要。

**推奨**: Issue の影響範囲セクションにこのファイルを追加し、共通関数化の候補として検討する。

---

### S3-002: response-poller.ts / claude-poller.ts の未言及

**ファイル**: `src/lib/response-poller.ts`, `src/lib/claude-poller.ts`

`detectPrompt()` を呼び出している2つのポーラーファイルが影響範囲に含まれていない。

`response-poller.ts` の `extractResponse()` 内での呼び出し箇所:
- 行248: `detectPrompt(cleanFullOutput)` -- Claude の全出力に対して呼び出し
- 行442: `detectPrompt(fullOutput)` -- 全行の結合出力に対して呼び出し
- 行556: `detectPrompt(result.response)` -- 抽出済みレスポンスに対して呼び出し

`claude-poller.ts` の呼び出し箇所:
- 行164: `detectPrompt(fullOutput)` -- 全出力に対して呼び出し
- 行232: `detectPrompt(result.response)` -- 抽出済みレスポンスに対して呼び出し

方式Bを選択した場合、これらの呼び出し箇所で有効なプロンプトを見逃すリスクがある。

**推奨**: 影響範囲にこれらのファイルを追加し、方式選択時にポーラーへの影響を分析する。

---

### S3-003: current-output/route.ts の未言及

**ファイル**: `src/app/api/worktrees/[id]/current-output/route.ts`, `src/hooks/useAutoYes.ts`

`current-output/route.ts`（行88）で `detectPrompt(cleanOutput)` を呼び出している。このAPIの結果（`isPromptWaiting`, `promptData`）は `useAutoYes` フックに伝播し、クライアント側の自動応答トリガーとなる。

```
current-output API -> isPromptWaiting/promptData -> useAutoYes -> prompt-response API
```

このチェーンの入口である `detectPrompt()` の範囲変更は、自動応答の挙動全体に影響する。

**推奨**: 影響範囲にこれらのファイルを追加する。

---

### S3-004: prompt-response/route.ts の未言及

**ファイル**: `src/app/api/worktrees/[id]/prompt-response/route.ts`

`prompt-response API`（行75）では、プロンプト応答を送信する前に `detectPrompt()` で再検証を行っている（Issue #161 で追加されたレースコンディション防止）。この呼び出しは 5000 行分のキャプチャ出力に対して行われる。

方式B（内部範囲制限）を選択した場合、再検証で「末尾にプロンプトがない」と誤判定し、有効なプロンプトへの応答がブロックされる可能性がある。

**推奨**: 影響範囲に追加し、プロンプト再検証への影響を設計時に考慮する。

---

## should_fix 項目

### S3-005: 方式選択による影響ファイル差異の分析不足

Issue は detectPrompt() の検索範囲変更に3つの方式（A/B/C）を提示しているが、各方式の影響ファイル範囲が異なることの分析が不足している。

| 方式 | 変更ファイル | detectPrompt() 呼び出し元への影響 |
|------|------------|----------------------------------|
| A: route.ts側で切り出し | route.ts x2 のみ | 他の呼び出し元は影響なし |
| B: detectPrompt 内部制限 | prompt-detector.ts | 全8ファイルの呼び出し元に影響 |
| C: 末尾位置検証追加 | prompt-detector.ts | 全8ファイルの呼び出し元に影響 |

**推奨**: 各方式の影響ファイル一覧を設計方針書に明記する。

---

### S3-006: テスト影響範囲の記載不足

影響を受けるテストファイル一覧:

| テストファイル | 内容 | テスト数 |
|---------------|------|---------|
| `tests/unit/prompt-detector.test.ts` | detectPrompt 直接テスト | 約40件（Issue #161 回帰テスト含む） |
| `tests/unit/lib/auto-yes-manager.test.ts` | pollAutoYes thinking スキップテスト | 約25件 |
| `tests/unit/api/prompt-response-verification.test.ts` | プロンプト再検証テスト | 5件 |
| `src/lib/__tests__/status-detector.test.ts` | detectSessionStatus テスト | 約15件 |
| `src/lib/__tests__/cli-patterns.test.ts` | detectThinking テスト | 約15件 |

**推奨**: 受け入れ条件に具体的なテストファイル一覧と実行コマンドを明記する。

---

### S3-007: detectPrompt() への入力の前処理不一致

現状のコードベースで detectPrompt() に渡される入力が呼び出し箇所ごとに異なる:

| 呼び出し箇所 | 入力内容 |
|-------------|---------|
| route.ts (x2) | cleanOutput（全文） |
| status-detector.ts | lastLines（最後15行） |
| current-output/route.ts | cleanOutput（全文） |
| auto-yes-manager.ts | cleanOutput（全文） |
| prompt-response/route.ts | cleanOutput（5000行キャプチャ） |
| response-poller.ts | cleanFullOutput / fullOutput（全文） |
| claude-poller.ts | fullOutput / result.response |

**推奨**: 共通関数化の際に入力の前処理を統一する方針を定める。

---

### S3-008: detectThinking() の検索範囲不一致

detectThinking() の呼び出し箇所でも入力範囲が不一致:

| 呼び出し箇所 | 入力内容 |
|-------------|---------|
| route.ts (x2) | lastLines（最後15行の非空行） |
| auto-yes-manager.ts | cleanOutput（全文） |
| current-output/route.ts | lastSection（最後15行の非空行） |
| status-detector.ts | lastLines（最後15行） |

**推奨**: 統一すべきか、意図的な差異かを設計方針で明確にする。

---

### S3-009: UIコンポーネント側の間接的影響

API レスポンスの `isWaitingForResponse` / `isProcessing` フラグを参照する UI コンポーネント:

- `WorktreeDetailRefactored.tsx`（行107-126）: ヘッダーステータスの色とアイコン
- `WorktreeCard.tsx`（行31, 160-165）: カードのステータスドット
- `sidebar.ts` の `deriveCliStatus()`（行30-38）: サイドバーのCLI別ステータスドット
- `BranchListItem.tsx`: サイドバーの各ブランチ表示

**推奨**: 受け入れ条件にUI表示確認項目を追加する。

---

## nice_to_have 項目

### S3-010: claude-poller.ts の使用状況確認

`claude-poller.ts` はレガシーポーラーの可能性がある（`response-poller.ts` が同等機能を提供）。不要であれば修正対象から除外可能。

### S3-011: status-detector.ts の既存実装活用

`detectSessionStatus()` の既存実装を拡張して route.ts の共通関数として使用すれば、実装コストと既存テストの活用の両面で有利。

---

## detectPrompt() 全呼び出し箇所マップ

Issue の影響範囲に記載されたファイルに加え、以下が未記載の呼び出し箇所:

```
detectPrompt() の呼び出し元（全10ファイル）:
  [記載済み]
  - src/app/api/worktrees/route.ts           (行62)
  - src/app/api/worktrees/[id]/route.ts      (行62)
  - src/lib/auto-yes-manager.ts              (行290)
  - src/lib/prompt-detector.ts               (自身)

  [未記載 - 追加必要]
  - src/lib/status-detector.ts               (行80)
  - src/app/api/worktrees/[id]/current-output/route.ts  (行88)
  - src/app/api/worktrees/[id]/prompt-response/route.ts (行75)
  - src/lib/response-poller.ts               (行248, 442, 556)
  - src/lib/claude-poller.ts                 (行164, 232)
  - src/lib/logger.ts                        (import のみ、呼び出しなし)
```

---

## 影響フロー図

```
tmux buffer capture (100 lines)
    |
    v
[route.ts / [id]/route.ts]
    |-- detectPrompt(cleanOutput)     --> isWaitingForResponse
    |-- detectThinking(lastLines)     --> isProcessing
    |-- promptPattern.test(lastLines) --> ready
    |
    v
API Response: { isWaitingForResponse, isProcessing, sessionStatusByCli }
    |
    +---> [sidebar.ts] deriveCliStatus() --> BranchStatus
    +---> [WorktreeDetailRefactored.tsx] --> Header status display
    +---> [WorktreeCard.tsx] --> Card status dot

[current-output/route.ts]
    |-- detectThinking(lastSection)   --> thinking skip
    |-- detectPrompt(cleanOutput)     --> isPromptWaiting, promptData
    |
    v
API Response: { isPromptWaiting, promptData, lastServerResponseTimestamp }
    |
    +---> [useAutoYes.ts] --> auto-response trigger
              |
              v
         [prompt-response/route.ts]
              |-- detectPrompt(cleanOutput) --> re-verification
              |
              v
         sendKeys to tmux

[auto-yes-manager.ts] pollAutoYes()
    |-- detectThinking(cleanOutput)   --> thinking skip
    |-- detectPrompt(cleanOutput)     --> prompt detection
    |-- resolveAutoAnswer()           --> auto-response
    |
    v
sendKeys to tmux

[response-poller.ts / claude-poller.ts]
    |-- detectPrompt(fullOutput)      --> prompt as complete response
    |-- detectPrompt(result.response) --> classify response type
    |
    v
Save to DB + WebSocket broadcast
```

---

## 結論

Issue #180 の影響範囲は Issue に記載されている4ファイルよりも大幅に広い。`detectPrompt()` は10ファイルから呼び出されており、方式B/C を選択した場合は全てに影響する。特に以下の4つの未記載ファイル（S3-001〜S3-004）は must_fix として影響範囲への追加が必要:

1. `src/lib/status-detector.ts` -- 共通関数化の候補
2. `src/lib/response-poller.ts` -- プロンプト検出のポーラーパス
3. `src/app/api/worktrees/[id]/current-output/route.ts` -- 自動応答の入口
4. `src/app/api/worktrees/[id]/prompt-response/route.ts` -- プロンプト再検証

設計方針策定時に、方式選択（A/B/C）と各方式の影響ファイル範囲を明確にした上で、テスト戦略を立てることを推奨する。
