# Issue #481 設計方針書: src/lib ディレクトリ再整理（R-3）

## 作成日時
- 2026-03-13

## 概要

`src/lib` ルートの72ファイルをドメイン別サブディレクトリに再整理するリファクタリング。ファイル探索性の向上とドメイン境界の明確化を目的とする。

---

## 1. アーキテクチャ設計

### サブディレクトリ構成

```
src/lib/
├── cli-tools/        # 既存: CLIツール抽象化 (11ファイル)
├── proxy/            # 既存: プロキシ (4ファイル)
├── external-apps/    # 既存: 外部アプリ (5ファイル)
├── transports/       # 既存: tmuxトランスポート (2ファイル) ※tmux/に統合予定（R003）
├── __tests__/        # 既存: テスト (9ファイル) ※位置は現状維持
│
├── db/               # 新規: DB関連 (6ファイル)
│   ├── index.ts      # バレルエクスポート
│   ├── db.ts
│   ├── db-instance.ts
│   ├── db-migrations.ts
│   ├── db-path-resolver.ts
│   ├── db-repository.ts
│   └── db-migration-path.ts
│
├── tmux/             # 新規: tmux関連 (10ファイル) ※transports/統合含む（R003）
│   ├── index.ts
│   ├── tmux.ts
│   ├── tmux-capture-cache.ts
│   ├── tmux-control-client.ts
│   ├── tmux-control-mode-flags.ts
│   ├── tmux-control-mode-metrics.ts
│   ├── tmux-control-parser.ts
│   ├── tmux-control-registry.ts
│   ├── control-mode-tmux-transport.ts  # transports/ から統合
│   ├── polling-tmux-transport.ts       # transports/ から統合
│   └── session-transport.ts            # ルートから統合（R002）
│
├── security/         # 新規: セキュリティ (6ファイル)
│   ├── index.ts
│   ├── auth.ts
│   ├── ip-restriction.ts
│   ├── path-validator.ts
│   ├── env-sanitizer.ts
│   ├── sanitize.ts
│   └── worktree-path-validator.ts
│
├── detection/        # 新規: 検出系 (4ファイル)
│   ├── index.ts
│   ├── status-detector.ts
│   ├── prompt-detector.ts
│   ├── cli-patterns.ts
│   └── prompt-key.ts
│
├── session/          # 新規: セッション管理 (4ファイル)
│   ├── index.ts
│   ├── claude-session.ts
│   ├── cli-session.ts
│   ├── worktree-status-helper.ts
│   └── claude-executor.ts
│
├── git/              # 新規: Git操作 (3ファイル)
│   ├── index.ts
│   ├── git-utils.ts
│   ├── worktrees.ts
│   └── clone-manager.ts
│
├── polling/          # 新規: ポーリング・自動応答 (3ファイル)
│   ├── index.ts
│   ├── response-poller.ts
│   ├── auto-yes-manager.ts
│   └── auto-yes-resolver.ts
│
├── session-cleanup.ts   # ルート残留: リソース解放Facade（R001）
│                        # polling/, tmux/, schedule-managerにまたがるFacadeのためsession/に含めない
│
└── (残り38ファイル)  # ルート残留（ユーティリティ系）
```

### グループ間依存関係

```
polling/ ──→ session/ ──→ detection/
   │             │
   │             └──→ tmux/
   └──→ detection/

session/ ──→ tmux/ (session-transport.ts の型参照)
db/: 独立（他グループへの依存なし）
security/: 独立
git/: 独立
```

**注**: transports/ は tmux/ に統合されるため、依存グラフから消滅する（R003）。

---

## 2. 技術選定・設計パターン

### バレルエクスポートパターン

各新規サブディレクトリに `index.ts` を設置し、外部からはバレルエクスポート経由でアクセスする。

```typescript
// src/lib/db/index.ts
export * from './db'
export * from './db-instance'
export * from './db-migrations'
export * from './db-path-resolver'
export * from './db-repository'
export * from './db-migration-path'
```

**理由**:
- `cli-tools/`, `proxy/`, `external-apps/` の既存パターンを踏襲
- 内部ファイル名変更時の外部影響を最小化
- `vi.mock()` パスの大量更新を回避可能（バレルパス経由のmockで対応）

