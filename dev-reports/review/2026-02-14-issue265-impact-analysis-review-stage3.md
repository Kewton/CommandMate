# Architecture Review: Issue #265 - Impact Analysis (Stage 3)

## Executive Summary

| 項目 | 値 |
|------|-----|
| **Issue** | #265 - Claude CLIパスキャッシュの無効化と壊れたtmuxセッションの自動回復 |
| **レビューステージ** | Stage 3: 影響範囲分析レビュー |
| **ステータス** | 条件付き承認 (Conditionally Approved) |
| **スコア** | 4/5 |
| **レビュー日** | 2026-02-14 |
| **前提** | Stage 1 (設計原則) 4/5 条件付き承認、Stage 2 (整合性) 4/5 条件付き承認 |

Issue #265 の設計方針書を影響範囲の観点からレビューした。変更対象は主に `claude-session.ts`（4つの新関数追加 + フロー変更）、`cli-patterns.ts`（2つの新定数追加）、`daemon.ts`（env オブジェクト修正）の3ファイルだが、`claude-session.ts` の変更は `ClaudeTool` を経由して10以上の API ルートに波及する。最も重要な指摘として、`isClaudeRunning()` がヘルスチェックを含まないため、壊れたセッションが API レイヤーで「実行中」と誤報告される問題がある。

---

## 1. 変更の波及効果分析

### 1.1 直接変更ファイル

| ファイル | 変更内容 | リスク |
|---------|---------|-------|
| `src/lib/claude-session.ts` | 4新関数追加、startClaudeSession()フロー変更、3箇所のcapturePane+stripAnsi置換、新export追加 | Medium |
| `src/lib/cli-patterns.ts` | CLAUDE_SESSION_ERROR_PATTERNS / CLAUDE_SESSION_ERROR_REGEX_PATTERNS 定数追加 | Low |
| `src/cli/utils/daemon.ts` | DaemonManager.start() の env オブジェクトから CLAUDECODE を delete | Low |
| `tests/unit/lib/claude-session.test.ts` | Issue #265 テスト追加（新規 describe ブロック） | Low |

### 1.2 間接影響ファイル（呼び出し元の連鎖）

変更の波及は以下の経路で伝搬する:

```
claude-session.ts (直接変更)
  |
  +-> cli-tools/claude.ts (ClaudeTool.startSession / isRunning)
  |     |
  |     +-> api/worktrees/[id]/send/route.ts     [HIGH RISK]
  |     +-> api/worktrees/[id]/route.ts           [MEDIUM RISK]
  |     +-> api/worktrees/route.ts                [MEDIUM RISK]
  |     +-> api/worktrees/[id]/current-output/    [MEDIUM RISK]
  |     +-> api/worktrees/[id]/prompt-response/   [MEDIUM RISK]
  |     +-> api/worktrees/[id]/kill-session/      [LOW RISK]
  |     +-> api/worktrees/[id]/interrupt/         [LOW RISK]
  |     +-> api/repositories/route.ts             [LOW RISK]
  |
  +-> session-cleanup.ts (影響なし: tmux.killSession 直接使用)
  |
  +-> api/hooks/claude-done/route.ts (captureClaudeOutput: 影響なし)

cli-patterns.ts (直接変更)
  |
  +-> response-poller.ts     (影響なし: 新定数未使用)
  +-> auto-yes-manager.ts    (影響なし: 新定数未使用)
  +-> status-detector.ts     (影響なし: 新定数未使用)
  +-> 他6モジュール           (影響なし: 新定数未使用)

daemon.ts (直接変更)
  |
  +-> cli/commands/start.ts   (DaemonManager.start 経由: env変更が波及)
  +-> daemon-factory.ts       (DaemonManagerWrapper 経由: env変更が波及)
```

### 1.3 影響を受けないモジュール

以下のモジュールは変更の影響を受けない:

- `src/lib/response-poller.ts` - cli-patterns.ts の既存 export のみ使用
- `src/lib/auto-yes-manager.ts` - cli-patterns.ts の既存 export のみ使用
- `src/lib/status-detector.ts` - cli-patterns.ts の既存 export のみ使用
- `src/lib/session-cleanup.ts` - tmux.killSession() を直接使用
- `src/lib/pasted-text-helper.ts` - cli-patterns.ts の既存 export のみ使用
- `src/lib/cli-tools/codex.ts` - 独自の tmux セッション管理
- `src/components/` - フロントエンドコンポーネント群（API レスポンスの形式不変のため）

