# Issue #152: セッション一発目のメッセージが送信されない - 設計方針書

## 概要

新しいWorktreeを選択して初回メッセージを送信した際、Claude CLIが完全に初期化される前にメッセージが送信され、メッセージが無視される問題を修正する。

## 問題の根本原因

1. `startClaudeSession()`がタイムアウト（10秒）を超えてもエラーにならず、セッションが「起動済み」として扱われる
2. プロンプト検出パターンがClaude CLIの全ての初期化状態をカバーしていない可能性
3. プロンプト検出後に追加の安定待機がない
4. セッション起動とメッセージ送信の間に準備状態の検証がない

## 設計方針

### 採用アプローチ: 案1（プロンプト検出の強化）+ 案2の一部

複合的なアプローチを採用し、信頼性を最大化する。

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/claude-session.ts` | プロンプト検出ロジックの強化、タイムアウト処理の改善 |
| `src/app/api/worktrees/[id]/send/route.ts` | エラーハンドリングの強化 |
| `src/components/worktree/MessageInput.tsx` | エラー表示の追加（必要に応じて） |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | エラーハンドリングの追加 |

---

## レビュー履歴

| 日付 | ステージ | レビュアー | ステータス |
|-----|---------|-----------|----------|
| 2026-02-04 | Stage 1 (通常レビュー) | architecture-review-agent | 条件付き承認 |
| 2026-02-04 | Stage 2 (整合性レビュー) | architecture-review-agent | 条件付き承認 |
| 2026-02-04 | Stage 3 (影響分析レビュー) | architecture-review-agent | 条件付き承認 |
| 2026-02-04 | Stage 4 (セキュリティレビュー) | architecture-review-agent | 条件付き承認 |

---

## レビュー指摘事項サマリー

### Must Fix (必須対応)

| ID | 原則 | タイトル | ステータス |
|----|-----|---------|----------|
| DRY-001 | DRY | プロンプト検出パターンが重複している | 設計書反映済 |
| CONS-001 | Consistency | sendMessageToClaude() の Enter 送信方式の不整合 | 設計書反映済 (Stage 2) |
| CONS-002 | Consistency | capturePane のインポート確認 | 検証済・偽陽性 (Stage 2) |
| IMP-001 | Breaking Change | startClaudeSession() の新例外が破壊的変更として未文書化 | 設計書反映済 (Stage 3) |
| IMP-002 | Test Coverage | 統合テストがモックを使用しており実際のレース条件をテスト不可 | 設計書反映済 (Stage 3) |

### Should Fix (推奨対応)

| ID | 原則 | タイトル | ステータス |
|----|-----|---------|----------|
| SRP-001 | SRP | waitForPrompt()のタイムアウト/ポーリングロジックが再利用不可 | 設計書反映済（YAGNI優先で現状維持） |
| DRY-002 | DRY | セパレータパターンも重複 | 設計書反映済 |
| OCP-001 | OCP | タイムアウト値とポーリング間隔がハードコード | 設計書反映済 |
| CONS-003 | Consistency | プロンプト検出パターンの差異 | Stage 1 DRY-001 で対応済 (Stage 2 検証済) |
| CONS-004 | Consistency | タイムアウト値の差異 | Stage 1 OCP-001 で対応済 (Stage 2 検証済) |
| CONS-005 | Consistency | タイムアウト時のエラースロー | 設計書に明記済 (Stage 2 検証済) |
| CONS-006 | Consistency | sendMessageToClaude() のプロンプト検証 | 設計書に明記済 (Stage 2 検証済) |
| CONS-007 | Consistency | プロンプト検出後の安定待機 | CLAUDE_POST_PROMPT_DELAY で対応済 (Stage 2 検証済) |
| IMP-003 | Impact Scope | claude-poller.ts が影響範囲に未記載 | 設計書反映済 (Stage 3) |
| IMP-004 | Impact Scope | api/hooks/claude-done/route.ts が影響範囲に未記載 | 設計書反映済 (Stage 3) |
| IMP-005 | Test Coverage | api-prompt-handling.test.ts が影響テストに未記載 | 設計書反映済 (Stage 3) |
| IMP-006 | API Response | タイムアウト時のエラーレスポンス形式が未指定 | 設計書反映済 (Stage 3) |
| IMP-007 | Rollback | 進行中セッションのロールバックシナリオが未対処 | 設計書反映済 (Stage 3) |
| SEC-001 | Security | tmux コマンドを execAsync から execFile に移行検討 | 技術的負債として記録 (Stage 4) |
| SEC-002 | Security | エラーメッセージの情報漏洩リスク確認 | 低リスク、現状維持 (Stage 4) |

### Nice to Have (検討事項)

| ID | 原則 | タイトル | ステータス |
|----|-----|---------|----------|
| KISS-001 | KISS | sendMessageToClaude()内の二重プロンプト確認 | 記録済（優先度低） |
| DOC-001 | Documentation | 500ms安定待機の根拠が不明 | 記録済（コメント追加推奨） |
| CONS-008 | Consistency | ログ出力の絵文字使用 | 軽微な差異、対応不要 |
| CONS-009 | Consistency | ClaudeTool ラッパーの整合性 | 変更不要（設計で確認済） |
| IMP-008 | Documentation | Codex/Gemini の CLI ツール整合性チェック | 記録済（影響なしを確認済） |
| IMP-009 | UI | MessageInput エラー表示は既存機能で対応可 | 記録済（追加変更不要） |
| IMP-010 | Test | cli-patterns.test.ts のテスト追加検討 | 記録済（優先度低） |
| SEC-003 | Security | 最大同時セッション数の文書化 | 記録済（優先度低） |
| SEC-004 | Security | セッション状態操作の排他制御 | 現状で適切に処理（記録のみ） |
| SEC-005 | Security | worktreeId の形式検証追加 | 記録済（優先度低） |

---

## Breaking Changes (IMP-001 対応)

### 新規例外: startClaudeSession() タイムアウトエラー

**変更内容:**
`startClaudeSession()` 関数は、初期化タイムアウト時に新たにエラーをスローするようになります。

**以前の動作:**
- タイムアウト後もセッションを「起動済み」として扱い、後続処理を続行
- エラーは発生せず、サイレントに失敗

**新しい動作:**
- タイムアウト時に `Error('Claude initialization timeout (15000ms)')` をスロー
- 呼び出し元はこのエラーをキャッチして適切に処理する必要がある

**影響を受ける呼び出し元:**

| ファイル | 行番号 | 呼び出しパス | 対応状況 |
|---------|-------|-------------|---------|
| `src/lib/cli-tools/claude.ts` | 56 | `startSession()` -> `startClaudeSession()` | エラーは上位に伝播 |
| `src/lib/claude-session.ts` | 373 | `restartClaudeSession()` -> `startClaudeSession()` | エラーは上位に伝播 |
| `src/app/api/worktrees/[id]/send/route.ts` | 100 | `ClaudeTool.startSession()` 経由 | try-catch で処理済 (lines 117-123) |

**エラーメッセージ形式:**
```
Claude initialization timeout (15000ms)
```

---

## API エラーレスポンス仕様 (IMP-006 対応)

### タイムアウトエラーのレスポンス

**エンドポイント:** `POST /api/worktrees/[id]/send`

**タイムアウト発生時:**
- **HTTP ステータスコード:** 500 Internal Server Error
- **レスポンス形式:**
```json
{
  "error": "Claude initialization timeout (15000ms)"
}
```

**設計判断:**
- タイムアウトエラーは他の内部エラーと同様に HTTP 500 で返却
- エラーメッセージにタイムアウト秒数を含め、問題の特定を容易にする
- タイムアウトを専用のステータスコード（例: 504 Gateway Timeout）で区別することも検討可能だが、現時点では他のエラーとの一貫性を優先

**既存のエラーハンドリング (send/route.ts lines 117-123):**
```typescript
} catch (error) {
  console.error('Error processing request:', error);
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'Failed to send message' },
    { status: 500 }
  );
}
```

---

## Stage 2 整合性レビュー詳細

### CONS-001: Enter キー送信方式の設計判断

**指摘内容:**
設計書では `sendKeys(sessionName, '', true)` を使用してEnterキーを送信する想定だが、現在の実装は `execAsync()` で直接 `C-m` を送信している。

**設計判断:**
`sendKeys()` を使用する方式を採用する。理由:
1. **抽象化の維持**: tmux操作は全て `sendKeys()` 経由で行うことで、将来的なtmux実装変更に対応しやすい
2. **一貫性**: メッセージ送信とEnter送信で異なる関数を使用する必要がない
3. **テスト容易性**: `sendKeys()` をモックすることで単体テストが容易

**実装コード:**
```typescript
// sendMessageToClaude() 内
await sendKeys(sessionName, message, false);  // メッセージ送信（Enterなし）
await sendKeys(sessionName, '', true);        // Enterキー送信
```

### CONS-002: capturePane インポート確認

**検証結果:** 偽陽性

`capturePane` は `src/lib/claude-session.ts` の Line 10 で既にインポート済み。
設計書の `waitForPrompt()` 実装で `capturePane()` を使用することに問題なし。

### CONS-003 - CONS-007: Stage 1 対応の検証

以下の指摘は Stage 1 レビューで既に対応済みであることを Stage 2 で検証した:

| 指摘 | 対応状況 |
|-----|---------|
| CONS-003 (プロンプトパターン) | DRY-001 で `CLAUDE_PROMPT_PATTERN` 使用を設計済 |
| CONS-004 (タイムアウト値) | OCP-001 で定数化を設計済 |
| CONS-005 (タイムアウトエラー) | 「タイムアウト時はエラーとして扱う」と明記済 |
| CONS-006 (プロンプト検証) | `sendMessageToClaude()` の改善で設計済 |
| CONS-007 (安定待機) | `CLAUDE_POST_PROMPT_DELAY = 500` で設計済 |

---

## Stage 3 影響分析レビュー詳細

### IMP-001: 破壊的変更の文書化

**対応:** 「Breaking Changes」セクションを新設し、以下を文書化:
- `startClaudeSession()` の新しいエラースロー動作
- 影響を受ける全呼び出し元のリスト
- エラーメッセージ形式の仕様

### IMP-002: テストカバレッジギャップ

**指摘内容:**
既存の統合テスト (`tests/integration/api-send-cli-tool.test.ts`) は `startClaudeSession` と `sendMessageToClaude` をモック化しており (lines 14-19)、実際のタイミング/レース条件をテストできない。

**設計判断:**
- **現在の統合テストの限界を認識:** モックを使用しているため、タイミング修正の検証は不可
- **検証戦略:**
  1. ユニットテストで `waitForPrompt()` と `startClaudeSession()` のタイムアウト動作を検証
  2. E2E テストまたは手動検証で実際の初回メッセージ送信を確認
  3. 本番環境でのモニタリングで再発がないことを確認

### IMP-003, IMP-004: 影響範囲の追加

影響範囲セクションに以下を追加:
- `src/lib/claude-poller.ts` - 変更不要（captureClaudeOutput, isClaudeRunning を使用、本修正の対象外）
- `src/app/api/hooks/claude-done/route.ts` - 変更不要（captureClaudeOutput のみ使用、影響なし）

### IMP-005: テストファイルの追加

テスト戦略セクションに追加:
- `tests/integration/api-prompt-handling.test.ts` - claude-session モジュールをモック化 (lines 48-51)。`waitForPrompt` をエクスポートする場合はモック更新が必要になる可能性あり

### IMP-006: API エラーレスポンス仕様

「API エラーレスポンス仕様」セクションを新設し、タイムアウト時のレスポンス形式を明確化。

### IMP-007: ロールバックシナリオ

ロールバック計画セクションに追記:
- 進行中セッションへの影響なし（新しいエラースロー動作は永続的な状態を変更しない）
- セッション起動済みのユーザーは正常に継続可能

---

## 実装優先順位

Stage 2 整合性レビューに基づく実装優先順位:

| 優先度 | 項目 | 対応する指摘 | 理由 |
|-------|------|-------------|------|
| 1 | タイムアウト時のエラースロー追加 | CONS-005, IMP-001 | バグの根本原因に直接対処 |
| 2 | CLAUDE_PROMPT_PATTERN/SEPARATOR_PATTERN のインポート・使用 | CONS-003, DRY-001, DRY-002 | パターン検出の網羅性向上 |
| 3 | sendMessageToClaude() のプロンプト検証追加 | CONS-006 | メッセージ送信の信頼性向上 |
| 4 | タイムアウト定数への置き換え | CONS-004, OCP-001 | 設定の可視性・変更容易性 |
| 5 | プロンプト検出後の安定待機追加 | CONS-007 | 描画完了の確実性向上 |
| 6 | sendKeys() による Enter 送信に統一 | CONS-001 | 抽象化レイヤーの一貫性 |

---

## 詳細設計

### 0. タイムアウト定数の定義 (OCP-001対応)

`src/lib/claude-session.ts` 冒頭に定数を定義し、設定の可視性を向上させる。

```typescript
import {
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SEPARATOR_PATTERN
} from './cli-patterns';

