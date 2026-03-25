# Issue #545 レビューレポート（Stage 5）

**レビュー日**: 2026-03-25
**フォーカス**: 通常レビュー（2回目）
**イテレーション**: 2回目
**対象Issue**: Copilot-cliに対応したい

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

**総合評価**: 前回のStage 1（10件）およびStage 3（13件）で検出された全23件の指摘事項が全て適切に反映されている。must_fixレベルの問題は残存しておらず、Issueは実装可能な品質に達している。

---

## 前回指摘の対応状況

### Stage 1: 通常レビュー（1回目） - 全10件 resolved

| ID | 重要度 | ステータス | 概要 |
|----|--------|-----------|------|
| F1-001 | must_fix | resolved | D1-003レジストリパターン移行の延期方針を明記 |
| F1-002 | must_fix | resolved | cli/config/cli-tool-ids.tsを実装タスクに追加 |
| F1-003 | must_fix | resolved | assistant-response-saver.tsとresponse-poller.tsを追加 |
| F1-004 | should_fix | resolved | index.tsエクスポート方針を明確化 |
| F1-005 | should_fix | resolved | IImageCapableCLITool実装を条件付きに変更 |
| F1-006 | should_fix | resolved | コマンド形式の前提調査タスクを追加 |
| F1-007 | should_fix | resolved | MAX_SELECTED_AGENTS=4維持を明示的に決定 |
| F1-008 | should_fix | resolved | TUIレイアウト分析の前提調査を追加 |
| F1-009 | nice_to_have | resolved | CLAUDE.md更新タスクを追加 |
| F1-010 | nice_to_have | resolved | slash-commands.tsの対応方針を明確化 |

### Stage 3: 影響範囲レビュー（1回目） - 全13件 resolved

| ID | 重要度 | ステータス | 概要 |
|----|--------|-----------|------|
| F3-001 | must_fix | resolved | claude-executor.tsを実装タスクに追加 |
| F3-002 | must_fix | resolved | response-poller.tsの全ディスパッチポイントを具体化 |
| F3-003 | must_fix | resolved | log-manager.tsを変更対象に追加 |
| F3-004 | should_fix | resolved | cmate-parser.ts/cmate-validator.tsを追加 |
| F3-005 | should_fix | resolved | worktree-status-helper.tsを関連コンポーネントに追加 |
| F3-006 | should_fix | resolved | response-extractor.tsを変更対象に追加 |
| F3-007 | should_fix | resolved | テスト影響範囲セクションを新設 |
| F3-008 | should_fix | resolved | savePendingAssistantResponse() TUI判定を明記 |
| F3-009 | should_fix | resolved | cli-patterns.tsの3つのswitch関数を明記 |
| F3-010 | should_fix | resolved | job-executor.tsを関連コンポーネントに追加 |
| F3-011 | nice_to_have | resolved | i18nタスクを具体化 |
| F3-012 | nice_to_have | resolved | docs/module-reference.mdを追加 |
| F3-013 | nice_to_have | resolved | command='gh'方針を反映 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### F5-001: log-manager.tsのPhase配置の不整合

**カテゴリ**: 正確性
**場所**: 実装タスク Phase 3

**問題**:
log-manager.tsは検出・クリーニングロジック（Phase 3）ではなく、ログ出力の表示名マッピングである。Phase 4（UI・関連処理）の方が性質として適切。

**推奨対応**:
log-manager.tsのタスクをPhase 4に移動するか、Phase 3の名称を「検出・クリーニング・レスポンス処理」等に変更する。

---

#### F5-002: log-manager.tsのツール名マッピングの既存問題

**カテゴリ**: 完全性
**場所**: 実装タスク Phase 3 / log-manager.ts

**問題**:
`log-manager.ts` line 94のツール名マッピングは claude/codex/Gemini CLI の3ツールのみ対応しており、vibe-localとopencodeも既に未対応。copilot追加時にcopilotケースのみ追加すると、既存の不整合が残る。

**証拠**:
```typescript
// line 94
const toolName = cliToolId === 'claude' ? 'Claude Code' : cliToolId === 'codex' ? 'Codex CLI' : 'Gemini CLI';
// line 104
logContent += `### ${cliToolId === 'claude' ? 'Claude' : cliToolId === 'codex' ? 'Codex' : 'Gemini'}\n\n`;
```

**推奨対応**:
Phase 3のlog-manager.tsタスクに「CLI_TOOL_DISPLAY_NAMESの利用を検討（vibe-local/opencodeも未対応のため一括修正が望ましい）」の注記を追加する。

---

#### F5-003: 変更対象ファイルと関連コンポーネントの分類基準の不一致

**カテゴリ**: 整合性
**場所**: 影響範囲 / 変更対象ファイル・関連コンポーネント

**問題**:
`response-extractor.ts` は「条件付き」と注記されつつ変更対象テーブルに含まれ、`worktree-status-helper.ts` は同様に「前提調査結果に基づき判断」とされつつ関連コンポーネントに分類されている。分類基準が不明確。

**推奨対応**:
分類基準を明記するか、条件付きファイルの配置を統一する。

---

### Nice to Have（あれば良い）

#### F5-004: レビュー履歴の完全性

**カテゴリ**: 完全性
**場所**: レビュー履歴セクション

**問題**:
Stage 2（反映）とStage 4（反映）の記録がレビュー履歴に含まれていない。

**推奨対応**:
反映フェーズの記録を追加する（例: 「Stage 2: 通常レビュー指摘反映 - 全10件applied」）。

---

#### F5-005: 前提調査タスクの完了判定基準

**カテゴリ**: 明確性
**場所**: 前提調査タスク

**問題**:
4つの調査項目に完了基準が明記されていない。

**推奨対応**:
各調査項目に「完了条件」を追記する。

---

## 参照ファイル

### コード
- `src/lib/log-manager.ts`: ツール名マッピングのハードコード（line 94, 104, 140）
- `src/lib/response-extractor.ts`: 条件付き変更対象として記載
- `src/lib/session/worktree-status-helper.ts`: 関連コンポーネントとして記載

### ドキュメント
- Issue #545 本文: 全23件の前回指摘が反映済み