---

## 2. 詳細な影響分析

### 2.1 MF-S3-001: isClaudeRunning() と API レイヤーの不整合（Must Fix）

**問題**: `isClaudeRunning()` (L224-227) は `hasSession()` のみで判定しており、Bug 2 修正後も壊れたセッションを「実行中」と報告する。

**現在のコード** (`src/lib/claude-session.ts` L224-227):

```typescript
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  return await hasSession(sessionName);
}
```

**影響を受ける API ルート**:

| API ルート | 使用箇所 | 壊れたセッション時の影響 |
|-----------|---------|----------------------|
| `POST /api/worktrees/:id/send` | L95: `isRunning()` -> L98-100: true なら startSession() スキップ | **高**: sendMessage() が壊れたセッションに送信を試み 500 エラーを返す |
| `GET /api/worktrees/:id` | L48: `isRunning()` -> L55: true なら captureSessionOutput() | **中**: ステータス検出エラーだが try-catch で吸収 |
| `GET /api/worktrees` | L48: `isRunning()` -> L55: true なら captureSessionOutput() | **中**: サイドバーに不正確なステータス表示 |
| `GET /api/worktrees/:id/current-output` | L47: `isRunning()` | **中**: 空 or エラーの出力を返す |
| `POST /api/worktrees/:id/prompt-response` | L57: `isRunning()` | **中**: セッション未実行エラーではなく予期しないエラー |
| `DELETE /api/worktrees/:id/kill-session` | L61: `isRunning()` | **低**: kill はいずれにせよ実行される |
| `POST /api/worktrees/:id/interrupt` | L67: `isRunning()` | **低**: Escape 送信が失敗するだけ |
| `GET /api/repositories` | L33: `isRunning()` | **低**: ステータス表示のみ |

最も問題なのは `send/route.ts` のパスである。このルートでは:

1. `isRunning()` が true を返す（壊れたセッションでも）
2. `startSession()` がスキップされる（L98: `if (!running)`）
3. `sendMessage()` が壊れたセッションに送信を試みる
4. エラーが発生して 500 レスポンスを返す

**Bug 2 の修正意図**: 壊れたセッションの自動回復は `startClaudeSession()` 内で行われる設計だが、上記パスでは `startClaudeSession()` が呼ばれないため回復が発動しない。

**推奨対策**: `isClaudeRunning()` 内でもヘルスチェックを実施する。

```typescript
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) return false;
  // Bug 2: Verify session health, not just tmux existence
  return await isSessionHealthy(sessionName);
}
```

この変更により全 API ルートが壊れたセッションを正しく「未実行」と認識し、次の `startSession()` 呼び出しで回復フローが発動する。追加のオーバーヘッドは ~50ms/回だが、API レスポンスタイム（通常数百ms以上）に対して許容範囲。

### 2.2 MF-S3-002: tmux set-environment -g -u のグローバルスコープ（Must Fix）

**問題**: `sanitizeSessionEnvironment()` の対策 3-1 で実行する `tmux set-environment -g -u CLAUDECODE` は tmux のグローバル環境に作用する。

**影響分析**:

- CommandMate は tmux セッション名を `mcbd-{cli_tool_id}-{worktree_id}` 形式で管理
- Claude/Codex/Gemini の全セッションが同一 tmux サーバー上で動作
- `-g` フラグによるグローバル環境変更は全セッションに波及

**実害の有無**:

| 条件 | 影響 |
|------|------|
| CLAUDECODE 変数が Claude 固有 | Codex/Gemini セッションに **実害なし** |
| 複数 Claude セッション同時起動 | `unset` 操作は冪等のため **安全** |
| 将来の tmux 環境変数操作追加 | **競合リスク**あり（要注意） |

**推奨**: 設計方針書に「-g フラグのグローバルスコープが許容される根拠」を明記する。

