# Issue #545 レビューレポート

**レビュー日**: 2026-03-25
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3（Stage 1 通常レビュー適用済み）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 7 |
| Nice to Have | 3 |

Issue の影響範囲テーブルには12ファイルが記載されているが、コードベース調査の結果、追加で少なくとも8ファイルが直接影響を受けることが判明した。特に `claude-executor.ts`（スケジュール実行）、`log-manager.ts`（ログ表示名）、`response-poller.ts`（完了判定ロジック全体）の影響が記載から漏れている。

---

## Must Fix（必須対応）

### F3-001: claude-executor.ts の ALLOWED_CLI_TOOLS と buildCliArgs() が影響範囲に記載されていない

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/session/claude-executor.ts`

**問題**:
`src/lib/session/claude-executor.ts` には `ALLOWED_CLI_TOOLS`（Set型ホワイトリスト、line 37）と `buildCliArgs()`（switch文、line 100-120）がある。`ALLOWED_CLI_TOOLS` に `'copilot'` を追加しないと、スケジュール実行時に `Invalid CLI tool` エラーが発生する。`buildCliArgs()` にも copilot 用の case（`gh copilot suggest` 等のサブコマンド形式）が必要。

**証拠**:
```typescript
// line 37
export const ALLOWED_CLI_TOOLS = new Set(['claude', 'codex', 'gemini', 'vibe-local', 'opencode']);

// line 158-159: cliToolId をそのままコマンド名に使用
const child = execFile(cliToolId, args, ...);
```

**推奨対応**:
影響範囲テーブルに `src/lib/session/claude-executor.ts` を追加。copilot は `gh` コマンドのサブコマンドであるため、`execFile` に渡すコマンド名が `'copilot'` ではなく `'gh'` になる点も考慮が必要。

---

### F3-002: response-poller.ts 内の複数の cliToolId 分岐ポイントが影響範囲で過小評価

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/polling/response-poller.ts`

**問題**:
Issue では「レスポンスクリーニングif-elseチェーンにcopilotケース追加」と記載されているが、実際には `response-poller.ts` 内に以下の分岐がある:

1. `findRecentUserPromptIndex` のツール別パターン（line 305-327）
2. 早期プロンプト検出の `claude || codex` 分岐（line 344）
3. `isCodexOrGeminiComplete` 等の完了判定ロジック（line 372-375）
4. ツール別 stop condition（codex: line 395, gemini: line 401, opencode: line 407）
5. ツール別バナー検出（claude: line 435, gemini: line 471, opencode: line 489）
6. TUI accumulator の opencode 固有処理（line 605, 637, 697-708）
7. ツール別クリーニング dispatch（line 697-709）

copilot のインタラクションモデルに応じて、これらの多くに分岐追加が必要。

**推奨対応**:
影響範囲の記載を具体化し、前提調査後に各分岐での copilot の扱いを決定するタスクを追加する。

---

### F3-003: log-manager.ts のツール名マッピングが copilot 未対応

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/log-manager.ts`

**問題**:
`src/lib/log-manager.ts` の `saveConversationLog()`（line 94, 104）と `appendToLog()`（line 140）にハードコードされたツール名マッピングがある:

```typescript
const toolName = cliToolId === 'claude' ? 'Claude Code' : cliToolId === 'codex' ? 'Codex CLI' : 'Gemini CLI';
```

copilot を追加しないと、copilot のログに `Gemini CLI` と表示される不正な動作となる。

**推奨対応**:
影響範囲テーブルに追加。`CLI_TOOL_DISPLAY_NAMES` を使用するようリファクタリングするか、copilot ケースを三項演算子チェーンに追加する。

---

## Should Fix（推奨対応）

### F3-004: cmate-parser.ts と cmate-validator.ts の switch 文

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/cmate-parser.ts`, `src/lib/cmate-validator.ts`

CMATE.md スケジュール定義パーサーに、ツール別パーミッション検証のswitch文がある。copilot のパーミッションポリシー（おそらく gemini/vibe-local と同様に不要）を決定し、ケースを追加する必要がある。

---

### F3-005: worktree-status-helper.ts の captureLines 分岐

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/session/worktree-status-helper.ts`

opencode の場合は 200行、それ以外は 100行でキャプチャしている。copilot の TUI レイアウト次第で、同様の分岐が必要になる可能性がある。

---

### F3-006: response-extractor.ts の resolveExtractionStartIndex

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/response-extractor.ts`

5分岐の決定木（opencode用、codex用、バッファリセット用、スクロール境界用、通常）に copilot の分岐が必要か検討が必要。

---

### F3-007: 既存テストファイルへの影響が未記載

**カテゴリ**: テスト影響
**影響ファイル**: 5ファイル

