# Issue #405 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-04
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**ステージ**: 3（影響範囲レビュー 1回目）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 7 |
| Nice to Have | 3 |
| **合計** | **12** |

### 全体評価: medium

Issue #405のStage 2更新により、キャッシュ設計の方針（A案採用、メモリ見積もり10MB、キャッシュ無効化戦略）が大幅に改善された。しかし、影響範囲レビューの観点から、auto-yesの二重応答リスク、captureSessionOutput()のインターフェース互換性、キャッシュ無効化フックの挿入箇所の網羅性、既存テストへの影響という4つの重要な課題が残っている。

---

## Must Fix（必須対応）

### R3-001: auto-yes-managerのキャッシュ利用がプロンプト検出の二重応答リスクを生む

**カテゴリ**: reliability
**対象セクション**: 提案する解決策 > 1. キャッシュ無効化戦略

**問題**:

auto-yes-manager.ts の `captureAndCleanOutput()` (L503-512) は `captureSessionOutput()` でプロンプト検出を行い、自動応答する。キャッシュ導入後、以下の競合シナリオが発生し得る:

1. auto-yes pollerが t=0 でキャッシュ書き込み（プロンプト検出、応答送信）
2. t=0.5秒後に current-output API がキャッシュヒット（同じプロンプトが表示される）
3. UIがプロンプトを表示、ユーザーが手動で応答しようとする
4. 実際にはauto-yesが既に応答済みで、ユーザーの入力がCLIの通常入力として送信される

Issueの「auto-yes応答直後のキャッシュクリア」だけでは不十分。`detectAndRespondToPrompt()` (L576-636) 内の `sendPromptAnswer()` 呼び出し後、キャッシュクリアされる前に他のAPIがキャッシュを読む時間窓が存在する。

