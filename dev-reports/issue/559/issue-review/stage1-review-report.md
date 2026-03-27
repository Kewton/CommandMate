# Issue #559 Stage 1 レビューレポート: 通常レビュー（1回目）

## レビュー対象

- **Issue**: #559 fix: Copilot CLIのスラッシュコマンドがテキストとして処理される場合がある
- **レビュー種別**: 通常レビュー（Consistency & Correctness）
- **レビュー日**: 2026-03-27

## サマリー

Issue #559は問題の存在自体は妥当であるが、根本原因の分析と再現手順に重要な不正確さがある。最大の問題は、UIの通常メッセージ送信経路では既にプロンプト待機が実装済みであり、問題がterminal API経由でのみ発生する可能性が高い点が明記されていないこと。受入条件・修正方針・影響範囲の記載も不足している。

## 指摘一覧

| ID | 重要度 | カテゴリ | タイトル |
|----|--------|----------|----------|
| F1-001 | must_fix | 正確性・根本原因の特定 | 根本原因がterminal API経由の問題のみであることを明記すべき |
| F1-002 | must_fix | 再現手順の正確性 | 再現手順がどのUI操作・API経路で問題が起きるか不明 |
| F1-003 | must_fix | 受入条件の欠如 | 受入条件（Acceptance Criteria）が記載されていない |
| F1-004 | should_fix | 修正方針の不足 | 修正方針・実装アプローチが記載されていない |
| F1-005 | should_fix | 影響範囲の不足 | 影響範囲テーブルが記載されていない |
| F1-006 | should_fix | waitForPromptのタイムアウト処理 | waitForPromptタイムアウト時の期待動作が未定義 |
| F1-007 | nice_to_have | ドキュメント整合性 | CLAUDE.mdのモジュール説明との整合性確認 |
| F1-008 | nice_to_have | 関連Issue参照 | Issue #558への参照が不足 |

## 詳細

### F1-001 [must_fix] 根本原因がterminal API経由の問題のみであることを明記すべき

Issueの「根本原因」セクションでは「Terminal APIのsendKeysはCopilotの状態を確認せず即座に送信する」と記載されているが、通常のUI操作（MessageInput -> `/api/worktrees/:id/send` -> `CopilotTool.sendMessage()`）では既に`waitForPrompt()`が実装されている（`copilot.ts:254`）。

コード経路の比較:

| 操作 | API経路 | プロンプト確認 |
|------|---------|--------------|
| UI MessageInput送信 | `/api/worktrees/:id/send` -> `CopilotTool.sendMessage()` | あり（waitForPrompt） |
| Terminal API | `/api/worktrees/:id/terminal` -> `sendKeys()` 直接呼出 | なし |
| CLI `commandmate send` | `/api/worktrees/:id/send` -> `CopilotTool.sendMessage()` | あり（waitForPrompt） |

**推奨**: 問題が発生するのはterminal API経由のみであることを根本原因セクションに明記する。

### F1-002 [must_fix] 再現手順がどのUI操作・API経路で問題が起きるか不明

再現手順「Copilotに質問を送信 -> 応答中に/modelを送信」が曖昧。通常のUI操作では`/api/worktrees/:id/send`経由で`CopilotTool.sendMessage()`が呼ばれ、`waitForPrompt()`により最大15秒待機される。この手順で本当に問題が再現するか不明確。

**推奨**: 具体的なUI操作またはAPI呼び出し手順を記載する。

### F1-003 [must_fix] 受入条件が記載されていない

関連Issue #547では詳細な受入条件チェックリストが記載されているが、本Issueにはそれがない。

**推奨**: 以下の受入条件を追加する:
- terminal API経由でCopilotスラッシュコマンドを送信した場合にプロンプト待機が行われること
- Copilot応答中に/modelを送信してもテキストとして処理されないこと
- タイムアウト後の振る舞いが定義されていること
- 既存のsendMessage経路に影響がないこと
- 単体テストの追加

### F1-004 [should_fix] 修正方針・実装アプローチが記載されていない

複数のアプローチが考えられる:
- (A) `terminal/route.ts`でCopilotスラッシュコマンド検出時にプロンプト待機を追加
- (B) UIからのスラッシュコマンド送信をsend API経由に統一
- (C) terminal APIにcliToolIdベースの分岐を追加しCopilotの場合は`CopilotTool.sendMessage()`に委譲

**推奨**: 修正方針セクションを追加し、推奨アプローチとその理由を記載する。

### F1-005 [should_fix] 影響範囲テーブルが記載されていない

**推奨**: 変更対象ファイルと変更内容を明記した影響範囲テーブルを追加する。

### F1-006 [should_fix] waitForPromptタイムアウト時の期待動作が未定義

`CopilotTool.waitForPrompt()`は15秒のタイムアウトがあり、タイムアウト時はエラーをthrowせずログ出力のみで処理を継続する（`copilot.ts:197`）。つまり現行のsendMessage経路でも、15秒待って結局テキストとして送信される可能性がある。

**推奨**: タイムアウト後の振る舞い（エラー返却 or 送信続行）を明確に定義する。

### F1-007 [nice_to_have] CLAUDE.mdのモジュール説明との整合性確認

**推奨**: 実装完了後にCLAUDE.mdのモジュール一覧を確認し、必要に応じて更新する。

### F1-008 [nice_to_have] Issue #558への参照が不足

直近のコミット（63c4a0b5）にIssue #558が含まれており、Copilot CLIスラッシュコマンドに関する修正が行われている。

**推奨**: 関連Issueセクションに#558を追加する。

## 統計

| 重要度 | 件数 |
|--------|------|
| must_fix | 3 |
| should_fix | 3 |
| nice_to_have | 2 |
| **合計** | **8** |