以下のテストが CLI_TOOL_IDS 変更で影響を受ける:
- `tests/unit/cli-tools/types-cli-tool-ids.test.ts`
- `tests/unit/cli-tools/display-name.test.ts`
- `tests/unit/cli-tools/manager.test.ts`
- `tests/unit/cli/config/cross-validation.test.ts`
- `tests/unit/components/worktree/AgentSettingsPane.test.tsx`

Phase 5 のテストタスクに「既存テスト更新」を明記すべき。

---

### F3-008: assistant-response-saver.ts の opencode スキップロジック

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/assistant-response-saver.ts`

`savePendingAssistantResponse()` 内の opencode スキップ判定（line 236）に copilot が該当するか検討が必要。Issue では cleanCliResponse() の switch 文のみ記載されている。

---

### F3-009: cli-patterns.ts の内部関数への copilot ケース追加が不明確

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/detection/cli-patterns.ts`

Issue では `COPILOT_PROMPT_PATTERN` と `COPILOT_THINKING_PATTERN` の追加が記載されているが、`getCliToolPatterns()`、`getCliToolSkipPatterns()`、`buildDetectPromptOptions()` の switch 文へのケース追加が明示されていない。

---

### F3-010: job-executor.ts の model パラメータ処理

**カテゴリ**: 影響範囲
**影響ファイル**: `src/lib/job-executor.ts`

vibe-local 固有の model パラメータ渡しロジックがある。copilot は GitHub 側でモデル管理のため不要と想定されるが、関連コンポーネントとして記載しておくべき。

---

## Nice to Have（あれば良い）

### F3-011: i18n タスクの具体化

**カテゴリ**: i18n影響

locale ファイルは `{tool}` プレースホルダーを使用しており、`CLI_TOOL_DISPLAY_NAMES` の追加で自動対応される。i18n ファイル自体の変更が本当に必要かを明確化すべき。

---

### F3-012: docs/module-reference.md の更新

**カテゴリ**: 設定影響

CLAUDE.md に加え、`docs/module-reference.md` も copilot モジュール追加に伴い更新が必要。

---

### F3-013: gh copilot の execFile コマンド名の考慮

**カテゴリ**: セキュリティ

`claude-executor.ts` は `cliToolId` をそのまま `execFile` のコマンド名として使用する。copilot は `gh` コマンドのサブコマンドであるため、command を `'gh'` として扱う対応が必要。`CopilotTool.command = 'gh'` で対応可能だが、`claude-executor.ts` 側の整合性を確保する設計判断が必要。

---

## 影響範囲まとめ

### Issue に記載済みのファイル（12ファイル）

全て妥当。記載内容は正確。

### 追加で影響を受けるファイル（Issue 未記載）

| ファイル | 影響内容 | 重要度 |
|---------|---------|--------|
| `src/lib/session/claude-executor.ts` | ALLOWED_CLI_TOOLS + buildCliArgs() | Must Fix |
| `src/lib/log-manager.ts` | ツール名ハードコードマッピング | Must Fix |
| `src/lib/response-extractor.ts` | resolveExtractionStartIndex 分岐 | Should Fix |
| `src/lib/session/worktree-status-helper.ts` | captureLines 分岐 | Should Fix |
| `src/lib/cmate-parser.ts` | パーミッション検証 switch | Should Fix |
| `src/lib/cmate-validator.ts` | パーミッション検証 | Should Fix |
| `src/lib/job-executor.ts` | model パラメータ処理 | Should Fix |
| `docs/module-reference.md` | モジュール参照 | Nice to Have |

### 影響を受けるテストファイル（Issue 未記載）

| テストファイル | 影響理由 |
|--------------|---------|
| `tests/unit/cli-tools/types-cli-tool-ids.test.ts` | CLI_TOOL_IDS 変更 |
| `tests/unit/cli-tools/display-name.test.ts` | CLI_TOOL_DISPLAY_NAMES 変更 |
| `tests/unit/cli-tools/manager.test.ts` | CLIToolManager 初期化変更 |
| `tests/unit/cli/config/cross-validation.test.ts` | CLI/サーバー間整合性 |
| `tests/unit/components/worktree/AgentSettingsPane.test.tsx` | UI 選択肢変更 |

---

## 参照ファイル

### コード
- `src/lib/cli-tools/types.ts`: CLI_TOOL_IDS 定義（変更対象、Issue 記載済み）
- `src/lib/session/claude-executor.ts`: ALLOWED_CLI_TOOLS ホワイトリスト（未記載）
- `src/lib/polling/response-poller.ts`: 複数の cliToolId 分岐（過小評価）
- `src/lib/log-manager.ts`: ツール名ハードコード（未記載）
- `src/lib/detection/cli-patterns.ts`: 3つの switch 関数（部分的に記載）

### ドキュメント
- `docs/module-reference.md`: モジュール参照の更新（未記載）
