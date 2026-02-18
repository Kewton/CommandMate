> **Note**: このIssueは 2026-02-18 にレビュー結果（Stage 1-5: 通常レビュー2回・影響範囲レビュー・指摘反映2回）を反映して更新されました。
> 詳細: dev-reports/issue/306/issue-review/

## 概要

tmuxセッションが定期的に削除（kill→再作成）される、またはUIでセッションが認識されない問題。主に3つの原因と1つのデバッグ改善点が特定されている。

1. **サーバー側Auto-Yes Pollerの重複応答**: 同一プロンプトに対して繰り返し応答が送信され、Claude CLIが不正状態に陥り終了する
2. **長時間実行タスクでのコンテキスト枯渇**: コンテキストウィンドウが枯渇するとClaude CLIが終了し、ヘルスチェックがセッションをkillする
3. **ヘルスチェックの偽陽性（SHELL_PROMPT_ENDINGS誤判定）**: Claude CLIステータスバーの `Context left until auto-compact: N%` の末尾 `%` がzshシェルプロンプトと誤判定され、正常稼働中のセッションが「不健全」と判定される

いずれの場合も、ヘルスチェック（`isSessionHealthy`）の判定によりセッションがkillされる、またはUIで `isSessionRunning: false` と表示される。

## 再現手順

### パターンA: Auto-Yes重複応答

1. Worktreeに対してClaude CLIセッションを起動する
2. Auto-Yesモードを有効にする
3. Claude CLIが権限プロンプト等を表示する状態にする
4. しばらく待つ（数分～数十分）
5. → セッションが消失し、再作成される

### パターンB: コンテキスト枯渇

1. Worktreeに対してClaude CLIセッションを起動する
2. `/pm-auto-issue2dev` 等の長時間・大規模タスクを実行する（Auto-Yes有効）
   - **補足**: `/pm-auto-issue2dev` は自動開発ワークフローコマンドで、多数のファイル変更を伴う長時間タスク
3. コンテキスト残量が1%程度まで低下する
4. auto-compactが実行されるが、失敗またはCLI終了に至る
5. → セッションが消失し、再作成される

**実際の確認例（feature-299-worktree）**:
- 経過時間: 1時間26分、トークン消費: 137.5k、変更: 50ファイル +303/-9行
- Phase 5（TDD自動開発）途中でプロンプト待機状態に停止
- コンテキスト残量: **1%**（ほぼ枯渇）

### パターンC: ヘルスチェック偽陽性（SHELL_PROMPT_ENDINGS誤判定）

1. Claude CLIセッションが正常に稼働している状態にする
2. コンテキスト残量が低下し、ステータスバーに `Context left until auto-compact: N%` が表示される
   - **目安**: 任意のタスクを20-30分以上実行するとステータスバーが表示される場合がある
3. CommandMateのUIでWorktree詳細画面を開く
4. → **tmuxセッションは存在しClaude CLIも正常稼働中なのに、UIではセッションが「停止中」と表示される**

**実際の確認例（commandmate-marketing-main）**:
- tmuxセッション `mcbd-claude-commandmate-marketing-main` は存在
- Claude CLIはプロンプト待機中（`❯`）で正常稼働
- ステータスバー末尾: `Context left until auto-compact: 7%`
- API応答: `isSessionRunning: false`（誤判定）

**原因**: `isSessionHealthy()` の `SHELL_PROMPT_ENDINGS` チェック（`claude-session.ts:58,288`）が、Claude CLIステータスバーの `7%` の末尾 `%` をzshシェルプロンプト `%` と誤判定している。

```
tmux出力の末尾行:
  5 files +242 -113                        Context left until auto-compact: 7%
                                                                             ^
                                                                    この % がマッチ
```

## 期待する動作

- Auto-Yesは各プロンプトに対して1回だけ応答を送信する
- コンテキスト枯渇時にセッションが適切にハンドリングされる（即kill ではなく状態を保持）
- Claude CLIのステータスバー表示（`N%`）がシェルプロンプトと誤判定されない
- Claude CLIセッションが安定して維持される
- セッションが意図せず削除されない

## 実際の動作

- Auto-Yes Pollerが同一プロンプトに対して繰り返し応答を送信する（feature-299で129回のSent responseを確認）
- 重複キーストロークによりClaude CLIが不正状態に陥り終了する
- コンテキスト枯渇時にClaude CLIが終了し、tmuxペインにシェルプロンプトが残る
- **正常稼働中のClaude CLIセッションがヘルスチェックで偽陽性判定される**（`N%` → `%` 誤検出）
- ヘルスチェックがシェルプロンプトを検出し、セッションをkillする
- ログ上では `feature-287-worktree` が5回、`feature-288-worktree` が3回、`feature-302-worktree` が2回再作成されている

