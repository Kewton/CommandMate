# Issue #368 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-25
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3
**対象Issue**: feat: CMATEタブにAgent設定タブを追加し、表示するコーディングエージェントを選択可能にする

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 6 |
| Nice to Have | 3 |

Stage 1レビュー後のIssue更新によりハードコード箇所の網羅性・DB設計方針・テスト受け入れ条件が大幅に改善された。しかし影響範囲分析の結果、switch文のdefaultフォールバック問題、sidebar型定義の制限、selected_agentsのバリデーション不足という3つのMust Fix事項が新たに特定された。

---

## Must Fix（必須対応）

### F301: switch文のdefaultフォールバックによるvibe-localの暗黙的claude扱い（5箇所）

**カテゴリ**: 型安全性
**重大度**: must_fix

**問題**:

CLIToolTypeに`'vibe-local'`を追加しても、既存のswitch文はdefaultケースでフォールバックするため、TypeScriptコンパイラエラーにはならない。しかし、vibe-localが暗黙的にclaude扱いされる問題が以下5箇所で発生する:

| # | ファイル | 関数 | defaultの挙動 |
|---|---------|------|--------------|
| 1 | `src/lib/cli-patterns.ts` L140-153 | `detectThinking()` | claude thinkingパターンを使用 |
| 2 | `src/lib/cli-patterns.ts` L168-224 | `getCliToolPatterns()` | claude patternsを返却 |
| 3 | `src/lib/assistant-response-saver.ts` L190-200 | `cleanCliResponse()` | `output.trim()`のみ |
| 4 | `src/lib/claude-executor.ts` L86-92 | `buildCliArgs()` | claude引数（`-p`, `--output-format text`）を使用 |
| 5 | `src/components/worktree/MessageList.tsx` L69-78, L406-415 | `getToolName()` | 'Assistant'表示 |

**証拠**:
```typescript
// src/lib/claude-executor.ts L86-92
export function buildCliArgs(message: string, cliToolId: string, permission?: string): string[] {
  switch (cliToolId) {
    case 'codex':
      return ['exec', message, '--sandbox', permission ?? 'workspace-write'];
    case 'claude':
    default:
      return ['-p', message, '--output-format', 'text', '--permission-mode', permission ?? 'acceptEdits'];
  }
}
```

vibe-localの場合、claude用の`-p`引数が渡されるが、vibe-localのCLI仕様が全く異なる場合は致命的なバグとなる。

**推奨対応**:

各switch文にvibe-local用のcase分岐を明示的に追加する。変更対象ファイルとしてIssueに記載すべき:
- `src/lib/cli-patterns.ts`: `detectThinking()`, `getCliToolPatterns()`
- `src/lib/assistant-response-saver.ts`: `cleanCliResponse()`
- `src/lib/claude-executor.ts`: `buildCliArgs()`
- `src/components/worktree/MessageList.tsx`: `getToolName()` (2箇所)

将来のツール追加時に同様の問題を防ぐため、exhaustive switch guardの導入も検討:
```typescript
default: {
  const _exhaustive: never = cliToolId;
  throw new Error(`Unsupported CLI tool: ${_exhaustive}`);
}
```

---

### F302: sidebar.tsのSidebarBranchItem.cliStatusがclaude/codexに限定されている

**カテゴリ**: 影響ファイル
**重大度**: must_fix

**問題**:

`src/types/sidebar.ts` L60-63で`SidebarBranchItem.cliStatus`は以下のハードコード型定義:

```typescript
cliStatus?: {
  claude: BranchStatus;
  codex: BranchStatus;
};
```

`toBranchItem()`関数（L114-117）もclaude/codexのみ参照:

```typescript
cliStatus: {
  claude: deriveCliStatus(worktree.sessionStatusByCli?.claude),
  codex: deriveCliStatus(worktree.sessionStatusByCli?.codex),
},
```

この型定義ではgeminiもvibe-localも表示できない。`selected_agents`で選択されたツールに応じて動的にcliStatusを構築する必要があるが、現在の固定型では不可能。

**推奨対応**:

sidebar.tsの変更方針を具体化する:

