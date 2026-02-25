# Issue #368 レビューレポート

**レビュー日**: 2026-02-25
**フォーカス**: 通常レビュー（整合性・正確性）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 6 |
| Nice to Have | 3 |

Issue #368は機能要件と目的が明確であり、UIハードコード箇所やCLI_TOOL_IDS定義等の参照情報は正確である。しかし、変更影響範囲の見積もりの大幅な不足、DB設計の整合性未定義、vibe-localの技術詳細不足という3点のMust Fix事項がある。

---

## Must Fix（必須対応）

### F001: 変更対象ファイルの網羅性が大幅に不足

**カテゴリ**: 完全性
**場所**: Issue本文「変更対象」セクション全体

**問題**:
CLIToolType型に `'vibe-local'` を追加した場合に影響を受ける多数のファイルが変更対象に記載されていない。`['claude', 'codex', 'gemini']` のハードコード配列が以下14箇所以上に存在する:

| ファイル | 行 | 内容 |
|---------|-----|------|
| `src/app/api/worktrees/route.ts` | L31 | `allCliTools` 配列 |
| `src/app/api/worktrees/[id]/route.ts` | L34, L165 | `allCliTools` / `validCliTools` 配列 |
| `src/app/api/worktrees/[id]/send/route.ts` | L26 | `VALID_CLI_TOOL_IDS` |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L17 | `SUPPORTED_TOOLS` |
| `src/app/api/worktrees/[id]/interrupt/route.ts` | L63 | フォールバック配列 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | L23 | `ALLOWED_CLI_TOOLS` |
| `src/app/api/worktrees/[id]/cli-tool/route.ts` | L42 | `validToolIds` |
| `src/app/api/worktrees/[id]/start-polling/route.ts` | L37 | `validToolIds` |
| `src/app/api/worktrees/[id]/messages/route.ts` | L37 | インライン配列 |
| `src/lib/log-manager.ts` | L187, L221 | `toolIds` 配列 |
| `src/types/models.ts` | L55-77 | `sessionStatusByCli` / `lastMessagesByCli` 型 |

**推奨対応**:
変更対象ファイルセクションに「CLIToolType/CLI_TOOL_IDSのハードコード箇所の統一」カテゴリを追加し、上記ファイルを全て列挙する。理想的には `CLI_TOOL_IDS` からの動的生成に統一するリファクタリングを含めるべき。

---

### F002: cli_tool_idカラムとselected_agentsカラムの関係性が未定義

**カテゴリ**: 設計整合性
**場所**: Issue本文「3. エージェント選択の永続化」セクション

**問題**:
worktreesテーブルには既に `cli_tool_id` カラム（単一のCLIツールID、デフォルト `'claude'`）が存在する（Migration v7で追加）。新規 `selected_agents` カラム（JSON配列）との関係が未定義:

1. `cli_tool_id` の既存の役割は何か（アクティブセッション? スケジュール実行?）
2. `selected_agents` はUI表示用の2ツール選択のみか
3. `cli_tool_id` と `selected_agents` の値に整合性は必要か
4. 既存のPATCH API（`body.cliToolId`）および `/api/worktrees/[id]/cli-tool/route.ts` との関係

**証拠**:
```typescript
// src/lib/db-migrations.ts (Migration v7)
db.exec(`ALTER TABLE worktrees ADD COLUMN cli_tool_id TEXT DEFAULT 'claude';`);

// src/app/api/worktrees/[id]/route.ts L164-168
if ('cliToolId' in body) {
  const validCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];
  if (validCliTools.includes(body.cliToolId)) {
    updateCliToolId(db, params.id, body.cliToolId);
  }
}
```

**推奨対応**:
Issueに「cli_tool_idとselected_agentsの設計方針」セクションを追加し、それぞれの役割、整合性ルール、既存APIとの関係を明記する。

---

### F003: vibe-localのCLIツール実装に必要な技術的詳細が不足

**カテゴリ**: 技術的妥当性
**場所**: Issue本文「1. 新規コーディングエージェントの追加」セクション

**問題**:
vibe-localのtmuxセッション管理が「既存のclaude/codexと同様」と記載されているが、実装に必要な以下の情報が欠落している:

