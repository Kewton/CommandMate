> **Note**: このIssueは 2026-03-04 にレビュー結果（イテレーション2 Stage 8: 影響範囲レビュー2回目の指摘反映）を反映して更新されました。
> 詳細: dev-reports/issue/405/issue-review/

## 概要

GET /api/worktrees のN+1クエリパターン、tmux captureの重複取得、クライアント/サーバーのポーリング効率を一体的に改善する。

## 背景・課題

### S1: GET /api/worktrees の N+1 パターン
- `src/app/api/worktrees/route.ts` (L35-99) で、各worktreeに対して5つのCLIツール全てに `isRunning()` + `captureSessionOutput()` を実行
- 10 worktree × 5 CLI = 50回のtmux操作が1回のAPIコールで発生
- クライアントが2-5秒ごとにこのAPIを呼び出すため、毎秒10-25回のtmux操作
- **補足**: `isRunning()` は全5ツールで `tmux.hasSession()` を呼び出しており、さらに `captureSessionOutput()` 内部（`cli-session.ts` L51）でも `hasSession()` で存在確認を行うため、同一セッションに対して `hasSession()` が2回呼ばれるケースがある

### S3: tmux capture結果のキャッシュなし
- 同一セッションの出力を複数APIから重複取得:
  - GET /api/worktrees（ステータス検出用、100行/opencode時200行）
  - GET /api/worktrees/:id（個別worktree取得、ステータス検出用）
  - GET /api/worktrees/:id/current-output（UI表示用、10,000行）
  - POST /api/worktrees/:id/prompt-response（プロンプト応答前の再検証用、5,000行 -- リアルタイム性要求高）
  - auto-yes poller（プロンプト検出用、5,000行）
  - response poller（レスポンス取得用、10,000行）
  - assistant-response-saver（保留中レスポンス保存用）

### P1: クライアントポーリング2秒間隔（処理中）
- `WorktreeSelectionContext.tsx` (L29-36) で処理中2秒、セッション実行中5秒、アイドル10秒
- 全worktreeのステータスを一括取得するため、S1のN+1が増幅される

### P2: auto-yesポーラー2秒間隔×worktree数
- `auto-yes-manager.ts` (L69) でworktreeごとに独立して2秒ごとにtmux capture
- S3と合わせて同一セッションの重複取得が発生

## 提案する解決策

### 1. tmux captureキャッシュ導入（1-2秒TTL）
- セッションID単位でcapture結果をキャッシュ
- 複数API/pollerからの重複取得を排除
- 期待効果: tmux操作回数を1/5〜1/10に削減

**captureLines行数差異への対応方針（A案採用）:**
- 呼び出し箇所ごとにcaptureLines引数が異なる（100行〜10,000行）
- **A案を採用**: 最大行数（10,000行）でキャッシュし、少ない行数要求にはsliceで対応
  - メリット: 実装がシンプル、キャッシュヒット率が最大化
  - メモリ見積もり: 10worktree × 10,000行 × 約100bytes/行 = 約10MB（許容範囲）
  - 100行要求時はキャッシュ済み10,000行の末尾100行をsliceで返却
  - **ANSIエスケープシーケンスの考慮**: sliceは行ベース（`output.split('\n').slice(-requestedLines).join('\n')`）で実施する。tmux `-e`フラグによるANSI preserveモードでは行をまたぐANSIエスケープシーケンスが存在する可能性があるが、後段で`stripAnsi()`が適用される箇所では問題にならない。`current-output` APIの`fullOutput`フィールドなどANSI付きで返却される箇所については、実装時にslice結果とtmux直接取得結果の差異を検証する受入テストを設ける

**キャッシュ無効化戦略:**
- TTLベースの自動失効（1-2秒）に加え、Write操作時の明示的なキャッシュ無効化を組み合わせる:
  - `sendKeys()` / `sendMessage()` / `sendSpecialKeys()` 呼び出し時: 該当セッションのキャッシュをクリア（ユーザーコマンド送信直後に古いキャッシュが返される問題を防止）
  - `killSession()` 呼び出し時: 該当セッションのキャッシュをクリア（セッション停止後のキャッシュ残留を防止）
  - `prompt-response` API: キャッシュをバイパスしてフレッシュな取得を行うオプションを提供（応答直前の最新出力確認というリアルタイム性要求に対応）
  - auto-yes応答直後: 該当セッションのキャッシュをクリア（二重応答リスクを防止）

**auto-yes応答後のキャッシュ無効化タイミング詳細設計:**
- `detectAndRespondToPrompt()` 内の `sendPromptAnswer()` 呼び出し後、**try-finallyパターン**でキャッシュクリアを保証する:
  ```
  try {
    await sendPromptAnswer(...)
  } finally {
    clearCache(sessionName)  // 成功・失敗に関わらず必ず実行
  }
  scheduleNextPoll(...)  // キャッシュクリア後にスケジュール
  ```