## 根本原因

### 原因1: サーバー側Auto-Yes Pollerの重複応答防止欠如

`src/lib/auto-yes-manager.ts` の `pollAutoYes()`（274-369行）にサーバー側の重複防止メカニズムがない。

```
クライアント側（useAutoYes.ts）：重複防止あり
  - promptKey による同一プロンプト判定（77-78行）
  - lastServerResponseTimestamp による3秒ウィンドウ（68-73行）

サーバー側（auto-yes-manager.ts）：重複防止なし ← 問題
  - detectPrompt → sendPromptAnswer → scheduleNextPoll のループ
  - 前回送信したプロンプトとの比較ロジックなし
```

障害シーケンス：
1. Auto-Yesがプロンプトを検出し応答を送信
2. Claude CLIが応答を処理する前に（2秒以内）次のポーリングが発生
3. 同じプロンプトに重複応答が送信される
4. 余分なキーストローク（矢印キー、Enter）がClaude CLIに送られる
5. 予期しない入力によりClaude CLIが終了する
6. tmuxペインにシェルプロンプト（$, %, #）が表示される
7. ヘルスチェック（`isSessionHealthy`）が異常を検出
8. 次のsend API呼び出しで `ensureHealthySession` がセッションをkill

### 原因2: コンテキスト枯渇によるClaude CLI終了

長時間実行タスク（`/pm-auto-issue2dev` 等）でコンテキストウィンドウが枯渇すると、Claude CLIがauto-compactを試みるが、以下のケースでセッション終了に至る：

- auto-compact自体が失敗する場合
- auto-compact後もコンテキストが不足する場合
- コンテキスト残量1%でCLIが応答不能になる場合

Claude CLI終了後、tmuxペインにはシェルプロンプトが表示され、ヘルスチェック（`isSessionHealthy`、`claude-session.ts:262-296`）が以下の条件で不健全と判定する：

| 条件 | 行 | リスク |
|------|-----|--------|
| 空出力 (`trimmed === ''`) | 285 | 高 - 初期化中・CLI終了後に発生 |
| シェルプロンプト末尾 (`$`, `%`, `#`) | 288 | 高 - CLIプロセス終了後に検出 |
| エラーパターン一致 | 268-277 | 中 - 偽陽性の可能性 |

現状のヘルスチェックは「CLIが終了した」ことは検出できるが、**終了理由を区別しない**。コンテキスト枯渇による正常終了もエラーとして扱われ、即座にセッションがkillされる。

### 原因3: SHELL_PROMPT_ENDINGSの偽陽性（ヘルスチェック誤判定）

`src/lib/claude-session.ts:58` で定義された `SHELL_PROMPT_ENDINGS` が、Claude CLIの正常な出力に含まれる `%` を誤検出する。

```typescript
// claude-session.ts:58
const SHELL_PROMPT_ENDINGS: readonly string[] = ['$', '%', '#'] as const;

// claude-session.ts:288
if (SHELL_PROMPT_ENDINGS.some(ending => trimmed.endsWith(ending))) {
  return false;  // ← 偽陽性で不健全判定
}
```

**誤判定のメカニズム**:
- Claude CLIのステータスバーには `Context left until auto-compact: N%` が表示される
- tmux capture-paneで取得した出力の末尾行がこのステータスバー行になる場合がある
- `trimmed.endsWith('%')` が `7%` の `%` にマッチし、zshシェルプロンプト `%` と誤判定される
- 結果として `isSessionHealthy()` が `false` を返し、正常稼働中のセッションが不健全扱いになる

**影響**:
- `isClaudeRunning()` が `false` を返すため、UIでセッションが「停止中」と表示される
- `ensureHealthySession()` が呼ばれた場合、正常稼働中のセッションがkillされる
- コンテキスト残量が低いセッション（長時間稼働中）ほど発生しやすい

### 付帯的な改善点: ヘルスチェックのkill時ログ不足

> **Note**: この項目はセッション削除の直接原因ではなく、デバッグ困難性に関する改善点のため、根本原因とは分離して記載。

`src/lib/claude-session.ts:306-313` の `ensureHealthySession()` がセッションをkillする際、なぜ不健全と判定されたかのログが出力されない。

## 対策案

