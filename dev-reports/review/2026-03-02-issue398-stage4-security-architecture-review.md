# Architecture Review Report: Issue #398 Stage 4 (Security)

| 項目 | 値 |
|------|-----|
| Issue | #398 |
| Stage | 4 - セキュリティレビュー |
| 対象 | `dev-reports/design/issue-398-lmstudio-opencode-design-policy.md` |
| フォーカス | セキュリティ (OWASP Top 10 準拠) |
| レビュー日 | 2026-03-02 |
| ステータス | **conditionally_approved** |
| スコア | 4/5 |

---

## Executive Summary

Issue #398 の設計方針書は、LM Studio OpenAI互換APIの統合において、セキュリティ面で堅実な設計がなされている。既存の Ollama 実装で確立されたセキュリティパターン（SEC-001 SSRF防止、SEC-002 DoS防御、SEC-003 JSONインジェクション防止、SEC-004 パストラバーサル防止）を一貫して LM Studio にも適用しており、新たな脆弱性の導入リスクは低い。

Must Fix 1件、Should Fix 4件、Nice to Have 4件の指摘を行ったが、いずれも設計方針書の記述強化やリスク認識の明文化が中心であり、根本的な設計変更を要するものはない。

---

## OWASP Top 10 Checklist

| OWASP | カテゴリ | 評価 | 備考 |
|-------|---------|------|------|
| A01 | Broken Access Control | PASS (条件付き) | validateWorktreePath() 継続使用、writeFileSync のパーミッション注記推奨 (S4-006) |
| A02 | Cryptographic Failures | N/A | API キーや機密データの扱いなし |
| A03 | Injection | PASS (条件付き) | JSON.stringify 使用で JSON injection 防止、将来の引数インジェクションリスクの注記推奨 (S4-004) |
| A04 | Insecure Design | PASS | 失敗隔離設計、独立関数抽出は適切 |
| A05 | Security Misconfiguration | PASS (条件付き) | ハードコードURL/ポートは妥当、バリデーションパターンの根拠明記推奨 (S4-002, S4-008) |
| A06 | Vulnerable Components | PASS | 新規外部ライブラリの追加なし（fetch API のみ使用） |
| A07 | Auth Failures | N/A | 認証機能に変更なし |
| A08 | Data Integrity | PASS | writeFileSync flag:'wx' で競合書き込み防止 |
| A09 | Logging Failures | PASS (条件付き) | ログ出力の情報制御ポリシー追記推奨 (S4-001) |
| A10 | SSRF | PASS | SEC-001 適切に適用、localhost ハードコード、環境変数導出禁止 |

---

## Detailed Findings

### Must Fix (1件)

#### S4-004: LM Studio モデルIDの安全性とスケジュール実行時の引数インジェクションリスク

**重要度**: Must Fix
**カテゴリ**: Injection (OWASP A03)
**該当セクション**: セクション5 SEC-003 / セクション6-2 / セクション9

**説明**:

設計方針書セクション6-2の `fetchLmStudioModels()` では、LM Studio APIから取得した `model.id` をそのまま `ProviderModels` のキーとして使用している。

```typescript
models[model.id] = { name: model.id };
```

JSON.stringify() による出力でエスケープされるためJSON構造の破壊はないが、以下の2点で設計書にセキュリティ考慮の記録が必要である。

1. **モデルIDの `/` 文字**: `LM_STUDIO_MODEL_PATTERN` で `/` が許可されているため、`lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF` のようなキーが opencode.json に設定される。OpenCode がこのキーをパスとして解釈する可能性について認識を記録すべきである。

2. **将来のスケジュール実行**: `claude-executor.ts` の `buildCliArgs()` で opencode case が `ollama/${options.model}` をハードコードしている（セクション9でスコープ外と明記）。将来 LM Studio モデルをスケジュール実行で使用する際、`-m` フラグの引数としてモデル名が渡されるが、`execFile` を使用しているためシェルインジェクションは防止される。しかし、コマンドライン引数インジェクション（`--` を含む値によるフラグ解釈変更等）のリスクは別途考慮が必要である。