- 実行順序: `sendPromptAnswer()` -> キャッシュクリア（finally保証） -> `scheduleNextPoll()`
- `prompt-answer-sender.ts` の `sendKeys()` / `sendSpecialKeys()` 呼び出しもキャッシュ無効化フック対象とする（応答送信経路の漏れを防止）

**captureSessionOutput()のインターフェース方針（A案採用）:**
- キャッシュ導入に際し、`captureSessionOutput()` の関数シグネチャは変更しない
- **A案を採用**: キャッシュモジュール側で`hasSession`チェック済みフラグを管理し、`captureSessionOutput()`のインターフェースは変更しない
  - キャッシュヒット時: `hasSession()`呼び出しをスキップ（キャッシュ書き込み時点でセッション存在が確認済み）
  - キャッシュミス時: 従来通り`hasSession()` -> `capturePane()`の順序で実行
  - エラーメッセージの後方互換性を完全に維持（セッション不在時は従来と同一のエラーメッセージをthrow）
- これにより既存テスト（auto-yes-manager.test.tsの90箇所以上のモック等）の修正が不要

### 2. GET /api/worktrees で実行中CLIツールのみ状態取得
- `isRunning()`が`false`のCLIツールに対する`captureSessionOutput()`をスキップ
- DB上のactive CLI toolを先に確認し、それ以外はスキップ
- 期待効果: 5N → 1N操作に削減

### 3. ポーリング間隔の見直し
- 処理中の最小間隔を2秒→3秒に延長を検討
- auto-yesポーラーのインターバルをcaptureキャッシュTTLに合わせる

## 実装タスク

- [ ] tmux captureキャッシュモジュール作成（Map + TTL + 自動eviction）
  - **globalThisパターン準拠**: `declare global { var __tmuxCaptureCache: Map<string, CacheEntry> | undefined; }` + `globalThis.__tmuxCaptureCache ?? (globalThis.__tmuxCaptureCache = new Map())` で初期化（Next.js hot reload対応、既存のauto-yes-manager/schedule-manager/version-checkerと同一パターン）
- [ ] キャッシュ無効化: sendKeys/sendMessage/sendSpecialKeys/killSession呼び出し時のキャッシュクリア実装
  - フック挿入方式: **B案（呼び出し元での明示的キャッシュクリア）を採用**（tmux.tsへのキャッシュモジュール依存を避け、循環依存リスクを排除）
  - フック挿入箇所: prompt-answer-sender.ts、claude-session.ts、codex.ts、gemini.ts、opencode.ts、vibe-local.ts、session-cleanup.ts、**terminal/route.ts**（sendKeys()後のキャッシュクリア）
  - **注意（漏れ防止策）**: B案では新規CLIツール追加時にキャッシュ無効化フックの挿入漏れリスクがある。以下の対策を実施する:
    - CLAUDE.mdのCLIツールモジュール説明に「新規CLIツール追加時、sendMessage()/killSession()実装にtmux captureキャッシュの無効化フック（`clearCache(sessionName)`）を挿入すること」の注記を追加
    - 受入テストに「全CLIツールのsendMessage()後にキャッシュが無効化されること」の網羅的テストを追加
- [ ] キャッシュ無効化: prompt-response APIでのキャッシュバイパスオプション実装
- [ ] キャッシュ無効化: auto-yes応答後のtry-finallyパターンによるキャッシュクリア実装
- [ ] GET /api/worktrees: DBのworktreeレコードからactive CLI tool情報を事前取得し、isRunning()呼び出し対象を絞り込む（tmux list-sessionsの一括取得も検討）
- [ ] GET /api/worktrees/[id]: worktrees/route.tsと同等のlistSessions()一括取得・active CLI tool絞り込みを適用（個別worktree取得APIも2秒間隔のポーリング対象であり、同一のN+1パターン（L54-88: 全5ツールへのisRunning() + captureSessionOutput()ループ）を持つため、同等の最適化が必要）
- [ ] isRunning()最適化: **A案（route.ts側でlistSessions()を1回呼び、結果のセッション名リストからcliTool.getSessionName(worktreeId)が含まれるかを直接判定）**によるN+1解消（5N回のhas-sessionを1回のlist-sessionsに集約、ICLIToolインターフェース変更不要）。**適用範囲: worktrees/route.tsおよびworktrees/[id]/route.tsの両方**
- [ ] auto-yes-manager: キャッシュ経由でcapture取得
- [ ] response-poller: キャッシュ経由でcapture取得
- [ ] current-output API: キャッシュ経由でcapture取得
- [ ] ユニットテスト
  - **既存テストが変更なしでパスすること**を確認（captureSessionOutput()のインターフェース非変更方針に基づく）
  - キャッシュモジュールのモック or TTL=0設定によるキャッシュ無効化でテスト分離
  - **全CLIツールのsendMessage()後にキャッシュが無効化されること**の網羅的テスト（B案の漏れ防止策）