### 対策1: SHELL_PROMPT_ENDINGSの判定ロジック改善（必須・最優先）

単純な `endsWith` ではなく、シェルプロンプトの典型的なパターンをより正確に判定する。

**重要な変更点**: 現行コード（`claude-session.ts:280,288`）は `cleanOutput.trim()` した出力**全体の末尾文字**で判定しているが、改善案では**最終行の末尾文字**で判定する方式に変更する。これにより、tmux capture-paneの出力にステータスバー行が含まれていても、シェルプロンプト行のみを正確に判定できるようになる。

#### 3文字全てに対する偽陽性防止戦略

SHELL_PROMPT_ENDINGS の `$`, `%`, `#` 全てについて偽陽性リスクを分析し、多段防御で対処する。

| 文字 | 偽陽性リスク | 防御方式 |
|------|-------------|---------|
| `%` | コンテキスト残量表示 `N%`、進捗率表示 | 第1段階: `\d+%$` 個別パターンで除外 |
| `$` | シェル変数 `$HOME`、金額表示 `100$`、コード例中の `$` | 第2段階: 行長チェック（40文字以上）で対応。短い行での `$` 終端はシェルプロンプトの可能性が高いため個別パターンは不要 |
| `#` | Markdownの見出し行、コメント行 | 第2段階: 行長チェック（40文字以上）で対応。短い行での `#` 終端はrootプロンプトの可能性が高いため個別パターンは不要 |

> **設計判断**: `$` と `#` については個別パターンによる第1段階除外を設けず、第2段階の行長チェックで対応する。理由: (1) `%` と異なり、短い行で偽陽性となる典型的なパターン（`N%` のような数値+記号の組み合わせ）がない、(2) 行長チェックで十分カバーされ、個別パターンの過剰設計を避けるため。

**推奨: 多段防御（第1段階 + 第2段階の組み合わせ）**

1. **第1段階（個別パターン除外）**: `%` のみ `\d+%$` パターンで除外
2. **第2段階（行長チェック）**: 最終行が短い（例: 40文字以下）ことをシェルプロンプトの条件に加える（全文字共通の防御）

```typescript
// claude-session.ts:280-290 の修正案（多段防御）
// 注: 戻り値型は対策4の HealthCheckResult（{ healthy: boolean; reason?: string }）を使用
const trimmed = cleanOutput.trim();
if (trimmed === '') { return { healthy: false, reason: 'empty_output' }; }
// 最終行の取得: 空行を除外し、最後の非空行を使用する
// （tmux capture-pane出力には末尾に空行が含まれることがあるため）
const lines = trimmed.split('\n');
const lastLine = lines.filter(l => l.trim() !== '').pop()?.trim() ?? '';
// 第2段階: 行長チェック（シェルプロンプトは通常短い）
if (lastLine.length > 40) {
  // 長い行はシェルプロンプトではない可能性が高い → スキップ
} else if (SHELL_PROMPT_ENDINGS.some(ending => {
  if (!lastLine.endsWith(ending)) return false;
  // 第1段階: 個別パターン除外（% のみ）
  if (ending === '%' && /\d+%$/.test(lastLine)) return false;
  return true;
})) {
  return { healthy: false, reason: 'shell_prompt' };
}
```

> **設計根拠**: 全体末尾ではなく最終行末尾で判定する方式に変更すること自体が、tmux capture-pane出力の構造をより正確に扱う改善になる。
>
> **実装上の注意**: tmux capture-pane出力の末尾には空行が含まれることがあるため、`trimmed.split('\n').pop()?.trim()` で取得した最終行が空の場合がある。`lines.filter(l => l.trim() !== '').pop()` で非空の最後の行をフォールバックとして検査するロジックが必要（先行の `trimmed === ''` チェックで全行空のケースはカバー済み）。

### 対策2: サーバー側Auto-Yes Pollerに重複応答防止を追加（必須）

`AutoYesPollerState` に `lastAnsweredPromptKey` フィールドを追加し、同一プロンプトへの再送信を防止する。

**重要: `lastAnsweredPromptKey` のリセット条件**

プロンプト非検出時に `lastAnsweredPromptKey` を `null` にリセットする。これにより、同一プロンプトが正規に再表示された場合に再応答が可能になる。このロジックはクライアント側（`useAutoYes.ts:60-62`）の `lastAutoRespondedRef.current = null` リセットと同じ設計意図。

**重要: `startAutoYesPolling()` 内の初期化コードも修正が必要**

