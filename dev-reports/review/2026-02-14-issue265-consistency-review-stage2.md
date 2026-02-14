# Architecture Review Report: Issue #265 - Stage 2 整合性レビュー

| 項目 | 内容 |
|------|------|
| **Issue** | #265 - Claude CLIパスキャッシュの無効化と壊れたtmuxセッションの自動回復 |
| **Stage** | 2 - 整合性レビュー |
| **Focus** | 設計方針書と既存実装の整合性 |
| **Status** | 条件付き承認 (Conditionally Approved) |
| **Score** | 4/5 |
| **Date** | 2026-02-14 |

---

## 1. Executive Summary

Issue #265 の設計方針書について、既存実装との整合性観点でレビューを実施した。設計方針書は Stage 1（設計原則レビュー）の指摘事項を適切に反映しており、全体的な設計品質は高い。ただし、既存コードとの具体的な統合ポイントにおいて、いくつかの整合性課題が検出された。

主要な課題は以下の2点:
1. `getCleanPaneOutput()` ヘルパーの適用範囲が不明確で、既存の4箇所の `capturePane + stripAnsi` パターンのうちどこまで統一するかが設計書に明記されていない
2. `startClaudeSession()` の catch ブロック全体でキャッシュクリアを行う設計が、エラー粒度と合っていない

これらは実装前に設計書を補完することで解決可能であり、設計の根本的な方向性に問題はない。

---

## 2. レビュー対象ファイル

| ファイル | 役割 | レビュー観点 |
|---------|------|-------------|
| `src/lib/claude-session.ts` | メイン修正対象 | Bug 1/2/3 の設計と既存コードの整合性 |
| `src/lib/cli-patterns.ts` | パターン定数 | 新定数の追加スタイルと既存定数の一貫性 |
| `src/cli/utils/daemon.ts` | CLAUDECODE除去 | env オブジェクト構築パターンとの整合性 |
| `src/lib/tmux.ts` | tmux操作 | capturePane/sendKeys API の正しい使用 |
| `src/lib/cli-tools/types.ts` | ICLITool定義 | インターフェースへの影響確認 |
| `src/lib/cli-tools/claude.ts` | ClaudeTool実装 | startClaudeSession 変更の間接影響 |
| `src/lib/session-cleanup.ts` | セッション管理 | killSession フローとの整合性 |
| `src/lib/version-checker.ts` | @internal使用例 | JSDocパターンの先例確認 |
| `tests/unit/lib/claude-session.test.ts` | 既存テスト | テスト構造との統合方針 |
| `tests/unit/lib/cli-patterns.test.ts` | パターンテスト | テスト追加パターン |

---

## 3. 整合性マトリクス

### 3.1 設計項目と既存実装の対応

| 設計項目 | 設計書の記載 | 既存実装の状態 | 整合性 | 差異詳細 |
|---------|------------|--------------|--------|---------|
| Bug 1: cachedClaudePath クリア | catch ブロック内で clearCachedClaudePath() 呼び出し | catch ブロックは try 全体をラップ（L378） | 要確認 | catch の粒度が粗い（MF-S2-002） |
| Bug 2: isSessionHealthy() 追加 | capturePane + stripAnsi でヘルスチェック | 同パターンが4箇所に分散（L271,343,349,410-411） | 要確認 | getCleanPaneOutput() 適用範囲が不明確（MF-S2-001） |
| Bug 2: ensureHealthySession() | hasSession true の場合にヘルスチェック | 既存は hasSession true なら即 return（L312-315） | 要確認 | フォールスルー or 再呼び出しが不明（SF-S2-004） |
| Bug 3: sanitizeSessionEnvironment() | tmux env 除去 + unset 送信 | createSession 後のフローに新規挿入 | 要確認 | 呼び出し位置未確定（SF-S2-003） |
| Bug 3: daemon.ts env 修正 | env オブジェクトから CLAUDECODE を delete | 既存の env 構築パターン L59-67 と一致 | 整合 | 問題なし |
| MF-001: エラーパターン定数 | readonly string[] + as const | cli-patterns.ts に readonly 型なし定数が混在 | 軽微差異 | SF-S2-001 |
| MF-002: SHELL_PROMPT_ENDINGS | cli-patterns.ts or claude-session.ts | 配置先未確定 | 要決定 | SF-S2-002 |
| SF-001: getCleanPaneOutput() | DRY統合ヘルパー | 4箇所の capturePane+stripAnsi パターン | 要確認 | 適用範囲不明確（MF-S2-001） |
| SF-002: 関数分離 | ensureHealthySession / sanitizeSessionEnvironment | startClaudeSession は現在84行 | 整合 | 分離方針は適切 |
| SF-003: daemon.ts DIP | env オブジェクト経由の除去 | DaemonManager.start() L59-67 で env 構築済み | 整合 | 既存パターンと一致 |
| C-002: @internal JSDoc | clearCachedClaudePath() に付与 | version-checker.ts に先例あり | 整合 | 先例と一貫（SF-S2-005） |