### security/ グループのバレルエクスポート方針（S001, S002）

**security/ グループでは `export *` ではなく明示的な named export を使用する。**

セキュリティ関連モジュールは、内部専用関数（`@internal`）や認証コア関数が意図せず広く公開されることを防ぐため、他グループとは異なり named export を採用する。

```typescript
// src/lib/security/index.ts（named export 方式）

// auth.ts: 外部から必要な関数のみを公開
export { verifyToken, parseCookies, createRateLimiter, isAuthEnabled, AUTH_COOKIE_NAME } from './auth'

// ip-restriction.ts: 全関数を公開
export { getAllowedRanges, isIpAllowed, isIpRestrictionEnabled, normalizeIp } from './ip-restriction'

// path-validator.ts: isWithinRoot() は @internal のため除外
export { isPathSafe, validateWorktreePath, resolveAndValidateRealPath } from './path-validator'

// env-sanitizer.ts
export { SENSITIVE_ENV_KEYS, sanitizeEnvForChildProcess } from './env-sanitizer'

// sanitize.ts
export { sanitizeTerminalOutput, sanitizeUserInput, containsDangerousContent } from './sanitize'

// worktree-path-validator.ts
export { validateWorktreePathAccess } from './worktree-path-validator'
```

**除外対象**:
- `isWithinRoot()`（path-validator.ts）: JSDoc で `@internal Exported for unit testing only` と明記。テストからは直接パス `@/lib/security/path-validator` で import する
- `generateToken()`, `hashToken()`（auth.ts）: 認証ロジック内部でのみ使用すべき関数。外部モジュールからの呼び出しを防ぐ

**注意**: auth.ts の公開関数リストは実装時に実際の外部参照を精査して確定する。上記は現時点での分析に基づく推奨リスト。

### importパス規約

```typescript
// グループ内: 相対パス維持
import { captureOutput } from './tmux-capture-cache'

// グループ外: @/lib/グループ名 形式
import { getDb } from '@/lib/db'
import { detectStatus } from '@/lib/detection'
```

---

## 3. 移行戦略

### 推奨移行順序

依存の少ない順に移行することでリスクを最小化する。

| 順序 | グループ | 移動ファイル数 | 理由 |
|------|---------|-------------|------|
| 1 | db/ | 6 | 独立、参照元が最多（46+36ファイル）だがバレルで互換維持 |
| 2 | tmux/ | 10 | session/ の前提、transports/ 統合含む（R003） |
| 3 | security/ | 6 | 独立 |
| 4 | detection/ | 4 | session/, polling/ の前提 |
| 5 | session/ | 4 | detection/, tmux/ に依存（R001でsession-cleanup除外、R002でsession-transport除外） |
| 6 | polling/ | 3 | session/, detection/ に依存 |
| 7 | git/ | 3 | 独立、優先度低 |

### db/ 移行の原子性（I001: must_fix）

`src/lib/db.ts` と `src/lib/db/index.ts` が同時に存在すると、TypeScript の `moduleResolution: 'bundler'` ではファイル（db.ts）がディレクトリ（db/index.ts）より優先されるため、バレルエクスポートが機能しない。

**移行手順（1コミットで原子的に実施）**:
1. `src/lib/db/` ディレクトリを作成
2. `src/lib/db.ts` を `src/lib/db/db.ts` に移動
3. 他のDB関連ファイル（db-instance.ts, db-migrations.ts, db-path-resolver.ts, db-repository.ts, db-migration-path.ts）を `src/lib/db/` に移動
4. `src/lib/db/index.ts` を作成（バレルエクスポート）

**重要**: 手順2で `src/lib/db.ts` が消滅するため、`@/lib/db` は `db/index.ts` に正しく解決される。db.ts の移動と db/index.ts の作成を別コミットにしてはならない。

### db/ の後方互換性維持

`@/lib/db` → `@/lib/db/index.ts` の自動解決により、既存の36箇所のimportを変更不要にする。

```typescript
// db/index.ts で全エクスポートを再エクスポートすることで
// 既存の `import { ... } from '@/lib/db'` は変更不要
```

### db-instance.ts の個別importパス移行方針（I002: must_fix）

