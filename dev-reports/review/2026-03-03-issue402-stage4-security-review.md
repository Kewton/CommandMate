# Architecture Review: Issue #402 - Stage 4 Security Review

## Executive Summary

| Item | Detail |
|------|--------|
| Issue | #402: detectPrompt の重複ログ出力抑制 |
| Stage | 4 - セキュリティレビュー |
| Focus | セキュリティ (OWASP Top 10 compliance) |
| Status | **approved** |
| Score | **5/5** |
| Must Fix | 0 |
| Should Fix | 0 |
| Nice to Have | 7 |

Issue #402 の設計は、セキュリティ観点で懸念事項なしと判定する。変更は `prompt-detector.ts` のモジュールスコープにおけるログ出力抑制キャッシュの追加に限定されており、認証・認可・入力バリデーション・暗号処理・外部通信のいずれにも影響しない。OWASP Top 10 の全10項目について分析を行い、該当なし（6項目）または適合（4項目）と判定した。

---

## OWASP Top 10 Checklist

| # | Category | Status | Analysis |
|---|----------|--------|----------|
| A01 | Broken Access Control | N/A | アクセス制御ロジックへの変更なし |
| A02 | Cryptographic Failures | N/A | 暗号処理への変更なし。ハッシュ不使用は設計意図（文字列比較で十分） |
| A03 | Injection | PASS | キャッシュ値はログメッセージに直接挿入されない。logger.ts sanitize() が多層防御として機能 |
| A04 | Insecure Design | PASS | フェールセーフ設計。キャッシュ障害時は変更前と同等の動作 |
| A05 | Security Misconfiguration | N/A | 新たな設定パラメータの追加なし |
| A06 | Vulnerable Components | N/A | 新たな外部依存の追加なし |
| A07 | Auth Failures | N/A | 認証ロジックへの変更なし |
| A08 | Data Integrity | N/A | シリアライゼーション処理なし |
| A09 | Logging Failures | PASS | セキュリティログは別モジュール管理。プロンプト検出の初回ログは常に出力される |
| A10 | SSRF | N/A | 外部リクエスト発行なし |

---

## Detailed Security Analysis

### 1. Information Leakage Assessment (S4-002)

**Risk: None**

`lastOutputTail` はモジュールスコープの `let` 変数としてプロセスメモリ内にのみ保持される。外部に公開される経路を網羅的に確認した。

| Exposure Path | Status | Evidence |
|--------------|--------|----------|
| API Response | Blocked | D4-001/D4-002 制約により detectPrompt() 戻り値にキャッシュ状態は含まれない |
| Error Message | Blocked | resetDetectPromptCache() は `lastOutputTail = null` のみ。例外にキャッシュ値を含まない |
| Log Output | Blocked | ログに含まれるのは `{ outputLength: output.length }` 等のメタデータのみ。lastOutputTail の値は出力されない |
| Client-side Access | Blocked | `isServer()` ガードにより、サーバーサイドのモジュールスコープ変数はクライアントに送信されない |
| Debug Endpoint | Blocked | キャッシュ状態を返す API エンドポイントは設計に存在しない |

`output` パラメータにはユーザーの CLI セッション出力が含まれるが、これは既にプロセスメモリ内に存在する情報であり、末尾50行のキャッシュが新たな攻撃面を追加することはない。

### 2. Log Injection Analysis (S4-003)

**Risk: None**

`lastOutputTail` は tmux capturePane の出力に由来する外部入力であるが、以下の理由でログインジェクションのリスクはない。

1. **比較のみで使用**: `tailForDedup === lastOutputTail` の等値比較のみ。ログ文字列テンプレートに挿入されない。
2. **構造化ログ**: logger.ts は `JSON.stringify()` でフォーマットするため、改行文字やエスケープシーケンスはエスケープされる。
3. **sanitize() 防御層**: logger.ts の `sanitize()` 関数はログ出力時に自動適用され、Bearer トークン、パスワード、API キー等の機密パターンをマスクする。

```typescript
// 設計上のデータフロー
const tailForDedup = lines.slice(-50).join('\n');
const isDuplicate = tailForDedup === lastOutputTail;  // 比較のみ

if (!isDuplicate) {
  logger.debug('detectPrompt:start', { outputLength: output.length });
  // ^ outputLength はメタデータ。lastOutputTail/tailForDedup はログに含まれない
}
```

### 3. DoS Prevention Analysis (S4-004)

**Risk: None**

| Metric | Value | Rationale |
|--------|-------|-----------|
| Cache Entries | 1 (constant) | 設計制約 D4-003 |
| Max String Size | ~10KB | 50 lines x ~200 chars |
| Comparison Cost | O(n), n <= 10KB | V8 最適化により数マイクロ秒 |
| Input Upper Bound | 10MB | tmux.ts MAX_BUFFER_SIZE で間接制約 |
| GC Safety | Automatic | 文字列参照の上書きで前の値は即座に GC 対象 |

単一エントリの文字列参照であるため、Map/Set のようなコレクション型のメモリリーク経路は構造的に存在しない。仮に極端に長い行が tmux 出力に含まれたとしても、50行の `.slice(-50)` で切り出された文字列の1エントリのみが保持される。

### 4. Access Control for @internal Export (S4-005)

**Risk: None**

`resetDetectPromptCache()` は `@internal` JSDoc アノテーション付きでエクスポートされ、テスト専用であることが設計制約 D4-004 で明記されている。このパターンはプロジェクト内の広範な先例に準拠している。

