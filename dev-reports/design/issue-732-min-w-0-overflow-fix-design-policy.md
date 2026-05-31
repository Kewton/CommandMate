# 設計方針書 — Issue #732: FilePanel 横溢れ修正（min-w-0 欠落）

> **スコープ注記**: 本Issueは CSS クラス追記のみの最小バグ修正（#730 follow-up）。本設計方針書は修正規模に比例した軽量版とする。アーキテクチャ・データモデル・API・DB に変更はない。

## 1. 背景・問題定義

Issue #730 でPC版レイアウトを ActivityBar 全高貫通構造に再構成した際、外側 flex コンテナ 2 箇所に `min-w-0` が付与されず、Flexbox の `min-width: auto` 既定により flex item が**コンテンツ最小幅以下に縮まない**問題が発生。

結果として Files アクティビティでファイルを選択すると、`FilePanelSplit` 内の固定幅ペインがレイアウトを膨張させ、親の `overflow-hidden` でクリップされた右端の `file-panel-pane` が **viewport 外**（横スクロール領域右端）に押し出され、視認上「隠れる」。

### 計測（viewport 1920px、Issue 実測）
| 要素 | 期待 | 実測 |
|------|------|------|
| 親 `flex h-full overflow-hidden relative` (L1738) | ≤1920 | 1633px ✅ |
| 子 `flex flex-col flex-1 min-h-0` (L1740) | ≤1633 | **2825px ❌** |
| 中間 `flex-1 min-h-0` (L1763) | ≤1633 | **2825px ❌** |
| file-panel-pane | viewport内 | left=2473（画面外） ❌ |

## 2. 根本原因（確定）

CSS Flexbox 仕様: flex item の `min-width` 既定は `auto` = main 軸方向のコンテンツ最小サイズ。`flex-1`（= `flex: 1 1 0%`）でも `min-width` は明示しない限り `0` にならない。

- **主因**: `WorktreeDetailRefactored.tsx:1740` の div は **flex-row コンテナ (L1738) の直接の flex item**。main 軸（横）に `min-width:auto` が効き、子孫（`FilePanelSplit` の `width:50% flex-shrink-0` ペイン）のコンテンツ要求まで拡大する。
- **防御的補強**: `WorktreeDetailRefactored.tsx:1763` の div は flex-col コンテナ内 cross 軸の item。理論上は主因ではないが、Issue の Playwright 実測で両 div が 2825px に膨張していたため、確実性のため両方に付与する。

`right-pane-slot`（`WorktreeDesktopLayout.tsx:136`）と terminal slot（`TerminalContainer.tsx:131`、実 `data-testid="terminal-container-terminal-slot"`）は既に `flex-grow overflow-hidden min-w-0` を持つ → チーム既存規約であり、上位 2 箇所が規約からの**漏れ**であることが裏付けられる。

## 3. 設計判断 / 採用案

| 決定事項 | 採用 | 理由 | トレードオフ |
|---------|------|------|-------------|
| 修正方法 | 既存 className 末尾に `min-w-0` を追記（2箇所） | 最小・既存規約（`min-w-0`）に一致・他コンポーネント無影響 | なし（純粋な CSS、props/API 変更なし） |
| 修正対象 | L1740 と L1763 の **PC経路のみ** | 主因 + 防御的補強。モバイル経路 (`flex-1 min-h-0` @ ~L1590) は別構造で対象外 | L1763 は理論上冗長だが無害 |
| 代替案: flex レイアウト全面再設計 | **不採用** | YAGNI。最小修正で症状解消可能 | — |
| 代替案: 子（FilePanelSplit）側で吸収 | **不採用** | 既存規約は上位コンテナで `min-w-0` を持つ方式。一貫性を優先 | — |

### 適用原則
- **KISS / YAGNI**: 既存規約に沿った 2 トークン追記のみ。設計の作り直しはしない。
- **DRY**: `right-pane-slot` / `terminal-slot` と同じ `min-w-0` 規約を踏襲。
- **最小影響**: ロジック・props・公開API・DB・i18n すべて無変更。

### 実装メモ（DR1-001, Stage 1 設計レビュー反映）
- **L1763 の `min-w-0` には防御的補強である旨の短いコメントを付与**する（例: `{/* Issue #732: min-w-0 防御的補強。横溢れ防止のため main 軸主因(L1740)と併せて付与 */}`）。将来のクリーンアップで誤削除されないようトレーサビリティを確保。L1740 にも同様に主因である旨を簡潔に注記する。

## 4. 影響範囲

| 区分 | 内容 |
|------|------|
| 変更ファイル | `src/components/worktree/WorktreeDetailRefactored.tsx`（2行のclassName追記） |
| 変更なし | props/公開API/DB/型定義/i18n/モバイル経路 |
| 既存テスト | 非破壊。`WorktreeDetailRefactored.test.tsx` は `WorktreeDesktopLayout`/`TerminalContainer` をモックし、対象 div の className をアサートしない（`desktop-layout` 参照は存在チェックのみ） |
| ドキュメント | `CHANGELOG.md` [Unreleased] にバグ修正記載 |

## 5. テスト戦略

| レベル | 検証内容 | 手段 |
|--------|---------|------|
| unit (jsdom/Vitest) | L1740/L1763 の div の className に `min-w-0` が含まれる | RTL でクラス文字列アサート（モックを実DOM出力に調整 or 専用テスト） |
| e2e (Playwright) | Files→ファイルクリックで `getBoundingClientRect().right <= window.innerWidth`、`desktop-layout` 幅 ≤ viewport-sidebar-ActivityBar、History 表示/非表示・ActivityPane 幅変更でも成立 | 既存 e2e パターン踏襲（任意・推奨） |
| 共通 | `npm run lint` / `npx tsc --noEmit` / `npm run test:unit` / `npm run build` 全PASS | CI |

> jsdom は実レイアウトを計算せず `getBoundingClientRect` が 0 を返すため、幅ベースの厳密検証は e2e のみ有効。unit では className レベルの回帰防止に留める。

## 6. リスクと対策

| リスク | 影響度 | 対策 |
|--------|-------|------|
| L1763 への付与が他の縦レイアウトに副作用 | 低 | `min-w-0` は横方向のみに作用。flex-col の高さ配分（`flex-1`/`min-h-0`）に影響なし |
| ターミナル分割（1〜3）の幅配分が変わる | 低 | `min-w-0` は親が viewport を超えて膨張するのを止めるのみ。子の `flex-grow`/`width` 配分は不変。受入条件で検証 |
| モバイル回帰 | なし | モバイル経路は未変更 |

## 7. 完了条件（受入条件マッピング）

- [ ] PC版 (1920px) で Files→ファイルクリックで FilePanel が viewport 内
- [ ] `file-panel-pane.getBoundingClientRect().right <= window.innerWidth`（e2e）
- [ ] `desktop-layout` 幅 ≤ viewport（e2e）
- [ ] History 表示/非表示・ActivityPane 幅変更でも viewport 内（e2e）
- [ ] L1740/L1763 の className に `min-w-0`（unit）
- [ ] ターミナル/履歴の既存挙動維持・モバイル変更なし
- [ ] lint / tsc / test:unit / build 全PASS
- [ ] CHANGELOG 更新
