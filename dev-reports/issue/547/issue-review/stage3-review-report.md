# Issue #547 影響範囲レビューレポート

**レビュー日**: 2026-03-27
**フォーカス**: 影響範囲レビュー（Impact Scope）
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |
| **合計** | **8** |

Issue #547 は Copilot CLI のスラッシュコマンドと選択ウィンドウ検出を実装するものだが、影響範囲表に記載されていないファイルへの波及影響がある。特に current-output/route.ts の isSelectionListActive 判定への条件追加が欠落しており、これがなければ status-detector.ts で選択ウィンドウを検出しても UI に伝達されない。

---

## Must Fix（必須対応）

### F3-001: STATUS_REASON に Copilot 選択リスト用定数が必要

**カテゴリ**: missing_impact
**影響ファイル**: `src/lib/detection/status-detector.ts`, `src/app/api/worktrees/[id]/current-output/route.ts`

**問題**:
Issue の影響範囲表に status-detector.ts の変更として「STATUS_REASON定数追加含む」と記載があるが、具体的にどの定数を追加するかが明記されていない。現状 `STATUS_REASON` には `OPENCODE_SELECTION_LIST` と `CLAUDE_SELECTION_LIST` は存在するが `COPILOT_SELECTION_LIST` は存在しない。

`current-output/route.ts` (L108-110) の `isSelectionListActive` 判定が以下のように2つの定数のみをチェックしている:

```typescript
const isSelectionListActive = statusResult.status === 'waiting'
  && (statusResult.reason === STATUS_REASON.OPENCODE_SELECTION_LIST
    || statusResult.reason === STATUS_REASON.CLAUDE_SELECTION_LIST);
```

Copilot の選択ウィンドウを検出しても、この条件に合致しないため UI 側の NavigationButtons が表示されない。

**推奨対応**:
`STATUS_REASON` に `COPILOT_SELECTION_LIST: 'copilot_selection_list'` を追加し、`current-output/route.ts` の `isSelectionListActive` 判定条件に `STATUS_REASON.COPILOT_SELECTION_LIST` を追加する。

---

### F3-002: status-detector.ts に Copilot 選択リスト検出ロジックが必要

**カテゴリ**: missing_impact
**影響ファイル**: `src/lib/detection/status-detector.ts`, `src/lib/detection/cli-patterns.ts`

**問題**:
`detectSessionStatus()` 内に OpenCode 用（`OPENCODE_SELECTION_LIST_PATTERN` によるフルコンテンツスキャン）と Claude 用（`CLAUDE_SELECTION_LIST_FOOTER` による lastLines マッチ）の選択リスト検出分岐があるが、Copilot 用の検出分岐がない。

`cli-patterns.ts` にパターンを追加しても、`status-detector.ts` に対応する検出分岐がなければ選択ウィンドウは検出されない。Issue には「選択ウィンドウ検出ロジック追加」とあるが、以下が不明確:

- Copilot CLI のTUIレイアウト（OpenCode のようなパディング構造があるか）
- 検出アプローチ（ヘッダーテキストマッチか、フッターテキストマッチか）

**推奨対応**:
Copilot CLI の選択ウィンドウ形式に応じた検出パターン定数（例: `COPILOT_SELECTION_LIST_PATTERN`）を `cli-patterns.ts` に追加し、`status-detector.ts` の `detectSessionStatus()` に Copilot 用分岐を追加する。調査メモに TUI レイアウト調査項目を追加する。

---

## Should Fix（推奨対応）

### F3-003: current-output/route.ts が影響範囲に含まれていない

**カテゴリ**: missing_impact
**影響ファイル**: `src/app/api/worktrees/[id]/current-output/route.ts`

**問題**:
Issue の影響範囲表に `current-output/route.ts` が含まれていないが、選択ウィンドウ検出結果を API レスポンスの `isSelectionListActive` フラグとして返す箇所（L108-110）に Copilot 用の条件追加が必要。これがなければ、status-detector.ts で検出しても UI に伝達されない。

**推奨対応**:
影響範囲表に `src/app/api/worktrees/[id]/current-output/route.ts` を追加する。

---

### F3-004: response-cleaner.ts の cleanCopilotResponse() 更新が影響範囲に含まれていない

**カテゴリ**: missing_impact
**影響ファイル**: `src/lib/response-cleaner.ts`, `src/lib/detection/cli-patterns.ts`

**問題**:
`cleanCopilotResponse()` は `COPILOT_SKIP_PATTERNS` を使用しており、現在は `PASTED_TEXT_PATTERN` のみ。`cli-patterns.ts` のパターン更新に伴い `COPILOT_SKIP_PATTERNS` にも選択リスト関連パターンやその他の TUI アーティファクト除去パターンの追加が見込まれる。

