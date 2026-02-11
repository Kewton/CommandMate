# Issue #235 影響範囲レビューレポート

**レビュー日**: 2026-02-11
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

---

## 影響範囲の全体像

### 変更対象ファイル（直接影響）

| ファイル | 変更内容 | リスク |
|---------|---------|--------|
| `src/lib/prompt-detector.ts` | PromptDetectionResult 型に rawContent?: string 追加、全パターンで rawContent 返却 | Low |
| `src/lib/response-poller.ts` | L618 の DB 保存値を rawContent 優先に変更 | Medium |
| `src/components/worktree/PromptMessage.tsx` | message.content（rawContent 由来）の表示追加 | Medium |

### 影響なし確認済みファイル

| ファイル | 確認理由 |
|---------|---------|
| `src/lib/auto-yes-manager.ts` | promptData のみ使用（L321）、cleanContent/rawContent 非参照 |
| `src/lib/auto-yes-resolver.ts` | PromptData 型のみ使用、PromptDetectionResult 非 import |
| `src/lib/status-detector.ts` | isPrompt フラグのみ参照 |
| `src/lib/claude-session.ts` | セッション管理のみ、プロンプト検出に非関与 |
| `src/lib/claude-poller.ts` | response-poller.ts に統合済み（L234 TODO コメント参照、到達不能コード） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L91 で独自にデフォルト値設定、PromptDetectionResult 型非参照 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | isPrompt フラグのみ参照（L79） |
| `src/hooks/useAutoYes.ts` | PromptData のみ使用 |
| `src/lib/cli-tools/codex.ts` | detectPrompt の直接参照なし（response-poller.ts 経由で間接的に恩恵） |
| `src/components/worktree/MessageList.tsx` | PromptMessage に message をそのまま渡すだけ、props 変更なし |

### DB スキーマ

**スキーマ変更: 不要**

`chat_messages.content` は `TEXT NOT NULL`（文字数制限なし）。rawContent が格納されてもスキーマ変更・マイグレーション不要。

---

## Must Fix（必須対応）

### MF-1: rawContent に関するユニットテストの明示的なタスク化

**カテゴリ**: テスト範囲
**場所**: 実装タスク / `tests/unit/prompt-detector.test.ts`

**問題**:
現在の `tests/unit/prompt-detector.test.ts`（1529行）は全テストが `result.cleanContent` のみを assert しており、新規追加される `rawContent` に関するテストが一切存在しない。Issue の実装タスクでは「既存テストの確認・必要に応じて更新」と曖昧な表現にとどまっている。

**証拠**:
- `tests/unit/prompt-detector.test.ts` L34: `expect(result.cleanContent).toBe('Do you want to proceed with this operation?');`
- L129: `cleanContent: question`
- L508: `cleanContent: question.trim()`
- rawContent を検証するテストは0件

**推奨対応**:
以下のテストケースを実装タスクに明記する:
1. multiple_choice パターンで `rawContent` に `output.trim()` 全体が設定されること
2. Yes/No パターンで `rawContent` に `lastLines.trim()` が設定されること
3. Approve パターンで `rawContent` が設定されること
4. プロンプト非検出時に `rawContent` が undefined であること
5. `noPromptResult()` の返却値に `rawContent` が含まれないこと

---

### MF-2: response-poller.ts のDB保存フォールバックロジックのテスト不在

**カテゴリ**: テスト範囲
**場所**: 実装タスク / `tests/unit/lib/response-poller.test.ts`

**問題**:
`response-poller.ts` の `checkForResponse()` 内 L618 を `content: promptDetection.rawContent || promptDetection.cleanContent` に変更する計画だが、このフォールバックロジックをテストする手段が現状存在しない。`tests/unit/lib/response-poller.test.ts` は `cleanClaudeResponse()` のみを34行テストしている。

**証拠**:
- `tests/unit/lib/response-poller.test.ts`: 全34行が `cleanClaudeResponse()` のフィルタリングテスト（Issue #212 由来）
- `checkForResponse()` は DB、tmux、WebSocket に依存し、ユニットテスト未実装

**推奨対応**:
1. `rawContent || cleanContent` のフォールバック動作をテスト可能にするため、DB保存ロジックのモック付きテストを追加するか、フォールバック部分を独立関数として抽出しテスト可能にする
2. 最低限、統合テストで rawContent 付き prompt メッセージの DB 保存を検証する

