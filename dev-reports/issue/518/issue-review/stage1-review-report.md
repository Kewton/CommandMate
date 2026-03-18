# Issue #518 Stage 1 Review Report

## Review Summary

| Stage | Focus | Findings |
|-------|-------|----------|
| Stage 1 | 通常レビュー（Consistency & Correctness） | 11件 |

| Severity | Count |
|----------|-------|
| must_fix | 3 |
| should_fix | 6 |
| nice_to_have | 2 |

---

## Must Fix (3件)

### F1-01: ls コマンドのステータス値が実装と不一致

**Category**: 既存コードとの不一致

Issue では `ls` コマンドの出力項目のステータスを `idle/running/prompt` と記載しているが、実際の `SessionStatus` 型は `'idle' | 'ready' | 'running' | 'waiting'` であり `prompt` は存在しない。

さらに、`GET /api/worktrees` のレスポンスではステータスは `isSessionRunning` / `isWaitingForResponse` / `isProcessing` の3つの boolean 値で返される。単一の文字列ステータスではない。

**根拠**: `src/lib/detection/status-detector.ts` line 35: `export type SessionStatus = 'idle' | 'ready' | 'running' | 'waiting';`
`src/lib/session/worktree-status-helper.ts`: `WorktreeSessionStatus` は3つのbooleanフィールドで構成。

**修正案**: ステータス値を `idle/ready/running/waiting` に修正し、3つのboolean値からステータス文字列を導出するロジックの仕様を明記する。

---

### F1-02: wait コマンド exit 2 時の promptData 形式が実装と不一致

**Category**: 既存コードとの不一致

Issue の exit 2 時 stdout JSON:
```json
{
  "promptType": "yes_no",
  "question": "Do you want to proceed? [Y/n]",
  "options": ["yes", "no"],
  "defaultOption": "yes"
}
```

実際の `PromptData` 型（`src/types/models.ts`）:
- フィールド名は `type`（`promptType` ではない）
- `YesNoPromptData.options` は `['yes', 'no']`（文字列配列）で一致するが
- `MultipleChoicePromptData.options` は `MultipleChoiceOption[]`（`{number, label, isDefault?, requiresTextInput?}` のオブジェクト配列）

**修正案**: フィールド名を `type` に修正し、MultipleChoice の場合の options 形式も正しく記載する。

---

### F1-03: Auto-Yes の duration 形式が API と不一致

**Category**: 既存コードとの不一致

Issue では `--duration 1h, 3h, 8h` と人間可読文字列を指定する仕様だが、`POST /api/worktrees/:id/auto-yes` API は `duration` をミリ秒数値（`3600000, 10800000, 28800000`）で受け取る（`src/config/auto-yes-config.ts` の `ALLOWED_DURATIONS`）。

CLI 側の変換ロジックが必要だが仕様に明記されていない。また指定可能な値が3つのみであることも記載がない。

**修正案**: CLI 変換マッピング（`1h` -> `3600000` 等）を明記し、指定可能な値が `1h/3h/8h` の3つのみであることを追記する。

---

## Should Fix (6件)

### F1-04: ExitCode enum との衝突

既存の `ExitCode` enum（`src/cli/types/index.ts`）では `1=DEPENDENCY_ERROR`, `2=CONFIG_ERROR`, `3=START_FAILED` と定義されている。`wait` コマンドが提案する `1=エラー終了`, `2=プロンプト検出`, `3=LLM/ネットワークエラー` は意味が異なり、同一 CLI 内で終了コードの意味が不統一になる。

**修正案**: `wait` コマンド固有の `WaitExitCode` を新設して区別するか、衝突しない値域を使用する。

---

### F1-05: wait コマンドの exit 3（エラー検出）の実装仕様が不足

`current-output` API にはエラー種別フィールドがない。「ターミナル出力の文字列マッチで実装」とあるが、具体的なマッチパターンが定義されていない。

**修正案**: 検出対象パターンを具体的に定義するか、Phase 1 ではスコープ外とする。

---

### F1-06: 認証トークンの扱いが未記載

サーバーが `--auth` で認証有効化されている場合、CLI コマンドの REST API 呼び出しに認証ヘッダーが必要だが、その取得・送信方法が記載されていない。

**修正案**: `CM_AUTH_TOKEN` 環境変数や `--token` オプション等の認証連携仕様を追加する。

---

### F1-07: respond / prompt-response ルートの二重存在が未整理

`/respond`（messageId必須、DB連携）と `/prompt-response`（軽量、DB不要）の2ルートが存在する。CLI が `prompt-response` を使う判断の根拠が記載されていない。

**修正案**: `prompt-response` を選択した理由（messageId不要でCLI向き）を明記する。

---

### F1-08: ls --branch フィルターの実装方式が不明

`GET /api/worktrees` API にはブランチ名フィルターがない（`repository` フィルターのみ）。CLI 側でフィルタリングするのか API を拡張するのか不明。

**修正案**: CLI 側で全取得後フィルタリングする方式を明記する。

---

### F1-09: ls コマンドの N+1 API 呼び出し問題

Issue では `GET /api/worktrees` + `GET /api/worktrees/:id/current-output` と記載しているが、`GET /api/worktrees` は既に `detectWorktreeSessionStatus()` でステータス情報を含めて返している。`current-output` の追加呼び出しは冗長。

**修正案**: `GET /api/worktrees` のレスポンスのみで `ls` コマンドを実装する設計に修正する。

---

## Nice to Have (2件)

### F1-10: wait --on-prompt human の受け入れテスト方法が不明

UI 操作を含むため自動テストが困難。テスト方法の区分（自動/手動）が未記載。

### F1-11: エントリポイント記述の小さな誤り

`dist/cli/index.ts` -> `dist/cli/index.js` に修正すべき（ビルド後はJSファイル）。

---

## Overall Assessment

Issue #518 は CLI コマンド群の全体設計として骨格は明確であり、コマンド体系・オプション設計は適切である。しかし、既存の API レスポンス形式や型定義との不一致が3箇所（must_fix）あり、このまま実装すると CLI の出力が実際の API レスポンスと合わない問題が発生する。

特に以下の点は実装前に修正が必要:
1. ステータス値の不一致（`prompt` -> `waiting`）と、ステータスがboolean3値で返される構造の把握
2. `PromptData` のフィールド名・構造の不一致
3. `duration` のミリ秒変換仕様の明記

認証対応（F1-06）と N+1 問題（F1-09）も設計品質に関わるため、should_fix として早期対応を推奨する。