`AutoYesPollerState` にフィールドを追加する際、`startAutoYesPolling()` 内のpollerState初期化コード（`auto-yes-manager.ts:414-420`）にも `lastAnsweredPromptKey: null` の初期値を追加する必要がある。TypeScriptコンパイラが初期化時のプロパティ不足を検出するため、ビルドエラーとして顕在化する。

```typescript
// auto-yes-manager.ts startAutoYesPolling() 内の初期化コード修正
const pollerState: AutoYesPollerState = {
  timerId: null,
  cliToolId,
  consecutiveErrors: 0,
  currentInterval: POLLING_INTERVAL_MS,
  lastServerResponseTimestamp: null,
  lastAnsweredPromptKey: null,  // 追加
};
```

```typescript
// auto-yes-manager.ts の pollAutoYes() に追加

// プロンプト非検出時のリセット
if (!promptDetection.isPrompt || !promptDetection.promptData) {
  // プロンプトが消えたらリセット（正規の再表示に対応）
  pollerState.lastAnsweredPromptKey = null;
  scheduleNextPoll(worktreeId, cliToolId);
  return;
}

// 重複防止チェック
const promptKey = `${promptDetection.promptData.type}:${promptDetection.promptData.question}`;
if (pollerState.lastAnsweredPromptKey === promptKey) {
  scheduleNextPoll(worktreeId, cliToolId);
  return;
}
// ... sendPromptAnswer() ...
pollerState.lastAnsweredPromptKey = promptKey;
```

> **クライアント側との対称性**: `useAutoYes.ts:60-62` では `if (!isPromptWaiting) { lastAutoRespondedRef.current = null; return; }` でリセットしている。サーバー側も同様にプロンプト非検出時にリセットすることで、両者の動作を一致させる。

### 対策3: コンテキスト枯渇の検出と通知（推奨）

コンテキスト残量が低下した場合にUIへ通知し、ユーザーに判断を委ねる。

- tmux出力から `Context left until auto-compact: N%` パターンを検出
- 閾値（例: 10%）以下になった場合にUI通知（バナー等）
- Auto-Yesの自動停止オプション（コンテキスト残量低下時にAuto-Yesを無効化）

```typescript
// cli-patterns.ts に追加
export const CONTEXT_REMAINING_PATTERN = /Context left until auto-compact:\s*(\d+)%/;

// ヘルパー関数例
export function extractContextRemaining(output: string): number | null {
  const match = output.match(CONTEXT_REMAINING_PATTERN);
  return match ? parseInt(match[1], 10) : null;
}
```

> **スコープ限定**: 対策3のスコープは `cli-patterns.ts` へのパターン定数と抽出ヘルパー関数の追加のみとする。`response-poller.ts` での利用やUI通知メカニズム（WebSocket連携等）の実装は別Issueとして切り出す。パターン追加は追加のみの変更であり、既存コードへの影響はない。

### 対策4: ヘルスチェックのkill時にログ出力を追加（推奨）

`ensureHealthySession()` で不健全判定の理由をログに出力する。

**`isSessionHealthy()` の戻り値を拡張して判定理由を伝搬する**（テスト容易性の観点から推奨）:

```typescript
// HealthCheckResult は isSessionHealthy() と同じファイル（claude-session.ts）内に定義する。
// 理由: (1) 使用範囲がclaude-session.ts内部とテストのみ、
//        (2) 別ファイルに分離するほどの汎用性はない、
//        (3) @internal exportの慣例（clearCachedClaudePath()）と合わせてファイル内に閉じる方が分かりやすい。
export interface HealthCheckResult {
  healthy: boolean;
  reason?: string;  // 'error_pattern' | 'empty_output' | 'shell_prompt' | undefined
}

/**
 * @internal Exported for testing purposes only.
 * Check if the tmux session is healthy (Claude CLI is running).
 */
export async function isSessionHealthy(sessionName: string): Promise<HealthCheckResult> {
  // 各 return false 箇所で reason を設定
  // ...
  if (trimmed === '') {
    return { healthy: false, reason: 'empty_output' };
  }
  // ...
}

async function ensureHealthySession(sessionName: string): Promise<boolean> {
  const result = await isSessionHealthy(sessionName);
  if (!result.healthy) {
    console.warn(`[health-check] Session ${sessionName} is unhealthy (reason: ${result.reason}), killing...`);
    await killSession(sessionName);
    return false;
  }
  return true;
}
```

> **設計根拠**: 案Aはテストでreason値を検証可能なため、案B（各return false箇所にconsole.warnを追加）よりテスト容易性が高い。