`@/lib/db-instance` を直接importしているファイルが48箇所、`vi.mock('@/lib/db-instance')` が33箇所存在する。バレルエクスポート（`@/lib/db`）では `@/lib/db-instance` パスの後方互換性を維持できない。

**採用方針: 互換レイヤーファイルを残す**

旧パスに再エクスポートファイルを設置し、既存48ファイル+テスト33箇所の一括書き換えを回避する。

```typescript
// src/lib/db-instance.ts（互換レイヤー、移行後も残留）
export * from './db/db-instance'
```

同様に、以下のファイルにも互換レイヤーを設置する:
- `src/lib/db-migrations.ts` → `export * from './db/db-migrations'`（参照: 34箇所）
- `src/lib/db-path-resolver.ts` → `export * from './db/db-path-resolver'`
- `src/lib/db-repository.ts` → `export * from './db/db-repository'`
- `src/lib/db-migration-path.ts` → `export * from './db/db-migration-path'`

**注意**: 互換レイヤーは将来のPhase 2で一括書き換え後に削除する。セクション7の影響規模サマリーの「更新が必要なimport行: 約696行」には、互換レイヤー採用時は db-instance 等の48+33箇所分が除外される。

### transports/ の統合方針（R003: 確定）

**案A を採用**: `transports/` を `tmux/` に統合する。

transports/ 内のファイル（control-mode-tmux-transport.ts, polling-tmux-transport.ts）はいずれもtmux固有の実装であり、tmux/ への統合が最もKISSに沿う。統合により transports/ ディレクトリを完全に解消する。

- `control-mode-tmux-transport.ts` --> `tmux/`
- `polling-tmux-transport.ts` --> `tmux/`
- `session-transport.ts` --> `tmux/`（型定義。cli-session.ts からは `@/lib/tmux` 経由でimport）

**移行タイミング**: tmux/ グループ移行（順序2）と同時に実施する。

**transports/ 参照の更新対象（I005: should_fix）**:

統合時にimportパス更新が必要な具体的ファイル4件:

| ファイル | 現在のimport | 更新後 |
|---------|-------------|--------|
| `src/lib/ws-server.ts` | `./transports/control-mode-tmux-transport` | `./tmux/control-mode-tmux-transport` または `@/lib/tmux` |
| `src/lib/cli-session.ts` | `./transports/polling-tmux-transport` | `./tmux/polling-tmux-transport` または `@/lib/tmux` |
| `tests/unit/lib/cli-session-transport.test.ts` | `vi.mock('@/lib/transports/polling-tmux-transport')` | `vi.mock('@/lib/tmux/polling-tmux-transport')` |
| `tests/unit/lib/ws-server-terminal.test.ts` | `vi.mock('@/lib/transports/control-mode-tmux-transport')` | `vi.mock('@/lib/tmux/control-mode-tmux-transport')` |

### middleware.ts の Edge Runtime 対応（I006: should_fix）

`src/middleware.ts` は `'./lib/ip-restriction'` で ip-restriction.ts を参照している。security/ 移行後は以下の方針とする:

- **middleware.ts では `'./lib/security/ip-restriction'` の直接import形式を使用する**（バレル `@/lib/security` 経由にしない）
- 理由: security/index.ts の re-export に path-validator.ts 等の Node.js 依存モジュールが含まれるため、バレル経由では Edge Runtime で不要なモジュールがバンドルされるリスクがある
- R005（Stage 1）で「Edge Runtime向け直接import許容」とした方針の具体的適用

---

## 4. セキュリティ設計

このリファクタリングはファイル移動のみであり、ロジック変更を伴わない。セキュリティ上の注意点:

- `security/` グループへの移動により、セキュリティ関連コードの所在が明確になる
- importパス変更によるセキュリティロジックの誤削除・誤接続に注意
- 各ステップでビルド・テストを通過させてから次のグループに移行

---

## 5. 実装上の設計判断とトレードオフ

