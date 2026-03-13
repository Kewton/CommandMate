# Issue #480 影響範囲レビューレポート（Stage 3）

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 2 |

**総合評価**: fair

本Issueは console.log 約160件を logger 経由に統一するリファクタリングだが、logger.ts の依存チェーンによりクライアントコンポーネントで使用不可という構造的な問題と、テストが console.log 出力を直接検証している箇所の修正が必要である。

---

## Must Fix（必須対応）

### S3-001: logger.ts はクライアントコンポーネントでインポート不可

**カテゴリ**: 実行環境

**問題**:
`logger.ts` は以下の依存チェーンを持つ:

```
logger.ts -> env.ts -> db-path-resolver.ts -> path, os, cli/utils/install-context
```

`db-path-resolver.ts` が Node.js 専用モジュール（`path`, `os`）および CLI ユーティリティに依存するため、`'use client'` 指定のあるコンポーネントでは `logger.ts` をインポートできない。

**影響ファイル**:
- `src/components/Terminal.tsx` - console.log 1件（`'use client'`）
- `src/components/worktree/MessageList.tsx` - console.log 1件（`'use client'`）
- `src/hooks/useWebSocket.ts` - console.log 1件（フック）

**推奨対応**:
クライアント用の軽量ロガー（例: `src/lib/client-logger.ts`）を別途作成し、サーバー専用の依存を持たないようにする。または `logger.ts` の `getLogConfig()` を `process.env` から直接読み取るように変更し、依存チェーンを断ち切る。Issue の設計方針にクライアント/サーバー分離の考慮を明記すべき。

---

### S3-002: テストが console.log の出力文字列を直接検証している

**カテゴリ**: テスト影響

**問題**:
以下のテストは `console.log` の呼び出しや出力文字列を直接 assertion しており、`console.log` を `logger` 経由に変更するとテストが失敗する。

| テストファイル | 行 | 検証内容 |
|--------------|-----|---------|
| `tests/integration/trust-dialog-auto-response.test.ts` | 146 | `Trust dialog detected` 文字列を `consoleSpy.mock.calls` で検証 |
| `tests/unit/lib/schedule-manager.test.ts` | 136 | `Already initialized` 文字列を `logSpy` で検証 |
| `tests/unit/lib/schedule-manager.test.ts` | 372 | `Initializing` 文字列を `logSpy` で検証 |

**推奨対応**:
console.log を logger 経由に変更する際、対応するテストも同時に更新する必要がある。logger をモック化して `logger.info` / `logger.debug` の呼び出しを検証するか、logger の出力先である console.log の spy 対象を維持するかを明確に決定し、Issue の受け入れ基準に「影響テストの修正」を追加すべき。

---

## Should Fix（推奨対応）

### S3-003: prompt-detector-cache テストが logger の内部実装に依存

**カテゴリ**: テスト影響

**問題**:
`tests/unit/prompt-detector-cache.test.ts:25` で `vi.spyOn(console, 'log')` を `debugSpy` として使用している。`prompt-detector` は既に `createLogger` を導入済みだが、テスト側は logger の内部実装（logger 内部で console.log を呼ぶ）に依存している。

**推奨対応**:
テストを logger のモック化に切り替えることを推奨。ただし現状のまま動作はするため、優先度は中。

---

### S3-004: db-migrations.ts（53件）の一括変更リスク

**カテゴリ**: 移行リスク

**問題**:
`db-migrations.ts` はスキーママイグレーション処理に53件の console.log を含む。マイグレーション処理はアプリ起動の最初期に実行され、失敗するとアプリが起動できなくなる。`logger` モジュール自体が `env.ts` 経由で DB 関連モジュールを参照するため、マイグレーション実行時に logger の初期化順序に問題が生じる可能性がある（循環依存リスク）。

依存関係:
```
db-migrations.ts -> logger.ts -> env.ts -> db-path-resolver.ts
```

`db-migrations.ts` は DB 初期化の一環として実行されるが、`db-path-resolver.ts` も DB パス解決に関与するため、初期化順序の整合性を検証する必要がある。

**推奨対応**:
`db-migrations.ts` は最優先で logger 移行の動作検証を行うべき。特に循環依存が発生する場合は対象から除外するか、軽量なマイグレーション専用ロガーを用意する。

---

### S3-005: 160件の一括変更による大規模 PR / レビュー負荷

**カテゴリ**: 移行リスク

**問題**:
35ファイル・約160件の変更を1つの PR で行うと、レビュー負荷が高くなりリグレッションの発見が困難になる。サーバーサイド（`src/lib/`）、API ルート（`src/app/api/`）、クライアントサイド（`src/components/`、`src/hooks/`）で実行環境が異なる。

**推奨対応**:
段階的移行を推奨:

| Phase | 対象 | 件数（概算） | 前提条件 |
|-------|------|------------|---------|
| 1 | 既に createLogger 導入済みファイルの残存 console.log | ~15件 | なし |
| 2 | `src/lib/` 配下のサーバーサイドモジュール | ~90件 | S3-004 検証済み |
| 3 | `src/app/api/` 配下の API ルート | ~10件 | Phase 2 完了 |
| 4 | `src/components/`、`src/hooks/` のクライアントサイド | ~5件 | S3-001 解決済み |

---

### S3-006: logger.ts の依存チェーンが重い

**カテゴリ**: 依存関係

**問題**:
ログ出力という基盤機能が、DB 関連やCLIユーティリティに依存する設計は、Issue #480 の大規模適用時にリスクを生む。

**推奨対応**:
Issue #480 のスコープ外だが関連として記録。`logger.ts` の `getLogConfig()` を `process.env` から直接読み取る軽量実装に切り替えることで、依存チェーンを断ち切ることを検討すべき。