```typescript
// claude-executor.ts L110-115 (現在のコード)
case 'opencode':
  if (options?.model) {
    return ['run', '-m', `ollama/${options.model}`, message];
  }
  return ['run', message];
```

**提案**:

設計方針書のセクション5に以下を追記する:

- SEC-005（モデルID安全性）: JSON.stringify() によるエスケープで JSON 構造破壊は防止済み。モデルIDに含まれる `/` は OpenCode 側で適切に処理されることを前提とする。
- セクション9のスコープ外に注記: 将来のスケジュール実行対応時に、`buildCliArgs()` の引数バリデーション（`--` 文字列の拒否、プロバイダー識別子の動的切り替え）を追加する旨をセキュリティ要件として記録する。

---

### Should Fix (4件)

#### S4-001: console.warn によるログ情報漏洩リスクの設計方針記載

**重要度**: Should Fix
**カテゴリ**: InfoLeak (OWASP A09)
**該当セクション**: セクション5 / セクション6-2

`fetchLmStudioModels()` で `console.warn(`LM Studio API returned status ${response.status}`)` のようにHTTPステータスコードをログ出力している。サーバーサイドログへのアクセス権を持つ攻撃者にとって内部インフラ構成の推測材料となりうる。現在の出力内容（ステータスコードのみ）は許容範囲だが、設計方針書のセキュリティセクションにログ出力ポリシー（レスポンスボディの記録禁止等）を明記すべきである。

#### S4-002: LM_STUDIO_MODEL_PATTERN の文字種と長さ上限の根拠不足

**重要度**: Should Fix
**カテゴリ**: DoS (OWASP A05)
**該当セクション**: セクション4-1 LM_STUDIO_MODEL_PATTERN

`LM_STUDIO_MODEL_PATTERN = /^[a-zA-Z0-9._:/@-]{1,200}$/` は既存 `OLLAMA_MODEL_PATTERN` と比較して `@` 文字が追加され、長さ上限が100から200に倍増している。`@` が必要な具体的なモデルID例が設計方針書に記載されていない。セキュリティ原則として、正規表現の文字クラスは必要最小限に保つべきである。

**提案**: LM Studio の実際のモデルIDフォーマットを確認し、`@` が不要であれば除去する。200文字上限は実際の最長モデルID + マージンに基づく値に調整する。

#### S4-006: opencode.json の writeFileSync にファイルパーミッション（mode）が未指定

**重要度**: Should Fix
**カテゴリ**: AccessControl (OWASP A01)
**該当セクション**: セクション5 / セクション6-3

`fs.writeFileSync()` に `mode` が指定されておらず、OS デフォルト（通常 0o644）に依存している。opencode.json は現時点で機密情報を含まないため許容されるが、設計方針書のセキュリティセクションで意図的な判断として記録すべきである。将来的にプロバイダー設定に認証情報が追加される場合は `mode: 0o600` を設定する方針を注記する。

#### S4-008: response.text() 後のサイズチェック設計判断の根拠未記載

**重要度**: Should Fix
**カテゴリ**: DoS (OWASP A05)
**該当セクション**: セクション5 SEC-002 / セクション6-2

`response.text()` でレスポンス全体をメモリに読み込んだ後にサイズチェックを行う方式は、既存 Ollama 実装と一貫しており合理的な選択である。しかし、SEC-002 にこの設計判断の根拠（Content-Length の非信頼性、ストリーミングの複雑性、AbortController による二次保護等）が明記されていない。

---

### Nice to Have (4件)

#### S4-003: DNS rebinding リスクの注記

localhost へのfetchリクエストにおけるDNS rebinding攻撃の理論的リスク。ローカル開発環境前提であるため実質的なリスクは極めて低い。SEC-001 に「ローカル開発環境前提」の注記を追加することを推奨。

#### S4-005: Promise.all 並列実行時のメモリ消費量の考慮

最大 2MB（各 1MB x 2プロバイダー）のメモリ消費は問題ないレベル。3プロバイダー目追加時の検討事項として記録を推奨。

#### S4-007: LM Studio ポート 1234 の衝突リスク

