# Issue #479 レビューレポート - Stage 7

**レビュー日**: 2026-03-13
**フォーカス**: 影響範囲レビュー（2回目）
**イテレーション**: 4（通常1 -> 影響範囲1 -> 通常2 -> 影響範囲2）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 1 |
| Nice to Have | 1 |

前回の影響範囲レビュー（Stage 3）で指摘された6件（must_fix 1件、should_fix 5件）は全て適切に反映済み。Stage 5-6で追加された変更による新たな重大な影響範囲上の問題は発見されなかった。

---

## 前回指摘事項の対応確認

### I001: isValidWorktreeIdの再配置 -- 対応済み

path-validator.tsへの移動方針が明記されている。実コード確認により、isValidWorktreeIdは12ファイルから参照されていることを確認（auto-yes-manager.ts + 11 APIルート）。path-validator.tsは237行・4 export関数の汎用バリデーションモジュールであり、移動先として適切。

### I002: db.tsテストモックパターン -- 対応済み

段階的移行方針がテスト戦略に記載済み。

### I003: response-poller.tsバレルファイル戦略 -- 対応済み

バレルファイル戦略の適用が明記されている。消費者6ファイル（API 3 + lib 3）の記載を実コードで確認。

### I004: Phase 3内実施順序 -- 対応済み

db.ts先行、response-poller.ts後続の順序と根拠（6関数依存）が記載済み。

### I005: モジュールレベル状態の整合性設計 -- 対応済み

response-poller.ts内のactivePollers MapとTUI accumulator Mapの分割後配置と整合性維持方針が記載済み。

### I006: テストファイル対応表 -- 対応済み

response-poller.tsの4テストファイルの対応表が追記済み。

---

## Should Fix（推奨対応）

### I2-001: auto-yes-manager.tsの3ファイル分割時のglobalThis状態分離設計が未記載

**カテゴリ**: 依存関係
**場所**: auto-yes-manager.ts詳細分割設計セクション

**問題**:
Stage 6でauto-yes-manager.tsの3ファイル分割案（auto-yes-manager.ts, auto-yes-poller.ts, auto-yes-state.ts）が追加されたが、globalThis上の2つのMap（`__autoYesStates`, `__autoYesPollerStates`）の分割後の配置が明記されていない。

現在のコード（L129-142）では以下のglobalThisパターンが使用されている:
- `globalThis.__autoYesStates` -> `autoYesStates` Map
- `globalThis.__autoYesPollerStates` -> `autoYesPollerStates` Map

`startAutoYesPolling()`は`getAutoYesState()`（autoYesStatesを参照）と`autoYesPollerStates`の両方にアクセスしており、auto-yes-poller.tsからauto-yes-state.tsへのモジュール間依存が発生する。

response-poller.tsの分割ではI005で同様のモジュールレベル状態の配置設計が指摘・反映されているため、auto-yes-manager.tsにも同等の設計記載が必要。

**推奨対応**:
auto-yes-manager.tsの詳細分割設計セクションに以下を追記:
- `__autoYesStates` Map: `auto-yes-state.ts` に配置
- `__autoYesPollerStates` Map: `auto-yes-poller.ts` に配置
- `auto-yes-poller.ts`から`auto-yes-state.ts`の`getAutoYesState()`を呼び出す形でモジュール間依存を管理

---

## Nice to Have（あれば良い）

### I2-002: auto-yes-manager.tsの3ファイル分割に伴うテストファイル対応表が未記載

**カテゴリ**: テスト
**場所**: auto-yes-manager.ts詳細分割設計セクション

**問題**:
response-poller.tsにはテストファイル対応表（I006）が追記されているが、auto-yes-manager.tsの3ファイル分割に対するテスト対応は未記載。現在8つのテストファイルが関連:

| テストファイル | 内容 |
|---|---|
| `auto-yes-manager.test.ts` | メインテスト（ポーリング + 状態管理） |
| `auto-yes-manager-cleanup.test.ts` | クリーンアップテスト |
| `session-cleanup-issue404.test.ts` | セッションクリーンアップ統合 |
| `resource-cleanup.test.ts` | リソースクリーンアップ統合 |
| `api/git-log.test.ts` | isValidWorktreeId使用 |
| `api/git-diff.test.ts` | isValidWorktreeId使用 |
| `api/git-show.test.ts` | isValidWorktreeId使用 |
| `auto-yes-persistence.test.ts` | 永続化統合テスト |

**推奨対応**:
response-poller.tsと同様のテストファイル対応表を追記。

---

## 新規変更の影響範囲確認

### auto-yes-manager.tsの3ファイル分割（F2-002）

| 項目 | 評価 |
|------|------|
| globalThis状態の分離 | 設計追記が必要（I2-001） |
| 消費者への影響 | バレルre-exportで回避可能 |
| テストへの影響 | 8ファイルが関連（I2-002） |
| Phase 2配置の妥当性 | 妥当（中リスク分類は適切） |

### Phase 1ファイル名追加（F2-003）

| ファイル | 消費者数 | リスク |
|---------|---------|-------|
| MarkdownEditor.tsx | 0（直接import無し） | 低 |
| FileTreeView.tsx | 1（WorktreeDetailRefactored.tsx） | 低 |
| schedule-manager.ts | 2（session-cleanup, resource-cleanup） | 低 |

Phase 1の低リスク分類は消費者数からも裏付けられる。

### R-3との関係（F2-001）

`tsconfig.json`の`moduleResolution: "bundler"`を確認。bundlerモードでは`@/lib/db`が`src/lib/db/index.ts`として解決されるため、R-3でのディレクトリ移動時もimportパス互換性が維持される。Issueの記載内容と整合。

---

## 参照ファイル

### コード
- `src/lib/auto-yes-manager.ts`: 3ファイル分割対象（866行、globalThis上に2つのMap）
- `src/lib/path-validator.ts`: isValidWorktreeId移動先（237行、4 export関数）
- `tsconfig.json`: moduleResolution: "bundler" 確認

### テスト
- `tests/unit/lib/auto-yes-manager.test.ts`: メインテスト
- `tests/unit/auto-yes-manager-cleanup.test.ts`: クリーンアップテスト
- 他6ファイル（詳細はI2-002参照）

---

## 総合評価

Issue #479は4回のレビュー（通常2回 + 影響範囲2回）を経て、影響範囲の観点から実装着手可能な品質に達している。前回のmust_fix（I001: isValidWorktreeId再配置）は適切に反映済み。今回のshould_fix 1件（I2-001: auto-yes-manager globalThis状態分離設計）は実装の安全性を高めるための補足であり、実装を妨げるものではない。