| 決定事項 | 採用案 | 理由 | トレードオフ |
|---------|--------|------|------------|
| バレルエクスポート | 採用 | 既存パターン踏襲、互換性維持 | ツリーシェイキング効率がやや低下。ただしサーバー側モジュールが大半のため実影響は軽微。Edge Runtime向けの security/ については直接importも許容する（R005） |
| 段階的移行 | グループ単位 | リスク分散、レビューしやすい | 一括移行より工数増 |
| ルート残留38ファイル | 現状維持 | 対象外（将来検討） | ルートはまだ密集 |
| transports/ 統合 | 案A: tmux/ に統合（R003） | transports/ 内は全てtmux固有実装 | transports/ ディレクトリ解消 |

---

## 6. 受け入れ基準チェックリスト

### importパス更新
- [ ] 外部参照（`@/lib/xxx` → `@/lib/group/xxx` または `@/lib/group` 経由）の一括更新
- [ ] 移動ファイル内部の相対importをグループ内は相対パス維持、グループ外は `@/lib/` 形式に変換
- [ ] `__tests__/` 内の相対importパスを `@/lib/group/xxx` 形式に更新（6ファイル）
- [ ] `vi.mock()` のモジュールパス更新方針を確定・実施

### 循環依存チェック
- [ ] `npx tsc --noEmit` が通ること
- [ ] 必要に応じて `npx madge --circular src/` で循環依存を確認

### テスト・ビルド
- [ ] 既存テストが全パス（`npm run test:unit`）
- [ ] `npm run lint && npx tsc --noEmit` がパス
- [ ] `npm run build:cli` がパス（CLIモジュールへの間接影響がないことを確認）（I004）

### バレルエクスポート
- [ ] 各新規サブディレクトリに `index.ts` を設置

### transports/ 統合確認
- [ ] transports/ ディレクトリの完全削除を確認（tmux/ への統合完了後、空ディレクトリが残留していないこと）

### セキュリティ関連importの接続確認（S004）
- [ ] `ws-server.ts` が auth.ts から `verifyToken`, `isAuthEnabled`, `parseCookies`, `AUTH_COOKIE_NAME` を正しく import していること
- [ ] `ws-server.ts` が ip-restriction.ts から `getAllowedRanges`, `isIpAllowed`, `isIpRestrictionEnabled`, `normalizeIp` を正しく import していること
- [ ] `middleware.ts` が ip-restriction.ts から必要な関数群を正しく import していること（直接パス `./lib/security/ip-restriction` 経由）
- [ ] `file-operations.ts` が path-validator.ts から `isPathSafe` を正しく import していること

### ドキュメント更新
- [ ] CLAUDE.md のモジュール一覧を更新（約52箇所）
- [ ] docs/module-reference.md のパス更新（約54箇所）
- [ ] docs/architecture.md の更新（約6箇所、該当する場合）

---

## 7. ロールバック計画（I007: should_fix）

### 基本方針

各グループの移行を feature ブランチ上の独立コミットとし、問題発生時に `git revert` で個別にロールバック可能にする。

### コミット粒度

| コミット | 内容 | ロールバック単位 |
|---------|------|---------------|
| Commit 1 | db/ グループ移行（db.ts移動 + index.ts作成 + 互換レイヤー設置を原子的に実施） | `git revert <commit1>` |
| Commit 2 | tmux/ グループ移行（transports/ 統合含む） | `git revert <commit2>` |
| Commit 3 | security/ グループ移行 | `git revert <commit3>` |
| Commit 4 | detection/ グループ移行 | `git revert <commit4>` |
| Commit 5 | session/ グループ移行 | `git revert <commit5>` |
| Commit 6 | polling/ グループ移行 | `git revert <commit6>` |
| Commit 7 | git/ グループ移行 | `git revert <commit7>` |

### ロールバック手順

1. 各グループ移行後に `npm run lint && npx tsc --noEmit && npm run test:unit` を実行
2. 失敗時は即座にそのコミットを `git revert` する
3. 複数グループをロールバックする場合は移行順序の逆順（git/ -> polling/ -> session/ -> detection/ -> security/ -> tmux/ -> db/）で実施
4. 各コミットが独立しているため、途中のグループのみロールバックする場合は依存関係に注意（例: session/ をロールバックする場合、polling/ も先にロールバックする必要がある）

### 前提条件

- 各グループ移行を1コミットにまとめること（特にdb/グループはI001の原子性要件あり）
- PRマージ前にsquashしないこと（個別revertを可能にするため）