| Module | @internal Export | Purpose |
|--------|-----------------|---------|
| version-checker.ts | resetCacheForTesting() | バージョンキャッシュリセット |
| claude-session.ts | clearCachedClaudePath() | CLI パスキャッシュクリア |
| claude-session.ts | HealthCheckResult | テスト用型 |
| auto-yes-manager.ts | clearAllAutoYesStates() | ポーラー状態リセット |
| auto-yes-manager.ts | checkStopCondition() | Stop条件テスト |
| clone-manager.ts | resetWorktreeBasePathWarning() | 警告フラグリセット |

仮に本番コードから誤って呼び出された場合でも、次回の `detectPrompt()` 呼び出しでログが1回出力されるのみであり、セキュリティ上の副作用（認証バイパス、権限昇格、データ破損等）は一切ない。最悪ケースは変更前の動作と同等であるため、フェールセーフである。

### 5. Fail-Safe Design Evaluation (S4-006)

**Risk: None**

キャッシュ機構はすべての障害シナリオで安全方向にフェールする。

| Scenario | Behavior | Security Impact |
|----------|----------|-----------------|
| Cache miss (null) | 通常ログ出力 | なし（変更前と同等） |
| Cache miss (mismatch) | 通常ログ出力 | なし（変更前と同等） |
| Cache hit | ログスキップ、戻り値は正常 | なし |
| Hot Reload reset | lastOutputTail = null | なし（次回ログ出力） |
| Multi-worktree thrashing | キャッシュヒット率低下 | なし（最悪で変更前と同等） |
| resetDetectPromptCache() call | lastOutputTail = null | なし（次回ログ出力） |
| Memory pressure | GC が前回の文字列を回収 | なし（新しい値は保持される） |

### 6. Security Logging Impact (S4-001)

**Risk: None**

| Log Category | Module | Impact |
|--------------|--------|--------|
| Authentication failures | middleware.ts, auth.ts | None |
| IP restriction violations | ip-restriction.ts, middleware.ts | None |
| Input validation errors | Various API routes | None |
| Prompt detection (debug) | prompt-detector.ts | Duplicate suppressed only |
| Session operations | claude-session.ts | None |
| Security events | cli/utils/security-logger.ts | None |

detectPrompt() のログは `debug` レベル（detectPrompt:start, detectPrompt:complete）と `info` レベル（detectPrompt:multipleChoice）であり、いずれもセキュリティ監視には使用されない。新規 output 到着時は常にログが出力されるため、プロンプト検出の初回記録は失われない。

---

## Risk Assessment

| Risk Type | Level | Rationale |
|-----------|-------|-----------|
| Technical | Low | 単一エントリの文字列キャッシュ、フェールセーフ設計 |
| Security | Low | OWASP Top 10 全項目で影響なし/適合。新たな攻撃面なし |
| Operational | Low | ログ抑制は監視能力に影響しない。セキュリティログは別系統 |

---

## Findings Summary

### Must Fix (0 items)

None.

### Should Fix (0 items)

None.

### Nice to Have (7 items)

| ID | Category | Title |
|----|----------|-------|
| S4-001 | A09 Logging | ログ抑制による監視能力への影響は設計上許容範囲内 |
| S4-002 | Information Leakage | lastOutputTail のメモリ内保持は情報漏洩リスクなし |
| S4-003 | A03 Injection | ログインジェクションリスクなし |
| S4-004 | DoS Prevention | 50行キャッシュ上限によるメモリ DoS 防御は十分 |
| S4-005 | Access Control | @internal export のスコープは既存パターンに準拠 |
| S4-006 | A04 Insecure Design | キャッシュ設計は安全なフォールバック動作を保証 |
| S4-007 | OWASP Top 10 | 全10項目の網羅的チェック完了 |

いずれも対応不要の確認事項であり、設計の安全性を裏付ける分析結果である。

---

## Design Security Strengths

本設計のセキュリティ面で特に評価できる点を以下にまとめる。

1. **単一エントリキャッシュ (D4-003)**: Map やリストではなく単一の `let` 変数を使用することで、メモリリークの構造的可能性を排除している。
2. **戻り値不変制約 (D4-001/D4-002)**: キャッシュの有無が detectPrompt() の機能的振る舞いに一切影響しないことを設計レベルで保証している。
3. **フェールセーフ原則**: すべての障害シナリオで「ログが出力される」方向にフェールし、セキュリティ機能には影響しない。
4. **情報隠蔽**: lastOutputTail は API レスポンス、エラーメッセージ、ログ本文のいずれにも露出しない。
5. **多層防御の維持**: logger.ts の sanitize() 関数によるログサニタイズは本変更の影響を受けず、引き続き機能する。
6. **crypto 依存の回避**: ハッシュ計算を使用しない設計により、暗号関連の脆弱性リスクを根本的に排除している。

---

## Conclusion

Issue #402 の設計方針書は、セキュリティ観点で懸念事項なしと判定する（Score: 5/5, Status: approved）。変更対象は `src/lib/prompt-detector.ts` のログ出力制御に閉じており、セキュリティ機能（認証、IP制限、入力バリデーション）への影響は皆無である。OWASP Top 10 の全項目に対する分析を実施し、新たなセキュリティリスクの導入がないことを確認した。設計のフェールセーフ特性、情報隠蔽、メモリ安全性はいずれも優れており、セキュリティレビューの観点から実装を承認する。

---

*Reviewed by: Architecture Review Agent (Stage 4 - Security)*
*Date: 2026-03-03*
*Design Document: dev-reports/design/issue-402-detect-prompt-log-dedup-design-policy.md*