#### 破壊的変更の防止: `isClaudeRunning()` と `ensureHealthySession()` の修正

`isSessionHealthy()` の戻り値を `boolean` から `HealthCheckResult` に変更する場合、以下の呼び出し元の修正が**必須**:

1. **`isClaudeRunning()`** (`claude-session.ts:426`): 現在 `return isSessionHealthy(sessionName)` でboolean直接返却。戻り値変更後は `.healthy` フィールドを取り出す必要がある。
   ```typescript
   // 修正前
   return isSessionHealthy(sessionName);

   // 修正後
   const result = await isSessionHealthy(sessionName);
   return result.healthy;
   ```
   この修正により、`isClaudeRunning()` の外部インターフェース（boolean戻り値）は維持される。呼び出し元（`ClaudeTool.isRunning()`、各API routes、統合テスト）への影響はない。

2. **`ensureHealthySession()`** (`claude-session.ts:306-313`): 同様に `.healthy` でブール値を取り出し、`.reason` をログ出力に使用する。

**注意**: この修正が漏れると、`isClaudeRunning()` が `HealthCheckResult` オブジェクトを返すことになり、オブジェクトは常にtruthyであるため、全ての呼び出し元（6箇所以上）でセッション状態が常にtrue（稼働中）と誤判定される。

#### `isSessionHealthy()` のexport戦略

`isSessionHealthy()` は現在 non-export の内部関数（`claude-session.ts:262`）。reason値をテストで直接検証するために、`@internal` アノテーション付きでexportする（`clearCachedClaudePath()` と同じパターン、`claude-session.ts:149-153` 参照）。

> **設計根拠**: `clearCachedClaudePath()` が同じ `@internal` exportパターンを使用しており（`claude-session.ts:154`）、プロジェクト内の既存慣例に従う。`isClaudeRunning()` の戻り値を `HealthCheckResult` に変更する案は破壊的変更が大きすぎるため非推奨。console.warnのスパイテストは脆弱性が高いため非推奨。

### 対策5: 応答送信後のクールダウン期間追加（推奨）

応答送信後、一定時間（例: 5秒）はポーリングをスキップし、Claude CLIが応答を処理する時間を確保する。

**対策2との関係**: 対策2（promptKey比較）を「主防御（論理的重複防止）」、対策5（クールダウン）を「副防御（Claude CLI処理時間確保）」として位置付ける。

- **対策2の役割**: 同一プロンプトへの論理的な重複送信を防止する
- **対策5の役割**: Claude CLIが応答を処理する物理的な時間を確保する（クールダウン中はポーリング自体をスキップするため、不要なtmux capture-paneも削減）

両方を組み合わせることで、論理的防御と時間的防御の多段防御を実現する。クールダウン中はpromptKeyチェックに到達しないため、実質的にクールダウンが優先される。

**クールダウン期間の定数化**: 応答後のクールダウン期間は `COOLDOWN_INTERVAL_MS` として定数化しexportする。テストでのタイミング値ハードコーディングを回避し、`vi.advanceTimersByTime(COOLDOWN_INTERVAL_MS)` で明確に検証可能にする。

```typescript
// auto-yes-manager.ts に追加
export const COOLDOWN_INTERVAL_MS = 5000;  // 応答送信後のクールダウン

// scheduleNextPoll() での使用
function scheduleNextPoll(worktreeId: string, cliToolId: string, afterResponse: boolean = false): void {
  const interval = afterResponse ? COOLDOWN_INTERVAL_MS : pollerState.currentInterval;
  // ...
}
```

**`pollAutoYes()` 内での `scheduleNextPoll()` 呼び出しパターン**:

現行の `pollAutoYes()` は末尾（L368付近）で共通の `scheduleNextPoll(worktreeId, cliToolId)` を呼び出している。クールダウンの適用対象は**応答送信成功後のみ**であり、以下のパターンで呼び分ける:

```typescript
// pollAutoYes() 内の呼び出しパターン整理

// (A) プロンプト非検出・重複スキップ等 → デフォルト間隔（afterResponse: false）
//     L313, L323, L331 付近
scheduleNextPoll(worktreeId, cliToolId);  // afterResponse省略 = false

// (B) 応答送信成功後 → クールダウン適用 + early return
//     try ブロック内、sendPromptAnswer() 成功後
await sendPromptAnswer({...});
pollerState.lastAnsweredPromptKey = promptKey;
scheduleNextPoll(worktreeId, cliToolId, true);  // クールダウン適用
return;  // L368の共通scheduleNextPollをスキップ

// (C) catchブロック・L368の共通パス → デフォルト間隔
scheduleNextPoll(worktreeId, cliToolId);  // afterResponse省略 = false
```