// ----- タイムアウト・ポーリング定数 (OCP-001) -----
/**
 * Claude CLI初期化の最大待機時間（ミリ秒）
 */
const CLAUDE_INIT_TIMEOUT = 15000;

/**
 * 初期化ポーリング間隔（ミリ秒）
 */
const CLAUDE_INIT_POLL_INTERVAL = 300;

/**
 * プロンプト検出後の安定待機時間（ミリ秒）
 * Claude CLIの描画完了を確実にするためのバッファ (DOC-001対応)
 */
const CLAUDE_POST_PROMPT_DELAY = 500;

/**
 * メッセージ送信前のプロンプト待機タイムアウト（ミリ秒）
 */
const CLAUDE_PROMPT_WAIT_TIMEOUT = 5000;

/**
 * プロンプト待機ポーリング間隔（ミリ秒）
 */
const CLAUDE_PROMPT_POLL_INTERVAL = 200;
```

### 1. startClaudeSession() の改善

#### 変更点

```typescript
// Before
const maxWaitTime = 10000;
const pollInterval = 500;

// After - 定数を使用 (OCP-001)
const maxWaitTime = CLAUDE_INIT_TIMEOUT;  // 15000ms
const pollInterval = CLAUDE_INIT_POLL_INTERVAL;  // 300ms
```

#### プロンプト検出ロジックの強化 (DRY-001, DRY-002対応)

```typescript
import {
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SEPARATOR_PATTERN
} from './cli-patterns';