---

## Nice to Have（あれば良い）

### S3-007: JSDoc 内の console.log は変更不要であることの明記

**カテゴリ**: 依存関係

**問題**:
以下のファイルの JSDoc `@example` ブロックに console.log が含まれるが、これらは実行されるコードではない（計8件）:
- `src/hooks/useFullscreen.ts`（2件）
- `src/hooks/useSwipeGesture.ts`（2件）
- `src/hooks/useWebSocket.ts`（1件）
- `src/components/worktree/SlashCommandList.tsx`（1件）
- `src/components/worktree/MarkdownEditor.tsx`（1件）
- `src/components/worktree/TerminalDisplay.tsx`（1件）

**推奨対応**:
Issue のスコープから JSDoc 内の console.log を明示的に除外する記載を追加し、grep 件数カウントからも除外すべき。

---

### S3-008: ログレベル変更による運用時情報量の変化

**カテゴリ**: 運用

**問題**:
現在の console.log は常時出力されるが、logger 経由に変更すると LOG_LEVEL 設定により debug レベルのログが本番環境で出力されなくなる（本番デフォルトは info）。

**推奨対応**:
運用ドキュメントに LOG_LEVEL の変更方法と各レベルで出力される情報の一覧を追加することを推奨。

---

## 影響ファイル一覧

### 直接変更対象（console.log を含む src/ 配下、cli/ 除外）

合計: 35ファイル・159件

| ファイル | 件数 | 環境 |
|---------|------|------|
| `src/lib/db-migrations.ts` | 53 | Server |
| `src/lib/claude-session.ts` | 12 | Server |
| `src/lib/cli-tools/codex.ts` | 10 | Server |
| `src/lib/schedule-manager.ts` | 9 | Server |
| `src/lib/cli-tools/gemini.ts` | 8 | Server |
| `src/lib/resource-cleanup.ts` | 6 | Server |
| `src/lib/assistant-response-saver.ts` | 5 | Server |
| `src/lib/response-poller.ts` | 5 | Server |
| `src/lib/worktrees.ts` | 4 | Server |
| `src/lib/cli-tools/vibe-local.ts` | 4 | Server |
| `src/lib/cli-tools/opencode.ts` | 4 | Server |
| `src/lib/cli-tools/manager.ts` | 4 | Server |
| `src/lib/env.ts` | 3 | Server |
| `src/lib/tmux.ts` | 3 | Server |
| `src/app/api/worktrees/[id]/send/route.ts` | 3 | Server |
| `src/app/api/worktrees/[id]/respond/route.ts` | 3 | Server |
| `src/lib/db.ts` | 2 | Server |
| `src/lib/db-migration-path.ts` | 2 | Server |
| `src/lib/logger.ts` | 1 | Server/Client |
| `src/lib/log-manager.ts` | 1 | Server |
| `src/lib/utils.ts` | 1 | Server/Client |
| `src/lib/clone-manager.ts` | 1 | Server |
| `src/components/Terminal.tsx` | 1 | Client |
| `src/components/worktree/MessageList.tsx` | 1 | Client |
| `src/components/worktree/MarkdownEditor.tsx` | 1 | Client (JSDoc) |
| `src/components/worktree/SlashCommandList.tsx` | 1 | Client (JSDoc) |
| `src/components/worktree/TerminalDisplay.tsx` | 1 | Client (JSDoc) |
| `src/hooks/useWebSocket.ts` | 1 | Client (JSDoc) |
| `src/hooks/useSwipeGesture.ts` | 2 | Client (JSDoc) |
| `src/hooks/useFullscreen.ts` | 2 | Client (JSDoc) |
| `src/types/external-apps.ts` | 1 | Shared |
| `src/app/api/hooks/claude-done/route.ts` | 1 | Server |
| `src/app/api/worktrees/[id]/start-polling/route.ts` | 1 | Server |
| `src/app/api/worktrees/[id]/viewed/route.ts` | 1 | Server |
| `src/app/api/worktrees/[id]/kill-session/route.ts` | 1 | Server |

### テスト修正が必要なファイル

| テストファイル | 理由 |
|--------------|------|
| `tests/integration/trust-dialog-auto-response.test.ts` | console.log 出力文字列を直接検証 |
| `tests/unit/lib/schedule-manager.test.ts` | console.log 出力文字列を直接検証（2箇所） |
| `tests/unit/prompt-detector-cache.test.ts` | console.log を logger の proxy として spy |

### 既に createLogger 導入済み（優先解消対象）

| ファイル | logger 導入済み | 残存 console.log |
|---------|---------------|-----------------|
| `src/lib/prompt-detector.ts` | Yes | 要確認 |
| `src/lib/cli-patterns.ts` | Yes | 要確認 |
| `src/lib/cli-session.ts` | Yes | 要確認 |
| `src/lib/pasted-text-helper.ts` | Yes | 要確認 |
| `src/lib/api-logger.ts` | Yes | 要確認 |

---

## 参照ファイル

### コード
- `src/lib/logger.ts`: ロガー基盤モジュール
- `src/lib/env.ts`: 環境変数設定（logger の依存先）
- `src/lib/db-path-resolver.ts`: DB パス解決（env.ts の依存先、Node.js 専用）
- `src/lib/db-migrations.ts`: 最大件数（53件）の変更対象

### テスト
- `tests/unit/logger.test.ts`: logger 自体のテスト（変更不要だが参照用）
- `tests/integration/trust-dialog-auto-response.test.ts`: 修正必要
- `tests/unit/lib/schedule-manager.test.ts`: 修正必要