- [ ] CLAUDE.mdのモジュール説明テーブル更新（新規: `src/lib/tmux-capture-cache.ts`（globalThisキャッシュ記述含む）、既存モジュールのIssue #405変更内容反映、**新規CLIツール追加時のキャッシュ無効化フック挿入ガイドライン追記**）

## 受入条件

- [ ] 同一セッションの重複tmux captureが排除されること
- [ ] 非実行中CLIツールへの不要なtmux操作がスキップされること
- [ ] キャッシュ導入後、セッションステータスの反映遅延がキャッシュTTL（1-2秒）以内に収まること
- [ ] ユーザーがコマンド送信後、次回ポーリングでステータスが更新されること（キャッシュ無効化が正しく動作すること）
- [ ] 既存のプロンプト検出・auto-yes動作に影響がないこと
- [ ] テストがパスすること
- [ ] **captureSessionOutput()のインターフェースが変更されないこと**（既存テストが変更なしでパスすること）
- [ ] **GET /api/worktrees/[id] にもlistSessions()一括取得・active CLI tool絞り込みが適用されていること**

## 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| 新規: `src/lib/tmux-capture-cache.ts` | キャッシュモジュール（globalThisパターン） |
| `src/app/api/worktrees/route.ts` | 実行中CLIのみcapture、キャッシュ利用、**listSessions()1回呼び出しによるisRunning()判定** |
| `src/app/api/worktrees/[id]/route.ts` | キャッシュ利用、**listSessions()1回呼び出しによるisRunning()判定**（worktrees/route.tsと同等の最適化を適用） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | キャッシュ利用 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | キャッシュ利用候補（リアルタイム性要求高のためバイパスオプション要検討） |
| `src/app/api/worktrees/[id]/terminal/route.ts` | `sendKeys()`後のキャッシュ無効化フック挿入（B案に基づく呼び出し元での明示的キャッシュクリア。ユーザーがターミナルUIからコマンド送信した直後に古いキャッシュが返されることを防止） |
| `src/app/api/worktrees/[id]/capture/route.ts` | **キャッシュ対象外**（設計判断）: `capturePane(sessionName, safeLines)`を直接呼び出しており、`captureSessionOutput()`を経由しない。ターミナルUI向けの専用APIとして、ユーザーが指定した行数でcapturePaneを直接呼ぶ設計であり、キャッシュ層（最大10,000行の固定キャッシュ+sliceパターン）とは異なるユースケースのため、意図的にキャッシュ対象外とする。キャッシュTTL=2秒以内での同時tmuxアクセスは許容する |
| `src/lib/auto-yes-manager.ts` | キャッシュ利用 |
| `src/lib/response-poller.ts` | キャッシュ利用 |
| `src/lib/assistant-response-saver.ts` | キャッシュ利用候補 |
| `src/lib/tmux.ts` | list-sessions一括取得の利用（route.ts側から呼び出し） |
| `src/lib/cli-session.ts` | キャッシュ利用時のhasSession()スキップ（インターフェース変更なし） |
| `src/contexts/WorktreeSelectionContext.tsx` | ポーリング間隔見直し（必要に応じて） |
| `src/lib/prompt-answer-sender.ts` | sendKeys/sendSpecialKeys後のキャッシュクリア |
| `src/lib/claude-session.ts` | sendMessageToClaude/stopClaudeSession後のキャッシュクリア |
| `src/lib/cli-tools/codex.ts` | sendMessage後のキャッシュクリア |
| `src/lib/cli-tools/gemini.ts` | sendMessage後のキャッシュクリア |
| `src/lib/cli-tools/opencode.ts` | sendMessage/killSession後のキャッシュクリア |
| `src/lib/cli-tools/vibe-local.ts` | sendMessage後のキャッシュクリア |
| `src/lib/session-cleanup.ts` | graceful shutdown時のキャッシュクリア追加（Facadeパターンの拡張） |
| `CLAUDE.md` | モジュール説明テーブル更新、**新規CLIツール追加時のキャッシュ無効化フック挿入ガイドライン追記** |

---

## レビュー履歴

