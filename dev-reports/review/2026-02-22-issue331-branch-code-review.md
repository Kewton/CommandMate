# Issue #331 ブランチ コードレビュー報告

作成日: 2026-02-22
対象ブランチ: `feature/331-worktree`
比較基準: `origin/develop...HEAD`

## 1. High: ログイン試行のグローバル固定キーによる全体ロックアウト（可用性リスク）

- 対象: `src/app/api/auth/login/route.ts:28`, `src/app/api/auth/login/route.ts:32`
- 内容:
  - レート制限キーが `global` 固定のため、失敗試行が閾値に達すると全ユーザーがログイン不可になります。
  - 外部公開時に第三者が意図的に失敗を繰り返すことで、15 分間のサービス妨害が可能です。
- 推奨対応:
  - 信頼できるリバースプロキシ配下では送信元 IP を利用（信頼境界を明確化）。
  - それ以外ではセッション識別子やクッキー等との複合キーで範囲を局所化。
  - 必要に応じて CAPTCHA / exponential backoff の併用を検討。

## 2. Medium: `CM_AUTH_TOKEN_HASH` 不正値時の有効判定不整合（実質ログイン不能）

- 対象: `src/lib/auth.ts:39`, `src/lib/auth.ts:80`, `src/lib/auth.ts:148`
- 内容:
  - `storedTokenHash` は不正フォーマット時に `undefined` へ落ちる一方、`isAuthEnabled()` は `process.env.CM_AUTH_TOKEN_HASH` の有無だけで `true` を返します。
  - その結果、UI/ミドルウェアは認証有効扱いになるのに、`verifyToken()` は常に失敗してログイン不能となる状態が発生します。
- 推奨対応:
  - `isAuthEnabled()` を `!!storedTokenHash` ベースに統一し、判定の一貫性を確保。
  - 起動時に不正値を検出した場合は fail-fast（起動失敗）も検討。

## 3. Medium: HTTPS 判定ロジックの不一致により表示 URL と実動作が乖離

- 対象: `src/cli/commands/start.ts:132`, `src/cli/commands/start.ts:224`, `server.ts:143`
- 内容:
  - CLI 表示用 `protocol` は `hasCert && (options.auth || options.https)` で決定。
  - 実サーバーは `CM_HTTPS_CERT` と `CM_HTTPS_KEY` が揃えば HTTPS 起動。
  - `--cert --key` 指定時に表示は `http://`、実際は HTTPS になりうるため運用ミスを誘発します。
- 推奨対応:
  - CLI 側のプロトコル判定をサーバー起動条件と一致させる。
  - `--https` 単独・証明書片側指定時は明示的にエラー化。

## 4. Low（テスト品質）: ミドルウェア統合テストが現仕様に追従できていない

- 対象: `src/middleware.ts:70`, `tests/integration/auth-middleware.test.ts:65`
- 内容:
  - 実装は `request.headers.get('upgrade')` を参照するが、テストモックに `headers` が存在しません。
  - そのため `auth-middleware` 統合テストが 8 件失敗します（実装不具合というよりテスト側の未追従）。
- 推奨対応:
  - `createMockRequest` に `headers.get()` モックを追加。
  - WebSocket upgrade パスの許可/拒否ケースも追加して回帰を防止。

## 実行確認メモ

- コマンド:
  - `npx vitest run tests/unit/auth.test.ts tests/unit/rate-limiter.test.ts tests/unit/cli-auth-options.test.ts tests/integration/auth-middleware.test.ts tests/integration/ws-auth.test.ts tests/integration/i18n-namespace-loading.test.ts`
- 結果要約:
  - `tests/integration/auth-middleware.test.ts` のみ 8 件失敗（`headers.get` 未モック）。
  - それ以外の対象テストは通過。
