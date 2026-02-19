# Issue #306 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-18
**フォーカス**: 影響範囲レビュー
**イテレーション**: 1回目
**対象Issue**: fix: Auto-Yes Pollerの重複応答によりtmuxセッションが定期的に削除される

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 6 |
| Nice to Have | 3 |
| **合計** | **11** |

**品質評価**: high - Issueは十分な技術的分析を含んでいるが、isSessionHealthy()の戻り値変更に伴う呼び出し元への波及効果が不十分。

---

## Must Fix（必須対応）

### MF-001: isSessionHealthy()の戻り値変更はisClaudeRunning()の戻り値型を変更する破壊的変更

**カテゴリ**: 破壊的変更
**場所**: `src/lib/claude-session.ts` L419-427 (isClaudeRunning), L306-313 (ensureHealthySession)

**問題**:

Issue対策4で `isSessionHealthy()` の戻り値を `boolean` から `{ healthy: boolean; reason?: string }` に変更する提案があるが、`isClaudeRunning()` は直接 `return isSessionHealthy(sessionName)` としている（L426）。

```typescript
// claude-session.ts:419-427 (現行)
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) { return false; }
  return isSessionHealthy(sessionName);  // ← ここがオブジェクトを返すようになる
}
```

isSessionHealthy() の戻り値がオブジェクトに変わると、isClaudeRunning() はオブジェクトを返すことになり、以下の全呼び出し元でtruthyの結果が壊れる（オブジェクトは常にtruthyなので全てtrue扱い）:

- `ClaudeTool.isRunning()` (`src/lib/cli-tools/claude.ts:41`)
- `GET /api/worktrees/[id]` (`src/app/api/worktrees/[id]/route.ts:48`)
- `GET /api/worktrees` (`src/app/api/worktrees/route.ts:48`)
- `POST /api/worktrees/[id]/send` (`src/app/api/worktrees/[id]/send/route.ts:95`)
- 統合テスト (`tests/integration/issue-265-acceptance.test.ts:149,157,165`)

**推奨対応**:

isClaudeRunning() と ensureHealthySession() を修正して戻り値から healthy フィールドを取り出す:

```typescript
// isClaudeRunning() 修正案
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) { return false; }
  const result = await isSessionHealthy(sessionName);
  return result.healthy;
}

// ensureHealthySession() 修正案
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

この修正をIssueの実装タスクに明記すべき。

---

### MF-002: isSessionHealthy()の戻り値変更に伴うテストモック修正の網羅性

**カテゴリ**: テスト影響
**場所**: `tests/unit/lib/claude-session.test.ts` L787-877, `tests/integration/issue-265-acceptance.test.ts` L142-165

**問題**:

isSessionHealthy() は非export（private）関数であり、`isClaudeRunning()` 経由で間接的にテストされている。isClaudeRunning() の戻り値型は `boolean` のまま維持されるため既存の11テストケースは修正不要だが、Issueで提案されている reason 値のテスト方法が不明確。

isSessionHealthy() をexportしない限り、reason 値はテストで検証できない。しかし、isSessionHealthy() のexport化については設計判断が未記載。

**推奨対応**:

isSessionHealthy() を `@internal` アノテーション付きでexportする設計を採用する（`clearCachedClaudePath()` と同じパターン、claude-session.ts:149-153参照）:

```typescript
/**
 * @internal Exported for testing purposes only.
 */
