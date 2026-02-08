# Issue #193 Stage 3: 影響範囲レビュー（1回目）

**レビュー日**: 2026-02-08
**対象Issue**: #193 - claude Codexからの複数選択肢に対し、回答を送信出来ない
**フォーカス**: 影響範囲（Impact Scope）

---

## 1. レビューサマリー

| 区分 | 件数 |
|------|------|
| must_fix | 3 |
| should_fix | 5 |
| nice_to_have | 2 |
| **合計** | **10** |

Issue #193 の影響範囲分析は概ね正確であるが、いくつかの見落としと不正確な記述がある。特に、Codex CLI が TUI ベースか テキストベースかの前提条件確認の結果が影響範囲を根本的に左右するため、両パターンの影響範囲を事前に文書化しておくことが重要である。

---

## 2. detectPrompt() 呼び出し箇所の完全マップ

コードベース全体を検索した結果、`detectPrompt()` の外部呼び出し箇所は以下の **9箇所** である（Issue 本文の「全11箇所」は不正確）。

| # | ファイル | 行 | CLIツールガード | Codex影響 |
|---|---------|-----|----------------|----------|
| 1 | `src/lib/auto-yes-manager.ts` | L290 | なし（全ツール共通） | 影響あり |
| 2 | `src/lib/status-detector.ts` | L87 | なし（全ツール共通） | 影響あり |
| 3 | `src/app/api/worktrees/[id]/prompt-response/route.ts` | L75 | なし（全ツール共通） | 影響あり |
| 4 | `src/app/api/worktrees/[id]/current-output/route.ts` | L88 | thinking検出でスキップ可 | 影響あり |
| 5 | `src/lib/response-poller.ts` | L248 | **`if (cliToolId === 'claude')`** | **影響なし** |
| 6 | `src/lib/response-poller.ts` | L442 | なし（全ツール共通） | 影響あり |
| 7 | `src/lib/response-poller.ts` | L556 | なし（全ツール共通） | 影響あり |
| 8 | `src/lib/claude-poller.ts` | L164 | Claude専用モジュール | **影響なし** |
| 9 | `src/lib/claude-poller.ts` | L232 | Claude専用モジュール | **影響なし** |

**Codex セッションで実際に実行される detectPrompt() 呼び出し: 6箇所**（#1, #2, #3, #4, #6, #7）

---

## 3. 指摘事項詳細

### S3-001 [must_fix] claude-poller.ts が変更対象ファイル一覧から欠落

**問題**: `src/lib/claude-poller.ts` は L164 と L232 で `detectPrompt()` を呼び出している。Issue の影響範囲テーブルにはこのファイルが記載されていない。

**分析**: `claude-poller.ts` の `checkForResponse()` は `isClaudeRunning()` を使い Claude セッション専用で動作する。Codex セッションでは呼び出されないため、Codex 対応の変更自体は不要。ただし、`detectPrompt` のシグネチャが変更される場合（optional パラメータ追加の案A/B）、後方互換性があれば変更不要だが、その判断根拠を明記すべき。

**推奨**: 影響範囲テーブルの「関連コンポーネント」に `claude-poller.ts` を追加し、「Claude 専用モジュールのため変更不要（detectPrompt のシグネチャ変更は後方互換）」と注記する。

---

### S3-002 [must_fix] response-poller.ts の L248 は Claude 専用ガード内

**問題**: Issue は `response-poller.ts` の detectPrompt 呼び出しを L248, L442, L556 として一括で cliToolId 対応が必要としているが、L248 は以下のように Claude 専用ガード内にある:

```typescript
// response-poller.ts L242-259
// Early check for Claude permission prompts (before extraction logic)
if (cliToolId === 'claude') {        // <-- Claude専用ガード
    const fullOutput = lines.join('\n');
    const cleanFullOutput = stripAnsi(fullOutput);
    const promptDetection = detectPrompt(cleanFullOutput);  // L248
    ...
}
```

L442 と L556 にはガードがなく、全 CLI ツールで実行される。

**推奨**: 影響範囲テーブルの response-poller.ts の説明を修正:
- L248: Claude 専用ガード内 -- 変更不要
- L442, L556: 全 CLI ツール共通 -- cliToolId 対応必要