// Before - ハードコードされたパターン
if (/^>\s*$/m.test(output) || /^─{10,}$/m.test(output)) {
  break;
}

// After - cli-patterns.ts の定数を使用
// CLAUDE_PROMPT_PATTERN: /^[>❯](\s*$|\s+\S)/m
//   - '>' (レガシー) と '❯' (新形式) の両方のプロンプト文字をサポート
//   - 空のプロンプトとコマンド付きプロンプトの両方を検出
// CLAUDE_SEPARATOR_PATTERN: /^─{10,}$/m
//   - セパレータラインを検出
if (CLAUDE_PROMPT_PATTERN.test(output) || CLAUDE_SEPARATOR_PATTERN.test(output)) {
  // プロンプト検出後、追加の安定待機 (DOC-001: 描画完了バッファ)
  await new Promise((resolve) => setTimeout(resolve, CLAUDE_POST_PROMPT_DELAY));
  console.log(`Claude initialized in ${Date.now() - startTime}ms`);
  return; // 正常終了
}
```

**DRY-001 対応のポイント:**
- `/^>\s*$/m` は レガシープロンプト `>` のみを検出
- `CLAUDE_PROMPT_PATTERN` は `>` と `❯` (U+276F) の両方を検出
- 新しいプロンプト文字への対応漏れを防止

#### タイムアウト処理の改善 (CONS-005, IMP-001 対応)

```typescript
// タイムアウト時はエラーとして扱う
// 重要: 現在の実装はタイムアウト後も続行するが、これがバグの根本原因
// IMP-001: この新しいエラースローは破壊的変更である
throw new Error(`Claude initialization timeout (${CLAUDE_INIT_TIMEOUT}ms)`);
```

### 2. waitForPrompt() 関数の新規実装

セッションがプロンプト状態であることを確認するユーティリティ関数を追加。

```typescript
import { CLAUDE_PROMPT_PATTERN } from './cli-patterns';

