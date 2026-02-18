# Architecture Review: Issue #306 - Security Review (Stage 4)

| 項目 | 値 |
|------|-----|
| Issue | #306 |
| Stage | 4 - セキュリティレビュー |
| Focus | セキュリティ (OWASP Top 10準拠確認) |
| Score | 4/5 |
| Status | 条件付き承認 (conditionally_approved) |
| Date | 2026-02-18 |

---

## Executive Summary

Issue #306の設計方針書に対するセキュリティレビューを実施した。対象はtmuxセッション安定性改善に関する4つの対策（SHELL_PROMPT_ENDINGS偽陽性防止、重複応答防止、ヘルスチェック構造化ログ、クールダウン期間追加）である。

全体として、設計書のセキュリティ設計は高い品質であり、OWASP Top 10に該当する重大な脆弱性は検出されなかった。変更範囲がビジネスロジック層（`src/lib/`）に閉じており、外部入力の新規受け入れポイントが追加されないことが、セキュリティリスクを低く保つ主因である。

Must Fixの指摘事項はなく、3件のShould Fixと5件のNice to Haveを検出した。

---

## Review Scope

### OWASP Top 10 チェックリスト

| OWASP ID | カテゴリ | 評価 | 詳細 |
|----------|---------|------|------|
| A01:2021 | Broken Access Control | N/A | 本変更にアクセス制御の変更なし |
| A02:2021 | Cryptographic Failures | N/A | 本変更に暗号処理の変更なし |
| A03:2021 | Injection | 安全 | S4-F001, S4-F008参照。sendKeysへの入力はresolveAutoAnswer()経由で英数字のみ |
| A04:2021 | Insecure Design | 安全 | S4-F004, S4-F005参照。多段防御・競合状態排除が適切 |
| A05:2021 | Security Misconfiguration | 安全 | S4-F003参照。定数値の妥当性確認済み |
| A06:2021 | Vulnerable Components | N/A | 本変更に外部ライブラリの追加なし |
| A07:2021 | Auth Failures | N/A | 本変更に認証処理の変更なし |
| A08:2021 | Software/Data Integrity | N/A | 本変更にデシリアライゼーション処理なし |
| A09:2021 | Logging/Monitoring | 安全 | S4-F002, S4-F006参照。ログにsensitive情報含まない設計 |
| A10:2021 | SSRF | N/A | 本変更に外部通信の追加なし |

### DoS防止チェック

| 観点 | 評価 | 詳細 |
|------|------|------|
| 重複応答防止 | 安全 | S4-F007参照。promptKeyベースの防止機構は実用上堅牢 |
| クールダウンバイパス | 安全 | S4-F003参照。COOLDOWN_INTERVAL_MSは定数。overrideIntervalの下限ガード推奨 |
| ポーリング間隔操作 | 安全 | ポーリング間隔は内部定数。外部からの操作経路なし |
| 並行ポーラー上限 | 既存安全 | MAX_CONCURRENT_POLLERS=50の制限は変更なし |

---

## Detailed Findings

### S4-F001 [Should Fix] generatePromptKey()の入力にサニタイズが未適用

**Category**: OWASP A03:2021 - Injection

**Description**:

`generatePromptKey()` は以下の形式でキーを生成する。

```typescript
// src/lib/prompt-key.ts（新規作成予定）
export function generatePromptKey(promptData: { type: string; question: string }): string {
  return `${promptData.type}:${promptData.question}`;
}
```

`promptData.question` はtmuxペイン出力からの正規表現マッチにより抽出される値であり、直接的なユーザー入力ではない。生成されたキーは `AutoYesPollerState.lastAnsweredPromptKey`（インメモリMap）に保存され、文字列比較（`===`）のみに使用される。

現在の設計ではSQLクエリ、HTMLレンダリング、シェルコマンド構築への使用はないため、即座のInjectionリスクはない。しかし、将来的にキーがログ出力やDB保存に使用される可能性に備え、用途制限を設計書に明記すべきである。

**Risk**: Low (現在の使用範囲では安全)

**Suggestion**: セクション4のセキュリティ設計テーブルに以下を追加する。

```
| promptKeyの用途制限 | generatePromptKey()の戻り値はインメモリの文字列比較にのみ使用する。ログ出力、DB保存、HTML表示に使用する場合はサニタイズを適用すること |
```

---

### S4-F002 [Should Fix] ensureHealthySession()のログ出力内容の安全性

**Category**: OWASP A09:2021 - Security Logging and Monitoring Failures

**Description**:

設計書セクション3.1で追加されるログ出力を分析した。

```typescript
console.warn(`[health-check] Session ${sessionName} unhealthy: ${result.reason}`);
```

