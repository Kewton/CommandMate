# Issue #473 Stage 1 通常レビュー報告書

## レビュー概要

| 項目 | 内容 |
|------|------|
| Issue | #473 feat: OpenCode TUI選択リストのキーボードナビゲーション対応 |
| ステージ | Stage 1: 通常レビュー（1回目） |
| レビュー日 | 2026-03-11 |
| レビュー観点 | 整合性・正確性（既存コード/ドキュメントとの照合） |

## サマリー

仮説検証で判明した「新規APIは不要」という誤りを中心に、バックエンド設計の不備、検出パターンの未定義、受け入れ基準の不足など、合計 **8件** の指摘を行った。

| 重要度 | 件数 |
|--------|------|
| must_fix | 3 |
| should_fix | 3 |
| nice_to_have | 2 |

must_fix の3件はいずれも実装設計に直接影響するため、Issue本文の修正が必要である。

---

## 指摘一覧

### must_fix（3件）

#### F001: 「新規APIは不要」の記述が誤り - sendSpecialKeys用の新規エンドポイントが必要

**該当箇所**: Issue本文 > 提案する解決策 > バックエンド セクション

**問題**: Issue本文に「新規APIは不要で、既存のspecial key送信インフラを流用可能」と記載されているが、これは事実と異なる。

- terminal API（`POST /api/worktrees/[id]/terminal`）は `sendKeys()` のみを使用（`route.ts:79`）
- `sendKeys(session, 'Up')` は文字列 "Up" をテキストとして送信するだけで、tmux の矢印上キーとは全く異なる動作
- `sendSpecialKeys()` は tmux の `send-keys` コマンドを引用符なしのキー名で実行し、実際の特殊キーを送信する（`tmux.ts:272`）
- prompt-response API は `sendPromptAnswer()` 経由だが、`isClaudeMultiChoice` 判定（`cliToolId === 'claude' && type === 'multiple_choice'`）を通過しない限り `sendSpecialKeys()` は呼ばれない

**改善提案**: 新規エンドポイント（例: `POST /api/worktrees/[id]/special-keys`）の設計を追加する。`{ cliToolId: string, keys: string[] }` を受け取り、バリデーション後に `sendSpecialKeys(sessionName, keys)` を呼び出す設計とする。

---

#### F002: prompt-response API の sendSpecialKeys 活用がフォールバックにならない旨の明記不足

**該当箇所**: Issue本文 > 技術的な参考情報 > 既存のAPI セクション

**問題**: prompt-response API が「sendSpecialKeysで矢印キー対応済み」と記載されているが、これは Claude の `multiple_choice` プロンプト専用ロジックである。`prompt-answer-sender.ts` の `isClaudeMultiChoice` 判定（L50-52）:

```typescript
const isClaudeMultiChoice = cliToolId === 'claude'
  && (promptData?.type === 'multiple_choice' || fallbackPromptType === 'multiple_choice')
  && /^\d+$/.test(answer);
```

OpenCode の `cliToolId` は `'opencode'` であり、この条件を満たさない。

**改善提案**: 既存APIセクションの prompt-response の説明に「Claude multiple_choice 専用、OpenCode TUI には適用不可」と注記を追加する。

---

#### F003: OpenCode TUI選択リストの検出パターンが cli-patterns.ts に未定義であることの明記不足

**該当箇所**: Issue本文 > 提案する解決策 > 検出方法（案）

**問題**: `cli-patterns.ts` の現行実装には OpenCode のファジー検索付き選択リストに対応するパターンが存在しない。現在定義済みの OpenCode パターン:

| パターン定数 | 検出対象 |
|-------------|---------|
| `OPENCODE_PROMPT_PATTERN` | `Ask anything...` |
| `OPENCODE_THINKING_PATTERN` | `Thinking:` |
| `OPENCODE_PROCESSING_INDICATOR` | `esc interrupt` |
| `OPENCODE_RESPONSE_COMPLETE` | 完了マーカー |

`status-detector.ts` の OpenCode 専用ロジック（L202-263）も処理中/完了のみ。選択リスト検出は未実装。

**改善提案**: (1) `cli-patterns.ts` に新規パターン定数を追加する旨を明記、(2) `status-detector.ts` に選択リスト検出分岐を追加する設計を記載。

---

### should_fix（3件）

#### F004: 新規APIエンドポイントに関する受け入れ基準が欠落

**該当箇所**: Issue本文 > 受け入れ基準

**問題**: フロントエンド側の受け入れ基準は揃っているが、バックエンドの新規APIに関する基準がない。

**改善提案**: 以下を追加:
- 新規 special-keys API が Up/Down/Enter/Escape を tmux セッションに送信できる
- 不正なキー名が拒否される
- 存在しないセッションに対するエラーハンドリング

---

#### F005: 新規エンドポイントのセキュリティ設計が未記載

**該当箇所**: Issue本文全体

**問題**: 既存の terminal API は Issue #393 のセキュリティハードニングにより4層防御を実装している。新規エンドポイントも同等の防御が必要だが、設計が記載されていない。

**改善提案**: keys 配列の最大長制限、isCliToolType() バリデーション、DB存在確認、セッション確認、ALLOWED_SPECIAL_KEYS ホワイトリスト検証を要件として明記する。

---

#### F006: OpenCode TUI選択リストの具体的な出力パターンが未定義

**該当箇所**: Issue本文 > 提案する解決策 > 検出方法（案）

**問題**: 検出方法の案は概念レベルであり、実際の tmux capture-pane 出力サンプルが記載されていない。既存パターンは全て具体的な文字列パターンに基づいている。

**改善提案**: 実装前の準備タスクとして、OpenCode `/models` 等の実行時の tmux 出力サンプル取得を明記する。

---

### nice_to_have（2件）

#### F007: キーボードショートカットの具体的なキーバインド定義が未記載

**該当箇所**: Issue本文 > フロントエンド セクション

**問題**: 「矢印キー直接送信」の記載があるが、ブラウザのスクロール動作との競合やフォーカス管理の方針が未定義。

---

#### F008: 他CLIツールへの汎用化に関する設計方針の整理

**該当箇所**: Issue本文 > スコープ外

**問題**: 新規エンドポイント自体は CLI ツール非依存の汎用設計にできる。検出パターンのみが OpenCode 固有であるという分離を明確にすると拡張が容易になる。

---

## 検証に使用したソースファイル

| ファイル | 確認内容 |
|---------|---------|
| `src/app/api/worktrees/[id]/terminal/route.ts` | sendKeys() のみ使用を確認（L79） |
| `src/lib/tmux.ts` | sendKeys() と sendSpecialKeys() の動作差異を確認（L210-282） |
| `src/lib/prompt-answer-sender.ts` | isClaudeMultiChoice 判定ロジックを確認（L50-52） |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | sendPromptAnswer() 経由の呼び出しを確認 |
| `src/lib/cli-patterns.ts` | OpenCode 関連パターン定義の範囲を確認 |
| `src/lib/status-detector.ts` | OpenCode 専用検出ロジックの範囲を確認（L202-263） |
| `src/app/api/worktrees/[id]/capture/route.ts` | capture API の構造を確認 |
