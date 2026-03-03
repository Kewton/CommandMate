# Issue #405 レビューレポート - Stage 7

**レビュー日**: 2026-03-04
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: 7 / 8（イテレーション 2）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

**全体品質**: high

Stage 3の影響範囲レビュー（1回目）で指摘された全must_fix / should_fix項目が適切に反映されていることを確認した。Stage 5-6の指摘反映も確認済み。新規指摘は重大度の低いshould_fix 2件とnice_to_have 2件のみであり、Issueは実装着手可能な品質に達している。

---

## 前回指摘事項の反映状況

### Stage 3 Must Fix（全2件 -- 全て反映済み）

| ID | タイトル | 状況 |
|----|---------|------|
| R3-001 | auto-yes応答後のキャッシュ無効化タイミング | 反映済み。try-finallyパターンの擬似コード付きで詳細設計が追記されている。sendPromptAnswer() -> finally { clearCache(sessionName) } -> scheduleNextPoll() の実行順序が明確。prompt-answer-sender.tsのsendKeys()/sendSpecialKeys()もフック対象に含まれている。 |
| R3-002 | captureSessionOutput()インターフェース互換性 | 反映済み。A案（キャッシュモジュール側でhasSessionチェック済みフラグ管理）の詳細設計が新サブセクションとして追記。受入条件にもインターフェース非変更とテスト互換性が追加されている。 |

### Stage 3 Should Fix（全7件 -- 全て反映済み）

| ID | タイトル | 状況 |
|----|---------|------|
| R3-005 | キャッシュ無効化フック挿入箇所 | 反映済み。影響範囲テーブルに7ファイル追加。ただしterminal/route.tsのsendKeys()が漏れている（R7-002で指摘）。 |
| R3-006 | 既存テストのcaptureSessionOutputモック影響 | 反映済み。「既存テストが変更なしでパスすること」がユニットテスト項目に記載。 |
| R3-007 | globalThisパターンとの整合性 | 反映済み。declare global型定義 + globalThis初期化パターンが実装タスクに明記。 |
| R3-008 | session-cleanup.tsの追加 | 反映済み。影響範囲テーブルにgraceful shutdown時のキャッシュクリアとして追加。 |
| R3-009 | ANSIエスケープシーケンス考慮 | 反映済み。行ベースsliceの実装方法、stripAnsi()後段適用の考慮、検証テスト設置が記載。 |
| R3-012 | isRunning()最適化のICLIToolインターフェース影響 | 反映済み。A案（route.ts側でlistSessions()1回呼び、ICLITool変更不要）が明記。 |

### Stage 5 Should Fix（全2件 -- 全てStage 6で反映済み）

| ID | タイトル | 状況 |
|----|---------|------|
| R5-001 | worktrees/[id]/route.tsのlistSessions()最適化タスク明示化 | 反映済み。実装タスク独立項目、影響範囲テーブル更新、受入条件追加の3箇所に反映。 |
| R5-002 | B案キャッシュ無効化フック漏れ防止策 | 反映済み。CLAUDE.mdガイドライン追記、網羅的テスト追加、影響範囲テーブル更新の3つの対策が記載。 |

---

## 新規指摘事項

### Should Fix

#### R7-001: capture/route.tsのcapturePane()直接呼び出しがキャッシュ層をバイパスする

**カテゴリ**: 影響範囲
**対象セクション**: 影響範囲テーブル

**問題**:
`src/app/api/worktrees/[id]/capture/route.ts` (L70) は `capturePane(sessionName, safeLines)` を直接呼び出しており、`captureSessionOutput()` を経由していない。キャッシュは `captureSessionOutput()` 内部に導入予定であり、capture APIはキャッシュ層をバイパスする。

影響範囲テーブルにcapture/route.tsが含まれていないが、キャッシュ対象外とする設計判断を明記すべき。

**推奨対応**:
影響範囲テーブルまたは設計方針に、capture/route.tsはcapturePane()を直接使用しておりキャッシュ対象外とする旨を注記する。

---

#### R7-002: terminal/route.tsのsendKeys()呼び出し後にキャッシュ無効化フックが必要