### 3.2 テストパターン整合性

| テスト項目 | 設計書のテスト方針 | 既存テストのパターン | 整合性 |
|-----------|------------------|-------------------|--------|
| モック構造 | claude-session.test.ts に追加 | vi.mock('@/lib/tmux') で tmux をモック | 整合 |
| 定数テスト | パターンの各値で false を検証 | 既存: 定数値の expect().toBe() | 整合 |
| 非同期テスト | vi.useFakeTimers 使用 | 既存: vi.useFakeTimers + advanceTimersByTimeAsync | 整合 |
| テスト構造 | describe/it ブロック | 既存: Issue単位の describe ブロック | 要明確化（C-S2-003） |

---

## 4. 詳細指摘事項

### 4.1 Must Fix (2件)

#### MF-S2-001: getCleanPaneOutput() の適用範囲が不明確

**設計書の記載**: `getCleanPaneOutput()` で `capturePane + stripAnsi` パターンを共通化する (SF-001)

**既存実装の状態**: `claude-session.ts` 内に `capturePane + stripAnsi` パターンが以下の4箇所に存在:

```typescript
// 箇所1: waitForPrompt() L271-274
const output = await capturePane(sessionName, { startLine: -50 });
if (CLAUDE_PROMPT_PATTERN.test(stripAnsi(output))) {

// 箇所2: startClaudeSession() 初期化ポーリング L343-349
const output = await capturePane(sessionName, { startLine: -50 });
const cleanOutput = stripAnsi(output);

// 箇所3: sendMessageToClaude() L410-411
const output = await capturePane(sessionName, { startLine: -50 });
if (!CLAUDE_PROMPT_PATTERN.test(stripAnsi(output))) {

// 箇所4: isSessionHealthy() (新規追加予定)
// 設計書ではここに getCleanPaneOutput() を使用
```

**差異**: 設計書では `isSessionHealthy()` と `startClaudeSession()` の初期化ポーリングでの使用のみ言及しているが、`waitForPrompt()` と `sendMessageToClaude()` にも同じパターンがある。DRY原則（SF-001）を徹底するなら4箇所全てを統一すべき。

**推奨対応**: 設計方針書の SF-001 セクションに、`getCleanPaneOutput()` の適用対象4箇所を全て列挙し、各箇所の置換方針を明記する。

---

#### MF-S2-002: catch ブロックでのキャッシュクリア位置の粒度

**設計書の記載**: `startClaudeSession()` の catch ブロック内で `clearCachedClaudePath()` を呼び出す

**既存実装の状態**:

```typescript
// src/lib/claude-session.ts L317-380
try {
  await createSession({ ... });         // 失敗パターン A
  const claudePath = await getClaudePath(); // 失敗パターン B (キャッシュクリア対象)
  await sendKeys(sessionName, claudePath, true); // 失敗パターン C
  // ... ポーリングループ ...
  if (!initialized) {
    throw new Error('Claude initialization timeout'); // 失敗パターン D
  }
} catch (error: unknown) {
  // ここで clearCachedClaudePath() を呼ぶと A/C/D でも実行される
  throw new Error(`Failed to start Claude session: ${getErrorMessage(error)}`);
}
```

**差異**: キャッシュクリアは `getClaudePath()` が無効なパスを返した場合（パターンB）にのみ必要だが、catch ブロックに一律配置すると `createSession` 失敗（tmux問題）や初期化タイムアウト（ネットワーク遅延）でもキャッシュがクリアされる。キャッシュクリアのコスト自体は低い（次回再キャッシュされるだけ）が、設計の意図と動作が乖離する。

**推奨対応**: 以下のいずれかの方針を設計書に明記する:
- **案A**: catch ブロック全体でキャッシュクリアする（コスト低のため許容。ただしその判断根拠を設計書に記載）
- **案B**: `getClaudePath()` を個別の try-catch で囲み、パス解決失敗時のみキャッシュクリア

---

### 4.2 Should Fix (5件)

#### SF-S2-001: 新定数の型宣言スタイル不一致

**設計書の記載**:
```typescript
export const CLAUDE_SESSION_ERROR_PATTERNS: readonly string[] = [
  'Claude Code cannot be launched inside another Claude Code session',
] as const;
```