---

## 8. 影響規模サマリー

| 項目 | 規模 |
|------|------|
| 移動対象ファイル | 36ファイル（7グループ） |
| 更新が必要なimport行 | 約696行 |
| 影響ソースファイル | 約100ファイル |
| 影響テストファイル | 約99ファイル |
| vi.mock() 更新箇所 | 約93箇所（バレルで旧パス維持時は不要） |
| ドキュメント更新 | 約112箇所（CLAUDE.md + module-reference.md + architecture.md） |

---

## 9. 新規グループ追加時のガイドライン（R007）

将来、新しいドメイングループを追加する場合は以下のルールに従う:

1. **index.ts によるバレルエクスポート必須**: グループディレクトリに `index.ts` を設置し、外部からはバレル経由でアクセスする
2. **セキュリティグループは named export を推奨**: `security/` グループのように `@internal` 関数や認証コア関数を含むグループでは、`export *` ではなく明示的な named export を使用する（S002）
3. **グループ間依存図の更新**: セクション1の依存関係図に新グループの依存を追記する
4. **依存の少ない順に移行**: 他グループへの依存が少ないファイルから段階的に移行する
5. **名前衝突時の対処**: `export *` で名前衝突が発生した場合は `export { foo as barFoo } from './bar'` で解決する（R008）

---

## 10. Stage 1 レビュー指摘反映サマリー

| ID | 重要度 | 概要 | 対応内容 |
|----|--------|------|---------|
| R001 | should_fix | session-cleanup.ts はFacadeでありsession/の責務と異なる | session/ から除外しルート残留に変更 |
| R002 | should_fix | session-transport.ts の配置がtransports/との依存問題を生む | ルート残留とし、transports/ 統合時に tmux/ へ移動する方針を明記 |
| R003 | should_fix | transports/ 統合方針が未確定 | 案A（tmux/ に統合）を確定。transports/ を完全に解消 |
| R004 | nice_to_have | polling/ グループの凝集度がやや低い | 現状維持。将来ファイル増加時に再分割を検討（対応不要） |
| R005 | nice_to_have | バレルエクスポートのEdge Runtime影響 | トレードオフ欄にEdge Runtime向け直接import許容を補足 |
| R006 | nice_to_have | ルート残留37ファイルにグループ化候補あり | 現状維持（対応不要。将来Phase 2候補: log系, conversation系, file系） |
| R007 | nice_to_have | 新規グループ追加のガイドライン不足 | セクション8に追加ガイドラインを新設 |
| R008 | nice_to_have | 名前衝突時のルール不足 | セクション8のガイドラインに追記 |

---

## 11. Stage 2 レビュー指摘反映サマリー

| ID | 重要度 | 概要 | 対応内容 |
|----|--------|------|---------|
| C001 | must_fix | 移動対象ファイル合計が35ではなく36 | セクション7の「35ファイル」を「36ファイル」に修正 |
| C002 | must_fix | ルート残留ファイル数が37ではなく38 | セクション1の「残り37ファイル」を「残り38ファイル」に修正。セクション5のトレードオフ表も「38ファイル」に修正 |
| C003 | nice_to_have | 依存関係図にcli-session.tsからの実装取得依存が未記載 | 対応不要（tmux/統合後は両方tmux/経由となり実害なし） |
| C004 | nice_to_have | session/のR002注記で「除外」が曖昧 | 対応不要（セクション1の構成図で正しくtmux/配下に記載済み） |
| C005 | nice_to_have | 受け入れ基準にtransports/削除確認がない | セクション6に「transports/ ディレクトリの完全削除確認」を追加 |
| C006 | nice_to_have | テストファイルパス更新「6ファイル」の根拠が不明確 | 対応不要（実装時にimport分析で確定する） |
| C007 | nice_to_have | db/のバレルエクスポート例にdb-migration-path.tsが欠落 | 既に反映済み（Stage 1対応時にセクション2のバレルエクスポート例に含まれている） |

---

## 12. Stage 3 レビュー指摘反映サマリー

