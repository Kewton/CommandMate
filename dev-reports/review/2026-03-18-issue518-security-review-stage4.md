# Security Architecture Review - Issue #518 CLI Base Commands (Stage 4)

**Issue**: #518 - CLI基盤コマンドの実装
**Focus Area**: セキュリティ (OWASP Top 10)
**Status**: Conditionally Approved
**Score**: 4/5
**Date**: 2026-03-18

---

## Executive Summary

Issue #518 の設計方針書に対する OWASP Top 10 準拠のセキュリティレビューを実施した。全体として、既存のセキュリティ基盤（timing-safe comparison、IP 制限、レートリミッター、worktree ID バリデーション、safe-regex2 による ReDoS 検出）を適切に活用する設計になっている。主要な懸念事項は、(1) `--token` フラグによるプロセスリストへのトークン露出、(2) デフォルト HTTP 通信でのトークン平文送信リスクの2点である。いずれも Phase 1 のローカル利用前提では許容範囲だが、ユーザーへの明確な警告メカニズムが設計書に欠如している。

---

## OWASP Top 10 Compliance Analysis

### A01: Broken Access Control - Partial

設計書は Bearer トークンによる認証を実装しているが、認可（authorization）レイヤーがない。有効なトークンを持つ CLI ユーザーは全 worktree に対して全操作が可能である。

**現状評価**: Phase 1 の単一ユーザー/ローカル利用前提では許容。worktree ID バリデーション（`isValidWorktreeId()`: `/^[a-zA-Z0-9_-]+$/`）により、パストラバーサル攻撃は防止される。

**既存の防御機構**:
- `src/lib/security/path-validator.ts` の `WORKTREE_ID_PATTERN` による入力制限
- `src/middleware.ts` の認証チェック（Cookie-first、Bearer フォールバック）
- `src/lib/security/ip-restriction.ts` による IP ベースのアクセス制御

### A02: Cryptographic Failures - Pass

トークンは SHA-256 ハッシュとして `CM_AUTH_TOKEN_HASH` に保存される。検証時は timing-safe comparison（Node.js: `crypto.timingSafeEqual`、Edge Runtime: XOR ベース）を使用しており、タイミング攻撃への耐性がある。

**環境変数での平文トークン保持**について: `CM_AUTH_TOKEN` は平文トークンを環境変数で保持するが、ローカルプロセス内での利用に限定されるため Phase 1 では許容。

### A03: Injection - Pass

設計書の Section 7-3「コマンドインジェクション防止」は適切に設計されている。

- CLI は HTTP リクエストのみ発行し、シェルコマンド実行を行わない
- ユーザー入力（message, answer）は JSON ボディに格納して送信
- worktree ID は正規表現で英数字+ハイフン+アンダースコアに制限
- stop-pattern はサーバー側で `safe-regex2` による ReDoS 検出と `MAX_STOP_PATTERN_LENGTH=500` の長さ制限が適用される
- 既存の tmux セッション管理は `execFile`（シェルを介さない）を使用

### A04: Insecure Design - Warning (Must Fix)

**--token フラグのトークン露出問題**:

```bash
# このコマンドは ps aux で他ユーザーから可視
commandmate ls --token abc123secret

# シェル履歴にも記録される
history | grep commandmate
```

設計書では `CM_AUTH_TOKEN` 環境変数を代替手段として提供しているが、`--token` が優先順位1位に設定されており（Section 7-1）、ユーザーが安全でない方法を選択するリスクが高い。

### A05: Security Misconfiguration - Warning (Must Fix)

`ApiClient` はデフォルトで `http://localhost:{port}` に接続する。localhost 通信ではネットワーク盗聴リスクは低いが、`CM_PORT` やベース URL をリモートサーバーに変更した場合、Bearer トークンが HTTP 平文で送信される。

既存コードベースでは `src/lib/security/auth.ts` に `isHttpsEnabled()` が実装されており、HTTPS 対応の基盤は存在する。

### A06: Vulnerable and Outdated Components - Pass

新規外部依存を追加しない方針は適切。Node.js 18+ 組み込み `fetch` の使用により、依存関係の脆弱性リスクが増大しない。

### A07: Identification and Authentication Failures - Partial

サーバー側の `src/lib/security/auth.ts` には `createRateLimiter()` が実装されている（5回失敗で15分ロックアウト）。しかし、`middleware.ts` は Edge Runtime で動作するため、Node.js ランタイムの `auth.ts` レートリミッターを直接参照できない可能性がある。

設計書の Bearer 認証失敗フロー（Section 2-3 ステップ3）で 401 JSON を返す際に、レートリミッターの `recordFailure()` が呼ばれるかどうかが不明確。

### A08: Software and Data Integrity Failures - Pass

CLI ビルドは既存の `tsconfig.cli.json` パイプラインを使用。新規のサプライチェーンリスクは導入されない。

### A09: Security Logging and Monitoring Failures - Warning