1. **実行コマンド名**: Pythonスクリプトの場合 `python vibe-local` なのか `vibe-local` コマンドとしてPATHに存在するのか
2. **起動引数**: インタラクティブモード/非インタラクティブモードの仕様
3. **buildCliArgs()対応**: `claude-executor.ts` の `buildCliArgs()` に vibe-local 用のcase分岐が必要か
4. **プロンプト検出パターン**: `response-poller.ts`, `prompt-detector.ts` での対応
5. **ステータス検出パターン**: `status-detector.ts` での対応
6. **isInstalled()検証**: `BaseCLITool.isInstalled()` は `which <command>` を使用しており、commandプロパティの値が必要

**証拠**:
仮説検証レポートでもvibe-localの実装詳細は「Unverifiable」と判定されている。

```typescript
// src/lib/cli-tools/base.ts L27-33 - commandプロパティが未確定
async isInstalled(): Promise<boolean> {
  try {
    await execAsync(`which ${this.command}`, { timeout: 5000 });
    return true;
  } catch { return false; }
}
```

**推奨対応**:
(A) vibe-localの技術調査フェーズを追加、(B) vibe-local追加を別Issueに分離、(C) 最低限command名・起動引数・対話/非対話モードの仕様を記載、のいずれかを選択。

---

## Should Fix（推奨対応）

### F004: クラス名のtypo: ViveLocalTool

**カテゴリ**: 正確性
**場所**: Issue本文「1. 新規コーディングエージェントの追加」変更対象

**問題**:
新規クラス名が「ViveLocalTool」と記載されているが、正しくは「VibeLocalTool」であるべき。ファイル名 `vibe-local.ts` やID `vibe-local` は正しい。

**推奨対応**:
「ViveLocalTool」を「VibeLocalTool」に修正する。

---

### F005: ALLOWED_CLI_TOOLS（claude-executor.ts）の拡張方針が曖昧

**カテゴリ**: 明確性
**場所**: Issue本文「4. UIの動的レンダリング」セクション、技術的考慮事項

**問題**:
「ALLOWED_CLI_TOOLS を全ツール対応に拡張」の具体的な意味が不明確。このSetはスケジュール実行（`claude -p` コマンド）で許可されるCLIツールのホワイトリストであり、UIの表示選択とは別の用途を持つ。

**証拠**:
```typescript
// src/lib/claude-executor.ts L32-33
export const ALLOWED_CLI_TOOLS = new Set(['claude', 'codex']);

// L85-93 - buildCliArgs()はclaude/codexの2パターンのみ
export function buildCliArgs(message: string, cliToolId: string, permission?: string): string[] {
  switch (cliToolId) {
    case 'codex': return ['exec', message, '--sandbox', permission ?? 'workspace-write'];
    case 'claude':
    default: return ['-p', message, '--output-format', 'text', '--permission-mode', permission ?? 'acceptEdits'];
  }
}
```

**推奨対応**:
ALLOWED_CLI_TOOLSの拡張対象ツール、各ツールの非インタラクティブ実行コマンド形式、UIのselected_agentsとの連動有無を明記する。

---

### F006: models.ts/sidebar.tsの型定義変更が変更対象に含まれていない

**カテゴリ**: 完全性
**場所**: Issue本文「変更対象」セクション

**問題**:
`src/types/models.ts` の Worktree interface 内 `sessionStatusByCli` と `lastMessagesByCli` が claude/codex/gemini のみをキーとしてハードコードされている。

**証拠**:
```typescript
// src/types/models.ts L73-77
sessionStatusByCli?: {
  claude?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  codex?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
  gemini?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
};
```

**推奨対応**:
変更対象に `src/types/models.ts` を追加し、`Record<CLIToolType, ...>` 等への変更を検討。

---

### F007: i18n翻訳ファイルの変更が変更対象に含まれていない

**カテゴリ**: 完全性
**場所**: Issue本文「変更対象」セクション

**問題**:
CMATEタブに「Agent」サブタブを追加する場合、i18n翻訳ファイルに新しいキーが必要。`NotesAndLogsPane` は `useTranslations('schedule')` を使用しており、現在 `notes` / `logs` キーのみ定義。

**推奨対応**:
変更対象に以下を追加:
- `locales/en/schedule.json`: `"agent"` キーおよび AgentSettingsPane 関連の翻訳キー
- `locales/ja/schedule.json`: 同上