| ID | 重要度 | 概要 | 対応内容 |
|----|--------|------|---------|
| I001 | must_fix | db.ts と db/ ディレクトリの同時存在によるモジュール解決の曖昧性 | セクション3に「db/ 移行の原子性」を追加。1コミットで db.ts 移動と db/index.ts 作成を同時に行う手順を明記 |
| I002 | must_fix | db-instance.ts を参照する48ファイルのimportパス更新が未記載 | セクション3に「db-instance.ts の個別importパス移行方針」を追加。互換レイヤーファイル（再エクスポート）を残す方針を採用 |
| I003 | nice_to_have | ドキュメント影響の見積もり精度 | 対応不要（実装時にimport分析で確定する。I003の指摘する __tests__/ 7ファイルの件はC006と同様に実装時確認とする） |
| I004 | should_fix | CLIモジュールへの間接的影響確認が必要 | セクション6の受け入れ基準に `npm run build:cli` パスを追加 |
| I005 | should_fix | transports/ を参照する4ファイルのimport更新が未明記 | セクション3の transports/ 統合方針に具体的な更新対象4ファイルの表を追加 |
| I006 | should_fix | middleware.ts の Edge Runtime での security/ 直接import方針が未記載 | セクション3に「middleware.ts の Edge Runtime 対応」を追加。直接import形式を明記 |
| I007 | should_fix | ロールバック計画が未記載 | セクション7にロールバック計画を新設。グループ単位の独立コミット + git revert による個別ロールバック方針を記載 |
| I008 | nice_to_have | hooks/contexts への影響は限定的 | 対応不要（影響は正しく見積もられている） |
| I009 | nice_to_have | components への影響は限定的 | 対応不要（影響は正しく見積もられている） |

---

## 13. Stage 4 レビュー指摘反映サマリー

| ID | 重要度 | 概要 | 対応内容 |
|----|--------|------|---------|
| S001 | should_fix | path-validator.ts の @internal 関数 isWithinRoot() がバレル経由で外部公開される | セクション2に「security/ グループのバレルエクスポート方針」を追加。named export を使用し isWithinRoot() をバレルから除外する方針を明記 |
| S002 | should_fix | auth.ts の generateToken()/hashToken() がバレル経由で広く公開される | セクション2の security/ バレル方針に auth.ts の named export 推奨を含めて記載。セクション9のガイドラインにセキュリティグループは named export 推奨を追記 |
| S003 | nice_to_have | middleware.ts の Edge Runtime 対応方針は適切 | 対応不要（I006で既に適切に記載済み） |
| S004 | should_fix | セキュリティ関連 import の誤削除を検出する受け入れ基準が不十分 | セクション6に「セキュリティ関連importの接続確認」チェック項目を追加（ws-server.ts, middleware.ts, file-operations.ts） |
| S005 | nice_to_have | security/ グループの構成ファイル選定は適切 | 対応不要 |
| S006 | nice_to_have | security/ グループ内に循環依存リスクはない | 対応不要 |
| S007 | nice_to_have | sanitize.ts と env-sanitizer.ts の命名が紛らわしいが技術的問題なし | 対応不要（KISS に沿い既存命名を維持） |

---

## 関連ファイル

- Issue: https://github.com/Kewton/CommandMate/issues/481
- Issueレビュー: `dev-reports/issue/481/issue-review/summary-report.md`
- Stage 1 レビュー結果: `dev-reports/issue/481/multi-stage-design-review/stage1-review-result.json`
- Stage 1 反映結果: `dev-reports/issue/481/multi-stage-design-review/stage1-apply-result.json`
- Stage 2 レビュー結果: `dev-reports/issue/481/multi-stage-design-review/stage2-review-result.json`
- Stage 2 反映結果: `dev-reports/issue/481/multi-stage-design-review/stage2-apply-result.json`
- Stage 3 レビュー結果: `dev-reports/issue/481/multi-stage-design-review/stage3-review-result.json`
- Stage 3 反映結果: `dev-reports/issue/481/multi-stage-design-review/stage3-apply-result.json`
- Stage 4 レビュー結果: `dev-reports/issue/481/multi-stage-design-review/stage4-review-result.json`
- Stage 4 反映結果: `dev-reports/issue/481/multi-stage-design-review/stage4-apply-result.json`