各構成要素の安全性:
- `sessionName`: `mcbd-claude-${worktreeId}` 形式。`worktreeId` は `isValidWorktreeId()` で `/^[a-zA-Z0-9_-]+$/` によりバリデーション済み。安全。
- `result.reason`: 以下のパターンで生成される。
  - `'empty output'` - 固定文字列。安全。
  - `'capture error'` - 固定文字列。安全。
  - `'error pattern: ${pattern}'` - `CLAUDE_SESSION_ERROR_PATTERNS` の固定文字列。安全。
  - `'error pattern: ${regex.source}'` - `CLAUDE_SESSION_ERROR_REGEX_PATTERNS` の正規表現ソース。安全。
  - `'shell prompt ending detected: ${lastLine}'` - tmuxペイン出力の最終行。

`lastLine` はtmuxペイン出力由来であるが、以下の制約により安全性が確保されている:
1. `MAX_SHELL_PROMPT_LENGTH=40` により40文字未満に制限
2. `.trim()` により前後の空白・制御文字が除去
3. `SHELL_PROMPT_ENDINGS.some()` がマッチした行のみが対象

しかし、理論的にはtmuxペイン出力に改行文字（CR/LF）が含まれる可能性があり、ログインジェクション（ログ偽装）の表面的なリスクが存在する。`.trim()` が前後のCR/LFを除去するが、文字列中間のCR/LFは除去されない。40文字未満の制約により実質的なリスクは極めて低い。

**Risk**: Very Low

**Suggestion**: セクション4の情報漏洩行に補足を追記する。

---

### S4-F003 [Should Fix] scheduleNextPoll()のoverrideInterval下限値ガード

**Category**: DoS防止

**Description**:

設計書セクション3.4で `scheduleNextPoll()` に `overrideInterval` パラメータが追加される。

```typescript
function scheduleNextPoll(
  worktreeId: string,
  cliToolId: CLIToolType,
  overrideInterval?: number
): void {
  const pollerState = autoYesPollerStates.get(worktreeId);
  if (!pollerState) return;
  const interval = overrideInterval ?? pollerState.currentInterval;
  pollerState.timerId = setTimeout(() => {
    pollAutoYes(worktreeId, cliToolId);
  }, interval);
}
```

現在のコードパスでは `COOLDOWN_INTERVAL_MS = 5000` のみが `overrideInterval` として渡される。しかし、防御的プログラミングの観点から、`interval` に下限値ガードがないことは潜在的なDoSリスクである。

- `overrideInterval = 0` の場合: `setTimeout(..., 0)` となり、ほぼ即時実行
- `overrideInterval = -1` の場合: `setTimeout(..., -1)` となり、仕様上0として扱われ即時実行
- これらが連続するとビジーループとなる

既存の `calculateBackoffInterval()` は `POLLING_INTERVAL_MS` 以上の値を返すため、通常パスでは問題ないが、`overrideInterval` パスには同等のガードがない。

**Risk**: Low (現在は定数のみ使用、将来の拡張時にリスク)

**Suggestion**: `scheduleNextPoll()` 内で下限値ガードを追加する。

```typescript
const interval = Math.max(overrideInterval ?? pollerState.currentInterval, POLLING_INTERVAL_MS);
```

---

### S4-F004 [Nice to Have] lastAnsweredPromptKeyの競合状態耐性

**Category**: OWASP A04:2021 - Insecure Design

Node.jsのシングルスレッドモデルにより、同一worktreeIdに対する `pollAutoYes()` の並行実行は発生しない。`startAutoYesPolling()` の再呼び出し時は `stopAutoYesPolling()` で旧pollerが先に停止される。旧pollerのsetTimeoutが発火するタイミングの窓は、`pollAutoYes()` 冒頭の `pollerState` 存在チェックで安全にreturnされる。

Issue #306の変更（`lastAnsweredPromptKey` フィールド追加）は、この既存の安全性モデルに影響しない。

**Risk**: None

**Suggestion**: セクション4に「Node.jsシングルスレッドモデルにより並行ポーリングは発生しない」旨を文書化することを推奨。

---

### S4-F005 [Nice to Have] SHELL_PROMPT_ENDINGSの偽陽性を攻撃に利用するリスク

**Category**: OWASP A04:2021 - Insecure Design

攻撃者がClaude CLIの出力を制御してシェルプロンプト風の文字列を末尾に配置し、`isSessionHealthy()` を `false` に誘導してセッション再作成をトリガーするシナリオを評価した。

結論: 実質的な攻撃リスクはない。
1. セッション再作成は安全なリカバリアクション（データ損失・権限昇格なし）
2. Claude CLIの出力を制御するには、Claude APIへのアクセスが必要であり、その時点で他の攻撃ベクトルの方が有効
3. `MAX_SHELL_PROMPT_LENGTH=40` により、40文字以上の出力は偽陽性にならない
4. 多段防御（行長チェック + 個別パターン除外）が適切に設計されている

**Risk**: None

---

### S4-F006 [Nice to Have] エラーパターン検出のreason出力におけるregex.sourceの安全性

