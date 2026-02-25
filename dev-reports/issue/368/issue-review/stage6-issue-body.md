> **Note**: このIssueは 2026-02-25 にStage 5（通常レビュー2回目）レビュー結果を反映して更新されました。
> 詳細: dev-reports/issue/368/issue-review/

## 概要

現在UIに表示されるコーディングエージェントは `claude` と `codex` の2つにハードコードされている。新たなコーディングエージェント（vibe-local等）への対応を強化するため、CMATEタブに「Agent」サブタブを追加し、ユーザーがUIに表示するエージェント2つを選択できるようにする。

## 背景

- 現在 `CLI_TOOL_IDS` には `['claude', 'codex', 'gemini']` が定義されているが、UIでは `claude` と `codex` のみハードコード表示
- [vibe-local](https://github.com/ochyai/vibe-local) など新しいコーディングエージェントが登場しており、対応の拡張が必要
- UIの制約上、ターミナルヘッダーに表示できるエージェントタブは**2つまで**（デスクトップ・モバイル共通）
- `['claude', 'codex', 'gemini']` のハードコード配列が14箇所以上のファイルに存在しており、ツール追加のたびに全箇所の手動更新が必要な状態（F001）

## 対応方針

### 推奨実装順序

以下の順序での実装を推奨する（F505）:

| 順序 | セクション | 内容 | 備考 |
|------|-----------|------|------|
| 1 | セクション0 | CLI_TOOL_IDS ハードコード箇所の一元化リファクタリング | **前提作業**。他セクションの基盤となるため最初に着手 |
| 2 | セクション3 | エージェント選択の永続化（DB・API） | UIコンポーネントが依存するAPIを先に整備 |
| 3 | セクション2 | CMATEタブに「Agent」サブタブ追加 | DB/APIが完成した上でUI実装 |
| 4 | セクション4 | UIの動的レンダリング | selected_agentsの永続化・取得が前提 |
| 5 | セクション1 | 新規コーディングエージェント（vibe-local）追加 | 技術調査フェーズはセクション0完了後に並行実施可能。実装はセクション0〜4完了後 |

> **注意**: セクション1の技術調査フェーズはセクション0の完了後、セクション2〜4の実装と並行して実施できる。ただし、vibe-localの実装自体はセクション0〜4の基盤が整った後に着手すること。

### 0. CLI_TOOL_IDS ハードコード箇所の一元化リファクタリング（前提作業）

現在 `['claude', 'codex', 'gemini']` が14箇所以上にハードコードされている。vibe-localの追加前に、これらを `CLI_TOOL_IDS` を唯一の情報源（single source of truth）として参照する形に統一する。

**ハードコード箇所一覧（要統一）:**
- `src/app/api/worktrees/route.ts` L31
- `src/app/api/worktrees/[id]/route.ts` L34, L165
- `src/app/api/worktrees/[id]/send/route.ts` L26
- `src/app/api/worktrees/[id]/current-output/route.ts` L17
- `src/app/api/worktrees/[id]/interrupt/route.ts` L63
- `src/app/api/worktrees/[id]/auto-yes/route.ts` L23
- `src/app/api/worktrees/[id]/cli-tool/route.ts` L42
- `src/app/api/worktrees/[id]/start-polling/route.ts` L37
- `src/app/api/worktrees/[id]/messages/route.ts` L37
- `src/lib/log-manager.ts` L187, L221
- `src/types/models.ts` L55-77（sessionStatusByCli, lastMessagesByCli）
- `src/app/api/worktrees/[id]/route.ts` L36-40（sessionStatusByCli型定義）

**リファクタリング方針:**
- 各APIルートおよびモデル型定義が `CLI_TOOL_IDS`（`src/lib/cli-tools/types.ts`）を直接importして使用する
- `src/types/models.ts` の `sessionStatusByCli`, `lastMessagesByCli` の型定義を `Record<CLIToolType, ...>` に変更する
- `src/lib/db.ts` の `getLastMessagesByCliBatch()` 戻り値型（現在 `{ claude?: string; codex?: string; gemini?: string }` とハードコード）も `Record<CLIToolType, string | undefined>` に合わせて更新する（F503）
- `src/types/sidebar.ts` のCLIToolType依存箇所も確認・更新する（下記 **sidebar.ts 型変更方針** 参照）
- これにより、今後ツールを追加する際は `CLI_TOOL_IDS` への追加のみで全箇所に反映される
- **exhaustive switchガードの導入**: 将来のツール追加時にswitch文の対応漏れを防ぐため、`default` ケースに `never` 型ガードの導入を推奨する（F301）

```typescript
// exhaustive switch guard パターン（推奨）
default: {
  const _exhaustive: never = cliToolId;
  // fallback logic
}
```

#### sidebar.ts 型変更方針（F302）

`src/types/sidebar.ts` の `SidebarBranchItem.cliStatus` は現在 `claude` / `codex` にハードコードされている:

```typescript
cliStatus?: {
  claude: BranchStatus;
  codex: BranchStatus;
};
```

**変更方針（Partial<Record> 方式）:**

```typescript
cliStatus?: Partial<Record<CLIToolType, BranchStatus>>;
```

- `toBranchItem()` 関数で `selected_agents` の2ツールのみステータスを格納する
- `toBranchItem()` に `selectedAgents` 引数を追加する設計変更が必要
- 呼び出し元のAPI（`/api/worktrees/route.ts`、`/api/worktrees/[id]/route.ts`）で `selected_agents` をDBから取得し `toBranchItem()` に渡す
- UI側（サイドバー）は `cliStatus` のキーを動的にイテレートして表示する

### 1. 新規コーディングエージェントの追加

`vibe-local` を4つ目のCLIツールとして追加する。

| 項目 | 内容 |
|------|------|
| ID | `vibe-local` |
| 特徴 | Ollama利用のオフラインAIコーディングエージェント |
| リポジトリ | https://github.com/ochyai/vibe-local |
| tmux連携 | 既存のclaude/codexと同様のtmuxセッション管理 |

**変更対象:**
- `src/lib/cli-tools/types.ts` - `CLI_TOOL_IDS` に `'vibe-local'` 追加
- `src/lib/cli-tools/vibe-local.ts` - 新規: **VibeLocalTool** クラス実装（BaseCLITool継承）
- `src/lib/cli-tools/manager.ts` - VibeLocalTool のインスタンス登録（`this.tools.set('vibe-local', new VibeLocalTool())`）
  - `getAllToolsInfo()`, `getInstalledTools()` は自動的にvibe-localを含むようになる
  - `stopPollers()` もvibe-local対応が必要

#### switch文のdefaultフォールバック対応（F301）

`CLIToolType` に `'vibe-local'` を追加しても、既存のswitch文は `default` ケースでフォールバックするため、TypeScriptコンパイラエラーにはならない。しかし、vibe-localが暗黙的にclaude扱いされる問題が以下5箇所で発生するため、明示的なcase分岐の追加が必要:

| ファイル | 関数 | 現在のdefault動作 | 必要な対応 |
|---------|------|-------------------|-----------|
| `src/lib/cli-patterns.ts` L140-153 | `detectThinking()` | claude thinkingパターンを使用 | vibe-local用thinkingパターンの定義 |
| `src/lib/cli-patterns.ts` L168-224 | `getCliToolPatterns()` | claude patternsを返却 | vibe-local用パターンの定義 |
| `src/lib/assistant-response-saver.ts` L190-200 | `cleanCliResponse()` | `output.trim()` のみ（クリーニングなし） | vibe-local用クリーニングロジックの定義 |
| `src/lib/claude-executor.ts` L86-92 | `buildCliArgs()` | claude引数（`-p`, `--output-format text`）を使用 | vibe-local用引数の定義（技術調査結果に依存） |
| `src/components/worktree/MessageList.tsx` L69-78, L406-415 | `getToolName()` | `'Assistant'` 表示 | `'Vibe Local'` 表示名の追加 |

> **注意**: `buildCliArgs()` のdefaultがclaude引数を返す点は、vibe-localの実行コマンドが異なる場合に致命的なバグとなる。技術調査フェーズの結果を踏まえて専用のcase分岐を必ず追加すること。

> **注意**: `MessageList.tsx` の `getToolName()` は2箇所に重複定義されている。DRY原則の観点からユーティリティ関数としての共通化を検討する（F312）。

#### vibe-local 技術調査フェーズ（実装前に実施）

vibe-localの実際のCLI仕様を調査し、以下を確定する必要がある:

| 調査項目 | 説明 | 確認方法 |
|---------|------|---------|
| 実行コマンド名 | `vibe-local` コマンドとしてPATHに存在するか、`python vibe-local` 形式か | `which vibe-local` / リポジトリのインストール手順確認 |
| 起動引数 | インタラクティブモード、非インタラクティブモード（`-p` 相当）の引数構造 | リポジトリのREADME・ヘルプコマンド確認 |
| プロンプト検出パターン | vibe-localのプロンプト文字列（`response-poller.ts`, `prompt-detector.ts` 用） | 実際の起動画面確認 |
| ステータス検出パターン | thinking/idle等のステータス判定用パターン（`status-detector.ts` 用） | 実際の動作確認 |
| インストール検証 | `BaseCLITool.isInstalled()` で使用する検証コマンド | `which` で検出可能か確認 |
| `buildCliArgs()` 対応 | `claude-executor.ts` の `buildCliArgs()` にvibe-local用case分岐が必要か | 非インタラクティブ実行モードの有無 |

> **注意**: 技術調査の結果、vibe-localの仕様が想定と大きく異なる場合は、vibe-localの追加を別Issueに分離し、本Issueはエージェント選択UI機能と `CLI_TOOL_IDS` のリファクタリング基盤のみに集中する判断もあり得る。

### 2. CMATEタブに「Agent」サブタブを追加

現在のCMATEタブ（Notes / Logs）に3つ目のサブタブ「Agent」を追加する。

**変更対象:**
- `src/components/worktree/NotesAndLogsPane.tsx` - SubTab型を `'notes' | 'logs' | 'agent'` に拡張し、`activeSubTab === 'agent'` の場合に `AgentSettingsPane` を描画する（F504）
- `src/components/worktree/AgentSettingsPane.tsx` - 新規: エージェント選択UI
- `locales/en/schedule.json` - `'agent'` キーおよびAgentSettingsPane関連のi18nキー追加
- `locales/ja/schedule.json` - 同上

**Agent サブタブのUI仕様:**
- 利用可能なエージェント一覧をリスト表示（claude, codex, gemini, vibe-local）
- チェックボックスまたはトグルで**2つまで**選択可能
- 2つ選択済みの状態で3つ目を選択しようとした場合は選択不可（disabled表示 + ツールチップ等で説明）
- 選択状態はWorktree単位で永続化（DB）

### 3. エージェント選択の永続化

選択状態をWorktree単位でDBに保存する。

**変更対象:**
- `src/lib/db-*.ts` 関連 - worktreesテーブルに `selected_agents` カラム追加（JSON文字列、デフォルト `'["claude","codex"]'`）
  - DBマイグレーション: **version 18**（現在のCURRENT_SCHEMA_VERSION = 17の次）
- `src/app/api/worktrees/[id]/route.ts` - 選択エージェントの取得・更新対応
- 新規API or 既存PATCH APIの拡張で選択状態を保存

#### cli_tool_id と selected_agents の設計方針

worktreesテーブルには既に `cli_tool_id` カラム（単一のCLIツールID、デフォルト `'claude'`、Migration v7で追加）が存在する。新たに `selected_agents` カラムを追加するにあたり、以下の設計方針を適用する:

| カラム | 役割 | 用途 |
|--------|------|------|
| `cli_tool_id` | **アクティブツール**: 現在セッションで使用中 / スケジュール実行で使用するCLIツール | セッション開始、スケジュール実行、`/api/worktrees/[id]/cli-tool` API |
| `selected_agents` | **表示ツール**: ターミナルヘッダーに表示する2つのCLIツール | AgentSettingsPane UI、ターミナルヘッダー描画 |

**整合性ルール:**
- `selected_agents` は常に2つのツールIDを持つJSON配列
- `cli_tool_id` が `selected_agents` に含まれない場合: ターミナルヘッダーでは `selected_agents` の2つが表示され、`cli_tool_id` は独立して動作する（既存のcli-tool切替APIの動作は変更しない）
- ユーザーが `selected_agents` を変更した際、現在の `cli_tool_id` が新しい `selected_agents` に含まれない場合は、`cli_tool_id` を `selected_agents` の先頭のツールに自動更新する（推奨動作、実装時に検討）
- 既存の `/api/worktrees/[id]/cli-tool` API（PATCH, body.cliToolId）は変更しない

**selected_agents 更新のAPI設計（F305）:**
- 既存の `PATCH /api/worktrees/[id]` に `selected_agents` フィールドを追加する（新規API不要）
- `cli_tool_id` の整合性チェックと自動更新はサーバーサイド（API内）で実施する
- `selected_agents` 更新と `cli_tool_id` 更新は同一トランザクション内で処理し、race conditionを防止する
- `cli_tool_id` が自動更新された場合、旧ツールのtmuxセッションは自動停止しない（ユーザーが手動で切り替えるまで現行セッションを維持）

**PATCHレスポンスのUI更新方針（F501）:**

現在の `PATCH /api/worktrees/[id]` レスポンス（route.ts L171-180）は `isSessionRunning`（単一ツール）のみを返し、`sessionStatusByCli` オブジェクトを含まない。一方、`GET /api/worktrees/[id]` レスポンス（L101-111）は `sessionStatusByCli` を含む。`selected_agents` を変更した直後のUIでは、新しい `selected_agents` に基づいたCLIステータス（サイドバーの `toBranchItem()` 等）が必要になるが、PATCHレスポンスには含まれない。

**方針: PATCHレスポンスは現行のまま維持し、既存ポーリング機構に依存する（方式B）。**

- `WorktreeDetailRefactored` の既存ポーリング機構が数秒以内にGET APIを再呼び出しするため、`selected_agents` 変更後のUI更新は自然に行われる
- PATCHレスポンスの拡張（`sessionStatusByCli` の追加）は不要で、API変更を最小限に抑えられる
- UIの即時反映が必要な場合は、クライアント側でPATCH成功後にGETを手動トリガーする楽観的更新パターンも選択肢として残す

**selected_agents 変更時のセッション管理（F306）:**
- `selected_agents` の変更はUI表示のみに影響し、既存tmuxセッションの停止・再起動は行わない
- `selected_agents` 外のツールのセッションは裏で継続動作し、次回 `selected_agents` に含まれた際に状態が表示される
- Auto-Yesポーラー / response-poller は `cli_tool_id`（アクティブツール）に基づいて動作するため、`selected_agents` 変更の直接的な影響は受けない
- ただし、`cli_tool_id` が自動更新される場合はセッション管理の切り替えが発生しうる点に注意

#### selected_agents のJSONバリデーション（F303）

`selected_agents` カラムはJSON文字列としてSQLiteに保存される。DB値は信頼できない外部入力として扱い、読み取り時に以下のバリデーションを実施する:

```typescript
// selected_agents バリデーション関数
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

**バリデーション観点:**
1. 不正なJSON文字列による `JSON.parse` エラー防止（try-catch）
2. JSON配列以外（オブジェクト、文字列等）の型チェック
3. 配列要素が `CLIToolType` に含まれない不正値の排除（XSSリスク軽減）
4. 配列長が2でない場合のフォールバック
5. 同一ツールIDの重複チェック
6. PATCH API側でも同様のバリデーションを実施し、不正値の保存自体を防止する

#### DBマイグレーション時のデフォルト値（F310）

Migration v18で `selected_agents` カラムを追加する際、既存worktreeの `cli_tool_id` を考慮して初期値を動的に設定する:

```sql
-- Step 1: カラム追加（デフォルト値なし）
ALTER TABLE worktrees ADD COLUMN selected_agents TEXT;

-- Step 2: cli_tool_idに応じて初期値を設定
UPDATE worktrees SET selected_agents =
  CASE
    WHEN cli_tool_id NOT IN ('claude', 'codex')
    THEN json_array(cli_tool_id, 'claude')
    ELSE '["claude","codex"]'
  END;
```

これにより、`cli_tool_id = 'gemini'` の既存worktreeでは `selected_agents = '["gemini","claude"]'` が設定され、整合性ルールによる `cli_tool_id` の強制変更を防止する。

### 4. UIの動的レンダリング

ハードコードされた `(['claude', 'codex'] as const)` を、DBから取得した選択状態に基づいて動的に描画する。

**変更対象:**
- `src/components/worktree/WorktreeDetailRefactored.tsx`
  - Line 1795付近（デスクトップ）: ハードコード配列を `selectedAgents` state に置換
  - Line 2081付近（モバイル）: 同上
  - **`activeCliTab` のデフォルト値を `selected_agents[0]` に連動させる（F502）**: 現在 `activeCliTab` は `useState<CLIToolType>('claude')` でハードコード初期化されている（L952）。`selected_agents` が `['gemini', 'codex']` の場合、初期表示で `'claude'` タブがアクティブになるが、`'claude'` は `selected_agents` に含まれておらず、ターミナルヘッダーに存在しないタブがアクティブになる矛盾が生じる。`selectedAgents` をpropsまたはAPIレスポンスから取得し、`useState<CLIToolType>(selectedAgents[0])` で初期化すること。`selectedAgents` がAPIレスポンスの非同期取得で遅延する場合は、`useEffect` で `selectedAgents` 変更時に `activeCliTab` を同期するパターンも検討する。
- `src/lib/claude-executor.ts` - `ALLOWED_CLI_TOOLS` の拡張（下記参照）

#### ALLOWED_CLI_TOOLS の拡張方針

`ALLOWED_CLI_TOOLS`（`claude-executor.ts`）はスケジュール実行（`claude -p` コマンド相当）で許可されるCLIツールのホワイトリストである。

**拡張方針:**
- **gemini**: 非インタラクティブ実行モードの有無を確認し、対応する場合は `ALLOWED_CLI_TOOLS` に追加。`buildCliArgs()` に gemini 用のcase分岐を追加する。
- **vibe-local**: 技術調査フェーズ（1.で定義）の結果に基づき判断。非インタラクティブ実行モードが存在する場合のみ追加。
- **UIのselected_agentsとの連動**: `ALLOWED_CLI_TOOLS` と `selected_agents` は**連動しない**。`ALLOWED_CLI_TOOLS` はスケジュール実行のセキュリティホワイトリストであり、UIの表示選択とは独立して管理する。

**vibe-local追加時の追加考慮事項（F307）:**
1. vibe-localを `ALLOWED_CLI_TOOLS` に追加する場合、`buildCliArgs()` にvibe-local専用のcase分岐が**必須**（defaultのclaude引数が使用されるため）
2. vibe-localが非インタラクティブ実行モードを持たない場合、`ALLOWED_CLI_TOOLS` には追加しない（スケジュール実行不可）
3. `executeClaudeCommand()` 内の `execFile(cliToolId, args, ...)` でcliToolId='vibe-local'を使用するため、PATH上に'vibe-local'コマンドが存在する必要がある（Pythonスクリプトの場合は 'python' コマンド経由が必要かもしれない）
4. `ScheduleEntry.cliToolId` が `string` 型（`CLIToolType` 制約なし）であるため、CMATE.mdに任意のツールIDを記載可能（`ALLOWED_CLI_TOOLS` でランタイム制限されるが型レベルの保護がない）

#### ScheduleEntry.cliToolId の型安全性（F308）

`src/types/cmate.ts` の `ScheduleEntry.cliToolId` は現在 `string` 型で定義されており、`CLIToolType` 制約がない。本Issueのスコープでは以下の対応方針とする:

- **本Issueのスコープ**: `ALLOWED_CLI_TOOLS` のランタイムバリデーションで十分とし、型厳格化は行わない
- **将来的なリファクタリング候補**: `ScheduleEntry.cliToolId: string` -> `CLIToolType`、`buildCliArgs()` / `executeClaudeCommand()` の引数型厳格化、`DEFAULT_PERMISSIONS` の型厳格化を別Issueで検討

## 受け入れ基準

### 機能要件
- [ ] CMATEタブに「Agent」サブタブが表示される
- [ ] Agentタブで利用可能なエージェント一覧（claude, codex, gemini, vibe-local）が表示される
- [ ] ユーザーが2つのエージェントを選択できる
- [ ] 3つ以上の選択はできない（UIで制御）
- [ ] 選択状態がWorktree単位で永続化される
- [ ] ターミナルヘッダーのエージェントタブが選択に応じて動的に切り替わる
- [ ] デフォルト値は `['claude', 'codex']`（既存動作の維持）
- [ ] デスクトップ・モバイル両方で正しく動作する
- [ ] vibe-localのtmuxセッション管理が他ツールと同様に機能する
- [ ] `selected_agents` のJSON読み取りバリデーションが実装されている（不正値でアプリがクラッシュしない）
- [ ] `selected_agents` 変更時のセッション副作用が定義通りに動作する（既存セッション非停止）
- [ ] `activeCliTab` のデフォルト値が `selected_agents[0]` と連動し、存在しないタブがアクティブにならない（F502）

### コード品質
- [ ] CLIToolType関連のハードコード箇所（14箇所以上）が `CLI_TOOL_IDS` を参照する形に統一されている
- [ ] i18n翻訳ファイル（en/ja）にAgentタブ関連のキーが追加されている
- [ ] `cli_tool_id` と `selected_agents` の整合性ルールが実装されている
- [ ] switch文のdefaultフォールバック問題（F301）が5箇所全てで対応されている（vibe-local用case分岐の追加 or exhaustive switchガード導入）
- [ ] `sidebar.ts` の `cliStatus` 型が `Partial<Record<CLIToolType, BranchStatus>>` に変更されている
- [ ] `selected_agents` のJSONバリデーション関数が実装されている（PATCH API側・読み取り側の両方）
- [ ] `MessageList.tsx` の `getToolName()` にvibe-localの表示名（'Vibe Local'）が追加されている
- [ ] `db.ts` の `getLastMessagesByCliBatch()` 戻り値型が `Record<CLIToolType, string | undefined>` に更新されている（F503）

### テスト
- [ ] 新規コンポーネント（AgentSettingsPane）のユニットテストが追加されている
- [ ] DBマイグレーション（selected_agentsカラム追加）のテストが追加されている
- [ ] 選択数上限（2つまで）のバリデーションテストが追加されている
- [ ] `selected_agents` JSONバリデーション関数のテストが追加されている（不正JSON、型不一致、重複、配列長超過）
- [ ] 既存テストが全てパスする（`npm run test:unit`）
- [ ] 既存テストの固定値アサーション（F304）が更新されている（下記テストファイル参照）

## 技術的考慮事項

- `CLIToolType` 型に `'vibe-local'` を追加するため、ハイフン付きの文字列リテラルとなる。`SESSION_NAME_PATTERN`（`/^[a-zA-Z0-9_-]+$/`）でハイフンは許容されるため、セッション名 `mcbd-vibe-local-{worktreeId}` は問題なく通過する。
- vibe-localはPythonスクリプトのため、tmuxセッション起動コマンドが他ツールと異なる可能性がある（技術調査フェーズで確定）
- `selected_agents` のDBマイグレーション（version 18）が必要（既存worktreeは `cli_tool_id` を考慮した動的デフォルト値を適用）
- `ALLOWED_CLI_TOOLS` と `selected_agents` は独立して管理する（上記「ALLOWED_CLI_TOOLSの拡張方針」参照）
- **ハイフン付きキーのアクセス方法（F309）**: `vibe-local` キーはハイフンを含むため、JavaScriptオブジェクトのドット記法（`obj.vibe-local`）ではアクセスできない。`obj['vibe-local']` 形式か、変数経由の `obj[tool]` 形式を使用すること。TypeScriptでは `Record<CLIToolType, ...>` 型で `obj[tool]`（変数アクセス）を使用すれば問題ない。フロントエンドで `for...of CLI_TOOL_IDS` 等のイテレーションパターンを使用すれば、この問題は自動的に回避される。
- **APIレスポンス形式の変更**: `sessionStatusByCli`、`lastMessagesByCli` のJSONレスポンスに `vibe-local` キーが追加される。フロントエンド側の参照箇所（`WorktreeDetailRefactored.tsx`、sidebar `toBranchItem()`）の更新が必要。
- **activeCliTabのデフォルト値連動（F502）**: `activeCliTab` の `useState` 初期値を `selected_agents[0]` に合わせる。APIレスポンスの非同期取得による遅延を考慮し、`useEffect` での同期パターンも検討すること。
- **PATCHレスポンスの設計方針（F501）**: `selected_agents` 変更後のUI更新は既存ポーリング機構に依存する（PATCHレスポンスに `sessionStatusByCli` は追加しない）。即時性が必要な場合はクライアント側でGETを手動トリガーする。

## 変更対象ファイル一覧（全体）

### CLIツール定義・管理
| ファイル | 変更内容 |
|---------|---------|
| `src/lib/cli-tools/types.ts` | `CLI_TOOL_IDS` に `'vibe-local'` 追加 |
| `src/lib/cli-tools/vibe-local.ts` | 新規: VibeLocalTool クラス |
| `src/lib/cli-tools/manager.ts` | VibeLocalTool 登録、stopPollers対応 |

### switch文のdefaultフォールバック対応（F301）
| ファイル | 変更内容 |
|---------|---------|
| `src/lib/cli-patterns.ts` | `detectThinking()` / `getCliToolPatterns()` にvibe-localケース追加 |
| `src/lib/assistant-response-saver.ts` | `cleanCliResponse()` にvibe-localケース追加 |
| `src/lib/claude-executor.ts` | `buildCliArgs()` にvibe-localケース追加（技術調査結果に依存） |
| `src/components/worktree/MessageList.tsx` | `getToolName()` に `'vibe-local'` -> `'Vibe Local'` ケース追加（2箇所、DRY共通化検討） |

### CLI_TOOL_IDS ハードコード統一（リファクタリング）
| ファイル | 変更内容 |
|---------|---------|
| `src/app/api/worktrees/route.ts` | ハードコード配列を `CLI_TOOL_IDS` 参照に変更 |
| `src/app/api/worktrees/[id]/route.ts` | 同上（複数箇所） |
| `src/app/api/worktrees/[id]/send/route.ts` | 同上 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 同上 |
| `src/app/api/worktrees/[id]/interrupt/route.ts` | 同上 |
| `src/app/api/worktrees/[id]/auto-yes/route.ts` | 同上 |
| `src/app/api/worktrees/[id]/cli-tool/route.ts` | 同上 |
| `src/app/api/worktrees/[id]/start-polling/route.ts` | 同上 |
| `src/app/api/worktrees/[id]/messages/route.ts` | 同上 |
| `src/lib/log-manager.ts` | 同上（L187, L221） |
| `src/types/models.ts` | `sessionStatusByCli`, `lastMessagesByCli` を `Record<CLIToolType, ...>` に変更 |
| `src/lib/db.ts` | `getLastMessagesByCliBatch()` 戻り値型を `Record<CLIToolType, string \| undefined>` に更新（F503） |
| `src/types/sidebar.ts` | `cliStatus` を `Partial<Record<CLIToolType, BranchStatus>>` に変更、`toBranchItem()` にselectedAgents引数追加 |

### UIコンポーネント
| ファイル | 変更内容 |
|---------|---------|
| `src/components/worktree/NotesAndLogsPane.tsx` | SubTab型を `'notes' \| 'logs' \| 'agent'` に拡張、`activeSubTab === 'agent'` で `AgentSettingsPane` 描画（F504） |
| `src/components/worktree/AgentSettingsPane.tsx` | 新規: エージェント選択UI |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | ハードコード配列をselectedAgents stateに置換、`activeCliTab` デフォルト値を `selectedAgents[0]` に連動（F502） |

### DB・API
| ファイル | 変更内容 |
|---------|---------|
| `src/lib/db-*.ts` 関連 | `selected_agents` カラム追加（Migration v18、cli_tool_id連動デフォルト値） |
| `src/app/api/worktrees/[id]/route.ts` | 選択エージェントの取得・更新対応（PATCH APIにselected_agentsフィールド追加、レスポンスは現行維持） |

### スケジュール実行
| ファイル | 変更内容 |
|---------|---------|
| `src/lib/claude-executor.ts` | `ALLOWED_CLI_TOOLS` 拡張、`buildCliArgs()` vibe-localケース追加 |

### i18n
| ファイル | 変更内容 |
|---------|---------|
| `locales/en/schedule.json` | Agentタブ関連の翻訳キー追加 |
| `locales/ja/schedule.json` | 同上 |

### 既存テスト更新（F304）
| ファイル | 変更内容 |
|---------|---------|
| `tests/unit/cli-tools/types-cli-tool-ids.test.ts` | `toHaveLength(3)` -> `toHaveLength(4)` or `CLI_TOOL_IDS.length`、validTypes配列にvibe-local追加 |
| `tests/unit/cli-tools/types.test.ts` | validTypes配列にvibe-local追加 |
| `tests/unit/cli-tools/manager.test.ts` | `toHaveLength(3)` -> `toHaveLength(4)` or `CLI_TOOL_IDS.length` |
| `tests/unit/session-cleanup.test.ts` | 呼び出し回数の固定値アサーション更新（3->4, 9->12等） |

> **推奨**: 将来のツール追加に対する堅牢性を高めるため、固定値ではなく `CLI_TOOL_IDS.length` を参照するアサーションへのリファクタリングを推奨。

### ドキュメント（Issue完了後）
| ファイル | 変更内容 |
|---------|---------|
| `CLAUDE.md` | 主要機能モジュール表にvibe-local.ts、AgentSettingsPane.tsx追加 |

## 参考

- vibe-local: https://github.com/ochyai/vibe-local
- 現在のCLIツール定義: `src/lib/cli-tools/types.ts`
- UIハードコード箇所: `src/components/worktree/WorktreeDetailRefactored.tsx` L1795, L2081
- CMATEタブ実装: `src/components/worktree/NotesAndLogsPane.tsx`
- 現在のDBスキーマバージョン: 17（`CURRENT_SCHEMA_VERSION`）
- cli_tool_id カラム: Migration v7で追加済み

---

## レビュー履歴

### Stage 1 - 通常レビュー (2026-02-25)
- **F001 [must_fix]**: 変更対象ファイルの網羅性不足 - CLI_TOOL_IDSハードコード箇所（14箇所以上）を全て列挙し、リファクタリング方針を追加
- **F002 [must_fix]**: cli_tool_id と selected_agents の関係性未定義 - 設計方針セクションを追加し、役割・整合性ルールを明記
- **F003 [must_fix]**: vibe-localの技術的詳細不足 - 技術調査フェーズを追加し、調査項目を表形式で明記。仕様次第で別Issue分離の判断基準も記載
- **F004 [should_fix]**: クラス名typo ViveLocalTool -> VibeLocalTool に修正
- **F005 [should_fix]**: ALLOWED_CLI_TOOLS の拡張方針を明確化 - ツール別の方針とselected_agentsとの非連動を明記
- **F006 [should_fix]**: models.ts/sidebar.tsの型定義変更を変更対象に追加
- **F007 [should_fix]**: i18n翻訳ファイルを変更対象に追加
- **F008 [should_fix]**: テスト関連の受け入れ条件を追加（ユニットテスト、DBマイグレーションテスト、バリデーションテスト）
- **F009 [should_fix]**: CLIToolManager登録時の波及的影響（stopPollers等）を変更対象に追記
- **F010 [nice_to_have]**: SESSION_NAME_PATTERNのハイフン許容確認結果を技術的考慮事項に追記
- **F011 [nice_to_have]**: CLI_TOOL_IDSの一元化リファクタリングを前提作業として組み込み
- **F012 [nice_to_have]**: DBマイグレーションのバージョン番号（18）を明記

### Stage 3 - 影響範囲レビュー (2026-02-25)
- **F301 [must_fix]**: switch文のdefaultフォールバック問題 - cli-patterns.ts, assistant-response-saver.ts, claude-executor.ts, MessageList.tsxの5箇所を変更対象に追加。exhaustive switchガードの導入方針を追記
- **F302 [must_fix]**: sidebar.tsのcliStatus型変更 - `Partial<Record<CLIToolType, BranchStatus>>` への変更方針を具体化。toBranchItem()の設計変更、呼び出し元APIの影響を明記
- **F303 [must_fix]**: selected_agentsのJSONバリデーション戦略 - バリデーション関数の実装例を含む6つの検証観点を技術的考慮事項に追加。PATCH API側・読み取り側の両方で実施
- **F304 [should_fix]**: 既存テスト破損リスク - 固定値アサーションを持つ4テストファイルを変更対象に追加。CLI_TOOL_IDS.length参照へのリファクタリングを推奨
- **F305 [should_fix]**: selected_agents更新のAPI設計 - 既存PATCH APIへの統合、サーバーサイド整合性チェック、トランザクション処理、セッション非停止方針を明記
- **F306 [should_fix]**: selected_agents変更時のセッション管理 - UI表示のみの影響、既存セッション継続、ポーラーへの影響範囲を明記
- **F307 [should_fix]**: ALLOWED_CLI_TOOLSのvibe-local対応 - buildCliArgs()必須、execFile()のコマンド名問題、ScheduleEntry型制約の考慮事項を追記
- **F308 [should_fix]**: ScheduleEntry.cliToolIdの型安全性 - 本Issueスコープ外として明示し、将来的なリファクタリング候補として記載
- **F309 [should_fix]**: APIレスポンス形式変更 - ハイフン付きキーのアクセス方法、イテレーションパターンの推奨を技術的考慮事項に追記
- **F310 [nice_to_have]**: DBマイグレーションのデフォルト値 - cli_tool_idに応じた動的デフォルト値のSQL例を追加
- **F311 [nice_to_have]**: CLAUDE.md更新 - ドキュメントカテゴリとして変更対象ファイル一覧に追加
- **F312 [nice_to_have]**: MessageList.tsx getToolName()のDRY共通化検討 - 変更対象の注記として追記

### Stage 5 - 通常レビュー2回目 (2026-02-25)
- **F501 [should_fix]**: PATCHレスポンスのUI更新方針 - PATCH APIレスポンスにsessionStatusByCliを追加しない方針（方式B: 既存ポーリング機構依存）をAPI設計セクションに明記
- **F502 [should_fix]**: activeCliTabのデフォルト値連動 - WorktreeDetailRefactored.tsxのactiveCliTab初期値をselected_agents[0]に連動させる変更を明記。useEffect同期パターンの検討も追記
- **F503 [nice_to_have]**: db.tsのgetLastMessagesByCliBatch()戻り値型 - CLI_TOOL_IDSハードコード統一テーブルにdb.tsを追加、受け入れ基準にも追記
- **F504 [nice_to_have]**: NotesAndLogsPane SubTab型拡張の詳細 - SubTab型の拡張内容とAgentSettingsPane描画条件を変更対象に明記
- **F505 [nice_to_have]**: 受け入れ基準の実装順序ガイダンス - 推奨実装順序テーブルを対応方針の冒頭に追加