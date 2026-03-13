# Issue #481 Stage 3 影響範囲レビューレポート

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー（1回目）
**イテレーション**: 1
**対象Issue**: refactor: src/lib ディレクトリ再整理（R-3）

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 1 |
| **合計** | **9** |

### 影響規模の概要

| 項目 | 数値 |
|------|------|
| 移動対象ファイル数 | 35 |
| 更新が必要なimport行数 | 約696行 |
| 影響を受けるソースファイル数 | 約100ファイル |
| 影響を受けるテストファイル数 | 約99ファイル（tests/） + 9ファイル（src/lib/__tests__/） |
| ドキュメントのパス参照更新 | CLAUDE.md: 52箇所、module-reference.md: 54箇所、architecture.md: 6箇所 |

---

## Must Fix（必須対応）

### F101: importパス変更の総規模と段階的移行戦略が未記載

**カテゴリ**: 影響範囲
**場所**: Issue本文全体

**問題**:
35ファイルの移動により、約696行のimport文の更新が必要となる。src/app/api/以下だけで約100ファイル、tests/以下で約99ファイルが影響を受ける。この規模感がIssueに記載されておらず、段階的移行戦略も明記されていない。

**影響を受けるファイル数（グループ別・上位）**:
- db-instance: 46ファイルから参照
- db: 36ファイルから参照
- auto-yes-manager: 11ファイルから参照
- tmux: 8ファイルから参照
- path-validator: 6ファイルから参照
- git-utils: 5ファイルから参照

**推奨対応**:
「影響規模」セクションを追加し、具体的な数値と段階的移行戦略（グループ単位で db -> tmux -> security -> detection -> session -> polling -> git の順に移行）を記載する。

---

### F102: グループ間の相互依存関係が未分析

**カテゴリ**: 影響範囲
**場所**: 提案するサブディレクトリ構成セクション

**問題**:
循環依存の検証方法は記載されているが、既知のグループ間依存関係が分析されていない。実際の依存関係は以下の通り:

```
tmux/ <-- session/ <-- polling/
             |              |
             v              v
        detection/ <--------+
```

具体的な依存:
- `polling/` -> `session/` (cli-session): response-poller.ts, auto-yes-manager.ts
- `polling/` -> `detection/` (prompt-detector, cli-patterns, prompt-key): response-poller.ts, auto-yes-manager.ts
- `session/` -> `detection/` (status-detector): claude-session.ts, worktree-status-helper.ts, claude-executor.ts
- `session/` -> `tmux/` (tmux, tmux-capture-cache): claude-session.ts, cli-session.ts, session-cleanup.ts, worktree-status-helper.ts
- `transports/` -> `tmux/` (tmux, tmux-control-mode-metrics, tmux-control-registry): control-mode-tmux-transport.ts

依存方向は一方向であり循環依存リスクは低いが、安全な移行順序を事前に把握しておく必要がある。

**推奨対応**:
「グループ間依存関係」セクションを追加し、依存グラフと推奨移行順序（tmux -> detection -> session -> polling）を明記する。

---

### F103: 移動ファイル内部の相対importパス更新方針が不明確

**カテゴリ**: 影響範囲
**場所**: 受け入れ基準セクション

**問題**:
受け入れ基準の「importパスの一括更新」が外部参照のみを指すのか、移動ファイル内部の相対importも含むのか不明確。特に以下のファイルは多数のグループ外相対importを持つ:

- auto-yes-manager.ts: 12件の相対import（うちグループ外多数）
- response-poller.ts: 10件の相対import（session/, detection/, db/ 等への参照）
- worktree-status-helper.ts: 7件の相対import（cli-tools/, detection/, tmux/ 等への参照）

これらは移動後、グループ外ファイルへの参照になるため `@/lib/xxx` 形式への変換が必要。

**推奨対応**:
受け入れ基準を以下のように明確化:
- 外部からの参照パスの更新
- 移動ファイル内部の相対importのうち、グループ外参照を `@/lib/` パス形式に変換
- 同一グループ内の相対パスは維持

---

## Should Fix（推奨対応）

### F104: db/ グループの既存importパス衝突リスク

**カテゴリ**: 影響範囲
**場所**: バレルエクスポート方針セクション

**問題**:
現在 `@/lib/db` で db.ts を直接importしているコードが36箇所ある。db/ ディレクトリ作成後は `@/lib/db` がディレクトリのindex.tsを指すことになるため、db/index.ts で db.ts の全exportを再エクスポートすれば、外部からの `@/lib/db` importは変更不要になる可能性がある。

**推奨対応**:
db/ グループについての特記事項として、`@/lib/db` パスの後方互換性戦略を明記する。

---

### F105: src/lib/__tests__/ の相対importパス更新が必要

