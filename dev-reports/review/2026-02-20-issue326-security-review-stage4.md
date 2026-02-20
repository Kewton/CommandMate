# Architecture Review Report: Issue #326 Security Review (Stage 4)

## Executive Summary

Issue #326の設計方針書「インタラクティブプロンプト検出時のレスポンス抽出修正」に対するセキュリティレビュー（Stage 4）を実施した。

**評価結果: conditionally_approved (4/5)**

本修正はデータフィルタリング範囲の変更（tmuxバッファ全体からlastCapturedLine以降への限定）とstripAnsi()適用の統一を主な内容とする。セキュリティリスクは全体的に低いが、箇所2のstripAnsi未適用（既存バグ）がDB保存データを通じてXSS関連の描画パスに影響する可能性があるため、設計書記載の修正の確実な実装を必須条件とする。

---

## Review Scope

| 項目 | 内容 |
|------|------|
| Issue | #326 |
| Stage | 4 - セキュリティレビュー |
| 設計書 | `dev-reports/design/issue-326-prompt-response-extraction-design-policy.md` |
| レビュー日 | 2026-02-20 |
| 対象コード | `src/lib/response-poller.ts`, `src/lib/prompt-detector.ts`, `src/lib/cli-patterns.ts`, `src/lib/assistant-response-saver.ts`, `src/lib/db.ts`, `src/components/worktree/MessageList.tsx` |

---

## OWASP Top 10 Checklist

| OWASP Category | Status | 評価 |
|----------------|--------|------|
| A01: Broken Access Control | N/A | 変更は内部関数のデータフィルタリングのみ。認証・認可には影響なし。 |
| A02: Cryptographic Failures | N/A | 暗号化処理には関与しない。 |
| A03: Injection | PASS | DB保存にprepared statement使用（`db.prepare` + `stmt.run`）。`stripAnsi()`追加によりANSIエスケープのDB混入を防止。SQLインジェクションリスクなし。 |
| A04: Insecure Design | PASS | `lastCapturedLine`以降への制限はデータ最小化原則に合致。前会話混入防止は情報漏洩リスク軽減にも寄与。 |
| A05: Security Misconfiguration | N/A | セキュリティ設定の変更なし。 |
| A06: Vulnerable Components | N/A | 新規依存パッケージの追加なし。 |
| A07: Identification and Authentication | N/A | 認証機能への影響なし。 |
| A08: Software and Data Integrity | PASS | `stripAnsi()`適用の統一によりDB保存データの一貫性が向上。`truncateRawContent()`制限は維持。 |
| A09: Security Logging and Monitoring | N/A | ログ出力への影響なし。 |
| A10: Server-Side Request Forgery | N/A | 外部リクエストには関与しない。 |

---

## Detailed Findings

### 1. stripAnsi()の適用によるANSIインジェクション/エスケープコード混入防止の十分性

**評価: 条件付き合格**

現状のコード分析結果:

- **箇所1（L326-341）**: `stripAnsi(fullOutput)`が適用されている -- 問題なし
- **箇所2（L487-499）**: `stripAnsi`が未適用 -- **既存バグ**

箇所2の`fullOutput`がそのままDB保存される場合の影響パスを追跡した。

```
extractResponse() -> result.response（ANSIコード含む可能性）
  -> checkForResponse() L605: detectPromptWithOptions(result.response)
     -> 内部でstripAnsi()適用されるため検出自体は安全
  -> promptDetection.isPrompt == true の場合:
     -> createMessage() -> DB保存（content列にANSIコード残留）
  -> promptDetection.isPrompt == false の場合:
     -> cleanClaudeResponse() -> 内部でstripAnsi()適用 -> 安全
```

DB保存されたANSIコード含有データの表示パス:

```typescript
// src/components/worktree/MessageList.tsx L209-213
{hasAnsiCodes(message.content) ? (
  <pre dangerouslySetInnerHTML={{ __html: convertAnsiToHtml(message.content) }} />
) : (
  <ReactMarkdown>{message.content}</ReactMarkdown>
)}
```

`hasAnsiCodes()`がtrueの場合、`dangerouslySetInnerHTML`パスを通る。`AnsiToHtml`コンストラクタで`escapeXML: true`が設定されているため、XSS攻撃は緩和されているが、意図しない描画パスの選択自体がリスクである。

**設計書の修正方針（箇所2にstripAnsi追加）はこのリスクを解消する。確実な実装が必須。**

#### stripAnsi()のSEC-002既知制限について

`cli-patterns.ts`のANSI_PATTERNには以下の既知の未対応パターンがある:

- 8-bit CSI (0x9B)
- DEC private modes (ESC[?25h等)
- Character set switching (ESC(0, ESC(B)
- 一部のRGB color forms

tmux `capture-pane`の出力にこれらが含まれる頻度は低いが、完全な除去は保証されない。これは本修正のスコープ外の既存リスクであり、設計書セクション5にて言及しておくことを推奨する。

---

### 2. tmuxバッファ内容のDB保存における情報漏洩リスク

**評価: 合格（修正により改善）**

現状の問題:
- `extractResponse()`が`fullOutput`（バッファ全体）を返すことで、前の会話の内容がassistantメッセージとしてDB保存される
- これはCWE-200（Exposure of Sensitive Information）に相当するが、ローカルツールであるため外部漏洩リスクは限定的

修正後の状況:
- `lastCapturedLine`以降に限定されるため、前会話の混入が防止される
- データ最小化原則（OWASP A04 Insecure Design）への適合が向上する

DB保存の安全性:
```typescript
// src/lib/db.ts L475-493
const stmt = db.prepare(`INSERT INTO chat_messages ... VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
stmt.run(id, message.worktreeId, message.role, message.content, ...);
```

prepared statementによるパラメータバインディングが使用されており、SQLインジェクションリスクはない。

---

### 3. lastCapturedLineの境界値操作による不正データ挿入の可能性

**評価: 合格（軽微な改善推奨あり）**

`lastCapturedLine`の値は以下の経路で決定される:

```typescript
// src/lib/response-poller.ts L563
const lastCapturedLine = sessionState?.lastCapturedLine || 0;
```

`sessionState`はDBから取得され（`session_states`テーブルの`last_captured_line`列、INTEGER型、DEFAULT 0）、ユーザーが直接操作できるAPIは存在しない。値の更新は`updateSessionState()`経由でのみ行われ、`result.lineCount`（整数値）が書き込まれる。

`resolveExtractionStartIndex()`への入力値の安全性:

| パラメータ | ソース | 制約 | 安全性 |
|-----------|--------|------|--------|
| lastCapturedLine | DB (INTEGER, DEFAULT 0) | >= 0（`\|\| 0`フォールバック） | 安全 |
| totalLines | `lines.length` | >= 0 | 安全 |
| bufferReset | 内部計算（boolean） | true/false | 安全 |
| cliToolId | API入力（CLIToolType型） | 'claude'/'codex'/'gemini' | TypeScript型制約で安全 |
| findRecentUserPromptIndex | クロージャ | 数値を返す | 安全 |

ただし、`@internal` exportされる関数として、将来の不正利用を防ぐため、関数入口での防御的バリデーション（`lastCapturedLine = Math.max(0, lastCapturedLine)`の一律適用）を推奨する。

---

### 4. @internal exportがセキュリティ上問題を引き起こさないか

**評価: 合格（問題なし）**

プロジェクト内の`@internal` export使用状況を調査した:

| ファイル | @internal export数 |
|---------|-------------------|
| `src/lib/auto-yes-manager.ts` | 4 |
| `src/lib/claude-session.ts` | 3 |
| `src/lib/version-checker.ts` | 1 |
| `src/lib/clone-manager.ts` | 1 |
| `src/lib/prompt-key.ts` | 1 |

`@internal` exportは確立されたパターンであり、以下の理由でセキュリティ上の追加リスクはない:

1. TypeScriptの`@internal` JSDocタグはランタイムのアクセス制御を提供しない（ドキュメント目的のみ）
2. `resolveExtractionStartIndex()`はstartIndex計算のみを行い、I/O操作・DB操作・外部通信を含まない
3. 関数の入力は全て内部ソースから供給され、外部ユーザー入力が直接流入するパスは存在しない
4. npmパッケージとして公開される場合もNode.jsモジュールとして同一プロセス内でのみアクセス可能であり、ネットワーク経由のアクセスはない

---

### 5. 入力バリデーション（totalLines, lastCapturedLineの範囲チェック）の要否

**評価: 推奨レベルの改善あり**

現状の暗黙的バリデーション:

```typescript
// lastCapturedLine: DB DEFAULT 0 + || 0 フォールバック -> 0以上保証
const lastCapturedLine = sessionState?.lastCapturedLine || 0;

// totalLines: lines.length -> 0以上保証
const totalLines = lines.length;

// Codex/通常分岐: Math.max(0, lastCapturedLine) -> 明示的な負値ガード
startIndex = Math.max(0, lastCapturedLine);
```

設計書のテストケース#7, #8で`lastCapturedLine=0`のケースはカバーされているが、以下の追加を推奨する:

- `lastCapturedLine=-1`（負値入力）のテストケース
- `totalLines=0`（空バッファ）のテストケース

これらは現実のシナリオでは発生しにくいが、`@internal` exportとして他のコードから呼ばれる可能性を考慮した防御的テスト。

---

### 6. 前の会話内容の混入防止がセキュリティ観点でも重要であることの評価

**評価: 重要性を確認**

修正本来の目的（前の会話内容の混入防止）は以下のセキュリティ観点からも重要である:

| セキュリティ観点 | 影響評価 |
|----------------|---------|
| 情報の最小化 (Data Minimization) | DB保存データがlastCapturedLine以降に限定され、不要なデータの蓄積を防止 |
| CWE-200 (Information Exposure) | 前セッションの会話内容がassistantメッセージとして露出するリスクを排除 |
| コンテキスト分離 | 異なる会話コンテキストの混入を防止し、ユーザーが想定するデータのみが表示される |

本アプリケーションはローカルツールであり、ネットワーク経由の外部漏洩リスクは限定的だが、マルチworktree環境ではユーザーが異なるプロジェクトのデータを扱うため、コンテキスト分離は品質面だけでなくセキュリティ面でも意義がある。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| ANSIコードDB保存 | 箇所2のstripAnsi未適用により、ANSIエスケープコードがDBに残留しdangerouslySetInnerHTMLパスを通る | Medium | Medium | P1 (設計書の修正を確実に実装) |
| stripAnsi SEC-002制限 | 一部のエスケープシーケンスがstripAnsiで除去されずDB保存される | Low | Low | P3 (既存リスクの継承、スコープ外) |
| lastCapturedLine境界値 | @internal export関数に想定外の値が渡される | Low | Low | P2 (防御的バリデーション追加推奨) |
| 前会話混入 | 修正前: バッファ全体が保存され前会話が混入 | Medium | High | P1 (修正により解消) |

---

## Improvement Recommendations

### Must Fix (必須改善項目)

#### MF-001: 箇所2のstripAnsi未適用によるANSIエスケープコードのDB保存とXSSリスク

設計書セクション3-4の箇所2修正において、`stripAnsi()`の追加は単なる一貫性確保ではなく、セキュリティ上も必須である。

現状のコードパス分析:
```
箇所2: fullOutput（ANSIコード含む）-> createMessage() -> DB保存
-> MessageList.tsx: hasAnsiCodes() == true -> dangerouslySetInnerHTML
```

`AnsiToHtml`の`escapeXML: true`によりXSS自体は緩和されているが、`stripAnsi()`未適用のデータがDB保存されること自体が意図しない状態である。

**対応**: 設計書記載通り、箇所2に`stripAnsi(extractedLines.join('\n'))`を確実に適用すること。実装後のテストで、箇所2経由のDB保存データにANSIエスケープコードが含まれないことを検証すること。

### Should Fix (推奨改善項目)

#### SF-001: lastCapturedLineの負値入力に対する防御的バリデーション

`resolveExtractionStartIndex()`の冒頭で以下の防御的バリデーションを追加することを推奨:

```typescript
export function resolveExtractionStartIndex(
  lastCapturedLine: number,
  totalLines: number,
  bufferReset: boolean,
  cliToolId: CLIToolType,
  findRecentUserPromptIndex: (windowSize: number) => number
): number {
  // Defensive: ensure non-negative inputs
  const safeLCL = Math.max(0, lastCapturedLine);
  const safeTL = Math.max(0, totalLines);
  // ... rest of logic using safeLCL, safeTL
}
```

テストケースへの追加:
- `lastCapturedLine=-1, totalLines=100` -> startIndex=0
- `lastCapturedLine=50, totalLines=0` -> startIndex=0

#### SF-002: totalLines=0エッジケースの動作文書化

設計書セクション6-2のテストケースに`totalLines=0`のケースを追加し、`lines.slice(0)`が空配列を返す期待動作を明記すること。

#### SF-003: セキュリティ設計セクションへのstripAnsi SEC-002既知制限の参照追加

設計書セクション5-1に以下を追記することを推奨:

> `stripAnsi()`にはSEC-002として既知の未対応エスケープシーケンス（8-bit CSI、DEC private modes等）がある。これらがtmuxバッファに含まれた場合、修正後もDB保存データに残留する可能性がある。これは本修正のスコープ外であり、`cli-patterns.ts`の既存リスクを継承するものである。

### Consider (検討事項)

#### C-001: @internal exportパターンのセキュリティ影響

現状で問題なし。プロジェクト内で確立されたパターンであり、対象関数はI/O操作を含まないため、セキュリティ上の追加リスクはない。

#### C-002: 前会話混入防止のセキュリティ的意義

修正方針は情報漏洩防止の観点でも適切であり、追加対応は不要。

#### C-003: rawContentのtruncateRawContent()制限によるデータ量制御

既存の制限（200行/5000文字）で十分。追加対応不要。

#### C-004: SQLインジェクション防御

`createMessage()`のprepared statement使用により安全。追加対応不要。

---

## Approval Status

| 項目 | 判定 |
|------|------|
| **Status** | conditionally_approved |
| **Score** | 4/5 |
| **条件** | MF-001（箇所2へのstripAnsi適用）が実装時に確実に反映されること |

設計書のセキュリティ設計（セクション5）は「リスクなし」と記載しているが、箇所2のstripAnsi未適用は既存バグとして認識されており、修正方針にも含まれている。セキュリティ観点からは、この修正が「nice-to-have」ではなく「must-have」であることを改めて強調する。設計方針自体は適切であり、修正の確実な実装を条件として承認する。

---

*Generated by architecture-review-agent for Issue #326 Stage 4 (Security Review)*
*Date: 2026-02-20*
