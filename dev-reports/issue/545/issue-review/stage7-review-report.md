# Issue #545 Stage 7: 影響範囲レビュー（2回目）

**レビュー日**: 2026-03-25
**レビュー対象**: Copilot-cliに対応したい
**フォーカス**: 影響範囲（Impact Scope）- 2nd iteration

---

## 前回指摘の対応状況

### Stage 3（影響範囲レビュー1回目）: 全13件 resolved

全てのmust_fix (3件)、should_fix (7件)、nice_to_have (3件) が適切に反映されている。特に以下の重要な反映を確認:

- `claude-executor.ts` の ALLOWED_CLI_TOOLS / buildCliArgs() が Phase 2 に追加済み
- `response-poller.ts` の記載が全ディスパッチポイントに具体化済み
- `log-manager.ts` が Phase 4 に移動し、CLI_TOOL_DISPLAY_NAMES リファクタリング検討が付記済み
- テスト影響範囲セクションが新設済み
- 変更対象ファイルと関連コンポーネントの分類基準が明確化済み

### Stage 5（通常レビュー2回目）: 全5件 resolved

should_fix (3件)、nice_to_have (2件) が全て反映済み。前提調査タスクの完了条件追記も確認。

---

## 影響範囲の網羅性調査

### 調査方法

codebase 全体で以下のパターンを検索し、cliToolId を参照する全ファイルを特定:

1. `switch` 文での cliToolId 分岐 (4ファイル)
2. `cliToolId === '...'` の直接比較 (12ファイル)
3. `CLI_TOOL_IDS` / `CLI_TOOL_DISPLAY_NAMES` / `CliToolId` の参照 (27ファイル)

### カバレッジ状況

| カテゴリ | ファイル数 | Issue記載 | 備考 |
|---------|-----------|----------|------|
| 変更対象ファイル | 17 | 全て記載 | 確実に変更が必要 |
| 関連コンポーネント | 6 | 全て記載 | 前提調査結果次第 |
| API route ファイル群 | ~10 | 記載不要 | CliToolType 型で自動対応 |
| 今回検出の未記載ファイル | 2 | 未記載 | 下記 F7-001, F7-002 |

---

## 新規検出事項

### F7-001 [should_fix] prompt-answer-sender.ts の cliToolId 分岐が未記載

**ファイル**: `src/lib/prompt-answer-sender.ts` (line 50)

`sendPromptAnswer()` に `cliToolId === 'claude'` の分岐があり、Claude Code 固有の multiple-choice プロンプト応答（カーソルナビゲーション方式）を処理している。copilot の yes/no 選択プロンプトの応答方式によっては、copilot 固有の分岐が必要になる可能性がある。

**推奨**: 関連コンポーネントセクションに追加。テキスト入力で応答可能であれば変更不要。

---

### F7-002 [should_fix] command-merger.ts の filterCommandsByCliTool() が未記載

**ファイル**: `src/lib/command-merger.ts` (line 194)

`filterCommandsByCliTool()` で `cliToolId === 'claude'` の分岐があり、cliTools 未定義のコマンドを claude 専用として扱う。Issue では `slash-commands.ts` が関連コンポーネントに記載されているが、`command-merger.ts` は記載されていない。

**推奨**: 関連コンポーネントセクションに追加。slash-commands.ts でコマンドの cliTools プロパティに 'copilot' を設定すればフィルタリングは自動動作する旨を注記。

---

### F7-003 [nice_to_have] detectThinking() switch 文の copilot ケース明示

**ファイル**: `src/lib/detection/cli-patterns.ts` (line 264-282)

`detectThinking()` の switch 文にも copilot ケースが必要。Issue では cli-patterns.ts への COPILOT_THINKING_PATTERN 追加は記載されているが、detectThinking() への case 追加は明示されていない。

**推奨**: Phase 3 タスクの記載に detectThinking() を追加。既存記載の延長線上にあるため漏れの可能性は低い。

---

### F7-004 [nice_to_have] response-poller.ts の isFullScreenTui 判定

**ファイル**: `src/lib/polling/response-poller.ts` (line 637)

`isFullScreenTui = cliToolId === 'opencode'` の判定があり、copilot が full-screen TUI の場合はこの判定にも含める必要がある。

**推奨**: Phase 3 の response-poller.ts 記載への注記追加。「TUI accumulator処理」の既存記載でカバーされている可能性もある。

---

## 総合評価

| 指標 | 値 |
|-----|-----|
| 新規指摘数 | 4件 |
| must_fix | 0件 |
| should_fix | 2件 |
| nice_to_have | 2件 |
| 前回指摘の解消率 | 100% (18/18件) |

Issue の影響範囲カバレッジは非常に高い水準に達している。cliToolId を参照する全ファイルのうち、変更対象 + 関連コンポーネントとして未記載なのは `prompt-answer-sender.ts` と `command-merger.ts` の2ファイルのみ。両ファイルとも前提調査結果に依存する条件付き影響であり、copilot が一般的なテキスト入力ベースのインタラクションを採用する場合は変更不要となる可能性が高い。

全7ステージのレビューを通じて、Issue は実装可能な水準を十分に満たしている。