### 2.3 SF-S3-001: restartClaudeSession() との相互作用（Should Fix）

**現在のコード** (`src/lib/claude-session.ts` L522-535):

```typescript
export async function restartClaudeSession(options: ClaudeSessionOptions): Promise<void> {
  const { worktreeId } = options;
  await stopClaudeSession(worktreeId);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await startClaudeSession(options);
}
```

**Bug 2 修正後のフロー**:

1. `stopClaudeSession()` がセッションを kill
2. 1000ms 待機
3. `startClaudeSession()` が呼ばれる
   - `hasSession()` -> false（正常に kill された場合）
   - 新規セッション作成フローへ

**stop が失敗した場合**:

1. `stopClaudeSession()` が false を返す（セッション残存）
2. 1000ms 待機
3. `startClaudeSession()` が呼ばれる
   - `hasSession()` -> true
   - `ensureHealthySession()` -> false（壊れている）
   - kill + 再作成フローへ

この二重パスは `killSession()` の冪等性（tmux セッション未存在時は false を返す）により安全だが、設計書に記載がない。

### 2.4 SF-S3-002: 既存テストへの影響

**影響を受けるテスト**:

| テストファイル | テスト数 | 影響内容 |
|--------------|---------|---------|
| `tests/unit/lib/claude-session.test.ts` | 25+ | `startClaudeSession()` のテストで sendKeys モック呼び出し回数が変化する可能性 |
| `tests/integration/trust-dialog-auto-response.test.ts` | 4+ | 同上 + exec モックに tmux set-environment コマンドが追加される |

**具体的な影響**:

`startClaudeSession()` のテストでは、`sendKeys` の呼び出し回数を検証している箇所がある。Bug 3 の sanitizeSessionEnvironment() 追加により:

- `sendKeys(sessionName, 'unset CLAUDECODE', true)` が新たに呼ばれる
- 既存テストの `expect(sendKeys).toHaveBeenCalledTimes(N)` が N+1 になる可能性

また、`exec` モック（child_process）に `tmux set-environment -g -u CLAUDECODE` コマンドが新たに渡されるため、exec モックのコールバック処理が対応する必要がある。

**trust-dialog-auto-response.test.ts** の exec モック（L21-32）は `which claude` 以外のコマンドに対して空の stdout を返す設計のため、tmux set-environment コマンドにも空レスポンスを返して正常動作する。ただし、sendKeys のモック呼び出し回数の検証がある場合は修正が必要。

### 2.5 SF-S3-003: clearCachedClaudePath() export の公開 API 拡張

**現在の claude-session.ts のエクスポート**:

```typescript
// 定数
export const CLAUDE_INIT_TIMEOUT = 15000;
export const CLAUDE_INIT_POLL_INTERVAL = 300;
export const CLAUDE_POST_PROMPT_DELAY = 500;
export const CLAUDE_PROMPT_WAIT_TIMEOUT = 5000;
export const CLAUDE_SEND_PROMPT_WAIT_TIMEOUT = 10000;
export const CLAUDE_PROMPT_POLL_INTERVAL = 200;

// 型
export interface ClaudeSessionOptions { ... }
export interface ClaudeSessionState { ... }

// 関数
export function getSessionName(...) { ... }
export async function isClaudeInstalled(...) { ... }
export async function isClaudeRunning(...) { ... }
export async function getClaudeSessionState(...) { ... }
export async function waitForPrompt(...) { ... }
export async function startClaudeSession(...) { ... }
export async function sendMessageToClaude(...) { ... }
export async function captureClaudeOutput(...) { ... }
export async function stopClaudeSession(...) { ... }
export async function restartClaudeSession(...) { ... }
```

**追加される export**:

```typescript
export function clearCachedClaudePath(): void { ... }  // @internal
```

`@internal` タグは TypeScript のランタイムで強制されないため、意図しない外部使用のリスクがある。ただし、version-checker.ts の `resetCacheForTesting()` に先例があり、プロジェクト内の慣行としては確立されている。

### 2.6 SF-S3-004: パフォーマンスタイムライン分析

新規セッション作成時のタイムライン（Bug 修正後）:

```
T=0ms      isClaudeInstalled()        ~50ms
T=50ms     hasSession()               ~50ms
T=100ms    createSession()            ~100ms
T=200ms    sanitizeSessionEnvironment()
             tmux set-environment     ~50ms
             sendKeys(unset)          ~50ms
             100ms wait               ~100ms
T=400ms    getClaudePath()            ~数ms (キャッシュヒット)
T=400ms    sendKeys(claudePath)       ~50ms
T=450ms    ポーリングループ開始        最大14,550ms
T=15000ms  タイムアウト
```

sanitizeSessionEnvironment() の ~200ms 追加により、ポーリングに使える時間が 14,550ms -> 14,350ms に減少する。実質的な影響は無視できる。

既存セッション再利用時（正常）:

```
T=0ms      isClaudeInstalled()        ~50ms
T=50ms     hasSession() -> true       ~50ms
T=100ms    isSessionHealthy()         ~50ms (capturePane + pattern match)
T=150ms    return (セッション再利用)
```

既存のフロー（Bug 修正前）は hasSession() -> true -> 即 return (~100ms) であり、isSessionHealthy() の ~50ms が追加される。

---

## 3. 後方互換性分析

### 3.1 API 互換性

| 項目 | 互換性 |
|------|--------|
| API エンドポイントの URL | 変更なし |
| リクエスト形式 | 変更なし |
| レスポンス形式 | 変更なし |
| HTTP ステータスコード | 変更なし |
| エラーメッセージ形式 | 変更なし |

### 3.2 動作変更

| 変更点 | 以前の動作 | 変更後の動作 | 互換性 |
|--------|-----------|-------------|--------|
| 壊れたセッションの扱い | 存在すれば再利用（エラー発生） | ヘルスチェック -> kill -> 再作成 | **改善**（ユーザー体験向上） |
| セッション開始時の遅延 | なし | +100-300ms | 許容範囲 |
| Claude パスキャッシュ | 永続（再起動まで） | 失敗時クリア | **改善**（自己修復） |
| daemon start の env | CLAUDECODE が含まれる可能性 | CLAUDECODE が除去される | **改善**（ネスト検出防止） |

### 3.3 Breaking Changes

なし。全ての変更は内部実装の改善であり、外部 API や設定ファイルへの変更はない。

---

## 4. テストカバレッジ評価

### 4.1 設計方針書に含まれるテスト

| テスト対象 | カバレッジ | 評価 |
|-----------|-----------|------|
| clearCachedClaudePath() | 単体テスト計画あり | 十分 |
| isSessionHealthy() パターンマッチ | 各パターンの個別テスト計画あり | 十分 |
| ensureHealthySession() フロー | kill + フォールスルーのテスト計画あり | 十分 |
| getCleanPaneOutput() | 動作確認テスト計画あり | 十分 |
| sanitizeSessionEnvironment() | コマンド送信テスト計画あり | 十分 |
| daemon.ts env 除去 | process.env 不変のテスト計画あり | 十分 |
| SF-004 検証 | 対策 3-1 のみの除去確認テスト計画あり | 十分 |

### 4.2 テストギャップ

| ギャップ | 重要度 | 推奨アクション |
|---------|-------|--------------|
| isClaudeRunning() が壊れたセッションで true を返す場合の API 統合テスト | 高 | MF-S3-001 の対策後にテスト追加 |
| trust-dialog-auto-response.test.ts の sendKeys 呼び出し回数変化 | 中 | 既存テストの修正計画を追加 |
| restartClaudeSession() 経由の二重回復パス | 低 | 将来の回帰テストとして検討 |
| 複数 Claude セッション同時起動の競合テスト | 低 | 将来の統合テストとして検討 |

---

## 5. リスクアセスメント

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | isClaudeRunning() と API ルートの不整合（MF-S3-001） | High | High | **P1** |
| 技術的リスク | tmux set-environment -g のグローバルスコープ（MF-S3-002） | Medium | Low | **P2** |
| 技術的リスク | 既存テストの sendKeys モック呼び出し回数変化（SF-S3-002） | Medium | High | **P2** |
| パフォーマンスリスク | sanitizeSessionEnvironment() の遅延（SF-S3-004） | Low | Medium | **P3** |
| 運用リスク | build-and-start.sh 経由の CLAUDECODE 伝搬（C-S3-003） | Low | Low | **P4** |
| セキュリティリスク | clearCachedClaudePath() の意図しない外部使用（SF-S3-003） | Low | Low | **P4** |