### イテレーション 1 - Stage 2 (2026-03-04)
- **R1-007** (must_fix): 受入条件「UIのステータス更新遅延が体感上許容範囲」を定量的基準に具体化（キャッシュTTL以内 + キャッシュ無効化動作の検証条件を追加）
- **R1-001** (should_fix): S3セクションと影響範囲テーブルにcaptureSessionOutput全呼び出し箇所を追加（worktrees/[id]/route.ts、prompt-response/route.ts、assistant-response-saver.ts）
- **R1-002** (should_fix): キャッシュ設計方針（captureLines行数差異へのA案採用、メモリ見積もり）を「提案する解決策 > 1.」に追記
- **R1-003** (should_fix): 実装タスクにisRunning()最適化・tmux list-sessions一括取得を追加
- **R1-005** (should_fix): キャッシュ無効化戦略（sendKeys/killSession後のキャッシュクリア、prompt-responseバイパス、auto-yes応答後クリア）を「提案する解決策 > 1.」に追記
- **R1-009** (should_fix): 実装タスクに「CLAUDE.mdのモジュール説明テーブル更新」を追加
- **R1-010** (should_fix): 実装タスクの「GET /api/worktrees: 実行中CLIツールのみcapture」をDBからのactive CLI tool事前取得・isRunning()呼び出し対象絞り込みの説明に修正

### イテレーション 1 - Stage 4 (2026-03-04)
- **R3-001** (must_fix): auto-yes応答後のキャッシュ無効化タイミング詳細設計を追記（sendPromptAnswer() -> try-finallyキャッシュクリア -> scheduleNextPoll()の順序、prompt-answer-sender.tsのsendKeys()/sendSpecialKeys()もフック対象に追加）
- **R3-002** (must_fix): captureSessionOutput()のインターフェース非変更方針（A案: キャッシュモジュール側でhasSessionチェック済みフラグ管理）を「提案する解決策」に追記、受入条件に「captureSessionOutput()のインターフェースが変更されないこと」を追加
- **R3-005** (should_fix): 影響範囲テーブルにキャッシュ無効化フック挿入箇所を追加（prompt-answer-sender.ts、claude-session.ts、codex.ts、gemini.ts、opencode.ts、vibe-local.ts、session-cleanup.ts）
- **R3-006** (should_fix): 実装タスクのユニットテストに「既存テストが変更なしでパスすること確認」を追加
- **R3-007** (should_fix): 実装タスクのキャッシュモジュール作成にglobalThisパターン準拠（declare global + globalThis初期化）を明記
- **R3-008** (should_fix): 影響範囲テーブルに`src/lib/session-cleanup.ts`（graceful shutdown時のキャッシュクリア）を追加
- **R3-009** (should_fix): A案のslice操作に関するANSIエスケープシーケンス考慮を「提案する解決策 > captureLines行数差異への対応方針」に追記
- **R3-012** (should_fix): isRunning()最適化の設計方針（A案: route.ts側でlistSessions()を1回呼び判定、ICLIToolインターフェース変更不要）を実装タスクに明記

### イテレーション 2 - Stage 6 (2026-03-04)
- **R5-001** (should_fix): 実装タスクに「GET /api/worktrees/[id]: worktrees/route.tsと同等のlistSessions()一括取得・active CLI tool絞り込みを適用」を独立項目として追加。isRunning()最適化タスクの適用範囲にworktrees/[id]/route.tsを明記。影響範囲テーブルのworktrees/[id]/route.tsの変更内容をlistSessions()1回呼び出しによるisRunning()判定に更新。受入条件に「GET /api/worktrees/[id]にもlistSessions()一括取得が適用されていること」を追加
- **R5-002** (should_fix): キャッシュ無効化フック挿入方式B案の漏れ防止策を追加。実装タスクに「CLAUDE.mdへの新規CLIツール追加時のキャッシュ無効化フック挿入ガイドライン追記」を追加。ユニットテスト項目に「全CLIツールのsendMessage()後にキャッシュが無効化されること」の網羅的テストを追加。影響範囲テーブルのCLAUDE.md行にガイドライン追記を明記

### イテレーション 2 - Stage 8 (2026-03-04)
- **R7-001** (should_fix): 影響範囲テーブルに`src/app/api/worktrees/[id]/capture/route.ts`を追加。`capturePane()`を直接呼び出しており、キャッシュ層をバイパスする設計であることを明記。ターミナルUI向け専用APIとしてキャッシュ対象外とする設計判断を注記
- **R7-002** (should_fix): 影響範囲テーブルに`src/app/api/worktrees/[id]/terminal/route.ts`を追加。`sendKeys()`後のキャッシュ無効化フック挿入が必要であることを明記。実装タスクのキャッシュ無効化フック挿入箇所リストにterminal/route.tsを追加