---

### F008: 受け入れ条件にテスト関連の項目がない

**カテゴリ**: 受け入れ条件
**場所**: Issue本文「受け入れ基準」セクション

**問題**:
受け入れ条件に9項目あるが、テスト関連の条件が含まれていない。プロジェクトの品質担保ルール（CLAUDE.md）ではVitest（unit/integration）が必須チェックに含まれている。

**推奨対応**:
以下を受け入れ条件に追加:
- `[ ]` 新規コンポーネントのユニットテストが追加されている
- `[ ]` DBマイグレーションのテストが追加されている
- `[ ]` 既存テストが全てパスする（`npm run test:unit`）

---

### F009: CLIToolManagerへのvibe-local登録時の波及的影響の記述不足

**カテゴリ**: 設計整合性
**場所**: Issue本文「1. 新規コーディングエージェントの追加」セクション

**問題**:
`CLIToolManager` はSingletonパターンでconstructor内に3ツールを初期化している。Issueには `manager.ts` への登録は記載されているが、`getAllToolsInfo()` / `getInstalledTools()` を利用した各APIルートの動的化について言及がない。

**証拠**:
```typescript
// src/lib/cli-tools/manager.ts L23-29
private constructor() {
  this.tools = new Map();
  this.tools.set('claude', new ClaudeTool());
  this.tools.set('codex', new CodexTool());
  this.tools.set('gemini', new GeminiTool());
}
```

**推奨対応**:
manager.ts の説明を拡充し、登録だけでなく、各APIルート側のハードコード配列を `CLIToolManager.getAllTools()` 等で動的取得するリファクタリング方針を記載する。

---

## Nice to Have（あれば良い）

### F010: sessionNameのハイフン付きID対応確認結果の追記

**カテゴリ**: 明確性
**場所**: Issue本文「技術的考慮事項」セクション

`SESSION_NAME_PATTERN`（`/^[a-zA-Z0-9_-]+$/`）でハイフンは許容されるため、セッション名 `mcbd-vibe-local-{worktreeId}` は問題ない。確認済みである旨を追記すると実装者の疑問が減る。

---

### F011: CLI_TOOL_IDSハードコード箇所の統一リファクタリング提案

**カテゴリ**: 完全性

`['claude', 'codex', 'gemini']` が14箇所以上にハードコードされている。本Issueまたは事前Issueとして、`CLI_TOOL_IDS` を唯一の情報源（single source of truth）として一元化するリファクタリングを含めることを推奨。

---

### F012: DBマイグレーションのバージョン番号の明記

**カテゴリ**: 完全性

現在の `CURRENT_SCHEMA_VERSION = 17` のため、次のマイグレーションは version 18。明記しておくと実装時に迷いが減る。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/cli-tools/types.ts` | CLI_TOOL_IDS定義（変更対象）|
| `src/lib/cli-tools/manager.ts` | CLIToolManager Singleton（変更対象）|
| `src/lib/cli-tools/base.ts` | BaseCLITool抽象クラス（vibe-local継承元）|
| `src/lib/cli-tools/gemini.ts` | 既存ツール実装の参考（最もシンプル）|
| `src/lib/cli-tools/codex.ts` | 既存ツール実装の参考（起動手順が複雑）|
| `src/lib/claude-executor.ts` | ALLOWED_CLI_TOOLS / buildCliArgs（変更対象）|
| `src/components/worktree/WorktreeDetailRefactored.tsx` | UIハードコード箇所 L1795, L2081（変更対象）|
| `src/components/worktree/NotesAndLogsPane.tsx` | CMATEタブ SubTab定義（変更対象）|
| `src/lib/db-migrations.ts` | DBマイグレーション v17（拡張対象）|
| `src/types/models.ts` | Worktree interface 型定義（未記載の変更対象）|
| `src/app/api/worktrees/[id]/route.ts` | Worktree API（ハードコード箇所あり）|
| `src/lib/log-manager.ts` | ログ管理（ハードコード箇所あり）|

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | プロジェクトガイドライン、モジュール一覧 |
| `locales/en/schedule.json` | i18n翻訳（agent キー追加が必要）|
| `locales/ja/schedule.json` | i18n翻訳（agent キー追加が必要）|