---

## 6. 改善推奨事項

### 6.1 必須改善項目 (Must Fix) - 2件

#### MF-S3-001: isClaudeRunning() にヘルスチェックを追加

**対象ファイル**: `src/lib/claude-session.ts` L224-227

**理由**: 壊れたセッションが API レイヤーで「実行中」と報告され、send/route.ts の自動回復パスが発動しない。Bug 2 の修正効果が startClaudeSession() 経由でのみ発動し、isRunning() -> true -> startSession() スキップのパスでは無効になる。

**推奨実装**:

```typescript
export async function isClaudeRunning(worktreeId: string): Promise<boolean> {
  const sessionName = getSessionName(worktreeId);
  const exists = await hasSession(sessionName);
  if (!exists) return false;
  return await isSessionHealthy(sessionName);
}
```

**設計書への反映箇所**: Section 2（アーキテクチャ設計）の影響範囲に isClaudeRunning() を追加。Section 9（実装タスク）にタスクを追加。

#### MF-S3-002: tmux set-environment -g のグローバルスコープの設計根拠を明記

**対象ファイル**: 設計方針書 Section 3（Bug 3 対策）、Section 6（セキュリティ設計）

**理由**: `-g` フラグが全 tmux セッションに影響する点が設計書で明示されておらず、将来の保守者が意図しない副作用を見逃す可能性がある。

**推奨**: 設計方針書の sanitizeSessionEnvironment() のコード例に以下のコメントを追加:

```typescript
// MF-S3-002: -g flag affects tmux global environment (all sessions).
// This is acceptable because:
// 1. CLAUDECODE is Claude Code specific; no impact on Codex/Gemini sessions
// 2. unset is idempotent; safe under concurrent Claude session starts
// 3. If future env vars need session-scoped removal, use -t <session> instead
```

### 6.2 推奨改善項目 (Should Fix) - 5件

#### SF-S3-001: restartClaudeSession() との相互作用の設計根拠を記載

**対象**: 設計方針書 Section 8

**推奨**: 「restartClaudeSession() は stop + start の組み合わせであり、stop 失敗時にも start 内の ensureHealthySession() が回復を保証する。killSession() の冪等性により二重 kill は安全」と記載。

#### SF-S3-002: 既存テストへの影響を実装タスクに追加

**対象**: 設計方針書 Section 9、Section 10

**推奨**: 実装タスクに以下を追加:
- 「既存の startClaudeSession() テストで sendKeys モック呼び出し回数の検証を修正（sanitizeSessionEnvironment 内の sendKeys 追加分）」
- 「trust-dialog-auto-response.test.ts の exec モックが tmux set-environment コマンドに対応することを確認」

#### SF-S3-003: clearCachedClaudePath() の外部使用防止策

**対象**: 設計方針書 Section 3（Bug 1）

**推奨**: `@internal` タグに加えて、将来的な ESLint ルール追加の検討事項として記載。

#### SF-S3-004: SF-004 検証結果によるタイムアウトマージンの最適化

**対象**: 設計方針書 Section 7（パフォーマンス設計）

**推奨**: 「SF-004 の検証で対策 3-2 が不要と判断された場合、sanitizeSessionEnvironment() の遅延が ~250ms から ~50ms に削減される」旨を明記。

#### SF-S3-005: cli-patterns.ts への定数追加の影響確認

**対象**: 設計方針書 Section 3（MF-001）

**推奨**: cli-patterns.ts を import する 9 モジュールに影響がないことを確認済みである旨を設計書に明記。tree-shaking により未使用の新定数がバンドルに含まれないことを確認。

### 6.3 検討事項 (Consider) - 3件

#### C-S3-001: Codex/Gemini の同種バグの潜在リスク

CodexTool.startSession() (codex.ts L61-112) にも hasSession() -> true -> early return のパスがあり、壊れたセッションの検出なし。Bug 2 が Codex/Gemini でも発生する可能性があるが、C-001（Stage 1）の判断通り現時点では対応不要。Issue #265 完了後に Codex/Gemini での同種問題の有無をモニタリングすることを推奨。

