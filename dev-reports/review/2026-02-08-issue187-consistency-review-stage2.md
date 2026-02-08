# Issue #187 整合性レビュー (Stage 2)

**レビュー日**: 2026-02-08
**対象Issue**: #187 - セッション初回メッセージ送信信頼性改善
**レビュー種別**: 整合性レビュー (設計書 vs 実装コード)
**ステータス**: conditionally_approved
**スコア**: 4/5

---

## 1. レビュー概要

設計方針書 (`dev-reports/design/issue-187-session-first-message-reliability-design-policy.md`) に記載されたコードスニペット、行番号参照、関数シグネチャ、定数名・値、インポートパス、テスト期待値を、実際のソースコードと比較し整合性を検証した。

### レビュー対象ファイル

| ファイル | 絶対パス |
|---------|---------|
| 設計方針書 | `/Users/maenokota/share/work/github_kewton/commandmate-issue-187/dev-reports/design/issue-187-session-first-message-reliability-design-policy.md` |
| claude-session.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-187/src/lib/claude-session.ts` |
| cli-patterns.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-187/src/lib/cli-patterns.ts` |
| tmux.ts | `/Users/maenokota/share/work/github_kewton/commandmate-issue-187/src/lib/tmux.ts` |
| テストファイル | `/Users/maenokota/share/work/github_kewton/commandmate-issue-187/tests/unit/lib/claude-session.test.ts` |

---

## 2. 検証結果サマリー

| 検証項目 | 結果 |
|---------|------|
| 行番号の整合性 | 1件の不整合 (F-1: sendMessageToClaude 14行オフセット) |
| コードスニペットの整合性 | 2件の不整合 (F-2: コメント省略, F-8: エラーメッセージ接頭辞) |
| 関数シグネチャの整合性 | 一致 |
| インポートパスの整合性 | 一致 |
| 定数名・値の整合性 | 一致 |
| テスト期待値の整合性 | 2件の問題 (F-3: 既存テスト二重不整合, F-11: Path Bテスト) |

---

## 3. 指摘事項

### F-1: [must_fix] sendMessageToClaude 行番号オフセット

**カテゴリ**: line_number_mismatch

**設計書の記載** (Section 3.1):
> 変更前（L374-393）

**実際のコード**:
`sendMessageToClaude()` の関数シグネチャは `src/lib/claude-session.ts` の **L360** に位置する。設計書の「変更前」スニペットは `export async function sendMessageToClaude(` から始まっているが、これはL360であり、L374ではない。L374は関数本体中のコメント行 `// Verify prompt state before sending` に対応する。14行のオフセットがある。

```typescript
// L360 (実際の位置)
export async function sendMessageToClaude(
  worktreeId: string,
  message: string
): Promise<void> {
```

**提案**: 設計書の行番号を `L360-394` に修正するか、関数名による参照に切り替える。

---

### F-2: [should_fix] 変更前スニペットのコメント省略

**カテゴリ**: code_snippet_mismatch

**設計書の記載** (Section 3.1):
「変更前」コードスニペットにはインラインコメントが含まれていない。

**実際のコード** (`src/lib/claude-session.ts` L374-393):
実際のコードには以下のコメントが存在する:
- L374: `// Verify prompt state before sending (CONS-006, DRY-001)`
- L375: `// Use -50 lines to ensure we capture the prompt even with status bars`
- L377: `// Strip ANSI escape sequences before pattern matching (Issue #152)`
- L379-380: `// Wait for prompt if not at prompt state` / `// Use longer timeout (10s) to handle slow responses`
- L384: `// Log warning but don't block - Claude might be in a special state`

**提案**: 「変更前」スニペットにコメントを含めるか、「コメントは簡略化のため省略」と注記を追加する。

---

### F-3: [must_fix] 既存テスト L337-346 の二重不整合

**カテゴリ**: code_snippet_mismatch

**設計書の記載** (Section 4.1 修正3):
L337-346のテストを `CLAUDE_SEND_PROMPT_WAIT_TIMEOUT` を使用するよう修正する提案。

**実際のコードの問題**:
このテストには設計書が明示していない**二重の不整合**が存在する:

1. **タイムアウト値の不整合**: テストは `CLAUDE_PROMPT_WAIT_TIMEOUT + 100` (5100ms) でタイマーを進めるが、実装は `waitForPrompt(sessionName, 10000)` を呼び出す。つまりテストの5100msでは10000msのタイムアウトに達しない。

2. **エラー伝播の不整合**: 現在の実装ではtry-catchでwaitForPromptのエラーを握りつぶし、警告ログのみ出力して送信を継続する (`src/lib/claude-session.ts` L381-386)。このためsendMessageToClaudeはタイムアウト時もrejectしない。テストの `rejects.toThrow()` 期待値は現在のコードでは成立しない可能性がある。

```typescript
// 現在の実装 (L381-386) - エラーを握りつぶしている
try {
  await waitForPrompt(sessionName, 10000);
} catch {
  console.warn(`[sendMessageToClaude] Prompt not detected, sending anyway`);
}
```

**提案**: P1-2(try-catch削除)とP1-3(定数化)が同時に適用されることで両方の不整合が解消される点を、設計書の修正3セクションに明記する。実装者がこの二重の依存関係を理解できるようにする。

---

### F-8: [should_fix] 修正2のエラーメッセージ接頭辞不一致

**カテゴリ**: code_snippet_mismatch

**設計書の記載** (Section 4.1 修正2):
```typescript
await expect(promise).rejects.toThrow(`Claude initialization timeout (${CLAUDE_INIT_TIMEOUT}ms)`);
```

**実際のコード** (`src/lib/claude-session.ts` L338-344):
```typescript
// L338-339
if (!initialized) {
  throw new Error(`Claude initialization timeout (${CLAUDE_INIT_TIMEOUT}ms)`);
}
// ...
// L343-344 (外側のcatch)
} catch (error: unknown) {
  throw new Error(`Failed to start Claude session: ${getErrorMessage(error)}`);
}
```

L339で投げられたエラーはL344のcatchブロックで捕捉され、`Failed to start Claude session: Claude initialization timeout (15000ms)` という接頭辞付きメッセージに変換される。設計書の提案テストでは元のメッセージ `Claude initialization timeout (15000ms)` を完全一致で期待しているが、実際にはこの接頭辞が付く。

**提案**: テスト断言を部分一致に変更する:
```typescript
await expect(promise).rejects.toThrow('Claude initialization timeout');
```

---

### F-6: [should_fix] SpecialKey型の行番号未記載

**カテゴリ**: other

**設計書の記載** (Section 3.5):
> `sendSpecialKey`関数は既に存在し

**実際のコード**: `SpecialKey`型は `src/lib/tmux.ts` の **L362** に定義されている:
```typescript
export type SpecialKey = 'Escape' | 'C-c' | 'C-d';
```

**提案**: Section 3.5に `src/lib/tmux.ts L362` を行番号参照として追加する。

---

### F-11: [should_fix] P0テスト Path B のモック動作

**カテゴリ**: other

**設計書の記載** (Section 4.2 P0テスト Path B):
```typescript
vi.mocked(capturePane).mockImplementation(async () => {
  callCount++;
  if (callCount === 1) return 'Processing...';
  return '> ';
});
```

**実際のコードとの整合性問題**:
`sendMessageToClaude()` はL376で最初の `capturePane` を呼び出す。この呼び出しで `callCount` が1になり `'Processing...'` が返る。その後 `waitForPrompt()` に入り、waitForPrompt内の最初の `capturePane` 呼び出しで `callCount` が2になり `'> '` が返る。つまり `waitForPrompt` は最初のポーリングで即座にプロンプトを検出して返る。

テスト内のコメント `// Advance through waitForPrompt polling` は、実際にはポーリングのタイマー進行が不要であることと矛盾する。テストの動作自体は正しい（安定化待機のアサーションは有効）が、コメントが誤解を招く。

**提案**: モックを3回以上の呼び出しを必要とするよう変更（例: 最初の2回は非プロンプト、3回目でプロンプト返却）し、waitForPromptのポーリングを実際に行使するテストにする。

---