**推奨対応**:
影響範囲に `response-cleaner.ts` を含めるか、変更不要であれば除外理由を明記する。

---

### F3-005: filterCommandsByCliTool() での Copilot コマンドフィルタリング

**カテゴリ**: missing_impact
**影響ファイル**: `src/lib/slash-commands.ts`, `src/lib/command-merger.ts`

**問題**:
`filterCommandsByCliTool()` の現在のロジックでは `cliTools` が `undefined` のコマンドは `claude-only` として扱われる（L193-194）。新規追加する Copilot ビルトインコマンドには `cliTools: ['copilot']` を設定する必要があるが、この点が Issue 内で明示されていない。

**推奨対応**:
Copilot ビルトインコマンド追加時に `cliTools: ['copilot']` を設定する旨を Issue に明記する。

---

### F3-006: テスト範囲が具体的に特定されていない

**カテゴリ**: test_coverage
**影響ファイル**: `tests/unit/cli-patterns-selection.test.ts`, `tests/unit/status-detector-selection.test.ts`, `tests/unit/cli-tools/copilot.test.ts`

**問題**:
受入条件に「新規追加パターンおよび検出ロジックの単体テストが追加されている」とあるが、具体的なテストファイルやテストケースが未記載。既存テストファイルは上記3ファイル。

**推奨対応**:
以下のテストケースを明記する:
1. `cli-patterns.ts` の新パターン定数のマッチングテスト
2. `status-detector.ts` の Copilot 選択リスト検出テスト
3. `slash-commands.ts` のビルトインコマンド取得テスト
4. `response-cleaner.ts` の `cleanCopilotResponse()` が更新パターンで正しく動作するテスト

---

## Nice to Have（あれば良い）

### F3-007: slash-commands.ts のキャッシュ機構への影響

**カテゴリ**: ripple_effect
**影響ファイル**: `src/lib/slash-commands.ts`

**問題**:
ハードコードされたビルトインコマンドを追加する場合、`commandsCache` / `skillsCache` とは別の管理が必要になる可能性がある。挿入ポイントが不明確。

**推奨対応**:
設計方針セクションに、ハードコードコマンドの挿入ポイントとキャッシュ戦略を明記する。

---

### F3-008: CLAUDE.md モジュールリファレンスの更新

**カテゴリ**: ripple_effect
**影響ファイル**: `CLAUDE.md`

**問題**:
実装完了後に `CLAUDE.md` の `slash-commands.ts` 説明を更新し、Copilot ビルトインコマンドローダー対応を反映する必要がある。

**推奨対応**:
実装完了後のドキュメント更新タスクとして記録する。

---

## 影響波及マップ

```
cli-patterns.ts (パターン定義)
  |
  +---> status-detector.ts (検出ロジック)
  |       |
  |       +---> current-output/route.ts (API レスポンス)
  |               |
  |               +---> WorktreeDetailRefactored.tsx (isSelectionListActive)
  |                       |
  |                       +---> NavigationButtons.tsx (UI 表示) [変更不要]
  |
  +---> response-cleaner.ts (COPILOT_SKIP_PATTERNS 経由)
  |
  +---> copilot.ts (COPILOT_PROMPT_PATTERN 使用)

slash-commands.ts (ビルトインコマンド追加)
  |
  +---> command-merger.ts (filterCommandsByCliTool) [変更不要だが cliTools 設定に注意]
  |
  +---> slash-commands/route.ts (API) [変更不要]
```

## 変更不要と判断したファイル

| ファイル | 理由 |
|---------|------|
| `src/components/worktree/NavigationButtons.tsx` | CLIToolType を受け取る汎用設計のため変更不要 |
| `src/app/api/worktrees/[id]/special-keys/route.ts` | isCliToolType() で汎用バリデーションしているため変更不要 |
| `src/lib/command-merger.ts` | filterCommandsByCliTool() は汎用ロジックのため変更不要（ただしコマンド側の cliTools 設定に注意） |
| `src/app/api/worktrees/[id]/slash-commands/route.ts` | 汎用ロジックのため変更不要 |

## 参照ファイル

### コード
- `src/lib/detection/status-detector.ts`: STATUS_REASON 定数 (L117-127), detectSessionStatus() 選択リスト検出 (L198-211)
- `src/app/api/worktrees/[id]/current-output/route.ts`: isSelectionListActive 判定 (L108-110)
- `src/lib/detection/cli-patterns.ts`: Copilot パターン定義 (L246-266)
- `src/lib/slash-commands.ts`: コマンドローダー
- `src/lib/command-merger.ts`: filterCommandsByCliTool() (L184-201)
- `src/lib/response-cleaner.ts`: cleanCopilotResponse() (L159-176)

### ドキュメント
- `CLAUDE.md`: モジュールリファレンス
