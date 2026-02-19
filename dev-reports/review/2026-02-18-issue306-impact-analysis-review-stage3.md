# Issue #306 影響分析レビュー (Stage 3)

## Executive Summary

Issue #306 (tmuxセッション安定性改善) の設計方針書に対する影響分析レビューを実施した。設計変更の波及効果を、API呼び出し元、新規ファイル追加、定数導入、型変更、テスト影響の5つの観点で分析した。

**結論**: 設計変更はビジネスロジック層 (`src/lib/`) に適切に閉じられており、外部APIの破壊的変更はない。ただし、catchブロックのHealthCheckResult変換の記載漏れ（must_fix 1件）と、テスト影響の詳細分析が不十分な箇所（should_fix 5件）がある。

| 項目 | 評価 |
|------|------|
| **ステージ** | Stage 3 (影響分析) |
| **フォーカス** | 影響範囲 |
| **スコア** | 4/5 |
| **ステータス** | 条件付き承認 |

---

## 1. API呼び出し元への影響分析

### 1.1 isClaudeRunning() の呼び出しチェーン

**現在の呼び出し構造**:

```
API Routes (8箇所)
  -> cliTool.isRunning(worktreeId)  [src/app/api/worktrees/... 各route.ts]
    -> ClaudeTool.isRunning()       [src/lib/cli-tools/claude.ts L40-42]
      -> isClaudeRunning()          [src/lib/claude-session.ts L419-427]
        -> isSessionHealthy()       [src/lib/claude-session.ts L262-296]
```

**API Route呼び出し箇所一覧** (全8ファイル):

| ファイル | 行 | 用途 |
|---------|-----|------|
| `src/app/api/worktrees/route.ts` | L48 | worktree一覧のステータス表示 |
| `src/app/api/worktrees/[id]/route.ts` | L48, L176 | 個別worktreeのステータス・更新 |
| `src/app/api/worktrees/[id]/send/route.ts` | L95 | メッセージ送信前のセッション確認 |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L47 | 現在の出力取得 |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | L61 | セッション停止前の確認 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | L62 | プロンプト応答前の確認 |
| `src/app/api/worktrees/[id]/interrupt/route.ts` | L67 | 割り込み前の確認 |
| `src/app/api/repositories/route.ts` | L33 | リポジトリ操作時の確認 |

**影響評価**: isClaudeRunning()がboolean戻り値を維持する設計（`result.healthy`を取り出し）のため、全API routeへの影響は**なし**。ClaudeTool.isRunning()は`return await isClaudeRunning(worktreeId)`で直接delegateするのみで変更不要。

**指摘事項**: 設計書セクション9の関連コンポーネント表に`src/lib/cli-tools/claude.ts`が未記載 (S3-F002)。

### 1.2 ensureHealthySession() の呼び出し元

**現在の呼び出し構造**:

```
startClaudeSession()  [src/lib/claude-session.ts L522]
  -> ensureHealthySession()  [src/lib/claude-session.ts L306-313]
    -> isSessionHealthy()
```

ensureHealthySession()はclaude-session.tsの内部関数（非export）であり、startClaudeSession()からのみ呼び出される。外部への影響はない。変更後はreason付きconsole.warnが追加されるが、API戻り値には影響しない。

---

## 2. 新規ファイル追加の影響分析

### 2.1 src/lib/prompt-key.ts

| 項目 | 評価 |
|------|------|
| ファイルパス | `src/lib/prompt-key.ts` |
| import元 | `src/lib/auto-yes-manager.ts`, `src/hooks/useAutoYes.ts` |
| サーバー専用API | なし（純粋な文字列結合のみ） |
| クライアントバンドル影響 | 無視可能（1行の文字列テンプレートリテラル） |
| tsconfig paths解決 | `@/lib/prompt-key` で問題なし（既存パターンと一致） |

**useAutoYes.ts への影響**:
- 変更前 (L77): `const promptKey = \`${promptData.type}:${promptData.question}\`;`
- 変更後: `const promptKey = generatePromptKey({ type: promptData.type, question: promptData.question });`
- import追加: `import { generatePromptKey } from '@/lib/prompt-key';`

**実装順序依存**: prompt-key.tsが未作成の状態でuseAutoYes.tsを修正するとimportエラーが発生する。設計書セクション8のステップ4順序を厳守すること。

### 2.2 tests/unit/lib/prompt-key.test.ts

標準的なテストファイルパス。既存テスト構造と整合しており影響なし。

---

## 3. COOLDOWN_INTERVAL_MS導入の影響分析

### 3.1 既存テストタイマー値への影響

**分析対象**: `tests/unit/lib/auto-yes-manager.test.ts` の全 `vi.advanceTimersByTimeAsync` 呼び出し（10箇所）

| テスト | 行 | 使用値 | 影響 |
|--------|-----|--------|------|
| thinking state skip | L498 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| detectPrompt when not thinking | L534 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| stale thinking summary | L596 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| recent thinking | L636 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| Claude multiple_choice | L732 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| yes/no prompt | L773 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| codex multiple_choice | L811 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| Down arrow offset | L851 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| Up arrow offset | L894 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |
| Enter when offset=0 | L937 | `POLLING_INTERVAL_MS + 100` | 初回ポーリングのみ。影響なし |