- 方針A（selected_agents連動）: `cliStatus?: Partial<Record<CLIToolType, BranchStatus>>`
  - `toBranchItem()`にselected_agents引数を追加
  - 呼び出し元のAPI（`/api/worktrees/route.ts`, `/api/worktrees/[id]/route.ts`）も影響

- 方針B（全ツール格納、UI側でフィルタ）: `cliStatus?: Record<CLIToolType, BranchStatus>`
  - UI側でselected_agentsに基づいてフィルタ表示

いずれの方針かをIssueに明記すべき。

---

### F303: selected_agentsのJSONパース時のバリデーション戦略が未記載

**カテゴリ**: セキュリティ
**重大度**: must_fix

**問題**:

`selected_agents`カラムはJSON文字列としてSQLiteに保存される。DBからの読み取り時に`JSON.parse()`を実行するが、以下のリスクが存在:

1. 不正なJSON文字列によるJSON.parseエラー（アプリクラッシュ）
2. JSON配列ではなくオブジェクトや文字列が格納された場合
3. 配列要素がCLIToolTypeに含まれない不正な値（例: `'<script>alert(1)</script>'`）
4. 配列長が2を超える場合
5. 同一ツールIDが重複する場合

**推奨対応**:

パース+バリデーション関数の設計をIssueに記載:

```typescript
function parseSelectedAgents(raw: string | null): [CLIToolType, CLIToolType] {
  const DEFAULT: [CLIToolType, CLIToolType] = ['claude', 'codex'];
  if (!raw) return DEFAULT;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 2) return DEFAULT;
    if (!parsed.every(id => CLI_TOOL_IDS.includes(id))) return DEFAULT;
    if (parsed[0] === parsed[1]) return DEFAULT;
    return parsed as [CLIToolType, CLIToolType];
  } catch {
    return DEFAULT;
  }
}
```

PATCH API側でも同様のバリデーションを実施し、不正値の保存自体を防止する。

---

## Should Fix（推奨対応）

### F304: 既存テストの破損リスク: CLI_TOOL_IDS関連テスト8件が固定値アサーション

**カテゴリ**: テスト

**問題**:

CLI_TOOL_IDSに`'vibe-local'`を追加すると、以下の既存テストが確実に破損する:

| ファイル | 行 | 現在の値 | 変更後 |
|---------|-----|---------|--------|
| `tests/unit/cli-tools/types-cli-tool-ids.test.ts` | L21 | `toHaveLength(3)` | `toHaveLength(4)` |
| `tests/unit/cli-tools/types-cli-tool-ids.test.ts` | L32, L44 | `['claude', 'codex', 'gemini']` | `+ 'vibe-local'` |
| `tests/unit/cli-tools/types.test.ts` | L10, L18 | `['claude', 'codex', 'gemini']` | `+ 'vibe-local'` |
| `tests/unit/cli-tools/manager.test.ts` | L55, L99 | `toHaveLength(3)` | `toHaveLength(4)` |
| `tests/unit/session-cleanup.test.ts` | L35 | `toHaveBeenCalledTimes(3)` | `toHaveBeenCalledTimes(4)` |
| `tests/unit/session-cleanup.test.ts` | L47 | `toHaveBeenCalledTimes(3)` | `toHaveBeenCalledTimes(4)` |
| `tests/unit/session-cleanup.test.ts` | L121 | `toHaveBeenCalledTimes(9)` | `toHaveBeenCalledTimes(12)` |

**推奨対応**:

変更対象に上記テストファイルを明示的に追加。将来のツール追加に対する堅牢性を高めるため、`CLI_TOOL_IDS.length`を参照するアサーションへのリファクタリングを推奨。

---

### F305: selected_agents変更時のcli_tool_id自動更新ロジックのAPI設計が不明確

**カテゴリ**: DB後方互換性

**問題**:

Issueの設計方針で「cli_tool_idをselected_agentsの先頭のツールに自動更新する（推奨動作、実装時に検討）」と記載されているが、以下が不明確:

1. selected_agents更新は既存PATCH APIを拡張するのか、新規APIか
2. 自動更新はサーバーサイドかクライアントサイドか
3. cli_tool_id自動更新時のtmuxセッション停止・再起動の要否
4. `/api/worktrees/[id]/cli-tool` APIとの競合（race condition）

