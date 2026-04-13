# Issue #649 仮説検証レポート

## 仮説検証結果

| # | 前提条件 | ファイルパス | 判定 | 詳細 |
|---|---------|-----------|------|------|
| 1 | 現在の CLI セッションはすべて worktree 単位で紐づいている | `src/lib/session/cli-session.ts`, `src/lib/cli-tools/base.ts` | **Confirmed** | `resolveSessionContext()` で worktreeId を使用。セッション名フォーマット: `mcbd-{cli_tool_id}-{worktree_id}` |
| 2 | repositoryApi.list() が Issue #644 で追加済み | `src/app/api/repositories/route.ts`, `src/lib/db/db-repository.ts` | **Confirmed** | GET `/api/repositories` エンドポイントで `getAllRepositoriesWithWorktreeCount()` を実装済み |
| 3 | MessageInput コンポーネントが流用候補として存在 | `src/components/worktree/MessageInput.tsx` | **Confirmed** | Props: `worktreeId`, `cliToolId`, `isSessionRunning` を備える。ただし worktreeId 必須設計 |
| 4 | HomeSessionSummary が既存 Home コンポーネントとして存在 | `src/components/home/HomeSessionSummary.tsx` | **Confirmed** | Running/Waiting セッション数の集計表示。`src/app/page.tsx` で既に使用中 |
| 5 | CLIToolManager が CLI ツール管理として存在 | `src/lib/cli-tools/manager.ts` | **Confirmed** | シングルトン実装。`getTool()`, `getAllTools()`, `getInstalledTools()` メソッド提供 |
| 6 | src/app/page.tsx がHome画面のエントリポイント | `src/app/page.tsx` | **Confirmed** | HomeSessionSummary を包含し、ショートカットカード配置 |
| 7 | Gemini が CLI ツールとしてサポート | `src/lib/cli-tools/gemini.ts` | **Confirmed** | GeminiTool クラス実装済み。CLI_TOOL_IDS: `['claude', 'codex', 'gemini', 'vibe-local', 'opencode', 'copilot']` |

## 主な知見

### 1. 現在のセッションアーキテクチャ
- すべての CLI セッションは **worktree ベース**
- tmux セッション名の命名規則: `mcbd-{tool_id}-{worktree_id}`
- Session Transport 抽象化により、transport 層の切り替え可能

### 2. 汎用 CLI セッション実装のための現状
- CLIToolManager で複数ツール (Claude, Codex, Gemini, Vibe Local, OpenCode, Copilot) をサポート
- **Worktree に紐づかないセッション** の実装には新規インターフェース設計が必要

### 3. コンポーネント再利用の可能性
- **MessageInput**: worktreeId 依存設計のため、"汎用セッション"向けに Props 拡張が必要
  - 現状: `worktreeId` 必須
  - 提案: `sessionId` の追加フィールド or worktreeId をオプション化
- **HomeSessionSummary**: 実装内容がシンプルで再利用性が高い (worktree 集計のみ)

### 4. Architecture への影響
- 現在の CLI セッション管理は完全に worktree に紐づいており、汎用セッション実装には以下が必要:
  1. **新しいセッション ID スキーム** (worktree ID に依存しない識別子)
  2. **MessageInput の Props 拡張** (worktreeId と汎用セッションID の区分)
  3. **ホーム画面のセッション開始フロー** (既存 worktree-based flow との分離)
  4. **レスポンスポーリング機構** の汎用化 (現在は worktreeId を使用)

## Stage 1 レビューへの申し送り事項

- すべての前提条件が Confirmed だったため Rejected は0件
- ただし MessageInput の `worktreeId` 依存性は実装上の課題として申し送り（現状必須パラメータ）
- グローバルセッションのセッション名 `mcbd-global-home` はアーキテクチャ上実現可能だが、既存のポーリング・Auto-Yes 等が worktreeId を使うため API 設計の再考が必要