**カテゴリ**: 影響範囲
**場所**: 提案するサブディレクトリ構成 - __tests__/ の注釈

**問題**:
`__tests__/` は「現状維持」だが、以下6ファイルが移動対象ファイルを相対パス（`../xxx`）でimportしている:
- worktrees-sync.test.ts: ../db-migrations, ../db, ../worktrees
- db-migrations-v10.test.ts: ../db-migrations
- db-memo.test.ts: ../db-migrations, ../db
- assistant-response-saver.test.ts: ../db-migrations, ../db, ../cli-session
- status-detector.test.ts: ../status-detector
- cli-patterns.test.ts: ../cli-patterns

**推奨対応**:
`__tests__/` の注釈に影響ファイルリストと相対パス更新の必要性を明記する。

---

### F106: transports/ 案A/案B の具体的影響差分が未記載

**カテゴリ**: 影響範囲
**場所**: transports/ の扱い方針セクション

**問題**:
案A（tmux/統合）と案B（現状維持）の記載はあるが、具体的な影響差分が不明。

実際の依存状況:
- transports/ -> tmux/: 一方向のみ（3件のimport）
- transports/のimport元: cli-session.ts, ws-server.ts + テスト4ファイル

**推奨対応**:
- 案A(統合): cli-session.ts, ws-server.ts + テスト4ファイルのimportパス変更
- 案B(現状維持): transports/内3件の相対パスを `../tmux/xxx` に変更、index.ts新設検討

---

### F107: ドキュメント更新の具体的な影響規模が未記載

**カテゴリ**: 影響範囲
**場所**: 受け入れ基準セクション

**問題**:
受け入れ基準にドキュメント更新3件を記載しているが、具体的な更新箇所数が不明。

**影響規模**:
- CLAUDE.md: 約52箇所のパス参照更新
- docs/module-reference.md: 約54箇所のパス参照更新
- docs/architecture.md: 約6箇所のパス参照更新

**推奨対応**:
各ドキュメントの更新箇所数を注記として追記する。

---

### F108: テストファイルのvi.mock()パス更新への考慮不足

**カテゴリ**: 影響範囲
**場所**: 受け入れ基準セクション

**問題**:
tests/以下99ファイルへの影響はimport文だけでなく、`vi.mock('@/lib/xxx')` の呼び出しパスも全て更新が必要になる可能性がある。バレルエクスポートで旧パスを維持するか、mockパスも一括更新するか、方針が不明確。

**推奨対応**:
受け入れ基準にvi.mock()のモジュールパス更新方針を追記する。バレルエクスポートで旧パスの後方互換を確保する場合、mock対象パスの変更は最小限に抑えられる。

---

## Nice to Have（あれば良い）

### F109: polling/ グループの凝集度が低い

**カテゴリ**: 影響範囲

**問題**:
auto-yes-manager.ts は12件の相対import（うち大半がグループ外）、response-poller.ts は10件の相対import（session/, detection/, db/等）を持ち、polling/ グループとしての凝集度が低い。

**推奨対応**:
polling/ グループの注釈に「session/, detection/, cli-tools/ への外部依存が多い。凝集度向上のため将来的なグループ再編を検討可能」と追記する。

---

## ビルド設定への影響

| 設定ファイル | 影響 |
|-------------|------|
| tsconfig.json | `@/*: ./src/*` エイリアスは変更不要 |
| vitest.config.ts | `@: ./src` エイリアスは変更不要。テストのmockパスに波及可能性あり |
| package.json | 変更不要 |
| next.config.js | 変更不要 |

---

## 推奨移行順序

依存関係の分析結果に基づく安全な移行順序:

1. **db/** - 外部依存なし、最もimport参照が多いため先行移行でバレルexport効果を確認
2. **security/** - 外部依存なし
3. **git/** - 外部依存なし
4. **tmux/** - 外部依存なし
5. **detection/** - 外部依存なし（tmux/への依存なし）
6. **session/** - tmux/, detection/ に依存（先行移行済み）
7. **polling/** - session/, detection/ に依存（先行移行済み）

---

## 参照ファイル

### 高影響コードファイル
- `src/lib/db-instance.ts`: 46ファイルから参照される最多import対象
- `src/lib/db.ts`: 36ファイルから参照、db/ディレクトリ名との衝突リスク
- `src/lib/auto-yes-manager.ts`: 12件の相対import + 11ファイルから外部参照
- `src/lib/response-poller.ts`: 10件の相対import、3グループへの依存
- `src/lib/worktree-status-helper.ts`: 4グループへの依存

### ドキュメント
- `CLAUDE.md`: 52箇所のパス参照更新が必要
- `docs/module-reference.md`: 54箇所のパス参照更新が必要
- `docs/architecture.md`: 6箇所のパス参照更新が必要