**結論**: 全10箇所は初回ポーリングサイクルのトリガーのみ。COOLDOWN_INTERVAL_MSは応答送信成功後の2回目以降に適用されるため、**既存テストの修正は不要**。

### 3.2 応答レイテンシへの影響

| 項目 | 変更前 | 変更後 | 差分 |
|------|--------|--------|------|
| 応答後の次回ポーリング | 2秒 | 5秒 | +3秒 |
| Claude CLI処理時間 | 5秒以上 | 5秒以上 | - |
| 実質的な遅延 | - | 限定的 | +0~3秒 |

API route応答時間への影響はなし（isClaudeRunning()のboolean戻り値に依存しないため）。

### 3.3 scheduleNextPoll() シグネチャ変更

```typescript
// 変更前
function scheduleNextPoll(worktreeId: string, cliToolId: CLIToolType): void

// 変更後
function scheduleNextPoll(worktreeId: string, cliToolId: CLIToolType, overrideInterval?: number): void
```

オプションパラメータ追加のため、既存の呼び出し `scheduleNextPoll(worktreeId, cliToolId)` は**そのまま動作**。後方互換性あり。

---

## 4. AutoYesPollerState変更の影響分析

### 4.1 フィールド追加

```typescript
// 追加フィールド
lastAnsweredPromptKey: string | null;  // 初期値: null
```

### 4.2 globalThis型宣言への影響

```typescript
// auto-yes-manager.ts L99-104
declare global {
  var __autoYesPollerStates: Map<string, AutoYesPollerState> | undefined;
}
```

TypeScriptのinterface参照型のため、`declare global`の修正は不要。AutoYesPollerStateの定義変更が自動的に反映される。

### 4.3 startAutoYesPolling() 初期化コード

```typescript
// auto-yes-manager.ts L414-420 - 変更必要
const pollerState: AutoYesPollerState = {
  timerId: null,
  cliToolId,
  consecutiveErrors: 0,
  currentInterval: POLLING_INTERVAL_MS,
  lastServerResponseTimestamp: null,
  lastAnsweredPromptKey: null,  // <- 追加必須
};
```

TypeScriptコンパイラがinterface不整合を検出するため、追加漏れはビルド時に捕捉される。

### 4.4 関連テストへの影響

| テストファイル | 影響 |
|-------------|------|
| `tests/unit/lib/auto-yes-manager.test.ts` L399-471 | pollerStateの内部フィールドを直接検証していないため影響なし |
| `tests/integration/auto-yes-persistence.test.ts` | getActivePollerCount()経由の間接検証のみ。影響なし |

---

## 5. テスト影響の完全性確認

### 5.1 変更される関数とテストカバレッジ

| 関数 | ファイル | 既存テスト | 新規テスト必要 |
|------|---------|-----------|--------------|
| `isSessionHealthy()` | claude-session.ts | isClaudeRunning()経由で14テスト | セクション6.1, 6.2の新規テスト |
| `isClaudeRunning()` | claude-session.ts | 14テスト（L788-877） | 変更不要（boolean戻り値維持） |
| `ensureHealthySession()` | claude-session.ts | startClaudeSession()経由で間接テスト | console.warn追加のみ。直接テスト不要 |
| `pollAutoYes()` | auto-yes-manager.ts | 10テスト（L477-951） | セクション6.3, 6.4の新規テスト |
| `scheduleNextPoll()` | auto-yes-manager.ts | pollAutoYes()経由で間接テスト | overrideIntervalの新規テスト |
| `generatePromptKey()` | prompt-key.ts (新規) | なし | セクション6.5の新規テスト |
| `isDuplicatePrompt()` | auto-yes-manager.ts (新規) | なし | pollAutoYes()テスト経由で間接テスト |

### 5.2 既存テストが変更により壊れないかの分析

| テストファイル | テスト数 | 破壊リスク | 理由 |
|-------------|---------|-----------|------|
| `tests/unit/lib/claude-session.test.ts` | 48テスト | **なし** | isClaudeRunning()のboolean戻り値維持。import追加（isSessionHealthy, HealthCheckResult）は新規テスト用 |
| `tests/unit/lib/auto-yes-manager.test.ts` | 33テスト | **なし** | 初回ポーリングのみのテスト。COOLDOWN_INTERVAL_MS影響なし。AutoYesPollerState内部フィールド非参照 |
| `tests/unit/hooks/useAutoYes.test.ts` | 6テスト | **低** | generatePromptKey()置換は内部実装変更。prompt-key.ts未作成時にimportエラーの可能性あり |
| `tests/integration/auto-yes-persistence.test.ts` | 5テスト | **なし** | getActivePollerCount()経由の間接検証のみ |
| `tests/integration/issue-265-acceptance.test.ts` | - | **なし** | isClaudeRunning()のboolean戻り値を検証 |

### 5.3 設計書テスト影響テーブル (セクション6.6) の不足箇所