---

## Should Fix（推奨対応）

### SF-1: PromptMessage.tsx での rawContent 表示時の制御文字・Unicode 文字への対処方針未記載

**カテゴリ**: 影響ファイル
**場所**: 実装タスク > PromptMessage.tsx UI仕様

**問題**:
rawContent は `detectPromptWithOptions()` 内で `stripAnsi()` 適用済みのため ANSI エスケープコードは含まれないが、Unicode のボックス描画文字（U+2500 系）、スピナー文字、その他の制御文字は除去されない。PromptMessage.tsx で rawContent を表示する際、これらの文字が UI に表示される可能性がある。

**証拠**:
- `response-poller.ts` L95-101: `detectPromptWithOptions()` が `stripAnsi()` を適用
- `stripAnsi()` は ANSI エスケープシーケンスのみ除去（`cli-patterns.ts` で定義）
- tmux 出力には `───────` セパレータや `Esc to cancel` 等のUI要素が含まれうる

**推奨対応**:
rawContent に stripAnsi() が適用済みである前提を Issue に明記し、追加の sanitization が不要である理由を記載する。ボックス描画文字やナビゲーションヒント行（"Esc to cancel" 等）の表示品質について、受容する or フィルタリングする方針を決定する。

---

### SF-2: 既存DB保存済み prompt メッセージとの後方互換性分析の不足

**カテゴリ**: 破壊的変更
**場所**: PromptMessage.tsx UI仕様

**問題**:
既存の DB に保存済みの prompt メッセージでは `content` に `cleanContent`（質問テキストのみ）が格納されている。修正後は `rawContent`（完全出力）が格納される。PromptMessage.tsx を `message.content` 全体表示に変更する場合、古いメッセージと新しいメッセージで表示内容が異なる。

**証拠**:
- DB schema: `content TEXT NOT NULL` (db.ts:68)
- 既存データ: content = cleanContent（例: "Do you want to proceed?"）
- 新規データ: content = rawContent（例: 指示テキスト + 質問 + 選択肢の完全出力）

**推奨対応**:
Issue の PromptMessage.tsx UI 仕様セクションにフォールバック動作を明記する:
1. 既存メッセージ（rawContent 導入前）: content = cleanContent = prompt.question とほぼ同内容 --> 従来通りの表示
2. 新規メッセージ: content = rawContent --> 完全出力の表示
3. `message.content` が空または `prompt.question` と同一の場合は `prompt.question` を表示するフォールバックを設ける（Issue 記載済み、具体的な比較ロジックを補足推奨）

---

### SF-3: auto-yes-manager.ts の PromptDetectionResult 型消費に関する影響分析の明示化

**カテゴリ**: 依存関係
**場所**: 影響範囲 > 影響なしの確認済みコンポーネント

**問題**:
`auto-yes-manager.ts` は `detectPrompt()` を import し、`PromptDetectionResult` 型を消費している。`rawContent?: string` は optional フィールドのため TypeScript 型エラーは発生しないが、Issue の影響範囲テーブルでは `auto-yes-manager.ts` が `PromptDetectionResult` 型の消費者であることが十分に分析されていない。

**証拠**:
- `auto-yes-manager.ts` L14: `import { detectPrompt } from './prompt-detector';`
- L321: `if (!promptDetection.isPrompt || !promptDetection.promptData)`
- L328: `const answer = resolveAutoAnswer(promptDetection.promptData);`
- rawContent / cleanContent を直接参照するコードはなし

**推奨対応**:
影響範囲テーブルの「影響なし確認済み」セクションに `auto-yes-manager.ts` を追加し、「PromptDetectionResult 型を消費するが rawContent は参照しないため影響なし」と明記する。

---

### SF-4: PromptMessage.tsx の UI 変更に対するテスト戦略の不足

**カテゴリ**: テスト範囲
**場所**: 実装タスク

**問題**:
PromptMessage.tsx の表示ロジック変更は UI 層のため、既存のユニットテストだけでは検証が困難。現在 PromptMessage.tsx に対するテストは存在しない。

**証拠**:
- `tests/` ディレクトリに PromptMessage 関連のテストファイルなし
- 受入条件「PromptMessage UIで指示テキストが表示されること」の検証手段が未定義