#### C-S3-002: getClaudeSessionState() のヘルスチェック未対応

`getClaudeSessionState()` (L235-246) は `hasSession()` の結果を `isRunning` フィールドに設定するが、ヘルスチェックは実施しない。この関数が実際に外部から使用されているかの確認が必要。未使用であれば deprecation を検討。

#### C-S3-003: build-and-start.sh の CLAUDECODE 伝搬パス

build-and-start.sh は daemon.ts を経由せず直接 `npm start` を実行するため、env オブジェクトからの CLAUDECODE 除去（SF-003）が適用されない。ただし sanitizeSessionEnvironment() の対策 3-1 がカバーするため実質的な影響なし。設計書の代替案比較にこのパスの存在を根拠として追加すると判断の妥当性が強化される。

---

## 7. 実装チェックリスト追加項目（Stage 3）

### Must Fix

- [ ] **MF-S3-001**: `isClaudeRunning()` に `isSessionHealthy()` チェックを追加し、壊れたセッションでは false を返すように変更
- [ ] **MF-S3-001**: 全 API ルート（特に send/route.ts L95-100）で壊れたセッションが正しく「未実行」と認識されることを確認
- [ ] **MF-S3-001**: `isClaudeRunning()` のテストケースにヘルスチェック失敗ケースを追加
- [ ] **MF-S3-002**: `sanitizeSessionEnvironment()` のコードコメントに `-g` フラグのグローバルスコープと許容根拠を記載

### Should Fix

- [ ] **SF-S3-001**: 設計方針書 Section 8 に `restartClaudeSession()` との相互作用を記載
- [ ] **SF-S3-002**: 既存テスト（claude-session.test.ts、trust-dialog-auto-response.test.ts）の sendKeys/exec モック呼び出し回数変化への対応を実装タスクに追加
- [ ] **SF-S3-003**: `clearCachedClaudePath()` の `@internal` JSDoc に将来の ESLint ルール追加の検討メモを記載
- [ ] **SF-S3-004**: 設計方針書 Section 7 に SF-004 検証結果によるタイムアウトマージン最適化の見通しを記載
- [ ] **SF-S3-005**: cli-patterns.ts の 9 インポート元への影響なしを設計書で確認・記載

### Consider

- [ ] **C-S3-001**: Issue #265 完了後に Codex/Gemini の同種バグをモニタリング
- [ ] **C-S3-002**: `getClaudeSessionState()` の使用状況を確認し、必要に応じてヘルスチェック追加を検討
- [ ] **C-S3-003**: 設計方針書 Section 8 の代替案比較に build-and-start.sh パスの存在を追記

---

## 8. 承認判定

**ステータス**: 条件付き承認 (Conditionally Approved)

**条件**:
1. MF-S3-001（isClaudeRunning() へのヘルスチェック追加）を設計方針書に反映し、実装タスクに追加すること
2. MF-S3-002（tmux set-environment -g のグローバルスコープ根拠）を設計方針書に明記すること

**理由**:
- 設計方針書の Bug 修正アプローチは妥当であり、直接変更ファイルへの影響は適切に管理されている
- 間接影響の最大のリスク（isClaudeRunning() と API ルートの不整合）は、isClaudeRunning() への軽微な修正で解消可能
- パフォーマンスへの影響は許容範囲内（通常パス +50-300ms）
- 後方互換性は完全に維持される
- テストカバレッジは概ね十分だが、API 統合テストと既存テスト修正の計画が不足

---

## 9. レビュー履歴

| 日付 | ステージ | フォーカス | 結果 | スコア |
|------|---------|-----------|------|--------|
| 2026-02-14 | Stage 1 | 設計原則（SOLID/KISS/YAGNI/DRY） | 条件付き承認 | 4/5 |
| 2026-02-14 | Stage 2 | 整合性（既存実装との整合性検証） | 条件付き承認 | 4/5 |
| 2026-02-14 | Stage 3 | 影響範囲（波及効果・後方互換性・テスト） | 条件付き承認 | 4/5 |