| テストファイル | 設計書記載 | 実際の影響 |
|-------------|----------|-----------|
| `tests/unit/lib/claude-session.test.ts` | 記載あり | 正確 |
| `tests/unit/lib/auto-yes-manager.test.ts` | 記載あり（ただし具体性不足） | 既存テスト修正不要を明示すべき |
| `tests/unit/hooks/useAutoYes.test.ts` | **未記載** | import依存あり。記載追加必要 |
| `tests/integration/auto-yes-persistence.test.ts` | **未記載** | 影響なしだが確認対象として記載必要 |

---

## 6. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | isSessionHealthy()のcatchブロック変換漏れ | Med | Med | P1 |
| 技術的リスク | prompt-key.ts未作成時のimportエラー | Low | Low | P2 |
| 破壊的変更リスク | API route戻り値の変更 | High | **なし** | - |
| テスト破壊リスク | 既存テストのアサーション不整合 | Med | Low | P3 |
| 運用リスク | ログ量増加 | Low | Med | P3 |

---

## 7. 指摘事項詳細

### Must Fix (1件)

#### S3-F001: isSessionHealthy()のcatchブロック戻り値がHealthCheckResult形式に変更される必要があるが設計書に記載がない

**現在の実装** (`src/lib/claude-session.ts` L293-295):
```typescript
} catch {
  return false;
}
```

**変更後（必要）**:
```typescript
} catch {
  return { healthy: false, reason: 'capture error' };
}
```

設計書セクション3.2のコード例にはcatchブロックの変更が含まれていない。テスト設計セクション6.2にもcaptureエラー時のreason検証テストが含まれていない。既存テスト（L870-876）はisClaudeRunning()経由であるため破壊されないが、isSessionHealthy()を直接テストする新規テストにはcatch経路のカバレッジが欠落する。

### Should Fix (5件)

#### S3-F002: ClaudeTool.isRunning()が設計書の関連コンポーネント表に未記載
- 中間層の存在を認識しないと影響範囲を見誤る可能性
- `src/lib/cli-tools/claude.ts` を関連コンポーネント表に追加すべき

#### S3-F003: COOLDOWN_INTERVAL_MS導入が既存テストに影響しないことの根拠不明確
- 設計書セクション6.6の記載が「確認・修正」と曖昧
- 実際には既存テスト修正不要を明記すべき

#### S3-F004: pollAutoYes()制御フロー変更のcatchブロックfallthrough動作の補足
- 現在のL368は応答成功パスからも到達する
- 変更後はcatchブロック通過後のみ到達に変化

#### S3-F005: useAutoYes.test.tsが設計書テスト影響テーブルに未記載
- prompt-key.ts未作成時のimportエラーリスク
- 実装順序依存関係の明示が必要

#### S3-F006: integration/auto-yes-persistence.test.tsが設計書テスト影響テーブルに未記載
- 影響なしだが確認対象として記載すべき

### Nice to Have (4件)

- S3-F007: prompt-key.tsのクライアントバンドル影響は最小限
- S3-F008: AutoYesPollerState変更のglobalThis型宣言への影響なし
- S3-F009: session-cleanup.ts, prompt-answer-sender.tsへの影響なし
- S3-F010: COOLDOWN_INTERVAL_MSによる応答レイテンシ影響は限定的

---

## 8. 影響範囲サマリー図

```
直接変更 (5ファイル)
  src/lib/claude-session.ts          [対策1, 4: isSessionHealthy, HealthCheckResult]
  src/lib/auto-yes-manager.ts        [対策2, 5: lastAnsweredPromptKey, COOLDOWN]
  src/lib/prompt-key.ts              [新規: generatePromptKey()]
  src/hooks/useAutoYes.ts            [import変更: generatePromptKey]
  tests/unit/lib/prompt-key.test.ts  [新規テスト]

新規テスト追加 (2ファイル)
  tests/unit/lib/claude-session.test.ts    [偽陽性防止, reason検証テスト追加]
  tests/unit/lib/auto-yes-manager.test.ts  [重複防止, クールダウンテスト追加]

影響確認のみ (変更不要, 6ファイル)
  src/lib/cli-tools/claude.ts              [isClaudeRunning()にdelegate, 変更不要]
  src/lib/prompt-answer-sender.ts          [インターフェース変更なし]
  src/lib/session-cleanup.ts               [stopAutoYesPolling()使用, 変更不要]
  src/lib/cli-patterns.ts                  [対策3スコープ外]
  tests/unit/hooks/useAutoYes.test.ts      [import依存確認]
  tests/integration/auto-yes-persistence.test.ts [影響なし確認]

API Routes (影響なし, 8ファイル)
  全てisClaudeRunning()のboolean戻り値に依存 -> 変更なし
```

---

## 9. 承認ステータス

**条件付き承認**: must_fix 1件の対応を条件として承認。

| 条件 | 内容 |
|------|------|
| 必須 | S3-F001: isSessionHealthy()のcatchブロックのHealthCheckResult変換を設計書に追記 |
| 推奨 | S3-F002~F006: テスト影響テーブルの拡充と制御フロー図の補足 |

---

*Reviewed by architecture-review-agent (Stage 3: Impact Analysis)*
*Date: 2026-02-18*