**推奨対応**:
1. 最低限、React Testing Library を使用したコンポーネントレンダリングテストを追加
2. テストケース: (a) message.content 全体が表示されること、(b) message.content が空の場合に prompt.question にフォールバックすること、(c) message.content と prompt.question が同一の場合の重複回避

---

## Nice to Have（あれば良い）

### NTH-1: CLAUDE.md のモジュール説明更新

**カテゴリ**: ドキュメント更新
**場所**: CLAUDE.md > 主要機能モジュール

`CLAUDE.md` の `prompt-detector.ts` 行に rawContent フィールドの説明を追加し、`response-poller.ts` 行に rawContent 優先 DB 保存の旨を追記することで、ドキュメントの整合性を維持する。

---

### NTH-2: rawContent のサイズとパフォーマンスへの影響の見積り

**カテゴリ**: 移行考慮
**場所**: 修正方針

multiple_choice パターンでは `rawContent = output.trim()` で tmux 出力全体を保持する。`captureSessionOutput()` は最大10000行を取得するため、理論的な最大サイズを見積り、パフォーマンスへの影響が無視できることを確認した旨を Issue に記載すると安心。ただし実際には prompt 検出時の出力は数十行程度であり、実用上の問題は発生しにくい。

WebSocket の `broadcastMessage()` でペイロードが増加する点は低リスクだが、prompt メッセージの頻度が低いため影響は限定的。

---

### NTH-3: prompt-response API の影響範囲テーブルへの追記

**カテゴリ**: ドキュメント更新
**場所**: 影響範囲 > 影響なしの確認済みコンポーネント

`src/app/api/worktrees/[id]/prompt-response/route.ts` は `PromptDetectionResult` 型を import し `detectPrompt()` を呼び出しているが、`isPrompt` フラグのみ参照しており rawContent の影響を受けない。影響範囲テーブルの「影響なし確認済み」セクションへの追記が望ましい。

---

## DB スキーマ・既存データ互換性分析

| 項目 | 結論 |
|------|------|
| スキーマ変更 | 不要（content TEXT NOT NULL は文字数制限なし） |
| マイグレーション | 不要 |
| 既存データ互換性 | 互換性あり（既存の content = cleanContent はそのまま表示可能） |
| 新規データ | content に rawContent が保存される（cleanContent より大きいが問題なし） |

---

## パフォーマンス影響分析

| 観点 | 影響 | 説明 |
|------|------|------|
| DB 書き込み | Low | content カラムのサイズ増加は prompt メッセージのみ。prompt メッセージの頻度は低い |
| WebSocket broadcast | Low | prompt メッセージのペイロード増加。頻度が低いため影響軽微 |
| メモリ使用 | Low | rawContent は PromptDetectionResult に一時保持されるのみ。GC 対象 |
| クエリ性能 | None | content カラムのサイズ増加は INDEX に影響しない（content は非インデックスカラム） |

---

## セキュリティ影響分析

| 観点 | リスク | 説明 |
|------|--------|------|
| XSS | Low | rawContent は stripAnsi() 済み。PromptMessage.tsx でプレーンテキスト表示（React デフォルトエスケープ）する限りリスクなし |
| 情報漏洩 | Low | rawContent は tmux 出力由来。ユーザーが既にターミナルで閲覧可能な情報のみ含む |
| ログインジェクション | None | rawContent は DB 保存のみ。ログ出力には使用されない |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/prompt-detector.ts`: PromptDetectionResult 型定義、cleanContent/rawContent 生成ロジック
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/response-poller.ts`: DB 保存ロジック（L618）、detectPromptWithOptions()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/components/worktree/PromptMessage.tsx`: プロンプト表示 UI コンポーネント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/tests/unit/prompt-detector.test.ts`: 既存テスト（cleanContent のみ検証、1529行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/tests/unit/lib/response-poller.test.ts`: 既存テスト（cleanClaudeResponse のみ、34行）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/auto-yes-manager.ts`: detectPrompt() 消費者（影響なし確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/auto-yes-resolver.ts`: PromptData のみ使用（影響なし確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/lib/db.ts`: DB スキーマ定義（content TEXT NOT NULL）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/app/api/worktrees/[id]/current-output/route.ts`: cleanContent 独自設定（影響なし確認済み）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/src/app/api/worktrees/[id]/prompt-response/route.ts`: isPrompt のみ参照（影響なし確認済み）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-235/CLAUDE.md`: モジュール説明の更新が必要
