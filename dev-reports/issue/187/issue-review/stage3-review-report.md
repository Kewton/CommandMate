# Issue #187 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-02-08
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 4 |
| Nice to Have | 2 |

Issue #187 の変更影響範囲を分析した結果、直接修正ファイルは **2ファイル**、間接影響ファイルは **9ファイル**、テスト更新が必要なファイルは **2ファイル** である。最も重大なリスクは既存テストの破壊であり、修正前のテスト更新計画が必要。

---

## Must Fix（必須対応）

### F-1: 既存テストの startLine アサーション不整合

**カテゴリ**: impact_scope
**影響ファイル**: `tests/unit/lib/claude-session.test.ts`

**問題**:
`waitForPrompt()` のテスト（L108）が `capturePane` を `{ startLine: -10 }` で呼び出すことを期待しているが、実装（`src/lib/claude-session.ts` L248）では `{ startLine: -50 }` を使用している。

```typescript
// テスト (L108) - 期待値
expect(capturePane).toHaveBeenCalledWith(sessionName, { startLine: -10 });

// 実装 (L248) - 実際の値
const output = await capturePane(sessionName, { startLine: -50 });
```

この不整合は Issue #187 の修正以前から存在する問題であるが、受け入れ条件「claude-session.test.ts の既存テストが全てパスすること」と矛盾する。Issue #187 の作業開始前にこの不整合を修正する必要がある。

**推奨対応**:
テスト L108 の expect を `{ startLine: -50 }` に修正する。

---

### F-2: セパレータパターン除外による既存テストの破壊

**カテゴリ**: regression_risk
**影響ファイル**: `tests/unit/lib/claude-session.test.ts`, `src/lib/claude-session.ts`

**問題**:
P1 改善案「startClaudeSession() の初期化判定からセパレータパターンを除外」を実装すると、以下の既存テストが直接破壊される:

```typescript
// claude-session.test.ts L232-246
it('should detect separator using CLAUDE_SEPARATOR_PATTERN (DRY-002)', async () => {
  vi.mocked(capturePane).mockResolvedValue('────────────────────');
  // ... セパレータのみで初期化完了を期待
  await expect(promise).resolves.toBeUndefined();
});
```

修正後はセパレータのみでは初期化完了しない（プロンプト検出まで待機する）ため、このテストは削除または改変が必須。受け入れ条件「既存テストが全てパスすること」と矛盾する。

**推奨対応**:
受け入れ条件を「テストをセパレータ除外後の期待動作に合わせて更新した上で全てパスすること」と修正する。Issue 本文に DRY-002 テストの変更が必要である旨を明記する。

---

### F-3: タイムアウト挙動変更によるテストの破壊

**カテゴリ**: regression_risk
**影響ファイル**: `tests/unit/lib/claude-session.test.ts`, `src/lib/claude-session.ts`

**問題**:
P1「タイムアウト時の送信強行をエラースローに変更」と「ハードコード値10000msの定数化」は、以下の既存テストの前提を変更する:

```typescript
// claude-session.test.ts L337-346
it('should throw error if prompt not detected within timeout', async () => {
  vi.mocked(capturePane).mockResolvedValue('Still processing...');
  const promise = sendMessageToClaude('test-worktree', 'Hello');
  await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_WAIT_TIMEOUT + 100);
  await expect(promise).rejects.toThrow(`Prompt detection timeout (${CLAUDE_PROMPT_WAIT_TIMEOUT}ms)`);
});
```

現在の実装（L382）では `10000ms` のハードコード値を使用しており、`CLAUDE_PROMPT_WAIT_TIMEOUT`（5000ms）とは異なる。さらに、現在の catch ブロック（L383-386）は warn ログを出力して sendKeys を続行するが、修正後はエラーをスローして sendKeys を実行しない。テストの期待タイムアウト値とエラー伝播の両方が変更される。

**推奨対応**:
修正後のテストで、(1) 正しいタイムアウト定数を使用する、(2) エラースロー後に sendKeys が呼び出されないことを検証する、の2点を含めたテスト更新計画を Issue に追記する。

---

## Should Fix（推奨対応）

### F-4: 安定化待機の一律追加によるレスポンス時間増加

**カテゴリ**: impact_scope
**影響ファイル**: `src/lib/claude-session.ts`, `src/lib/cli-tools/claude.ts`, `src/app/api/worktrees/[id]/send/route.ts`

**問題**:
`sendMessageToClaude()` に `CLAUDE_POST_PROMPT_DELAY`（500ms）を追加することで、初回だけでなく **2回目以降の全てのメッセージ送信** にも 500ms の追加遅延が発生する。API コールチェーン:

```
UI (メッセージ送信ボタン)
  -> POST /api/worktrees/:id/send (route.ts L141)
    -> ClaudeTool.sendMessage() (claude.ts L66)
      -> sendMessageToClaude() (claude-session.ts L360)
        -> 500ms 安定化待機 (NEW)
        -> sendKeys()
```

2回目以降は Claude CLI が既に安定状態にあるため、500ms は理論上不要。

**推奨対応**:
一律 500ms 適用と条件分岐（初回のみ適用）のトレードオフを Issue に明記する。一律適用の場合は「500ms の追加はユーザー体感上問題ない」という判断根拠を記載する。

---

### F-5: auto-yes-manager の sendKeys パスとの整合性

**カテゴリ**: missing_consideration
**影響ファイル**: `src/lib/auto-yes-manager.ts`

**問題**:
`auto-yes-manager.ts` (L306-314) は `sendKeys` を直接使用して Claude CLI にメッセージを送信している:

```typescript
// auto-yes-manager.ts L312-314
await sendKeys(sessionName, answer, false);
await new Promise(resolve => setTimeout(resolve, 100));
await sendKeys(sessionName, '', true);
```

Issue #187 の修正範囲は `sendMessageToClaude()` に限定されており、auto-yes-manager のパスには安定化待機が適用されない。auto-yes-manager は `detectPrompt()` でプロンプトが確実に表示されている状態で送信するため問題は発生しにくいが、設計上の整合性として考慮が必要。

**推奨対応**:
auto-yes-manager の sendKeys パスでは安定化待機が不要である理由（detectPrompt で既にプロンプト確認済みのため、初期化直後のコンテキストとは異なる）を Issue または設計書に明記する。

---

### F-6: stripAnsi 変更の広範な波及

**カテゴリ**: impact_scope
**影響ファイル**: `src/lib/cli-patterns.ts`, `src/lib/claude-session.ts`, `src/lib/status-detector.ts`, `src/lib/auto-yes-manager.ts`, `src/lib/response-poller.ts`, `src/lib/assistant-response-saver.ts`, `tests/unit/lib/cli-patterns.test.ts`

**問題**:
P2「stripAnsi の DEC Private Mode 対応」で `ANSI_PATTERN` 正規表現を変更すると、`stripAnsi()` を使用する全 **6ファイル** に影響が波及する。特に `response-poller.ts` は 5 箇所で stripAnsi を使用しており、影響範囲が最も広い。

変更は「より多くのエスケープシーケンスを除去する」方向であるため基本的には正の効果だが、既存テスト結果やパース動作に微妙な変化を引き起こす可能性がある。

**推奨対応**:
1. `cli-patterns.test.ts` に DEC Private Mode のテストケースを追加する
2. 既存の stripAnsi テスト（L165-175）が破壊されないことを確認する
3. response-poller の関連テストが存在するか確認し、必要に応じて追加する

---

### F-7: 入力エリアクリア（Ctrl+U）の送信パス間の一貫性

**カテゴリ**: missing_consideration
**影響ファイル**: `src/lib/claude-session.ts`, `src/lib/auto-yes-manager.ts`, `src/lib/tmux.ts`

**問題**:
P2「メッセージ送信前に Ctrl+U で入力エリアをクリア」を `sendMessageToClaude()` のみに適用した場合、以下の他の送信パスには適用されない:

| 送信パス | ファイル | Ctrl+U 適用 |
|---------|--------|------------|
| sendMessageToClaude() | claude-session.ts | 適用予定 |
| auto-yes-manager | auto-yes-manager.ts L312-314 | 未適用 |
| respond API | respond/route.ts -> tmux.sendKeys | 未適用 |

**推奨対応**:
入力エリアクリアの適用範囲を明確にし、sendMessageToClaude のみに適用する理由（ユーザーが入力するメインパスであり、サジェスト結合のリスクが高いため）を記載する。

---

## Nice to Have（あれば良い）

### F-9: API レベルのテストカバレッジ

**カテゴリ**: missing_consideration
**影響ファイル**: `tests/integration/api-send-cli-tool.test.ts`

**問題**:
`api-send-cli-tool.test.ts` は `sendMessageToClaude` を `vi.fn()` でモックしているため、Issue #187 の修正がAPIレベルで正しく動作するかを検証できない。タイムアウト時のエラースローが API レスポンス（HTTP 500）に正しく反映されることは検証されない。

**推奨対応**:
テスト注意事項セクションにこの制約を追記する。

---

### F-10: api-prompt-handling.test.ts のモック状況

**カテゴリ**: missing_consideration
**影響ファイル**: `tests/integration/api-prompt-handling.test.ts`

**問題**:
`api-prompt-handling.test.ts` は `claude-session` モジュールを部分的にモック（getSessionName, isClaudeRunning のみ）しており、Issue #187 の変更は直接影響しない。

**推奨対応**:
現時点では対応不要。影響ファイル一覧に記録のみ。

---