---

### S3-003 [must_fix] TUI ベース選択肢の場合の代替影響範囲が未分析

**問題**: `codex.ts` の `startSession()` L91-96 で既に Down arrow key + Enter による TUI 操作を行っている:

```typescript
// codex.ts L91-96
await execAsync(`tmux send-keys -t "${sessionName}" Down`);
await new Promise((resolve) => setTimeout(resolve, CODEX_MODEL_SELECT_WAIT_MS));
await execAsync(`tmux send-keys -t "${sessionName}" Enter`);
```

これは Codex CLI が TUI ベースの選択肢 UI を使用している強い証拠。もし TUI ベースであれば:

1. `detectMultipleChoicePrompt` のテキストパターンマッチが機能しない可能性がある（tmux capture-pane で取得したバッファに選択肢テキストが残らない、または ANSI 制御コード混じりで stripAnsi 後に情報が失われる）
2. 番号入力ではなく矢印キー操作が必要になり、以下のファイルに追加影響:
   - `prompt-response/route.ts` の sendKeys ロジック
   - `respond/route.ts` の sendKeys ロジック（L149-156）
   - `auto-yes-manager.ts` の sendKeys ロジック（L312-314）
   - `getAnswerInput()` の multiple_choice ハンドリング

**推奨**: TUI ベースの場合の代替影響範囲を Issue に追記し、前提条件確認後に影響範囲テーブルを更新するワークフローを明記する。

---

### S3-004 [should_fix] prompt-detector.ts の CLI ツール非依存性原則と設計案の推奨が不明確

**問題**: Issue #161 で「prompt-detector.ts は CLIToolType を import せず CLI ツール非依存であるべき」という原則が確立された。Issue は案A/B/C を提示しているが推奨案が不明確。

**分析**:
- **案A** (`detectPrompt(output, cliToolId?)`): prompt-detector.ts に CLIToolType への依存を導入。#161 の原則に違反。
- **案B** (`detectPrompt(output, options?)`): パターンをパラメータ化。非依存性を維持しつつ拡張可能。後方互換性あり。
- **案C** (ラッパー関数): 既存関数を変更しないが、9箇所の呼び出しをラッパーに切り替える変更が必要。

**推奨**: 案B を推奨案として明記する。理由: (1) CLIツール非依存性を維持、(2) optional パラメータで後方互換性あり、(3) 呼び出し元は `cli-patterns.ts` から取得したパターンを渡すだけ。

---

### S3-005 [should_fix] respond/route.ts が影響範囲に含まれていない

**問題**: `src/app/api/worktrees/[id]/respond/route.ts` は `getAnswerInput()` を使用し（L105）、multiple_choice のハンドリング（L82-113）で番号を文字列として sendKeys に渡している。TUI ベースの場合はこの API のロジックも変更が必要。

**推奨**: 「関連コンポーネント（動作確認）」セクションに `respond/route.ts` を追加する。

---

### S3-006 [should_fix] auto-yes-resolver.ts の isDefault フラグ依存

**問題**: `resolveAutoAnswer()` は `options.find(o => o.isDefault)` でデフォルト選択肢を探す。Claude CLI では `❯` マーカーで isDefault を決定するが、Codex CLI に `❯` 相当のマーカーがなければ isDefault は常に false になり、常に最初の選択肢が選ばれる。

**推奨**: 前提条件確認項目3の結果に基づき auto-yes-resolver.ts の変更要否を判断するフローを明記する。

---

### S3-007 [should_fix] status-detector.ts の 15 行制限で Codex 選択肢が切り詰められる可能性

**問題**: `detectSessionStatus()` は最後の 15 行のみを `detectPrompt` に渡す（`STATUS_CHECK_LINE_COUNT = 15`）。Codex の選択肢が多い場合（7個以上 + 質問テキスト）、15 行では収まらず検出に失敗する可能性がある。

```typescript
// status-detector.ts L83
const lastLines = lines.slice(-STATUS_CHECK_LINE_COUNT).join('\n');
// STATUS_CHECK_LINE_COUNT = 15

// detectMultipleChoicePrompt は内部で最後50行をスキャンするが、
// 入力が15行なので15行分しかスキャンされない
```