**既存実装のスタイル**:
```typescript
// cli-patterns.ts - 型注釈なし
export const CLAUDE_SPINNER_CHARS = ['...'];

// response-poller.ts - readonly string[] あり
const GEMINI_LOADING_INDICATORS: readonly string[] = ['...'];
```

**推奨**: `readonly string[]` + `as const` のスタイルは型安全性が高く、`response-poller.ts` にも先例がある。このスタイルを採用してよいが、`cli-patterns.ts` 内の他定数（`CLAUDE_SPINNER_CHARS` 等）は `as const` を使っていない点を認識した上で追加すること。

---

#### SF-S2-002: SHELL_PROMPT_ENDINGS の配置先未確定

**設計書の記載**: `cli-patterns.ts（または claude-session.ts 内定数）`

**推奨**: `isSessionHealthy()` は `claude-session.ts` の内部関数であり、`SHELL_PROMPT_ENDINGS` もその内部でのみ使用される。最小公開原則に従い、`claude-session.ts` 内のモジュールレベル定数として定義するのが適切。ただし、将来的に `codex.ts` 等の他 CLI ツールでも同様のヘルスチェックが必要になった場合は `cli-patterns.ts` へ移動する。

---

#### SF-S2-003: sanitizeSessionEnvironment() の呼び出しタイミング

**設計書の記載**: タスク9で `startClaudeSession()` から各ヘルパーを呼び出す

**既存フロー**:
```
createSession → getClaudePath → sendKeys(claudePath) → ポーリング
```

**推奨フロー**:
```
createSession → sanitizeSessionEnvironment → getClaudePath → sendKeys(claudePath) → ポーリング
```

`sanitizeSessionEnvironment()` は tmux セッション内のシェルに `unset CLAUDECODE` を送信するため、`createSession()` の後（セッションが存在する状態）かつ `sendKeys(claudePath)` の前（Claude CLI 起動前）に実行する必要がある。設計書のタスク9にこの順序を明記すべき。

---

#### SF-S2-004: ensureHealthySession() と既存 early return の統合

**設計書の記載**: `hasSession() == true` の場合に `ensureHealthySession()` で検証し、異常なら kill して再作成

**既存実装** (L310-315):
```typescript
const exists = await hasSession(sessionName);
if (exists) {
  console.log(`Claude session ${sessionName} already exists`);
  return;  // 即座に終了
}
```

**推奨統合パターン**:
```typescript
const exists = await hasSession(sessionName);
if (exists) {
  const healthy = await ensureHealthySession(sessionName);
  if (healthy) {
    console.log(`Claude session ${sessionName} already exists`);
    return;  // 健全なセッションが存在するため終了
  }
  // 異常セッションは killSession 済み -> フォールスルーして再作成
  console.log(`Claude session ${sessionName} was unhealthy, recreating...`);
}
```

この統合パターンを設計書に明記することで、実装時の曖昧さを排除できる。

---

#### SF-S2-005: @internal JSDoc の既存パターンとの一貫性

**設計書の記載**: `clearCachedClaudePath()` に `@internal` JSDoc タグ

**既存実装** (`version-checker.ts` L228-236):
```typescript
/**
 * Reset cache for testing purposes only.
 * @internal
 */
export function resetCacheForTesting(): void {
```

**推奨**: `version-checker.ts` では関数名に `ForTesting` サフィックスを付与して用途を明示している。`clearCachedClaudePath()` は名前自体がテスト専用を示唆していないため、`@internal` タグの JSDoc コメント内で「Exported for testing purposes」と明記する（設計書の記載通り）ことで十分。

---

### 4.3 Consider (3件)

#### C-S2-001: 空出力判定の安全性

`isSessionHealthy()` で `trimmed === ''` の場合に false を返す設計は妥当。tmux セッションが存在するにもかかわらず出力が空ということは、Claude CLI が起動に失敗したか、シェルが応答していない状態を示す。コード内コメントでこの判定の根拠を明記することを推奨。

#### C-S2-002: SHELL_PROMPT_ENDINGS の誤検出リスク

Claude CLI の正常出力がシェルプロンプト文字（`$`, `%`, `#`）で終わる可能性は極めて低い。`capturePane` で取得する最後の50行の `trim()` 後の末尾文字で判定するため、Claude のマークダウン出力内にシェルプロンプト文字が含まれていても、それが最終行の末尾でない限り誤判定は発生しない。現設計で問題ない。

#### C-S2-003: テスト構造化方針