**推奨対応**:

API設計・セッション副作用・競合防止の方針をIssueの設計方針セクションに追加する。

---

### F306: selected_agents変更時の既存tmuxセッション・Auto-Yesポーラーへの影響が未定義

**カテゴリ**: セッション管理

**問題**:

selected_agents変更時（例: `['claude', 'codex']` -> `['claude', 'vibe-local']`）の以下の副作用が未定義:

- codexのtmuxセッションが実行中だった場合の扱い
- Auto-Yesポーラー・response-pollerの挙動
- 新ツールのセッション開始タイミング
- UI状態のリセット要否

**推奨対応**:

「selected_agents変更はUI表示のみに影響し、既存tmuxセッションの停止・再起動は行わない」等の方針を技術的考慮事項に追記する。

---

### F307: ALLOWED_CLI_TOOLSとbuildCliArgs()のvibe-local対応が実装可能性に依存

**カテゴリ**: スケジュール実行

**問題**:

`schedule-manager.ts`が`executeClaudeCommand()`を呼び出し、内部で`ALLOWED_CLI_TOOLS`チェックと`buildCliArgs()`が実行される。vibe-localをALLOWED_CLI_TOOLSに追加しても`buildCliArgs()`のdefaultがclaude引数を返すため不適切な引数が渡される。また、`execFile(cliToolId, args, ...)`の第1引数がcliToolIdであるため、vibe-localのコマンド名が`'vibe-local'`でない場合はロジック変更が必要。

**推奨対応**:

ALLOWED_CLI_TOOLSの拡張方針セクションにbuildCliArgs()対応・コマンド名解決の具体的方針を追加する。

---

### F308: ScheduleEntry.cliToolIdがstring型でCLIToolType制約がない

**カテゴリ**: 型安全性

**問題**:

`src/types/cmate.ts` L17で`ScheduleEntry.cliToolId`はstring型。同様に`claude-executor.ts`の`buildCliArgs()`、`executeClaudeCommand()`もstring型。CLIToolTypeに`'vibe-local'`を追加しても、型レベルの保護がない。

**推奨対応**:

本Issueのスコープ外として明示するか、型厳格化（`cliToolId: string -> CLIToolType`）をリファクタリング対象に含める。

---

### F309: models.tsの型変更がAPIレスポンス形式に影響

**カテゴリ**: 影響ファイル

**問題**:

`sessionStatusByCli`、`lastMessagesByCli`を`Record<CLIToolType, ...>`に変更すると、APIレスポンスのJSONに`vibe-local`キーが追加される。ハイフン付きキーはJavaScriptのドット記法（`obj.vibe-local`）ではアクセスできず、ブラケット記法（`obj['vibe-local']`）が必要。

**推奨対応**:

技術的考慮事項にハイフン付きキーのアクセス方法について注記を追加。`for...of CLI_TOOL_IDS`イテレーションパターンの使用を推奨。

---

## Nice to Have（あれば良い）

### F310: 既存ユーザーのDBマイグレーション時のデフォルト値とcli_tool_idの整合性

cli_tool_idが`'gemini'`の既存worktreeに対し、selected_agentsのデフォルト`['claude', 'codex']`が適用されると整合性ルールによりcli_tool_idが強制変更される可能性がある。Migration v18でcli_tool_idを考慮した初期値設定を推奨。

### F311: CLAUDE.mdの主要機能モジュール表にvibe-local関連の追加が必要

Issue完了後にvibe-local.ts、AgentSettingsPane.tsxの追加が必要。認識事項として記載。

### F312: MessageList.tsxのgetToolName()にvibe-local表示名のテストが必要

`getToolName()`が2箇所に重複定義されている点はDRY原則の観点からユーティリティ関数として共通化する好機。

---

## 影響ファイルマトリクス

以下にIssue #368で影響を受ける全ファイルを分類する:

### Issueに記載済みのファイル