## 影響範囲マップ

### 直接修正ファイル

| ファイル | 修正内容 | 優先度 |
|---------|---------|-------|
| `src/lib/claude-session.ts` | sendMessageToClaude() 安定化待機追加、セパレータパターン除外、タイムアウトエラースロー、ハードコード値定数化、入力エリアクリア | P0, P1, P2 |
| `src/lib/cli-patterns.ts` | stripAnsi の ANSI_PATTERN 拡張（DEC Private Mode 対応） | P2 |

### 間接影響ファイル

| ファイル | 影響内容 | 影響レベル |
|---------|---------|----------|
| `src/lib/cli-tools/claude.ts` | sendMessageToClaude 呼び出し元。遅延増加 | 低 |
| `src/app/api/worktrees/[id]/send/route.ts` | API レスポンス時間増加、エラー伝播の変更 | 中 |
| `src/app/api/worktrees/[id]/route.ts` | detectSessionStatus 使用。stripAnsi 変更の間接影響 | 低 |
| `src/app/api/worktrees/route.ts` | 同上 | 低 |
| `src/lib/auto-yes-manager.ts` | stripAnsi 使用 (L279)、独自 sendKeys パス (L312-314) | 低 |
| `src/lib/status-detector.ts` | stripAnsi 使用 (L81) | 低 |
| `src/lib/response-poller.ts` | stripAnsi 5箇所使用 | 低 |
| `src/lib/assistant-response-saver.ts` | stripAnsi 使用 (L89) | 低 |
| `src/lib/tmux.ts` | P2 Ctrl+U 対応の場合のみ影響 | 低（P2のみ） |

### テストファイル

| ファイル | 必要なアクション | 理由 |
|---------|----------------|------|
| `tests/unit/lib/claude-session.test.ts` | **要更新** | startLine 不整合修正、セパレータテスト改変、タイムアウトテスト改変、安定化待機テスト追加 |
| `tests/unit/lib/cli-patterns.test.ts` | **要更新（P2のみ）** | DEC Private Mode テスト追加 |
| `tests/integration/api-send-cli-tool.test.ts` | 変更不要 | sendMessageToClaude をモックしているため影響なし |
| `tests/integration/api-prompt-handling.test.ts` | 変更不要 | claude-session の部分モックのみで影響なし |

---

## コールチェーン分析

### sendMessageToClaude の呼び出しチェーン

```
UI (メッセージ送信)
  -> POST /api/worktrees/:id/send (route.ts)
    -> CLIToolManager.getTool('claude')
      -> ClaudeTool.sendMessage() (claude.ts L66)
        -> sendMessageToClaude(worktreeId, message) (claude-session.ts L360)
          -> capturePane()      ... プロンプト確認
          -> waitForPrompt()    ... プロンプト未検出時
          -> [NEW] CLAUDE_POST_PROMPT_DELAY (500ms)  ... 安定化待機
          -> [NEW/P2] sendKeys C-u  ... 入力クリア
          -> sendKeys(message)  ... メッセージ送信
          -> sendKeys(Enter)    ... Enter送信
```

### startClaudeSession の呼び出しチェーン

```
POST /api/worktrees/:id/send (route.ts L100)
  -> ClaudeTool.startSession() (claude.ts L56)
    -> startClaudeSession(options) (claude-session.ts L275)
      -> createSession()
      -> sendKeys(claudePath)
      -> [MODIFIED] ポーリングループ（セパレータ除外）
      -> CLAUDE_POST_PROMPT_DELAY (500ms)
```

### stripAnsi の使用箇所

```
cli-patterns.ts L169 (定義)
  +-- claude-session.ts L251, L324, L378
  +-- status-detector.ts L81
  +-- auto-yes-manager.ts L279
  +-- response-poller.ts L59, L233, L247, L262, L310, L349, L464, L532
  +-- assistant-response-saver.ts L89
```

---

## 参照ファイル

### コード
- `src/lib/claude-session.ts`: 主要変更対象（3関数修正）
- `src/lib/cli-patterns.ts`: stripAnsi の ANSI_PATTERN 修正（P2）
- `src/lib/cli-tools/claude.ts`: sendMessageToClaude の直接呼び出し元
- `src/app/api/worktrees/[id]/send/route.ts`: API レスポンス時間・エラー伝播に影響
- `src/lib/auto-yes-manager.ts`: sendKeys 直接使用パス（整合性考慮）

### テスト
- `tests/unit/lib/claude-session.test.ts`: 全面更新が必要
- `tests/unit/lib/cli-patterns.test.ts`: P2 適用時に更新
- `tests/integration/api-send-cli-tool.test.ts`: 変更不要（モック使用）

### ドキュメント
- `dev-reports/design/issue-152-first-message-not-sent-design-policy.md`: DRY-002, CONS-007 の設計根拠