**カテゴリ**: 影響範囲
**対象セクション**: 影響範囲テーブル / キャッシュ無効化戦略

**問題**:
`src/app/api/worktrees/[id]/terminal/route.ts` (L78) は `sendKeys(sessionName, command)` を直接呼び出してターミナルにコマンドを送信する。B案（呼び出し元での明示的キャッシュクリア）が採用されているが、影響範囲テーブルにterminal/route.tsが含まれておらず、この sendKeys() 呼び出し後のキャッシュ無効化フックが漏れている。

ユーザーがターミナルUIからコマンドを送信した直後に、キャッシュTTL以内は古い出力が返される可能性がある。

**推奨対応**:
影響範囲テーブルに `src/app/api/worktrees/[id]/terminal/route.ts` を追加し、変更内容として「sendKeys()後のキャッシュクリア」を記載する。

---

### Nice to Have

#### R7-003: session-cleanup.tsのキャッシュクリア粒度

**カテゴリ**: 影響範囲
**対象セクション**: 影響範囲テーブル > src/lib/session-cleanup.ts

`cleanupWorktreeSessions()` に追加するキャッシュクリアは、「該当worktreeのセッションに対応するキャッシュエントリの削除」とすべきか「全キャッシュのclear()」とすべきかの方針が未定義。冪等操作のため実質的な問題はないが、実装タスクに注記するとより明確になる。

---

#### R7-004: BaseCLITool.interrupt()のキャッシュ無効化

**カテゴリ**: 影響範囲
**対象セクション**: キャッシュ無効化戦略

`BaseCLITool.interrupt()` は `sendSpecialKey(sessionName, 'Escape')` を呼び出すが、キャッシュ無効化フック挿入箇所に含まれていない。呼び出し頻度は低くキャッシュTTL内にステータスが更新されるため影響は小さい。

---

## 影響範囲テーブルの網羅性評価

### 記載済みファイル（19ファイル）

全て妥当な記載であることを確認。特にStage 4で追加された7ファイルのキャッシュ無効化フック挿入箇所、Stage 6で更新されたworktrees/[id]/route.tsのlistSessions()最適化記載が適切。

### 未記載だが追加推奨のファイル

| ファイル | 理由 | 重大度 |
|---------|------|--------|
| `src/app/api/worktrees/[id]/terminal/route.ts` | sendKeys()直接呼び出し、キャッシュ無効化フック挿入が必要 | should_fix |
| `src/app/api/worktrees/[id]/capture/route.ts` | capturePane()直接呼び出し、キャッシュ対象外の設計判断注記が必要 | should_fix |

### キャッシュ対象外が妥当なファイル

| ファイル | 理由 |
|---------|------|
| `src/lib/pasted-text-helper.ts` | capturePane()を直接呼ぶが10行のみの取得で頻度も低い |
| `src/lib/schedule-manager.ts` | tmux captureを直接使用せず、claude-executor経由の非インタラクティブ実行のみ |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/[id]/terminal/route.ts` (L78): sendKeys()直接呼び出し -- キャッシュ無効化フック挿入候補
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/[id]/capture/route.ts` (L70): capturePane()直接呼び出し -- キャッシュバイパス設計
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/cli-tools/base.ts` (L64-67): BaseCLITool.interrupt()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/session-cleanup.ts` (L61-120): cleanupWorktreeSessions()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/cli-session.ts` (L38-72): captureSessionOutput()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/auto-yes-manager.ts` (L576-636): detectAndRespondToPrompt()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/tmux.ts` (L89-116): listSessions()
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/route.ts` (L44-89): N+1パターン主要箇所
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/app/api/worktrees/[id]/route.ts` (L54-99): 同一N+1パターン

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/CLAUDE.md`: モジュール説明テーブル更新計画

### 前回レビュー結果
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/dev-reports/issue/405/issue-review/stage3-review-result.json`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/dev-reports/issue/405/issue-review/stage4-apply-result.json`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/dev-reports/issue/405/issue-review/stage5-review-result.json`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/dev-reports/issue/405/issue-review/stage6-apply-result.json`