| ファイル | 変更内容 | 状態 |
|---------|---------|------|
| `src/lib/cli-tools/types.ts` | CLI_TOOL_IDSにvibe-local追加 | 記載済み |
| `src/lib/cli-tools/vibe-local.ts` | 新規VibeLocalToolクラス | 記載済み |
| `src/lib/cli-tools/manager.ts` | VibeLocalTool登録 | 記載済み |
| `src/app/api/worktrees/route.ts` | ハードコード統一 | 記載済み |
| `src/app/api/worktrees/[id]/route.ts` | ハードコード統一 + sessionStatusByCli型 | 記載済み |
| 他9個のAPIルート | ハードコード統一 | 記載済み |
| `src/lib/log-manager.ts` | ハードコード統一 | 記載済み |
| `src/types/models.ts` | Record<CLIToolType, ...>変更 | 記載済み |
| `src/types/sidebar.ts` | CLIToolType依存確認 | 記載済み |
| `src/components/worktree/NotesAndLogsPane.tsx` | Agent SubTab追加 | 記載済み |
| `src/components/worktree/AgentSettingsPane.tsx` | 新規UI | 記載済み |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | selectedAgents動的化 | 記載済み |
| `src/lib/db-*.ts` | Migration v18 | 記載済み |
| `src/lib/claude-executor.ts` | ALLOWED_CLI_TOOLS拡張 | 記載済み |
| `locales/en/schedule.json` | i18nキー追加 | 記載済み |
| `locales/ja/schedule.json` | i18nキー追加 | 記載済み |

### Issueに未記載だが影響を受けるファイル（本レビューで特定）

| ファイル | 変更内容 | 重要度 |
|---------|---------|--------|
| `src/lib/cli-patterns.ts` | detectThinking(), getCliToolPatterns()にvibe-localケース追加 | Must Fix (F301) |
| `src/lib/assistant-response-saver.ts` | cleanCliResponse()にvibe-localケース追加 | Must Fix (F301) |
| `src/components/worktree/MessageList.tsx` | getToolName()にvibe-localケース追加（2箇所） | Must Fix (F301) |
| `tests/unit/cli-tools/types-cli-tool-ids.test.ts` | 固定値アサーション更新 | Should Fix (F304) |
| `tests/unit/cli-tools/types.test.ts` | 固定値アサーション更新 | Should Fix (F304) |
| `tests/unit/cli-tools/manager.test.ts` | 固定値アサーション更新 | Should Fix (F304) |
| `tests/unit/session-cleanup.test.ts` | 固定値アサーション更新 | Should Fix (F304) |

---

## 参照ファイル

### コード
- `src/lib/cli-tools/types.ts`: CLI_TOOL_IDS定義（single source of truth）
- `src/lib/cli-patterns.ts`: switch文のdefaultフォールバック箇所
- `src/lib/assistant-response-saver.ts`: cleanCliResponse()のswitch文
- `src/lib/claude-executor.ts`: ALLOWED_CLI_TOOLS、buildCliArgs()
- `src/components/worktree/MessageList.tsx`: getToolName()（2箇所重複）
- `src/types/sidebar.ts`: SidebarBranchItem.cliStatus型定義
- `src/types/models.ts`: sessionStatusByCli、lastMessagesByCli型定義
- `src/types/cmate.ts`: ScheduleEntry.cliToolIdの型定義
- `src/lib/schedule-manager.ts`: executeSchedule()のexecuteClaudeCommand()呼び出し
- `src/lib/session-cleanup.ts`: CLI_TOOL_IDSベースのクリーンアップ
- `src/lib/db-migrations.ts`: CURRENT_SCHEMA_VERSION = 17、Migration定義

### テスト
- `tests/unit/cli-tools/types-cli-tool-ids.test.ts`: CLI_TOOL_IDS長アサーション
- `tests/unit/cli-tools/types.test.ts`: CLIToolType値アサーション
- `tests/unit/cli-tools/manager.test.ts`: getAllTools/getAllToolsInfo長アサーション
- `tests/unit/session-cleanup.test.ts`: killSessionFn/stopResponsePolling呼び出し回数

### ドキュメント
- `CLAUDE.md`: 主要機能モジュール表（Issue完了後更新）
- `locales/en/schedule.json`: i18nキー追加先
- `locales/ja/schedule.json`: i18nキー追加先