> **設計判断**: 応答送信成功後に `return` で早期脱出し、L368の共通 `scheduleNextPoll` をスキップすることで、クールダウン適用箇所を1箇所に限定する。catchブロック内のエラー後はクールダウン不要（応答が実際に送信されたか不確実なため、通常間隔で再ポーリングする方が安全）。

## 実装タスク

- [ ] `SHELL_PROMPT_ENDINGS` の判定ロジック改善（全体末尾→最終行末尾への変更、3文字全てに対する偽陽性防止の多段防御）
  - 最終行取得時に空行をフィルタリングし、非空の最後の行を使用する（tmux capture-pane出力の末尾空行対策）
- [ ] `isSessionHealthy()` にClaude CLI固有パターンの肯定的検出を追加
- [ ] `isSessionHealthy()` の戻り値を `{ healthy: boolean; reason?: string }` に拡張（テスト容易性向上）
- [ ] **`isClaudeRunning()` の修正**: `isSessionHealthy()` の戻り値変更に伴い、`.healthy` フィールドを取り出してboolean戻り値を維持する（`return isSessionHealthy(sessionName)` → `const result = await isSessionHealthy(sessionName); return result.healthy;`）
- [ ] **`ensureHealthySession()` の修正**: `.healthy` でブール値判定、`.reason` をログ出力に使用する
- [ ] `isSessionHealthy()` を `@internal` アノテーション付きでexportする（`clearCachedClaudePath()` と同じパターン）
- [ ] `HealthCheckResult` interfaceを `claude-session.ts` 内にexport定義する
- [ ] `AutoYesPollerState` に `lastAnsweredPromptKey: string | null` を追加
- [ ] `startAutoYesPolling()` の pollerState 初期化コードに `lastAnsweredPromptKey: null` を追加
- [ ] `pollAutoYes()` で前回応答済みプロンプトとの比較ロジックを実装
- [ ] `pollAutoYes()` でプロンプト非検出時の `lastAnsweredPromptKey` リセットロジックを実装
- [ ] 応答送信後のクールダウン期間を追加（`COOLDOWN_INTERVAL_MS` 定数化、`scheduleNextPoll()` で応答後かどうかによってintervalを切り替え）
  - 応答送信成功後に `return` で早期脱出し、共通 `scheduleNextPoll` をスキップする実装パターンを採用
- [ ] コンテキスト残量検出パターンの追加（`cli-patterns.ts` に `CONTEXT_REMAINING_PATTERN` 正規表現と `extractContextRemaining()` ヘルパー。response-poller.tsでの利用は別Issue）
- [ ] コンテキスト残量低下時のUI通知メカニズム検討（別Issue候補）
- [ ] `ensureHealthySession()` に不健全理由のログ出力を追加（`isSessionHealthy()` の拡張戻り値を使用）
- [ ] ユニットテスト追加（SHELL_PROMPT_ENDINGS偽陽性防止（3文字全て）、重複防止、リセット条件、クールダウン動作）
  - 既存テスト（`claude-session.test.ts` Bug 2セクション全11ケース、`issue-265-acceptance.test.ts` 3ケース）は `isClaudeRunning()` のboolean戻り値が不変のため修正不要
  - `isSessionHealthy()` の `@internal` export を利用し、reason値を検証する新規テストを追加
  - 応答後のクールダウン検証は `COOLDOWN_INTERVAL_MS` 定数を使用（タイミング値ハードコーディング回避）
  - 既存の `pollAutoYes` テスト（応答を伴わないパス: thinking状態スキップ等）は `POLLING_INTERVAL_MS` のまま影響なし

## 受入条件

### 自動テスト可能な条件

- [ ] Claude CLIのステータスバー `Context left until auto-compact: N%` がシェルプロンプトと誤判定されないこと
- [ ] `$` や `#` で終わるClaude CLI出力（コード例、Markdown等）がシェルプロンプトと誤判定されないこと
- [ ] サーバー側Auto-Yes Pollerが同一プロンプトに対して1回のみ応答を送信すること
- [ ] promptKeyが変わらない間は応答が1回のみ送信されること（ユニットテストで検証）
- [ ] プロンプト非検出時に `lastAnsweredPromptKey` が `null` にリセットされること
- [ ] 1000回のポーリングサイクルで重複応答が発生しないこと（`vi.useFakeTimers` で高速テスト可能）
- [ ] 応答送信後にクールダウン期間（`COOLDOWN_INTERVAL_MS`）が適用されること
- [ ] ヘルスチェックによるセッションkill時に判定理由がログ出力されること
- [ ] `isSessionHealthy()` の戻り値に判定理由（reason）が含まれること
- [ ] `isClaudeRunning()` の戻り値がboolean型を維持すること（HealthCheckResult型が外部に漏れないこと）
- [ ] 既存のAuto-Yesテストが全てパスすること
- [ ] 既存の `isClaudeRunning()` テスト（11+3ケース）が全てパスすること

