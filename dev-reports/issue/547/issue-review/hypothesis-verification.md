# Issue #547 仮説検証レポート

## 検証日時
- 2026-03-27

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | `src/lib/slash-commands.ts` にCopilotのデフォルトスラッシュコマンド定義が不足 | Confirmed | Copilot固有のデフォルトコマンド（`/model`等）の定義が存在しない |
| 2 | `src/lib/detection/cli-patterns.ts` にCopilotの選択ウィンドウ検出パターンが不足 | Confirmed | Copilot用のSELECTION_LIST_PATTERNが未定義 |
| 3 | `src/lib/cli-tools/copilot.ts` に選択ウィンドウ対応が不足 | Partially Confirmed | copilot.tsには選択ウィンドウ用ロジックがないが、対応すべきはstatus-detector.tsとcli-patterns.ts側 |

## 詳細検証

### 仮説 1: slash-commands.tsにCopilotのデフォルトスラッシュコマンド定義が不足

**Issue内の記述**: 「src/lib/slash-commands.ts: Copilot CLIのデフォルトスラッシュコマンド定義追加」

**検証手順**:
1. `src/lib/slash-commands.ts` を全文確認
2. `src/lib/command-merger.ts` の `filterCommandsByCliTool()` を確認

**判定**: Confirmed

**根拠**:
- `slash-commands.ts` にはファイルベースのコマンドローダーのみ存在（`.claude/commands/`, `.claude/skills/`, `.codex/skills/`, `.codex/prompts/`）
- Copilot CLI固有のビルトインコマンド（`/model`等）のハードコード定義は存在しない
- `filterCommandsByCliTool()` は `cliTools` 配列を持たないコマンドをclaude-onlyとして扱うため、現状Copilotタブにはclaude用コマンドが一切表示されない
- 他のCLIツール（Codex）は `.codex/skills/` と `.codex/prompts/` からコマンドをロード可能だが、Copilotにはそのような仕組みがない

**Issueへの影響**: Copilot用のデフォルトスラッシュコマンド（`/model`等）を定義するメカニズムが必要

### 仮説 2: cli-patterns.tsにCopilotの選択ウィンドウ検出パターンが不足

**Issue内の記述**: 「src/lib/detection/cli-patterns.ts: Copilotの選択ウィンドウ検出パターン追加」

**検証手順**:
1. `src/lib/detection/cli-patterns.ts` でCopilot関連パターンを確認
2. `src/lib/detection/status-detector.ts` で選択ウィンドウ検出ロジックを確認

**判定**: Confirmed

**根拠**:
- `cli-patterns.ts` にはCopilot用の基本パターン（COPILOT_PROMPT_PATTERN, COPILOT_THINKING_PATTERN等）は定義済み（Issue #545で追加、L246-266）
- ただし`COPILOT_SELECTION_LIST_PATTERN`は**未定義**
- 他ツールにはOpenCode用の`OPENCODE_SELECTION_LIST_PATTERN`（L205）、Claude用の`CLAUDE_SELECTION_LIST_FOOTER`（L216）が存在
- `status-detector.ts` でもCopilotの選択リスト検出ロジックは未実装
  - Claude: L203でCLAUDE_SELECTION_LIST_FOOTERを使用
  - OpenCode: L288でOPENCODE_SELECTION_LIST_PATTERNを使用
  - Copilot: 対応なし

**Issueへの影響**: Copilot CLIの`/model`等で表示される選択ウィンドウのパターン定義とstatus-detectorでの検出ロジックが必要

### 仮説 3: copilot.tsに選択ウィンドウ対応が不足

**Issue内の記述**: 「src/lib/cli-tools/copilot.ts: 選択ウィンドウ対応」

**検証手順**:
1. `src/lib/cli-tools/copilot.ts` のCopilotTool実装を確認
2. 他CLIツール実装と比較

**判定**: Partially Confirmed

**根拠**:
- `copilot.ts` のCopilotTool実装はセッション管理（start/send/kill）のみで、選択ウィンドウ固有のロジックは含まない
- ただし、選択ウィンドウの検出は主に`cli-patterns.ts`（パターン定義）と`status-detector.ts`（検出ロジック）が担当
- `copilot.ts`自体に大きな変更は不要と思われるが、Copilot CLIのTUI構造（選択リストの表示形式）の理解は必要

**Issueへの影響**: 主な変更箇所はcli-patterns.tsとstatus-detector.tsであり、copilot.ts自体の変更は限定的な可能性がある

---

## Stage 1レビューへの申し送り事項

- 仮説3は「Partially Confirmed」: Issue記載の影響範囲ファイルに`copilot.ts`が含まれているが、実際には`status-detector.ts`が主要な変更対象である可能性が高い。影響範囲テーブルの見直しが必要
- Copilot CLIの実際のTUI出力パターン（`/model`実行時の選択リスト表示形式）の調査・確認が必要
- `slash-commands.ts` への変更方法として、ハードコードのデフォルトコマンド定義 vs Copilot固有のコマンドディレクトリの2つのアプローチがあり、設計判断が必要