## 4. 正確に一致した項目

以下の項目は設計書と実際のコードが正確に一致していることを確認した:

| 検証項目 | 設計書参照 | 実コード位置 |
|---------|-----------|-------------|
| startClaudeSession セパレータチェック | Section 3.2 L325 | `src/lib/claude-session.ts:325` |
| ANSI_PATTERN 定義 | Section 3.6 L167 | `src/lib/cli-patterns.ts:167` |
| CLAUDE_PROMPT_PATTERN 定義 | Section 3.1 | `src/lib/cli-patterns.ts:47` |
| CLAUDE_SEPARATOR_PATTERN インポート | Section 3.2 F-7 | `src/lib/claude-session.ts:15` |
| SpecialKey 型定義 | Section 3.5 | `src/lib/tmux.ts:362` |
| waitForPrompt capturePane 引数テスト | Section 4.1 修正1 L108 | `tests/unit/lib/claude-session.test.ts:108` |
| セパレータ検出テスト | Section 4.1 修正2 L232-246 | `tests/unit/lib/claude-session.test.ts:232-246` |
| CLAUDE_POST_PROMPT_DELAY 値 | Section 3.1 | `src/lib/claude-session.ts:74` (500ms) |
| CLAUDE_PROMPT_WAIT_TIMEOUT 値 | Section 3.4 | `src/lib/claude-session.ts:83` (5000ms) |
| CLAUDE_PROMPT_POLL_INTERVAL 値 | Section 4.2 | `src/lib/claude-session.ts:91` (200ms) |
| CLAUDE_INIT_TIMEOUT 値 | Section 3.2 | `src/lib/claude-session.ts:50` (15000ms) |
| sendKeys 呼び出しパターン | Section 3.1 | `src/lib/claude-session.ts:390-391` |
| sendMessageToClaude エラーメッセージ | Section 3.1 | `src/lib/claude-session.ts:369-371` |

---

## 5. 変更後コードの構文検証

設計書に記載された「変更後」コードの構文的妥当性を検証した:

| セクション | 検証結果 | 備考 |
|-----------|---------|------|
| Section 3.1 (P0 sendMessageToClaude変更後) | 有効 | TypeScript構文として正しい。新定数CLAUDE_SEND_PROMPT_WAIT_TIMEOUTの定義が前提 |
| Section 3.2 (P1-1 セパレータ除外) | 有効 | 単純な条件削除 |
| Section 3.4 (P1-3 定数追加) | 有効 | エクスポート付きconst宣言 |
| Section 3.5 (P2-1 sendSpecialKey) | 有効 | 既存関数呼び出し。SpecialKey型拡張が前提 |
| Section 3.6 (P2-2 ANSI_PATTERN拡張) | 有効 | 正規表現として正しい。範囲指定が適切 |

---

## 6. リスク評価

| リスク種別 | レベル | 根拠 |
|-----------|-------|------|
| 技術的リスク | Low | P0/P1の変更は保守的で、既存動作を大きく変えない |
| 整合性リスク | Medium | F-3 (テストの二重不整合) と F-8 (エラーメッセージ接頭辞) は実装時にテスト失敗を引き起こす可能性がある |
| 実装順序リスク | Low | Section 8の実装順序は適切だが、F-3の依存関係の明記が必要 |

---

## 7. 結論

設計方針書は全体として実際のコードベースとの整合性が高い。行番号参照、コードスニペット、定数値、関数シグネチャの大部分が正確に一致している。

ただし、以下の3点は実装前に修正が必要:

1. **F-1 (must_fix)**: `sendMessageToClaude` の行番号参照を L360 に修正
2. **F-3 (must_fix)**: 既存テスト L337-346 のtry-catch握りつぶしとタイムアウト値の二重不整合について、P1-2/P1-3の同時適用で解消される旨を明記
3. **F-8 (should_fix)**: 修正2のテスト断言を部分一致に変更（`Failed to start Claude session:` 接頭辞対応）

これらの修正を反映すれば、設計書に従った実装は安全に進行可能である。

---

*Generated by architecture-review-agent for Issue #187 Stage 2 (2026-02-08)*