/**
 * セッションがプロンプト状態になるまで待機
 * @param sessionName tmuxセッション名
 * @param timeout タイムアウト時間（ミリ秒）
 * @throws Error タイムアウト時
 */
export async function waitForPrompt(
  sessionName: string,
  timeout: number = CLAUDE_PROMPT_WAIT_TIMEOUT
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = CLAUDE_PROMPT_POLL_INTERVAL;

  while (Date.now() - startTime < timeout) {
    const output = await capturePane(sessionName, { startLine: -10 });
    // DRY-001: cli-patterns.ts の定数を使用
    if (CLAUDE_PROMPT_PATTERN.test(output)) {
      return; // プロンプト検出
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Prompt detection timeout (${timeout}ms)`);
}
```

**SRP-001 設計判断:**
- `waitForPrompt()` と `startClaudeSession()` のポーリングロジックは類似構造を持つ
- しかし、YAGNI/KISS の観点から過度な抽象化は避ける
- 将来、同様のパターンが3箇所以上で必要になった場合に `pollWithTimeout()` 汎用関数の抽出を検討
- 現時点では各関数の責務を明確に分離し、シンプルな実装を維持

### 3. sendMessageToClaude() の改善 (CONS-001, CONS-006 対応)

メッセージ送信前にプロンプト状態を確認し、Enter送信は `sendKeys()` を使用。

```typescript
import { CLAUDE_PROMPT_PATTERN } from './cli-patterns';

export async function sendMessageToClaude(
  worktreeId: string,
  message: string
): Promise<void> {
  const sessionName = getSessionName(worktreeId);

  // セッション存在確認
  const exists = await hasSession(sessionName);
  if (!exists) {
    throw new Error(`Claude session ${sessionName} does not exist`);
  }

  // 送信前にプロンプト状態を確認 (CONS-006, DRY-001: cli-patterns.ts 使用)
  const output = await capturePane(sessionName, { startLine: -10 });
  if (!CLAUDE_PROMPT_PATTERN.test(output)) {
    // プロンプトが表示されるまで待機
    await waitForPrompt(sessionName, CLAUDE_PROMPT_WAIT_TIMEOUT);
  }

  // メッセージ送信 (CONS-001: sendKeys() を一貫して使用)
  await sendKeys(sessionName, message, false);  // メッセージ送信（Enterなし）
  await sendKeys(sessionName, '', true);        // Enter送信
}
```

**CONS-001 設計判断:**
- `execAsync()` 直接呼び出しではなく `sendKeys()` を使用
- 抽象化レイヤーを維持し、tmux実装の詳細を隠蔽
- テスト時のモック化が容易

**KISS-001 検討事項:**
- 現在の設計では送信前に一度プロンプト状態を確認し、プロンプトでなければ `waitForPrompt()` を呼ぶ
- `waitForPrompt()` 内でも即座にプロンプト検出すれば即時returnするため、単純に `waitForPrompt()` を呼ぶだけでも動作する
- しかし、現在の設計は意図が明確であり、パフォーマンスへの影響も軽微なため現状維持とする
- 優先度: 低

### 4. UIエラーハンドリング

#### MessageInput.tsx

現状の`sending`ステートを活用し、エラー時はToast通知で対応。

**IMP-009 確認:**
MessageInput.tsx は既に error state とエラー表示を実装済み (lines 35, 78, 206-209)。`handleApiError()` 経由でエラーを処理しており、追加の変更は不要。

#### WorktreeDetailRefactored.tsx

`handleMessageSent`でエラーをキャッチし、適切なフィードバックを表示。

---

## 設計原則への準拠

### SOLID原則

| 原則 | 準拠状況 | 説明 |
|-----|---------|-----|
| SRP | ✅ | waitForPrompt()は単一責任（プロンプト待機のみ）。SRP-001対応でポーリング抽象化はYAGNI優先で見送り |
| OCP | ✅ | 既存のsendMessageToClaude()を拡張、既存機能に影響なし。OCP-001対応でタイムアウト値を定数化 |
| LSP | N/A | 継承関係なし |
| ISP | N/A | インターフェース変更なし |
| DIP | ✅ | tmux操作は既存の抽象化（capturePane, sendKeys）を使用。CONS-001対応でsendKeys()に統一 |

### その他の原則

| 原則 | 準拠状況 | 説明 |
|-----|---------|-----|
| KISS | ✅ | シンプルなポーリングループで実装。過度な抽象化を避ける（SRP-001判断） |
| YAGNI | ✅ | 必要な機能のみ実装。pollWithTimeout()抽象化は将来の必要性に応じて検討 |
| DRY | ✅ | DRY-001/DRY-002対応: cli-patterns.tsのCLAUDE_PROMPT_PATTERN/CLAUDE_SEPARATOR_PATTERNを使用 |

---

## セキュリティ考慮事項

### Stage 4 OWASP Top 10 分析サマリー

| OWASP カテゴリ | リスクレベル | 評価 |
|--------------|------------|------|
| A01: アクセス制御の不備 | LOW | セッション名は worktreeId から内部生成。DB 検証で保護 |
| A02: 暗号化の失敗 | N/A | 暗号化操作なし |
| A03: インジェクション | MEDIUM | execAsync 使用は既存課題。本変更による新規リスクなし |
| A04: 安全でない設計 | LOW | タイムアウト処理の追加でセキュリティ向上 |
| A05: セキュリティ設定ミス | LOW | ハードコード定数で適切 |
| A06: 脆弱なコンポーネント | N/A | 新規依存なし |
| A07: 認証セッション障害 | LOW | ローカルプロセス管理、ユーザー認証ではない |
| A08: データ整合性障害 | LOW | データ永続化ロジック変更なし |
| A09: ログ監視障害 | LOW | 適切なエラーログ。タイムアウト値の露出は低リスク |
| A10: SSRF | N/A | サーバーサイドリクエスト機能なし |

### セキュリティ対策一覧

| 項目 | 対策 | 備考 |
|-----|-----|------|
| コマンドインジェクション | セッション名は内部生成（`mcbd-claude-{worktreeId}`）、DB 由来の UUID で制限 | SEC-001: execFile 移行は将来の技術的負債として記録 |
| DoS対策 | タイムアウト上限（15秒）を設定、定数化により可視性向上 | プロンプト検出パターンは ReDoS リスクなし |
| エラー情報漏洩 | エラーメッセージにセンシティブ情報を含めない | SEC-002: タイムアウト値の露出は低リスク |
| レース条件 | 既存の「セッション存在確認」で適切に処理 | SEC-004: 追加の排他制御は不要 |
| アクセス制御 | worktree 存在を DB 検証後に操作を実行 | SEC-005: 形式検証追加は将来検討 |

### SEC-001: execAsync から execFile への移行（技術的負債）

**現状:**
- `src/lib/tmux.ts` の複数関数で `execAsync`（promisified exec）を使用
- シェル解釈レイヤーを経由するため、理論上はインジェクションリスクが存在

**緩和要因:**
- セッション名は内部生成（`getSessionName()` で `mcbd-claude-` プレフィックス + worktreeId）
- worktreeId は DB の UUID から取得、外部入力ではない
- `sendKeys()` 関数では単一引用符のエスケープを実装済み

**設計判断:**
- Issue #152 のスコープ外（既存課題であり、本変更で導入されたものではない）
- 将来の改善として `execFile` への移行を推奨
- 推奨実装: `execFile('tmux', ['send-keys', '-t', sessionName, escapedKeys, 'C-m'])`

**対応状況:** 技術的負債として記録。将来の tmux.ts リファクタリング時に対応

### SEC-002: エラーメッセージの情報漏洩リスク

**現状:**
- API エラーレスポンスにタイムアウト秒数を含む: `{"error": "Claude initialization timeout (15000ms)"}`
- 内部タイミング設定の露出となる

**リスク評価:**
- **低リスク:** ローカル開発ツールとしての利用が想定される
- **考慮点:** 信頼できないネットワークに公開する場合はリスクが高まる

**設計判断:**
- 現時点ではデバッグ利便性を優先し、詳細なエラーメッセージを維持
- 本番環境での公開時は、汎用エラーメッセージへの変更を検討（例: `{"error": "Session initialization failed"}`）

**対応状況:** 低リスク、現状維持。環境に応じた将来検討事項として記録

---

## テスト戦略

### ユニットテスト

| テスト対象 | テストケース |
|-----------|------------|
| waitForPrompt() | プロンプト検出成功 |
| waitForPrompt() | タイムアウト発生 |
| startClaudeSession() | 正常初期化 |
| startClaudeSession() | タイムアウトエラー |
| CLAUDE_PROMPT_PATTERN | レガシープロンプト `>` の検出 |
| CLAUDE_PROMPT_PATTERN | 新プロンプト `❯` の検出 |

### インテグレーションテスト

| テスト対象 | テストケース |
|-----------|------------|
| send/route.ts | 新規セッション + 初回メッセージ送信成功 |
| send/route.ts | セッション初期化タイムアウト時のエラーレスポンス |

### テストカバレッジに関する注意 (IMP-002 対応)

**モック使用による制限:**
- `tests/integration/api-send-cli-tool.test.ts` (lines 14-19): `startClaudeSession` と `sendMessageToClaude` をモック化
- `tests/integration/api-prompt-handling.test.ts` (lines 48-51): `getSessionName` と `isClaudeRunning` をモック化

これらのモックにより、実際のタイミング/レース条件の検証は統合テストでは不可能。

**検証戦略:**
1. **ユニットテスト:** タイムアウト動作とプロンプト検出ロジックを個別に検証
2. **E2E テスト:** 実際の Claude CLI を使用した初回メッセージ送信のテストを検討
3. **手動検証:** リリース前に新規 Worktree での初回メッセージ送信を手動確認
4. **モニタリング:** 本番環境でのエラーログを監視し、タイムアウトエラーの発生頻度を確認

### 影響を受けるテストファイル (IMP-005 対応)

| テストファイル | 影響 | 対応 |
|--------------|------|------|
| `tests/integration/api-send-cli-tool.test.ts` | `startClaudeSession`, `sendMessageToClaude` をモック | `waitForPrompt` をエクスポートする場合はモック追加が必要 |
| `tests/integration/api-prompt-handling.test.ts` | claude-session モジュールをモック | 新規エクスポートがある場合はモック更新が必要 |
| `tests/unit/cli-tools/claude.test.ts` | ClaudeTool のプロパティをテスト | 変更不要 |
| `src/lib/__tests__/cli-patterns.test.ts` | CLAUDE_PROMPT_PATTERN をテスト | 変更不要（追加テスト検討可） |

---

## 影響範囲

### 直接影響

- `src/lib/claude-session.ts` - コア修正
- `src/app/api/worktrees/[id]/send/route.ts` - エラーハンドリング強化

### 間接影響

| ファイル | 影響度 | 説明 |
|---------|-------|------|
| `src/lib/cli-tools/claude.ts` | 低 | claude-session.ts をラップ。エラー動作が変更されるが、コード変更不要 |
| `src/lib/claude-poller.ts` | なし | captureClaudeOutput, isClaudeRunning を使用 - 本修正の対象関数とは異なる (IMP-003) |
| `src/app/api/hooks/claude-done/route.ts` | なし | captureClaudeOutput のみ使用 - 影響なし (IMP-004) |
| `src/lib/cli-tools/manager.ts` | なし | ClaudeTool をインスタンス化するが、claude-session.ts 関数を直接呼び出さない |
| `src/components/worktree/MessageInput.tsx` | 低 | 新しいタイムアウトエラーメッセージを表示する可能性。既存のエラーハンドリングで対応可 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 低 | handleMessageSent() コールバックでエラーを処理。MessageInput がエラーをハンドリング |

### 影響なし

| ファイル | 理由 |
|---------|------|
| `src/lib/cli-tools/codex.ts` | 固定遅延方式（3000ms）を使用 - プロンプト検出不要 (IMP-008) |
| `src/lib/cli-tools/gemini.ts` | 非対話型ツール - セッション管理なし (IMP-008) |

---

## ロールバック計画

変更がシンプルなため、ロールバックは容易。

### 手順

1. `src/lib/claude-session.ts`の変更をrevert
2. `src/app/api/worktrees/[id]/send/route.ts`の変更をrevert
3. DBマイグレーション不要
4. 設定変更不要

### 進行中セッションへの影響 (IMP-007 対応)

**影響なし:**
- 新しいエラースロー動作は永続的な状態を変更しない
- ロールバック時、既に起動済みのセッションは正常に動作を継続
- デプロイ期間中にタイムアウトエラーを経験したユーザーは、再試行することで正常に操作可能
- データベースやファイルシステムへの永続的な変更がないため、クリーンアップ作業は不要

---

## 実装チェックリスト

### 必須項目

- [ ] **DRY-001**: `CLAUDE_PROMPT_PATTERN` を cli-patterns.ts からインポートして使用
- [ ] **DRY-002**: `CLAUDE_SEPARATOR_PATTERN` を cli-patterns.ts からインポートして使用
- [ ] **OCP-001**: タイムアウト値を名前付き定数として抽出
  - [ ] `CLAUDE_INIT_TIMEOUT = 15000`
  - [ ] `CLAUDE_INIT_POLL_INTERVAL = 300`
  - [ ] `CLAUDE_POST_PROMPT_DELAY = 500`
  - [ ] `CLAUDE_PROMPT_WAIT_TIMEOUT = 5000`
  - [ ] `CLAUDE_PROMPT_POLL_INTERVAL = 200`
- [ ] **CONS-001**: sendMessageToClaude() で Enter 送信に `sendKeys()` を使用
- [ ] **CONS-005/IMP-001**: startClaudeSession() タイムアウト時にエラーをスロー
- [ ] **CONS-006**: sendMessageToClaude() 送信前にプロンプト状態を検証
- [ ] **CONS-007**: プロンプト検出後に `CLAUDE_POST_PROMPT_DELAY` で安定待機
- [ ] waitForPrompt()関数の実装（CLAUDE_PROMPT_PATTERN使用）
- [ ] startClaudeSession()のタイムアウト延長と安定待機追加

### テスト

- [ ] ユニットテストの追加
- [ ] インテグレーションテストの更新
- [ ] **IMP-002**: タイミング検証のためのE2Eテストまたは手動検証手順の作成

### UI

- [ ] UIエラーハンドリングの確認

### ドキュメント

- [ ] **IMP-001**: 破壊的変更のリリースノート記載
- [ ] **IMP-006**: API エラーレスポンス仕様の確認
- [ ] **DOC-001** (Nice to Have): 500ms安定待機の根拠をコードコメントに追記

---

*作成日: 2026-02-04*
*Issue: #152*
*レビュー反映: Stage 1 (2026-02-04), Stage 2 (2026-02-04), Stage 3 (2026-02-04), Stage 4 (2026-02-04)*