### 手動検証項目

- [ ] 長時間（30分以上）のAuto-Yesセッションでセッションが安定維持されること

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/claude-session.ts` | SHELL_PROMPT_ENDINGS判定ロジック改善（最終行末尾判定+多段防御+空行フィルタリング）、`HealthCheckResult` interface定義（同ファイル内にexport）、`isSessionHealthy()` 戻り値拡張+`@internal` export、**`isClaudeRunning()` の `.healthy` 取り出し修正**、**`ensureHealthySession()` の `.healthy` 判定+`.reason` ログ出力**、ヘルスチェックのログ出力強化 |
| `src/lib/auto-yes-manager.ts` | 重複応答防止ロジック追加（`lastAnsweredPromptKey` + リセット条件）、**`startAutoYesPolling()` の pollerState初期化修正**、`COOLDOWN_INTERVAL_MS` 定数追加、クールダウン期間追加（`scheduleNextPoll()` でinterval切り替え、応答成功後のearly return） |
| `src/lib/cli-patterns.ts` | コンテキスト残量検出パターン追加（`CONTEXT_REMAINING_PATTERN`、`extractContextRemaining()`） |
| `tests/unit/lib/claude-session.test.ts` | SHELL_PROMPT_ENDINGS偽陽性防止テスト（3文字全て）、`isSessionHealthy()` のreason値検証テスト追加、既存11ケースは修正不要 |
| `tests/unit/lib/auto-yes-manager.test.ts` | 重複防止・リセット条件・クールダウンのテスト追加。既存テスト（応答を伴わないパス）は影響なし。応答後のクールダウン検証は `COOLDOWN_INTERVAL_MS` を使用 |

### 関連コンポーネント

- `src/hooks/useAutoYes.ts`（クライアント側 - 変更不要、既に重複防止あり。サーバー側リセットロジックの参照実装）
- `src/lib/auto-yes-resolver.ts`（変更不要）
- `src/app/api/worktrees/[id]/send/route.ts`（変更不要、startSession呼び出し元）
- `src/lib/response-poller.ts`（コンテキスト残量検出の連携先候補。対策3のスコープ外、別Issue）
- `src/lib/prompt-answer-sender.ts`（変更不要、テストでの呼び出し回数検証対象）
- `src/lib/cli-session.ts`（`captureSessionOutput` を提供、変更不要）
- `src/lib/cli-tools/claude.ts`（`isClaudeRunning()` をimport、`isRunning()` で使用。`isClaudeRunning()` のboolean戻り値維持により変更不要）
- `src/app/api/worktrees/[id]/route.ts`、`src/app/api/worktrees/route.ts`（`cliTool.isRunning()` 呼び出し、boolean戻り値維持により変更不要）
- `src/lib/session-cleanup.ts`（`stopAutoYesPolling` をimport、インターフェース変更なし。pollerステート管理の一部として認識）
- `src/lib/cli-tools/codex.ts`、`src/lib/cli-tools/gemini.ts`（`hasSession()` のみでヘルスチェックなし。Issue #306のスコープ外だが、将来的にCodex/Geminiでも同様のヘルスチェック導入を検討する別Issue候補）
- `tests/integration/issue-265-acceptance.test.ts`（`isClaudeRunning()` 統合テスト3ケース、boolean戻り値維持により変更不要）

### 設計メモ

- `getClaudeSessionState()`（`claude-session.ts:431-455`）はヘルスチェックを行わない設計（軽量UIクエリ用、JSDoc C-S3-002で文書化済み）。Issue #306の変更対象外。

---

## レビュー履歴

### イテレーション 1 (2026-02-18) - Stage 1: 通常レビュー

**Must Fix (3件)**:
- MF-001: 対策1の案Aコード例を現行コード構造に合致するよう修正。全体末尾→最終行末尾への変更の意図を明記
- MF-002: `$` と `#` の偽陽性リスク分析と多段防御（案A個別パターン + 案B行長チェック）を追加
- MF-003: 対策2の `lastAnsweredPromptKey` リセット条件（プロンプト非検出時にnullリセット）を明記。クライアント側との対称性を記載