ポート 1234 は IANA 未登録であり他のアプリケーションとの衝突可能性がある。レスポンス構造バリデーションにより誤設定リスクは軽減されるが、SEC-001 への注記を推奨。

#### S4-009: HTTP ヘッダー（User-Agent 等）の設計

localhost 通信であるため実質的なリスクは極めて低い。将来のリモートサーバー対応時に検討。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| SSRF | localhost ハードコードで防止済み | Low | Low | -- |
| DoS | レスポンスサイズ/モデル数/タイムアウト制限で防止済み | Low | Low | -- |
| Injection | JSON.stringify で防止済み。将来のCLI引数インジェクション要注意 | Med | Low | P2 |
| AccessControl | validateWorktreePath 継続使用、mode 未指定は許容範囲 | Low | Low | P3 |
| InfoLeak | ログ出力はステータスコードのみで許容範囲 | Low | Low | P3 |
| パストラバーサル | validateWorktreePath() の3層防御で十分 | Low | Low | -- |

---

## Comparison with Existing Security Patterns

設計方針書のセキュリティ設計が既存の Ollama 実装（`opencode-config.ts` Issue #379）と一貫しているかを検証した。

| セキュリティ対策 | Ollama (既存) | LM Studio (設計方針) | 一貫性 |
|----------------|--------------|---------------------|--------|
| API URL ハードコード | `OLLAMA_API_URL` as const | `LM_STUDIO_API_URL` as const | 一貫 |
| 環境変数導出禁止 | JSDoc に明記 | JSDoc に明記（予定） | 一貫 |
| レスポンスサイズ制限 | 1MB | 1MB | 一貫 |
| モデル数制限 | 100 | 100 | 一貫 |
| タイムアウト | 3000ms | 3000ms | 一貫 |
| モデル名バリデーション | `/^[a-zA-Z0-9._:/-]{1,100}$/` | `/^[a-zA-Z0-9._:/@-]{1,200}$/` | 差異あり (S4-002) |
| JSON生成方式 | JSON.stringify | JSON.stringify | 一貫 |
| ファイル書き込み | flag: 'wx' | flag: 'wx' | 一貫 |
| パストラバーサル | validateWorktreePath() 3層防御 | 同左（変更なし） | 一貫 |
| エラーハンドリング | non-fatal (console.warn + return) | non-fatal (console.warn + return {}) | 一貫 |

---

## Improvement Recommendations

### 必須改善項目 (Must Fix)

1. **S4-004**: セクション5に SEC-005（モデルID安全性）を追加し、JSON.stringify によるエスケープの有効性と、将来のスケジュール実行対応時のCLI引数バリデーション要件を明記する。セクション9のスコープ外にセキュリティ要件の注記を追加する。

### 推奨改善項目 (Should Fix)

2. **S4-001**: セクション5に SEC-006（ログ出力の情報制御）を追加し、console.warn の出力ポリシーを明記する。
3. **S4-002**: `LM_STUDIO_MODEL_PATTERN` の `@` 文字許可と200文字上限について、LM Studio の実際のモデルIDに基づく根拠を確認・記載する。
4. **S4-006**: セクション5にファイルパーミッションの設計判断（mode 省略理由）を記録する。
5. **S4-008**: SEC-002 に response.text() 後サイズチェック方式の設計判断根拠を追記する。

### 検討事項 (Consider)

6. **S4-003**: SEC-001 にローカル開発環境前提の注記を追加する。
7. **S4-005**: 並列実行時のメモリ消費を3プロバイダー目追加時の検討事項として記録する。
8. **S4-007**: ポート衝突リスクの注記を SEC-001 に追加する。
9. **S4-009**: 将来のリモートサーバー対応時にHTTPヘッダー設計を検討する。

---

## Approval Status

**conditionally_approved** -- Must Fix 1件を設計方針書に反映した後、実装段階に進行可能。Should Fix 4件は設計方針書の記述強化であり、実装と並行して対応可能。

---

*Generated by architecture-review-agent for Issue #398 Stage 4*
*Date: 2026-03-02*