既存の `claude-session.test.ts` は Issue 番号単位のトップレベル `describe` ブロックで構成されている。Issue #265 のテストも同パターンで `describe('claude-session - Issue #265 fixes', () => { ... })` として追加するのが自然。

---

## 5. リスク評価

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| 技術的リスク | catch ブロックでのキャッシュクリアが過剰に発動 | Low | Medium | P2 |
| 技術的リスク | ensureHealthySession と既存フローの統合不備 | Medium | Medium | P1 |
| 技術的リスク | sanitizeSessionEnvironment の呼び出し順序ミス | Medium | Low | P2 |
| セキュリティリスク | CLAUDECODE 環境変数の残存 | Low | Low | P3 |
| 運用リスク | ヘルスチェックによる正常セッションの誤 kill | Low | Low | P3 |

---

## 6. daemon.ts 整合性確認

daemon.ts の `DaemonManager.start()` メソッド（L35-110）は以下の env 構築パターンを使用:

```typescript
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(envResult.parsed || {}),
};
// Command line options override .env values
if (options.port) {
  env.CM_PORT = String(options.port);
}
if (options.dbPath) {
  env.CM_DB_PATH = options.dbPath;
}
```

設計方針書の SF-003 で提案された `delete env.CLAUDECODE` は、この env オブジェクト構築の直後、`spawn()` 呼び出し（L86）の前に配置するのが自然。`process.env` を直接変更せず、spawn に渡す env オブジェクトのみを操作するため、既存パターンと完全に整合する。

---

## 7. テストモック整合性確認

既存テストのモック構造:
- `vi.mock('@/lib/tmux')` で tmux モジュール全体をモック
- `vi.mock('@/lib/pasted-text-helper')` で pasted-text-helper をモック
- `vi.mock('child_process')` で exec をモック（which claude のパス解決）

Issue #265 で追加される新機能のテストに必要な追加モック:
- `execAsync('tmux set-environment -g -u CLAUDECODE ...')` - 既存の child_process モックでカバー可能
- `killSession` - 既存の tmux モックにすでに含まれている

新たなモック追加は不要であり、既存のモック構造と完全に整合する。

---

## 8. 命名規則・コーディングスタイルの一貫性

| 項目 | 設計書の命名 | 既存の命名パターン | 一貫性 |
|------|------------|------------------|--------|
| 関数名 | `clearCachedClaudePath` | camelCase、動詞+名詞 | 整合 |
| 関数名 | `isSessionHealthy` | `is` プレフィックス boolean | 整合 |
| 関数名 | `ensureHealthySession` | `ensure` プレフィックス | `ensureSession` (tmux.ts) と整合 |
| 関数名 | `sanitizeSessionEnvironment` | 動詞+名詞 | 整合 |
| 関数名 | `getCleanPaneOutput` | `get` プレフィックス | 整合 |
| 定数名 | `CLAUDE_SESSION_ERROR_PATTERNS` | UPPER_SNAKE_CASE | 整合 |
| 定数名 | `SHELL_PROMPT_ENDINGS` | UPPER_SNAKE_CASE | 整合 |
| JSDoc | `@internal` タグ | version-checker.ts に先例 | 整合 |
| エラーメッセージ | 英語、説明的 | 既存パターンと一致 | 整合 |

---

## 9. 総合評価

### 強み
- Stage 1 の指摘事項（MF-001, MF-002, SF-001~SF-004）が全て適切に反映されている
- 既存の設計パターン（DRY, SRP, OCP）との整合性が高い
- daemon.ts の env 構築パターンとの整合性が完璧
- テストモック構造との互換性が確保されている
- 命名規則・コーディングスタイルが既存コードベースと一貫している

### 改善が必要な点
- `getCleanPaneOutput()` の適用範囲を4箇所全てに対して明確化すべき
- `startClaudeSession()` の catch ブロックでのキャッシュクリアの粒度を検討すべき
- `ensureHealthySession()` と既存 early return の具体的な統合フローを設計書に記載すべき
- `sanitizeSessionEnvironment()` の呼び出し位置を確定させるべき
- `SHELL_PROMPT_ENDINGS` の配置先を確定させるべき

### 承認条件
Must Fix 2件（MF-S2-001, MF-S2-002）への対応を設計書に反映した上で実装に進むことを条件として承認する。Should Fix 5件は実装時に対応可能。

---

## 10. 承認ステータス

**条件付き承認 (Conditionally Approved)** - Score: 4/5

Must Fix 2件の設計書補完を条件として実装可。設計の根本的な方向性は既存コードベースと整合しており、指摘事項は全て設計書の詳細化で解決可能。