設計書には CLI リクエストに対するサーバー側の監査ログ設計がない。以下のセキュリティイベントのログ記録が欠如している:

- Bearer トークン認証の成功/失敗（IP アドレス付き）
- CLI 経由の send コマンドによるエージェント操作
- auto-yes の有効化/無効化

### A10: Server-Side Request Forgery - Pass

`ApiClient` はローカルユーザーが実行する CLI プロセス内で動作する。`baseUrl` は環境変数 `CM_PORT` から構成されるが、攻撃者による環境変数制御はローカル利用前提では低リスク。worktree ID バリデーションにより、URL パスの改ざんも防止される。

---

## Risk Assessment

| リスク種別 | 内容 | 影響度 | 発生確率 | 対策優先度 |
|-----------|------|-------|---------|-----------|
| セキュリティ | --token フラグによるトークン露出 | High | Medium | P1 |
| セキュリティ | HTTP 平文通信でのトークン送信 | High | Low | P1 |
| セキュリティ | Bearer 認証失敗のレート制限適用不明確 | Medium | Medium | P2 |
| セキュリティ | CLI リクエストの監査ログ欠如 | Medium | Low | P2 |
| セキュリティ | 認可レイヤー未実装 | Medium | Low | P3 |
| 技術的リスク | stop-pattern の CLI 側バリデーション不足 | Low | Low | P3 |

---

## Improvement Recommendations

### Must Fix (2 items)

**SEC4-01: --token フラグによるトークン漏洩リスク (A04)**

`--token` オプションのヘルプテキストに「セキュリティ上の理由から CM_AUTH_TOKEN 環境変数の使用を推奨。--token はプロセスリスト（ps aux）やシェル履歴に露出する」旨の警告を明記すること。また、`--token` 使用時に stderr へ以下のような警告を出力することを検討すること:

```
Warning: Using --token flag exposes the token in process listings.
Consider using CM_AUTH_TOKEN environment variable instead.
```

**SEC4-02: デフォルト HTTP 通信におけるトークン平文送信 (A05)**

`ApiClient` のコンストラクタで、baseUrl が localhost/127.0.0.1/::1 以外であり、かつスキーマが `https://` でない場合に stderr へ警告を出力すること:

```
Warning: Sending auth token over unencrypted HTTP to non-localhost server.
Consider enabling HTTPS (CM_HTTPS_CERT).
```

### Should Fix (4 items)

**SEC4-03**: Phase 1 のドキュメントに「単一トークンによる全操作許可」の前提を明記し、Phase 2 計画にスコープベース認可を追加すること。

**SEC4-05**: middleware.ts の Bearer 認証失敗パスでレートリミッターが適用されるかどうかを設計書で明確化すること。Edge Runtime 制約がある場合、API Route レベルでのレート制限を検討すること。

**SEC4-06**: CLI 側で stop-pattern の長さチェック（MAX_STOP_PATTERN_LENGTH=500）を事前に行い、サーバーからの 400 エラー時のメッセージ表示を設計書に追記すること。

**SEC4-07**: Phase 1 では Bearer トークン認証失敗のログ記録（IP アドレス付き）を middleware.ts に追加すること。

### Consider (5 items)

**SEC4-04**: ApiClient の get/post メソッド内で worktree ID セグメントを `encodeURIComponent()` で処理するか、各コマンドの action 冒頭で `isValidWorktreeId()` ガードを必須化すること。

**SEC4-08**: Phase 2 の設定ファイルベース認証でファイルパーミッション 0600 を実装すること。

**SEC4-09**: baseUrl を外部公開する場合、許可ホストのホワイトリスト検証を追加すること。

**SEC4-11**: Phase 2 で npm publish する場合、package-lock.json 固定と npm audit の CI 統合を確認すること。

**SEC4-12**: message/answer 引数の最大長制限を CLI 側でも実施することを検討すること。

---

## Positive Findings

1. **既存セキュリティ基盤の活用**: timing-safe comparison、IP 制限、レートリミッター、worktree ID バリデーション、safe-regex2 ReDoS 検出など、堅牢な既存セキュリティ機構を活用する設計
2. **シェルインジェクション防止**: CLI は HTTP のみ発行し、`execFile` によるシェルバイパスを採用した既存 tmux 管理と組み合わせ
3. **Cookie-first 認証順序**: [IA3-01] で既存ブラウザ認証を破壊しない Cookie-first フローを明示
4. **外部依存追加なし**: サプライチェーンリスクを増大させない設計判断
5. **入力バリデーション設計**: duration のホワイトリスト制限（1h/3h/8h のみ）、worktree ID の正規表現制限

---

## Approval Status

**Conditionally Approved** - Must Fix 2件（--token 警告表示、HTTP 平文送信警告）の対応を条件として承認。いずれも実装コストが低く、ユーザー安全性を大幅に向上させる改善である。

---

*Generated by architecture-review-agent for Issue #518 Stage 4*
*Date: 2026-03-18*
