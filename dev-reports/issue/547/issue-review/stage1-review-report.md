# Issue #547 レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 通常レビュー（Consistency & Correctness）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 2 |
| **合計** | **6** |

---

## Must Fix（必須対応）

### F1-001: 影響範囲テーブルにstatus-detector.tsが欠落している

**カテゴリ**: 正確性（accuracy）
**場所**: Issue本文 - 影響範囲テーブル

**問題**:
Issueの影響範囲テーブルには `src/lib/cli-tools/copilot.ts` が「選択ウィンドウ対応」として記載されているが、選択ウィンドウ検出の主要な変更対象である `src/lib/detection/status-detector.ts` が含まれていない。

**根拠**:
- `status-detector.ts` L198-211: Claude用の選択リスト検出（`CLAUDE_SELECTION_LIST_FOOTER`使用）
- `status-detector.ts` L281-296: OpenCode用の選択リスト検出（`OPENCODE_SELECTION_LIST_PATTERN`使用）
- `status-detector.ts` L117-127: `STATUS_REASON`定数にCopilot用の追加が必要
- 仮説検証レポートでもこの点が指摘されている（仮説3: Partially Confirmed）

**推奨対応**:
影響範囲テーブルに以下を追加する:

| ファイル | 変更内容 |
|---------|--------|
| `src/lib/detection/status-detector.ts` | Copilotの選択ウィンドウ検出ロジック追加（STATUS_REASON定数追加含む） |

---

## Should Fix（推奨対応）

### F1-002: Copilot CLIの実際のTUI出力パターンに関する調査情報が不足

**カテゴリ**: 完全性（completeness）
**場所**: Issue本文全体

**問題**:
`cli-patterns.ts` に追加する正規表現パターンを定義するには、Copilot CLIが `/model` 実行時に実際にどのような形式で選択リストを表示するかの情報が必要である。現在のIssueにはこの情報が含まれていない。

**根拠**:
- OpenCode: ヘッダーテキスト `"Select model"` をマッチ（cli-patterns.ts L205）
- Claude: フッターテキスト `"Enter to select ... to navigate"` をマッチ（cli-patterns.ts L216）
- Copilot: パターン未定義

**推奨対応**:
`gh copilot` で `/model` を実行した際のtmux capture-pane出力サンプルをIssue本文に添付するか、設計ノートとして参照可能にする。

---

### F1-003: デフォルトスラッシュコマンドの定義方法に関する設計方針が未記載

**カテゴリ**: 完全性（completeness）
**場所**: Issue本文 - 影響範囲テーブル `src/lib/slash-commands.ts` の行

**問題**:
`slash-commands.ts` は現在ファイルベースのコマンドローダーのみで構成されており、ハードコードされたデフォルトコマンド定義の仕組みがない。Copilot用ビルトインコマンドをどのように追加するかの設計方針が示されていない。

**根拠**:
- `slash-commands.ts`: `.claude/commands/`, `.claude/skills/`, `.codex/skills/`, `.codex/prompts/` からのファイルロードのみ
- `command-merger.ts` L184-200: `filterCommandsByCliTool()` は `cmd.cliTools` が未定義のコマンドをclaude-onlyとして扱う
- Copilot用コマンドに `cliTools: ['copilot']` を設定する仕組みが必要

**推奨対応**:
以下のいずれかのアプローチを選択し、Issue本文に明記する:
1. `slash-commands.ts` にCopilotビルトインコマンドをハードコード
2. CLIツール別のデフォルトコマンド定義機構を新設
3. 既存のファイルベースの仕組みにCopilot用ディレクトリを追加

---

### F1-004: placeholder状態のパターンおよびIssue #545との関連が未記載

**カテゴリ**: 整合性（consistency）
**場所**: Issue本文全体

**問題**:
`cli-patterns.ts` のCopilot関連パターンはIssue #545でplaceholderとして追加されたものであり、コメントに「Placeholder - to be updated after Phase 1 TUI investigation」と明記されている（L243, L249, L255）。本Issue #547はこのplaceholder状態の解消が目的の一部であるが、Issue本文にこの経緯が記載されていない。

**推奨対応**:
Issue本文に「Issue #545で追加されたCopilotパターンのplaceholder状態を、実際のTUI出力に基づいて更新する」旨を追記し、#545を関連Issueとしてリンクする。

---

## Nice to Have（あれば良い）

### F1-005: 受け入れ条件にテストに関する項目がない

**カテゴリ**: 完全性（completeness）
**場所**: Issue本文 - 受入条件セクション

**問題**:
受け入れ条件は3つ記載されているが、テストコードに関する条件が含まれていない。パターンマッチの正確性を保証する単体テストは品質担保に重要。

**推奨対応**:
受け入れ条件に「新規追加パターンおよび検出ロジックの単体テストが追加されている」を追加する。

---

### F1-006: Copilotのデフォルトスラッシュコマンド一覧が未記載

**カテゴリ**: 完全性（completeness）
**場所**: Issue本文全体

**問題**:
`/model` のみが例示されているが、Copilot CLIが提供する全デフォルトスラッシュコマンドの一覧が記載されていない。

**推奨対応**:
`gh copilot` のヘルプや公式ドキュメントから利用可能なスラッシュコマンド一覧を調査し、Issue本文に記載する。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/slash-commands.ts` | スラッシュコマンドローダー - Copilotデフォルトコマンド定義の追加対象 |
| `src/lib/detection/cli-patterns.ts` | CLIパターン定義 - Copilot選択ウィンドウパターン追加対象（L246-266がplaceholder状態） |
| `src/lib/detection/status-detector.ts` | ステータス検出 - Copilot選択リスト検出ロジック追加が必要（Issueの影響範囲テーブルに未記載） |
| `src/lib/cli-tools/copilot.ts` | Copilot CLIツール実装 |
| `src/lib/command-merger.ts` | コマンドフィルタリング - filterCommandsByCliTool()がCopilotのコマンド表示に関連 |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクト構成・モジュール一覧の整合性確認 |