export async function isSessionHealthy(sessionName: string): Promise<HealthCheckResult> {
```

Issueの実装タスクに「isSessionHealthy()を@internal付きでexportし、テストでreason値を直接検証可能にする」を追加。

---

## Should Fix（推奨対応）

### SF-001: CodexToolとGeminiToolのisRunning()にはヘルスチェックがなく非対称

**カテゴリ**: 影響範囲
**場所**: `src/lib/cli-tools/codex.ts` L50-53, `src/lib/cli-tools/gemini.ts` L34-37

**問題**:

ClaudeTool.isRunning() は isClaudeRunning() を呼びヘルスチェックを実施するが、CodexTool と GeminiTool は `hasSession()` のみ。同様のヘルスチェック問題が発生する可能性がある。

**推奨対応**:

影響範囲の関連コンポーネントに注記を追加: 「CodexTool/GeminiToolのisRunning()はhasSession()のみ、ヘルスチェック導入は別Issue候補」。

---

### SF-002: AutoYesPollerState初期化コードの修正が明示されていない

**カテゴリ**: 波及効果
**場所**: `src/lib/auto-yes-manager.ts` L414-420

**問題**:

AutoYesPollerState に lastAnsweredPromptKey フィールドを追加する場合、`startAutoYesPolling()` でのpollerState初期化（L414-420）に `lastAnsweredPromptKey: null` を追加する必要がある。Issueでは pollAutoYes() 内の利用コードのみ示されている。

**推奨対応**:

Issueの対策2コード例に初期化コードの修正を追加:

```typescript
const pollerState: AutoYesPollerState = {
  timerId: null,
  cliToolId,
  consecutiveErrors: 0,
  currentInterval: POLLING_INTERVAL_MS,
  lastServerResponseTimestamp: null,
  lastAnsweredPromptKey: null,  // 追加
};
```

---

### SF-003: クールダウン期間追加の既存テスト影響が具体化されていない

**カテゴリ**: テスト影響
**場所**: `tests/unit/lib/auto-yes-manager.test.ts` L477-703

**問題**:

対策5で応答後のポーリング間隔を5秒に変更する場合、既存テストの `vi.advanceTimersByTime(POLLING_INTERVAL_MS)` に影響する可能性がある。

**推奨対応**:

クールダウン値を新定数 `COOLDOWN_INTERVAL_MS` として定義・exportし、テストでハードコーディングを回避する。既存テストで応答を伴わないパス（thinking状態スキップ等）は影響なし。

---

### SF-004: CONTEXT_REMAINING_PATTERNの利用先連携設計が未記載

**カテゴリ**: 影響範囲
**場所**: `src/lib/cli-patterns.ts`, `src/lib/response-poller.ts`

**問題**:

対策3の「コンテキスト残量検出」でパターンをcli-patterns.tsに追加しても、それをどこで使用するかの設計がない。UI通知への連携経路も未定義。

**推奨対応**:

対策3のスコープを「cli-patterns.tsへのパターン定義追加のみ」に限定し、response-poller.tsでの利用は別Issueに切り出す。

---

### SF-005: 最終行抽出方式変更時のtmux出力末尾空行への対応

**カテゴリ**: 波及効果
**場所**: `src/lib/claude-session.ts` L248-251, L262-296

**問題**:

tmux capture-paneの出力末尾には空行が含まれることがあり、`trimmed.split('\n').pop()?.trim()` で取得した最終行が空になる可能性がある。

**推奨対応**:

対策1のコード例を以下のように修正:

```typescript
const lines = trimmed.split('\n');
const lastLine = lines.filter(l => l.trim() !== '').pop()?.trim() ?? '';
```

---

### SF-006: isSessionHealthy()のreason値テストのためのexport戦略が未決定

**カテゴリ**: テスト影響
**場所**: `src/lib/claude-session.ts` L262

**問題**:

isSessionHealthy() は非exportであり、reason値をテストするにはexport戦略が必要。

**推奨対応**:

`@internal` アノテーション付きでexportする（clearCachedClaudePath()と同じパターン）。MF-002と統合して対応。

---

## Nice to Have（あれば良い）

### NTH-001: session-cleanup.tsの関連コンポーネント追加

`src/lib/session-cleanup.ts` は `stopAutoYesPolling()` をimportしており、pollerステート管理の一部として認識すべき。直接的な変更は不要。

### NTH-002: getClaudeSessionState()のヘルスチェック非対称性の文書化

`getClaudeSessionState()` はヘルスチェックなし（設計意図: 軽量UIクエリ）であることが既にJSDocで文書化されている。設計書作成時に「変更不要」と明記すると実装者に分かりやすい。

### NTH-003: Issue分割の検討

3つの独立した原因に対する修正が1 Issueに含まれており、以下の分割が可能:
- Issue #306A: SHELL_PROMPT_ENDINGS偽陽性防止 + ヘルスチェックログ強化（対策1+4）
- Issue #306B: Auto-Yes重複応答防止 + クールダウン（対策2+5）
- Issue #306C: コンテキスト残量検出・通知（対策3）

---

## 影響範囲マップ

### 直接影響ファイル（変更必要）

| ファイル | 変更内容 | リスク |
|---------|---------|--------|
| `src/lib/claude-session.ts` | isSessionHealthy()戻り値変更、SHELL_PROMPT_ENDINGS改善、isClaudeRunning()/.healthy取り出し、ensureHealthySession()ログ追加 | **高** |
| `src/lib/auto-yes-manager.ts` | AutoYesPollerState型拡張、pollAutoYes()重複防止、startAutoYesPolling()初期化修正 | 中 |
| `src/lib/cli-patterns.ts` | CONTEXT_REMAINING_PATTERN追加 | 低 |
| `tests/unit/lib/claude-session.test.ts` | 偽陽性防止テスト・reason値テスト追加 | 中 |
| `tests/unit/lib/auto-yes-manager.test.ts` | 重複防止・クールダウンテスト追加 | 中 |

### 間接影響ファイル（変更不要、動作確認推奨）

| ファイル | 関係 | リスク |
|---------|------|--------|
| `src/lib/cli-tools/claude.ts` | isClaudeRunning()をimport | 低 |
| `src/app/api/worktrees/[id]/route.ts` | cliTool.isRunning()呼び出し | 低 |
| `src/app/api/worktrees/route.ts` | cliTool.isRunning()呼び出し | 低 |
| `src/app/api/worktrees/[id]/send/route.ts` | cliTool.isRunning()呼び出し | 低 |
| `src/hooks/useAutoYes.ts` | クライアント側重複防止（参照実装） | 低 |
| `src/lib/prompt-answer-sender.ts` | sendPromptAnswer()呼び出し検証 | 低 |
| `src/lib/cli-session.ts` | captureSessionOutput提供 | 低 |
| `src/lib/session-cleanup.ts` | stopAutoYesPollingをimport | 低 |
| `src/lib/response-poller.ts` | コンテキスト残量連携候補 | 低 |
| `tests/integration/issue-265-acceptance.test.ts` | isClaudeRunning統合テスト | 低 |

### 破壊的変更

| 変更 | スコープ | 緩和策 |
|------|---------|--------|
| isSessionHealthy() 戻り値: `boolean` -> `HealthCheckResult` | claude-session.ts内部のみ（非export） | isClaudeRunning()とensureHealthySession()で `.healthy` を取り出し、外部インターフェースはboolean維持 |

### 非破壊的変更

- AutoYesPollerState へのフィールド追加（TypeScript型拡張）
- SHELL_PROMPT_ENDINGS 判定ロジック改善（判定がより厳密になるのみ）
- CONTEXT_REMAINING_PATTERN 追加（新規export）
- scheduleNextPoll() の interval 条件分岐（応答後のみ5秒）

---

## 参照ファイル

### コード（直接影響）
- `src/lib/claude-session.ts`: L58, L248-251, L262-296, L306-313, L419-427, L444-455
- `src/lib/auto-yes-manager.ts`: L31-42, L274-369, L374-381, L386-430
- `src/lib/cli-patterns.ts`: 全体

### コード（間接影響）
- `src/lib/cli-tools/claude.ts`: L10, L40-42
- `src/lib/cli-tools/codex.ts`: L50-53
- `src/lib/cli-tools/gemini.ts`: L34-37
- `src/app/api/worktrees/[id]/route.ts`: L48, L176
- `src/app/api/worktrees/route.ts`: L48
- `src/app/api/worktrees/[id]/send/route.ts`: L95
- `src/hooks/useAutoYes.ts`: L60-62, L68-78
- `src/lib/session-cleanup.ts`: L11, L100

### テスト
- `tests/unit/lib/claude-session.test.ts`: L787-877
- `tests/unit/lib/auto-yes-manager.test.ts`: L475-703
- `tests/integration/issue-265-acceptance.test.ts`: L142-165

### ドキュメント
- `CLAUDE.md`: モジュール一覧との整合性確認
- `dev-reports/design/issue-265-claude-session-recovery-design-policy.md`: SHELL_PROMPT_ENDINGS設計経緯