**Category**: OWASP A09:2021 - Security Logging and Monitoring Failures

`reason: 'error pattern: ${regex.source}'` で出力される `regex.source` は、`CLAUDE_SESSION_ERROR_REGEX_PATTERNS` に定義された正規表現のソース文字列（現在は `Error:.*Claude` のみ）。ソースコードにハードコードされた定数であり、機密情報は含まない。

**Risk**: None

**Suggestion**: パターン追加時にsensitive情報を含めないことを `CLAUDE_SESSION_ERROR_REGEX_PATTERNS` のJSDocに注記することを推奨。

---

### S4-F007 [Nice to Have] 重複応答防止メカニズムのバイパスリスク

**Category**: DoS防止

重複応答防止メカニズムのバイパスシナリオを分析した。

理論的には、ポーリング間隔内にプロンプト検出→応答送信→非プロンプト状態→同一プロンプト再表示が完了する場合、同一プロンプトへの2回目の応答が送信される可能性がある。しかし:
1. ポーリング間隔は最低2秒（応答後5秒のクールダウン）
2. Claude CLI処理時間は通常5秒以上
3. 2回目の応答が送信されても、Claude CLIは1回目の応答でプロンプト状態を抜けるため、2回目は無効

**Risk**: None (実用上の問題なし)

---

### S4-F008 [Nice to Have] tmux sendKeys経由の入力サニタイズ

**Category**: OWASP A03:2021 - Injection

Issue #306の変更範囲では、tmux `sendKeys()` への入力パスに変更はない。`pollAutoYes()` から呼び出される `sendPromptAnswer()` は、`resolveAutoAnswer()` が返す値（`'y'` またはオプション番号の文字列）を使用する。

`resolveAutoAnswer()` の戻り値:
- yes/no: `'y'` (固定文字列)
- multiple_choice: `target.number.toString()` (数値の文字列表現)

これらは英数字のみで構成されるため、コマンドインジェクションのリスクはない。

既存の `sendKeys()` (tmux.ts L207-225) のエスケープ処理:
```typescript
const escapedKeys = keys.replace(/'/g, "'\\''");
```
シングルクォートのエスケープのみだが、auto-yesの応答値にはシングルクォートが含まれないため安全。

**Risk**: None

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| Injection | promptKeyの用途拡大時のサニタイズ不足 | Low | Low | P3 |
| ログ安全性 | lastLineのログ出力にCR/LF含有の理論的リスク | Low | Very Low | P3 |
| DoS | overrideIntervalの下限値ガード不在 | Med | Low | P3 |
| 競合状態 | Node.jsシングルスレッドで排除済み | None | None | N/A |
| 偽陽性攻撃 | セッション再作成は安全なリカバリ | None | None | N/A |

---

## Security Design Quality Assessment

### 良い設計判断

1. **変更スコープの限定**: 全変更がビジネスロジック層（`src/lib/`）に閉じており、API境界や外部入力受け入れポイントの変更がない。これにより攻撃表面の拡大を防いでいる。

2. **既存のセキュリティ機構の活用**: `isValidWorktreeId()` によるworktreeIdバリデーション、`ALLOWED_SPECIAL_KEYS` によるtmuxキー入力のホワイトリスト制限、`isValidClaudePath()` によるCLAUDE_PATHバリデーションなど、既存のセキュリティ機構が適切に維持されている。

3. **多段防御パターン**: `isSessionHealthy()` の偽陽性防止において、行長チェック（第1段階）→個別パターン除外（第2段階）の2層構造を採用。F006対応により行長チェックが先行する設計に修正され、論理的整合性が確保されている。

4. **定数のexportとDoS防止**: `COOLDOWN_INTERVAL_MS` はexport constだが、外部入力から直接設定される経路がない。`MAX_CONCURRENT_POLLERS` による並行ポーラー上限も既存設計で維持されている。

5. **ログ出力のsensitive情報排除**: `ensureHealthySession()` のログ出力に含まれる情報は、sessionName（バリデーション済み）とreason（固定文字列または制限された長さの行）のみ。

### 改善推奨事項

1. セクション4のセキュリティ設計テーブルに、promptKeyの用途制限を明記
2. `scheduleNextPoll()` の `overrideInterval` に下限値ガードを追加
3. Node.jsシングルスレッドモデルによる競合状態排除の明文化

---

## Approval Status

**Status**: 条件付き承認 (Conditionally Approved)

**条件**: S4-F003（scheduleNextPollの下限値ガード）の設計反映を推奨するが、現在の使用パターンでは定数のみが渡されるため、実装フェーズでの対応でも可。

Must Fixの指摘事項はなく、セキュリティリスクは全体的に低い。設計書のセキュリティ設計セクション（セクション4）の評価は妥当であり、変更による新規セキュリティリスクは検出されなかった。

---

*Generated by architecture-review-agent (Stage 4: Security Review) on 2026-02-18*
