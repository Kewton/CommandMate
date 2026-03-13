# Issue #473 仮説検証レポート

## 検証日時
- 2026-03-11

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `sendSpecialKeys()` が Up/Down/Enter/Escape に対応済み | Confirmed | `ALLOWED_SPECIAL_KEYS` に全4キーが含まれる（tmux.ts:236-240） |
| 2 | terminal API が `sendKeys()` を使用している | Confirmed | terminal/route.ts:79 で `await sendKeys(sessionName, command)` |
| 3 | prompt-response API が `sendSpecialKeys` で矢印キーに対応 | Partially Confirmed | `sendPromptAnswer()` 経由で `sendSpecialKeys()` を呼ぶが、Claude の multiple_choice 専用ロジックで OpenCode TUI ナビゲーションには未対応 |
| 4 | 新規APIは不要で既存インフラを流用可能 | Rejected | terminal API は `sendKeys()`（テキスト送信）のみ。tmux 特殊キー（Up/Down）を送るには `sendSpecialKeys()` を呼ぶ新規 API エンドポイントが必要 |
| 5 | 既存の `status-detector.ts` の仕組みを活用してOpenCode TUI選択リストを検出できる | Partially Confirmed | status-detector.ts に OpenCode 専用検出ロジックはあるが（L202-263）、ファジー検索付き選択リストを検出するパターンは未実装 |

---

## 詳細検証

### 仮説 1: `sendSpecialKeys()` が Up/Down/Enter/Escape に対応済み

**Issue内の記述**:
> 既存の `sendSpecialKeys()` 関数（`src/lib/tmux.ts`）が Up/Down/Enter/Escape に対応済み

**検証手順**:
1. `src/lib/tmux.ts` を確認
2. `ALLOWED_SPECIAL_KEYS` の内容を確認

**判定**: Confirmed

**根拠**:
```typescript
// src/lib/tmux.ts:236-240
const ALLOWED_SPECIAL_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right',
  'Enter', 'Space', 'Tab', 'Escape',
  'BSpace', 'DC',
]);
```
Up/Down/Enter/Escape は全て含まれている。

**Issueへの影響**: なし

---

### 仮説 2: terminal API が `sendKeys()` を使用している

**Issue内の記述**:
> 既存の terminal API（`POST /api/worktrees/[id]/terminal`）で `sendKeys()` が利用可能

**検証手順**:
1. `src/app/api/worktrees/[id]/terminal/route.ts` を確認

**判定**: Confirmed

**根拠**:
```typescript
// src/app/api/worktrees/[id]/terminal/route.ts:79
await sendKeys(sessionName, command);
```
`sendKeys()` を使用しテキストを送信している。

**Issueへの影響**: なし（事実確認のみ）

---

### 仮説 3: prompt-response API が `sendSpecialKeys` で矢印キーに対応

**Issue内の記述**:
> `POST /api/worktrees/[id]/prompt-response` - プロンプト応答（`sendSpecialKeys`で矢印キー対応済み）

**検証手順**:
1. `src/app/api/worktrees/[id]/prompt-response/route.ts` を確認
2. `src/lib/prompt-answer-sender.ts` を確認

**判定**: Partially Confirmed

**根拠**:
- prompt-response API は `sendPromptAnswer()` を呼び出す
- `sendPromptAnswer()` は Claude の `multiple_choice` プロンプトに対してのみ `sendSpecialKeys()` で矢印キーを送信する
- OpenCode TUI のファジー選択リストナビゲーションには対応していない（`isClaudeMultiChoice` 判定を通過しない）

**Issueへの影響**: 矢印キーインフラが存在することは正しいが、OpenCode TUI向けには流用できない

---

### 仮説 4: 新規APIは不要で既存のspecial key送信インフラを流用可能

**Issue内の記述**:
> 新規APIは不要で、既存のspecial key送信インフラを流用可能

**検証手順**:
1. terminal API の実装を確認
2. prompt-response API の条件分岐を確認

**判定**: Rejected

**根拠**:
- terminal API（`POST /api/worktrees/[id]/terminal`）は `sendKeys()` のみ使用。`sendKeys()` は通常のテキスト文字列を送信するため、tmuxの特殊キー（Up/Down/Enter の非テキスト版）は送れない
- `sendKeys(session, "Up")` と `sendSpecialKeys(session, ["Up"])` は全く異なる動作
  - 前者: 文字列 "Up" を端末に入力
  - 後者: tmux の矢印上キーを送信
- prompt-response API は Claude `multiple_choice` 専用ロジックで OpenCode TUI には適用不可
- **OpenCode TUI の Up/Down ナビゲーションを実装するには、`sendSpecialKeys()` を呼ぶ新規 API エンドポイント（例: `POST /api/worktrees/[id]/special-keys`）が必要**

**Issueへの影響**: Issue の「バックエンド: 新規APIは不要」の記述を修正すること。新規エンドポイントの追加が必要。

---

### 仮説 5: 既存 status-detector.ts を活用してOpenCode TUI選択リストを検出できる

**Issue内の記述**:
> 既存のステータス検出（`status-detector.ts`）の仕組みを活用

**検証手順**:
1. `src/lib/status-detector.ts` の OpenCode 専用検出ロジックを確認
2. ファジー選択リストの検出パターンが存在するか確認

**判定**: Partially Confirmed

**根拠**:
- `status-detector.ts` には OpenCode 専用の検出ロジックが存在する（L202-263）
- 検出対象: `OPENCODE_PROCESSING_INDICATOR`（処理中）、`OPENCODE_RESPONSE_COMPLETE`（完了）、thinking インジケーター
- **ファジー検索付き選択リスト（`/models` 等）の検出パターンは存在しない**
- `detectPrompt()` が OpenCode に対応しているが、選択リストを「プロンプト」として検出するパターンが存在するか別途確認が必要

**Issueへの影響**: 「既存の仕組みを活用」は方向性として正しいが、OpenCode の選択リスト検出には新しいパターン定義が必要

---

## Stage 1レビューへの申し送り事項

- **重要（Rejected）**: Issue の「バックエンド: 新規APIは不要」という記述は誤り。terminal API は `sendKeys()`（テキスト送信）のみで、tmux 特殊キー（Up/Down アロー）を送信する `sendSpecialKeys()` を呼ぶ新規エンドポイントが必要。実装設計に影響するため、Issue のバックエンド設計箇所を修正すること。
- **補足（Partially Confirmed）**: prompt-response API の `sendSpecialKeys` 活用はフォールバックにならない（Claude 専用ロジック）。専用エンドポイントの設計を Issue に追加すること。
- **補足（Partially Confirmed）**: status-detector.ts の活用方針は正しいが、OpenCode TUI 選択リストの検出パターン（`cli-patterns.ts`）の追加が必要である旨を Issue に明記すること。