**Should Fix (6件)**:
- SF-001: 対策4のログ出力を `isSessionHealthy()` 戻り値拡張方式（`{ healthy, reason }`）に変更
- SF-002: 対策2（主防御: 論理的重複防止）と対策5（副防御: 処理時間確保）の関係を明確化
- SF-003: 受入条件を「自動テスト可能な条件」と「手動検証項目」に分離。具体的なテスト方法を記載
- SF-004: 関連コンポーネントに `src/lib/prompt-answer-sender.ts` と `src/lib/cli-session.ts` を追加
- SF-005: 概要の「主に3つの原因」を「主に3つの原因と1つのデバッグ改善点」に修正。原因4を「付帯的な改善点」として分離
- SF-006: テストファイルパスを正確に修正（`tests/unit/lib/` ディレクトリを含む正しいパスに）

**Nice to Have (3件)**:
- NTH-001: 対策3にコンテキスト残量検出の具体的な正規表現パターンとヘルパー関数のコード例を追加
- NTH-002: （タイトル変更は影響範囲レビューで判断するため保留）
- NTH-003: パターンBに `/pm-auto-issue2dev` の補足説明、パターンCに再現目安を追加

### イテレーション 2 (2026-02-18) - Stage 3: 影響範囲レビュー

**Must Fix (2件)**:
- MF-001: `isSessionHealthy()` 戻り値変更が `isClaudeRunning()` に波及する破壊的変更の防止。`isClaudeRunning()` と `ensureHealthySession()` の修正を実装タスクに明記。受入条件に「`isClaudeRunning()` のboolean戻り値維持」を追加
- MF-002: `isSessionHealthy()` のreason値テスト戦略として `@internal` export パターンを設計判断として明記。テスト影響の網羅（既存11+3ケースは修正不要、新規reason検証テスト追加）

**Should Fix (6件)**:
- SF-001: CodexTool/GeminiToolのヘルスチェック非対称性を関連コンポーネントに記載（スコープ外だが将来の別Issue候補として認識）
- SF-002: `startAutoYesPolling()` の pollerState初期化コードに `lastAnsweredPromptKey: null` 追加を対策2に明記
- SF-003: クールダウン期間の `COOLDOWN_INTERVAL_MS` 定数化とexportにより、テストでのタイミング値ハードコーディングを回避。既存テストへの影響を整理
- SF-004: 対策3のスコープを `cli-patterns.ts` へのパターン追加のみに限定。`response-poller.ts` での利用は別Issueとして切り出す旨を明記
- SF-005: 対策1のコード例に空行フィルタリングロジックを追加（`lines.filter(l => l.trim() !== '').pop()` で非空の最後の行を使用）
- SF-006: `isSessionHealthy()` を `@internal` export するパターンの設計根拠と既存慣例（`clearCachedClaudePath()`）を対策4に追記

**Nice to Have (3件)**:
- NTH-001: `src/lib/session-cleanup.ts` を関連コンポーネントに追加（変更不要だがpollerステート管理の一部として認識）
- NTH-002: `getClaudeSessionState()` のヘルスチェック非対称性を設計メモとして追記（変更不要、軽量UIクエリ用の設計意図）
- NTH-003: Issue分割は見送り。現状のまま1 Issueで進行（対策間の独立性は認識した上で）

### イテレーション 3 (2026-02-18) - Stage 5: 通常レビュー（2回目）

**Should Fix (3件)**:
- SF-001: 対策1のコード例に対策4の `HealthCheckResult` 型参照コメントを追加。戻り値型の不整合を解消
- SF-002: 偽陽性防止戦略テーブルの `$` と `#` の防御方式を「第2段階（行長チェック）で対応」に修正。テーブルとコード例の整合性を確保し、個別パターン不要の設計判断を明記
- SF-003: 対策5に `pollAutoYes()` 内での `scheduleNextPoll()` 呼び出しパターンを明確化。応答送信成功後のみクールダウン適用（early return）、catchブロックと共通パスはデフォルト間隔

**Nice to Have (2件)**:
- NTH-001: `HealthCheckResult` interfaceの定義場所を `claude-session.ts` 内に明記。実装タスクと変更対象ファイルにも反映
- NTH-002: Noteタグを Stage 1-5 の全反映結果を含む形式に更新