**証拠**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/auto-yes-manager.ts` L610-622:
```typescript
await sendPromptAnswer({
  sessionName,
  answer,
  cliToolId,
  promptData: promptDetection.promptData,
});
// ここでキャッシュクリアが必要だが、sendPromptAnswerとクリアの間に他のAPIがキャッシュヒットする可能性
updateLastServerResponseTimestamp(worktreeId, Date.now());
resetErrorCount(worktreeId);
pollerState.lastAnsweredPromptKey = promptKey;
```

**推奨対応**:

- `sendPromptAnswer()` 呼び出し直後にキャッシュクリアをtry-finallyで確実に実行
- 実装タスクに「auto-yes応答後のキャッシュ無効化タイミングの詳細設計」を追加
- `prompt-answer-sender.ts`内の`sendKeys()`/`sendSpecialKeys()`呼び出しもキャッシュ無効化のフック対象に含める

---

### R3-002: captureSessionOutput()内のhasSession()スキップによるエラーハンドリング変更

**カテゴリ**: compatibility
**対象セクション**: 影響範囲テーブル > src/lib/cli-session.ts

**問題**:

現在の `cli-session.ts captureSessionOutput()` (L38-72) は、`capturePane()` の前に `hasSession()` でセッション存在確認を行い、存在しない場合は明確なエラーメッセージ（`${cliTool.name} session ${sessionName} does not exist`）をthrowする。

Issueでは「キャッシュ利用時のhasSession()スキップ」と記載されているが:

1. キャッシュヒット時: 問題なし
2. キャッシュミス時: `capturePane()`が直接呼ばれ、セッション不在時に異なるエラーメッセージ（`Failed to capture pane: ...`）がthrowされる

呼び出し元のcatchロジックがエラーメッセージに依存している可能性がある。

**証拠**:

`/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/cli-session.ts` L51-55:
```typescript
const exists = await hasSession(sessionName);
if (!exists) {
  log.debug('captureSessionOutput:sessionNotFound', { sessionName });
  throw new Error(`${cliTool.name} session ${sessionName} does not exist`);
}
```

**推奨対応**:

A案（推奨）: キャッシュモジュール側でhasSessionチェック済みフラグを管理し、captureSessionOutput()のインターフェースは変更しない。
受入条件に「セッション不在時のエラーメッセージの後方互換性を保証するテスト」を追加。

---

## Should Fix（推奨対応）

### R3-003: response-pollerのキャッシュ利用が応答抽出の正確性に影響する可能性

**カテゴリ**: impact
**対象セクション**: 影響範囲テーブル > src/lib/response-poller.ts

response-pollerは独自のポーリングループを持ち、前回のcapture結果（lastCapturedLine）との差分で新しい出力を検出する。キャッシュ導入時、auto-yesの応答後にキャッシュクリアされない場合、response-pollerが古いキャッシュを読みauto-yesの応答結果を見逃す可能性がある。

また、response-pollerのポーリング間隔（~2秒）とキャッシュTTL（2秒）がほぼ同一のため、キャッシュの恩恵は他のAPIとの重複排除に限定される。

---

### R3-004: prompt-response APIのキャッシュバイパスとauto-yesの競合

**カテゴリ**: impact
**対象セクション**: 影響範囲テーブル > src/app/api/worktrees/[id]/prompt-response/route.ts

prompt-response APIとauto-yes-managerが同時にプロンプトに応答しようとする場合、キャッシュバイパスによりauto-yes応答後の「古い出力」を取得する確率が上がる。この問題はキャッシュ有無に関わらず元々存在するため、Issue #405のスコープ外として明記するか、軽減策を検討すべき。

バイパス時にフレッシュ取得した結果をキャッシュに書き戻すかどうかの設計も明記すべき。

---

### R3-005: tmux.ts sendKeys()へのキャッシュ無効化フック挿入がIssue #393のexecFile()移行と整合するか

**カテゴリ**: compatibility
**対象セクション**: 影響範囲テーブル / 実装タスク

キャッシュ無効化の実装として、以下の箇所を網羅的に列挙すべき:

1. `prompt-answer-sender.ts`: sendKeys()/sendSpecialKeys()の後
2. `claude-session.ts`: sendMessageToClaude()内のsendKeys()後、stopClaudeSession()内
3. `cli-tools/codex.ts`: sendMessage()内
4. `cli-tools/gemini.ts`: sendMessage()内
5. `cli-tools/opencode.ts`: sendMessage()内、killSession()内
6. `cli-tools/vibe-local.ts`: sendMessage()内
7. `session-cleanup.ts`: セッション停止時

B案（呼び出し元での明示的キャッシュクリア）が推奨だが、漏れリスクがあるため影響範囲テーブルに全箇所を記載すべき。

---

### R3-006: 既存テストのcaptureSessionOutputモック箇所への影響が大きい

**カテゴリ**: test
**対象セクション**: 実装タスク > ユニットテスト

10ファイル以上、auto-yes-manager.test.tsだけで90箇所以上のモック呼び出しが存在する。

**影響テストファイル一覧**:
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/unit/lib/auto-yes-manager.test.ts` (90+ 箇所)
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/unit/lib/claude-session.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/unit/capture-route.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/unit/api/prompt-response-verification.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/integration/trust-dialog-auto-response.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/integration/issue-265-acceptance.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/tests/integration/api-hooks.test.ts`
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-405/src/lib/__tests__/assistant-response-saver.test.ts`

**推奨**: `captureSessionOutput()`のインターフェースを変更しない設計を採用し、受入条件に「既存テストが変更なしでパスすること」を追加。

---

### R3-007: globalThisパターンとの整合性

**カテゴリ**: compatibility
**対象セクション**: 実装タスク > tmux captureキャッシュモジュール作成

プロジェクトで確立されたglobalThisパターン（auto-yes-manager, schedule-manager, claude-executor, version-checker）との整合性を保つため、以下を明記すべき:

1. キャッシュはglobalThisパターンを使用する（Next.js hot reload対応）
2. `declare global { var __tmuxCaptureCache: Map<string, CacheEntry> | undefined; }`
3. graceful shutdown時のキャッシュクリアをsession-cleanup.tsに追加

---

### R3-008: schedule-managerの影響範囲の明確化

**カテゴリ**: impact
**対象セクション**: 影響範囲テーブル

schedule-manager.tsはcaptureSessionOutput()を直接呼び出していない（executeClaudeCommand()による非インタラクティブ実行のみ）。直接的な影響はないが、graceful shutdownのクリーンアップ対象として関連する。影響範囲テーブルでの位置づけを明確化すべき。

---

### R3-009: A案sliceの透過性

**カテゴリ**: impact
**対象セクション**: 提案する解決策 > 1. > captureLines行数差異への対応方針

10,000行キャッシュの末尾100行をsliceで取得した結果と、tmuxのstartLine=-100で直接取得した結果に微妙な差異がある可能性（ANSIエスケープシーケンスの行またぎ）。current-output APIのfullOutputフィールドなどANSI付きで返却される箇所では影響あり。

---

## Nice to Have（あれば良い）

### R3-010: 影響範囲テーブルに不足しているファイル

以下のファイルを影響範囲テーブルに追加すべき:
- `src/lib/session-cleanup.ts`: graceful shutdown時のキャッシュクリア追加
- `src/lib/prompt-answer-sender.ts`: キャッシュ無効化フック挿入候補
- `src/lib/claude-session.ts`: sendMessageToClaude/stopClaudeSession後のキャッシュクリア
- `src/lib/cli-tools/*.ts`: 各ツールのsendMessage/killSession後のキャッシュクリア

### R3-011: キャッシュ内のセンシティブ情報への考慮

セキュリティ影響は軽微（tmux scrollbackバッファ自体がメモリ上に存在するため）だが、キャッシュモジュールのJSDocにセンシティブ情報の取扱いとTTL切れ後のGC対象化を記載すべき。

### R3-012: isRunning()最適化のICLIToolインターフェースへの影響

tmux list-sessions一括取得のA案（route.ts側でlistSessions()を1回呼び、結果のセッション名リストからgetSessionName()が含まれるかを直接判定）が最もインターフェース変更が少なく推奨。

---

## 参照ファイル

### コード（影響を受けるファイル）

| ファイル | 影響内容 |
|---------|---------|
| `src/lib/auto-yes-manager.ts` | キャッシュ利用、応答後のキャッシュ無効化 |
| `src/lib/cli-session.ts` | キャッシュ導入の主要インターフェース |
| `src/lib/response-poller.ts` | 10000行captureのキャッシュ利用 |
| `src/app/api/worktrees/route.ts` | N+1パターン改善の主要箇所 |
| `src/app/api/worktrees/[id]/route.ts` | 個別worktree status取得 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | 10000行captureのキャッシュ利用 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | キャッシュバイパス対象 |
| `src/lib/assistant-response-saver.ts` | 10000行captureのキャッシュ利用候補 |
| `src/lib/prompt-answer-sender.ts` | キャッシュ無効化フック挿入候補（影響範囲テーブル未記載） |
| `src/lib/session-cleanup.ts` | graceful shutdown時のキャッシュクリア（影響範囲テーブル未記載） |
| `src/lib/claude-session.ts` | sendMessageToClaude/stopClaudeSession後のキャッシュクリア |
| `src/lib/cli-tools/*.ts` | 各ツールのsendMessage/killSession後のキャッシュクリア |
| `src/lib/tmux.ts` | listSessions()一括取得、sendKeys/killSessionとの関係 |
| `tests/unit/lib/auto-yes-manager.test.ts` | 90+ captureSessionOutputモック箇所 |

### ドキュメント

| ファイル | 関連内容 |
|---------|---------|
| `CLAUDE.md` | モジュール説明テーブル更新（新規tmux-capture-cache.ts、既存モジュール更新） |