**推奨**: テスト計画に「選択肢数が多い場合（7個以上）」のケースを含める。必要に応じて STATUS_CHECK_LINE_COUNT の引き上げを検討する。

---

### S3-008 [should_fix] フロントエンドコンポーネントが影響範囲に含まれていない

**問題**: 以下のフロントエンドコンポーネントが `promptData.type === 'multiple_choice'` を処理しているが、影響範囲に記載されていない:

- `src/components/worktree/PromptPanel.tsx` - デスクトップ向け選択肢 UI
- `src/components/mobile/MobilePromptSheet.tsx` - モバイル向け選択肢 UI
- `src/components/worktree/MessageList.tsx` - メッセージ内の選択肢表示
- `src/hooks/useAutoYes.ts` - クライアント側 Auto-Yes フック

テキストベースであれば現行 UI で対応可能だが、TUI ベースの場合は UI の送信ロジックの変更が必要になる可能性がある。

**推奨**: 「関連コンポーネント（動作確認）」セクションにフロントエンドコンポーネントを追加する。

---

### S3-009 [nice_to_have] テストファイルの影響範囲が不足

**問題**: `detectPrompt` をモックしている既存テストファイルも、シグネチャ変更時に更新が必要:
- `tests/unit/lib/auto-yes-manager.test.ts` (L431)
- `tests/unit/api/prompt-response-verification.test.ts` (L50, L112, L141)
- `tests/integration/api-prompt-handling.test.ts`

**推奨**: 影響範囲テーブルに既存テストの更新対象を追記する。

---

### S3-010 [nice_to_have] detectPrompt の呼び出し箇所数が不正確

**問題**: Issue 本文で「全11箇所の呼び出し」と記載されているが、実際は 9 箇所（本レポート Section 2 参照）。

**推奨**: 正確な呼び出し箇所数と一覧に修正する。

---

## 4. 影響フローチャート

```
Codex CLIが選択肢を表示
  |
  +-- [テキストベースの場合]
  |     |
  |     +-- tmux capture-pane で選択肢テキスト取得可能
  |     +-- detectMultipleChoicePrompt のパターン拡張で対応
  |     +-- 影響範囲: prompt-detector.ts, cli-patterns.ts, + 6箇所の呼び出し元
  |     +-- sendKeys ロジック変更不要（番号入力）
  |
  +-- [TUI ベースの場合]
        |
        +-- tmux capture-pane の出力に選択肢が残るか不明
        +-- detectMultipleChoicePrompt では検出不可能な可能性
        +-- 代替アプローチ: tmux send-keys による矢印キー操作
        +-- 影響範囲が大幅に拡大:
            - prompt-detector.ts（検出ロジック変更 or 新ロジック追加）
            - prompt-response/route.ts（sendKeys を矢印キーに変換）
            - respond/route.ts（同上）
            - auto-yes-manager.ts（sendKeys を矢印キーに変換）
            - getAnswerInput()（番号 -> 矢印キー回数変換）
            - フロントエンド（UI の選択肢送信ロジック）
```

---

## 5. 総合評価

Issue #193 の影響範囲分析は **方向性は正しい** が、以下の改善が必要:

1. **前提条件確認の結果で影響範囲が二分される** ことをより明確に文書化し、TUI ベースの場合の代替影響範囲を事前に洗い出しておく
2. **response-poller.ts L248 の Claude 専用ガード** を区別し、不要な変更を避ける
3. **claude-poller.ts** を関連コンポーネントに含める
4. **設計方針（案A/B/C）の推奨** を明記し、#161 の原則との整合性を確保する
5. **フロントエンドコンポーネントと既存テスト** を動作確認対象に含める

---

## 6. 参照ファイル

- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/prompt-detector.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/cli-patterns.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-manager.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/auto-yes-resolver.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/status-detector.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/response-poller.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/claude-poller.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/prompt-response/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/current-output/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/app/api/worktrees/[id]/respond/route.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/lib/cli-tools/codex.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/types/models.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/components/worktree/PromptPanel.tsx`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/components/mobile/MobilePromptSheet.tsx`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-193/src/hooks/useAutoYes.ts`
